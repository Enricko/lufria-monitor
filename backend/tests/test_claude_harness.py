"""Claude Code page as a harness: per-turn flags, mixed official/custom sessions, interrupt,
re-attach replay, transcript parsing, `!` bash and `#` memory. The CLI is faked."""
import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app import claude_chat, claude_sessions, claude_transcript, claude_workspace, folder_guard, providers

SID = "12345678-1234-1234-1234-123456789abc"


class FakeInput:
    def __init__(self, proc):
        self.proc, self.lines, self.closed = proc, [], False

    def write(self, data):
        self.lines.append(json.loads(data))
        if self.lines[-1].get("type") == "control_request":
            self.proc.finish("interrupted")

    async def drain(self):
        pass

    def close(self):
        self.closed = True

    def is_closing(self):
        return self.closed


class FakeProcess:
    """Emits init + one text block, then waits until finish() (result + EOF)."""

    def __init__(self, auto_finish=True):
        self.stdin = FakeInput(self)
        self.stdout = asyncio.StreamReader()
        self.returncode = None
        self.pid = 0
        self.feed({"type": "system", "subtype": "init", "session_id": SID, "model": "reported"})
        self.feed({"type": "assistant", "message": {"content": [{"type": "text", "text": "working"}]}})
        if auto_finish:
            self.finish("success")

    def feed(self, obj):
        self.stdout.feed_data((json.dumps(obj) + "\n").encode())

    def finish(self, subtype):
        if self.returncode is None:
            self.feed({"type": "result", "subtype": subtype, "usage": {}, "total_cost_usd": 0})
            self.stdout.feed_eof()
            self.returncode = 0

    async def wait(self):
        return self.returncode

    def kill(self):
        self.finish("killed")

    def send_signal(self, sig):
        self.finish("signal")


class Socket:
    """Feeds scripted client frames; waits for the predicate before each one."""

    def __init__(self, frames):
        self.frames, self.sent = list(frames), []
        self.changed = asyncio.Event()

    async def accept(self):
        pass

    async def send_text(self, raw):
        self.sent.append(json.loads(raw))
        self.changed.set()

    async def receive_text(self):
        if not self.frames:
            await asyncio.sleep(0.05)
            raise claude_chat.WebSocketDisconnect()
        wait_for, frame = self.frames.pop(0)
        while wait_for and not wait_for(self.sent):
            self.changed.clear()
            await asyncio.wait_for(self.changed.wait(), timeout=5)
        return json.dumps(frame)


def idle_count(n):
    return lambda sent: sum(1 for e in sent if e.get("type") == "status" and e.get("state") == "idle"
                            and e.get("msg") != "ready") >= n


class HarnessBase(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.registry = providers.ProviderRegistry(root / "providers.json", builtins=[])
        self.pid = self.registry.create(name="Router", base_url="https://router.test/v1", api_key="router-key")["id"]
        for obj, attr, value in ((providers, "_registry", self.registry),
                                 (claude_sessions, "BINDINGS_FILE", root / "bindings.json"),
                                 (claude_sessions, "SESSIONS_DIR", root / "sessions"),
                                 (claude_sessions, "HISTORY_FILE", root / "history.jsonl")):
            p = patch.object(obj, attr, value, create=True)
            p.start()
            self.addCleanup(p.stop)
        claude_sessions.SESSIONS_DIR.mkdir()
        self.transcript = claude_sessions.SESSIONS_DIR / f"{SID}.jsonl"
        self.transcript.write_text(json.dumps({"type": "user", "message": {"content": "earlier prompt"}}) + "\n")
        claude_chat.RUNS.clear()
        self.addCleanup(claude_chat.RUNS.clear)


class PrepareTest(HarnessBase):
    async def test_official_combos_map_to_main_model_and_subagents(self):
        expected = {
            "official-hemat": ("sonnet", {"explorer": "haiku"}),
            "official-seimbang": ("opusplan", {"explorer": "haiku", "reviewer": "opus"}),
            "official-kualitas": ("opus", {"explorer": "haiku", "reviewer": "opus"}),
        }
        for combo, (main, agents_expected) in expected.items():
            with self.subTest(combo=combo):
                cmd, env, secret, provider = await claude_chat._prepare(combo, None, None, "plan", None)
                self.assertEqual(cmd[cmd.index("--model") + 1], main)
                agents = json.loads(cmd[cmd.index("--agents") + 1])
                self.assertEqual({name: a["model"] for name, a in agents.items()}, agents_expected)
                self.assertIsNone(secret)
                self.assertIsNone(provider)

    async def test_flags_follow_permission_mode_effort_and_native_aliases(self):
        cmd, env, secret, provider = await claude_chat._prepare("opus", None, SID, "plan", "high")
        self.assertIn("--include-partial-messages", cmd)
        self.assertEqual(cmd[cmd.index("--permission-prompts") + 1], "none")
        self.assertEqual(cmd[cmd.index("--permission-mode") + 1], "plan")
        self.assertNotIn("--dangerously-skip-permissions", cmd)
        self.assertEqual(cmd[cmd.index("--effort") + 1], "high")
        self.assertEqual(cmd[cmd.index("--model") + 1], "opus")
        self.assertEqual(cmd[-2:], ["--resume", SID])
        self.assertNotIn("ANTHROPIC_BASE_URL", {k for k in env if env[k] == "https://router.test"})
        self.assertIsNone(secret)
        self.assertIsNone(provider)

        cmd, *_ = await claude_chat._prepare("default", None, None, "bypassPermissions", None)
        self.assertIn("--dangerously-skip-permissions", cmd)
        self.assertNotIn("--model", cmd)
        self.assertNotIn("--effort", cmd)

    async def test_custom_provider_turn_gets_router_env(self):
        cmd, env, secret, provider = await claude_chat._prepare("gemini-x", self.pid, SID, "acceptEdits", None)
        self.assertEqual(env["ANTHROPIC_BASE_URL"], "https://router.test")
        self.assertEqual(secret, "router-key")
        self.assertEqual(provider, "Router")
        self.assertEqual(cmd[cmd.index("--permission-mode") + 1], "acceptEdits")


class SessionTest(HarnessBase):
    async def test_one_session_alternates_official_and_custom_models(self):
        calls = []

        async def spawn(*cmd, **kwargs):
            calls.append((cmd, kwargs["env"]))
            return FakeProcess()

        ws = Socket([
            (None, {"type": "resume", "session_id": SID}),
            (None, {"type": "user", "text": "official", "model": "opus", "provider_id": None}),
            (idle_count(1), {"type": "user", "text": "custom", "model": "gemini-x", "provider_id": self.pid}),
            (idle_count(2), {"type": "user", "text": "official again", "model": "sonnet", "provider_id": None}),
            (idle_count(3), {"type": "ping"}),
        ])
        with patch("app.claude_chat.asyncio.create_subprocess_exec", new=spawn):
            await claude_chat.handle_ws(ws)
        self.assertEqual(len(calls), 3)
        for cmd, _ in calls:
            self.assertEqual(cmd[-2:], ("--resume", SID))
        self.assertEqual([c[c.index("--model") + 1] for c, _ in calls], ["opus", "gemini-x", "sonnet"])
        self.assertEqual([env.get("ANTHROPIC_BASE_URL") for _, env in calls], [None, "https://router.test", None])
        self.assertEqual(claude_sessions.get_session_binding(SID)["model"], "sonnet")
        self.assertIsNone(claude_sessions.get_session_binding(SID)["provider_id"])
        starts = [e for e in ws.sent if e.get("type") == "turn_start"]
        self.assertEqual([s["provider"] for s in starts], [None, "Router", None])
        self.assertNotIn("router-key", json.dumps(ws.sent))

    async def test_interrupt_sends_control_request_and_ends_turn(self):
        procs = []

        async def spawn(*cmd, **kwargs):
            procs.append(FakeProcess(auto_finish=False))
            return procs[-1]

        ws = Socket([
            (None, {"type": "resume", "session_id": SID}),
            (None, {"type": "user", "text": "long task"}),
            (lambda sent: any(e.get("type") == "assistant" for e in sent), {"type": "interrupt"}),
            (idle_count(1), {"type": "ping"}),
        ])
        with patch("app.claude_chat.asyncio.create_subprocess_exec", new=spawn):
            await claude_chat.handle_ws(ws)
        requests = [l for l in procs[0].stdin.lines if l.get("type") == "control_request"]
        self.assertEqual(requests[0]["request"], {"subtype": "interrupt"})
        self.assertTrue(procs[0].stdin.closed)
        self.assertFalse(claude_chat.RUNS)

    async def test_resume_replays_running_turn_after_history(self):
        procs = []

        async def spawn(*cmd, **kwargs):
            procs.append(FakeProcess(auto_finish=False))
            return procs[-1]

        first = Socket([
            (None, {"type": "resume", "session_id": SID}),
            (None, {"type": "user", "text": "keep going", "client_id": "c1"}),
            (lambda sent: any(e.get("type") == "assistant" for e in sent), {"type": "resume", "session_id": ""}),
        ])
        with patch("app.claude_chat.asyncio.create_subprocess_exec", new=spawn):
            await claude_chat.handle_ws(first)
            self.assertIn(SID, claude_chat.running_ids())
            # The CLI has written this turn's prompt by now; history must stop before it.
            with self.transcript.open("a") as fh:
                fh.write(json.dumps({"type": "user", "message": {"content": "keep going"}}) + "\n")
            second = Socket([
                (None, {"type": "resume", "session_id": SID}),
                (lambda sent: any(e.get("type") == "attached" for e in sent), {"type": "user", "text": "too soon"}),
                (lambda sent: any(e.get("type") == "status" and e.get("state") == "error" for e in sent),
                 {"type": "interrupt"}),
                (idle_count(1), {"type": "ping"}),
            ])
            await claude_chat.handle_ws(second)
        kinds = [e.get("type") for e in second.sent]
        history = second.sent[kinds.index("history")]
        self.assertEqual([m["parts"][0]["text"] for m in history["messages"]], ["earlier prompt"])
        self.assertLess(kinds.index("history"), kinds.index("turn_start"))
        self.assertLess(kinds.index("turn_start"), kinds.index("attached"))
        self.assertEqual(second.sent[kinds.index("turn_start")]["client_id"], "c1")
        self.assertTrue(second.sent[kinds.index("attached")]["running"])
        self.assertEqual(len(procs), 1, "a second turn must not start while one runs")

    async def test_bash_mode_runs_command_and_reports_exit_code(self):
        ws = Socket([
            (None, {"type": "bash", "command": "echo hi; echo oops >&2; exit 3", "client_id": "b1"}),
            (lambda sent: any(e.get("type") == "bash_result" for e in sent), {"type": "ping"}),
        ])
        with patch.object(claude_workspace, "cwd", return_value=Path(self.temp.name)):
            await claude_chat.handle_ws(ws)
        result = next(e for e in ws.sent if e.get("type") == "bash_result")
        self.assertEqual((result["stdout"], result["stderr"], result["code"], result["client_id"]),
                         ("hi\n", "oops\n", 3, "b1"))


class FolderTest(HarnessBase):
    def setUp(self):
        super().setUp()
        self.folder = Path(self.temp.name) / "project"
        self.folder.mkdir()
        self.calls = []

    async def spawn(self, *cmd, **kwargs):
        self.calls.append((cmd, kwargs))
        return FakeProcess()

    async def test_new_chat_runs_in_its_folder_and_lock_adds_sandbox_and_guard(self):
        ws = Socket([
            (None, {"type": "resume", "session_id": ""}),
            (None, {"type": "user", "text": "hi", "cwd": str(self.folder), "locked": True}),
            (idle_count(1), {"type": "user", "text": "again", "locked": False}),
            (idle_count(2), {"type": "ping"}),
        ])
        with patch("app.claude_chat.asyncio.create_subprocess_exec", new=self.spawn), \
                patch.object(claude_workspace, "sandbox_missing", return_value=[]):
            await claude_chat.handle_ws(ws)
        (first, first_kw), (second, second_kw) = self.calls
        self.assertEqual((first_kw["cwd"], second_kw["cwd"]), (self.folder, self.folder))
        settings = json.loads(first[first.index("--settings") + 1])
        self.assertTrue(settings["sandbox"]["enabled"])
        self.assertFalse(settings["sandbox"]["allowUnsandboxedCommands"])
        hook = settings["hooks"]["PreToolUse"][0]
        self.assertEqual(hook["matcher"], "Edit|Write|MultiEdit|NotebookEdit")
        self.assertIn(str(self.folder), hook["hooks"][0]["command"])
        self.assertNotIn("--settings", second, "unlocking applies from the next message")
        self.assertEqual(claude_sessions.get_session_binding(SID)["cwd"], str(self.folder))
        starts = [e for e in ws.sent if e.get("type") == "turn_start"]
        self.assertEqual([(s["cwd"], s["locked"]) for s in starts], [(str(self.folder), True), (str(self.folder), False)])

    async def test_existing_session_keeps_its_folder(self):
        claude_sessions.set_session_binding(SID, "opus", None, None, str(self.folder), False)
        other = Path(self.temp.name) / "other"
        other.mkdir()
        ws = Socket([
            (None, {"type": "resume", "session_id": SID}),
            (None, {"type": "user", "text": "elsewhere", "cwd": str(other)}),
            (lambda sent: any(e.get("state") == "error" for e in sent), {"type": "user", "text": "here"}),
            (idle_count(1), {"type": "ping"}),
        ])
        with patch("app.claude_chat.asyncio.create_subprocess_exec", new=self.spawn):
            await claude_chat.handle_ws(ws)
        error = next(e["msg"] for e in ws.sent if e.get("state") == "error")
        self.assertIn("Start a new chat", error)
        self.assertEqual([kw["cwd"] for _, kw in self.calls], [self.folder])

    async def test_lock_without_sandbox_tools_explains_what_to_install(self):
        ws = Socket([
            (None, {"type": "user", "text": "hi", "cwd": str(self.folder), "locked": True}),
            (idle_count(1), {"type": "ping"}),
        ])
        with patch("app.claude_chat.asyncio.create_subprocess_exec", new=self.spawn), \
                patch.object(claude_workspace, "sandbox_missing", return_value=["socat"]):
            await claude_chat.handle_ws(ws)
        self.assertFalse(self.calls)
        errors = [e["error"] for e in ws.sent if e.get("type") == "assistant" and e.get("error")]
        self.assertIn("sudo apt install bubblewrap socat", errors[0])


FIVE_HOUR_RESET = "2026-10-28T12:20:00.012493+00:00"
USAGE_ANSWER = {
    "subscription_type": "pro", "rate_limits_available": True,
    "rate_limits": {
        "five_hour": {"utilization": 67, "resets_at": FIVE_HOUR_RESET},
        "limits": [
            {"kind": "session", "group": "session", "percent": 67, "severity": "normal",
             "resets_at": FIVE_HOUR_RESET, "scope": None, "is_active": True},
            {"kind": "weekly_all", "group": "weekly", "percent": 37, "severity": "normal",
             "resets_at": "2026-11-02T12:00:00+00:00", "scope": None, "is_active": False},
            {"kind": "weekly_scoped", "group": "weekly", "percent": 81, "severity": "warning",
             "resets_at": None, "scope": {"model": {"display_name": "Fable"}}, "is_active": False},
        ],
    },
}


class ControlProcess:
    """A CLI that answers each control request with `answer` (or an error)."""

    def __init__(self, answer, ok=True):
        self.answer, self.ok, self.requests = answer, ok, []
        self.stdin, self.stdout, self.returncode = self, asyncio.StreamReader(), None

    def write(self, data):
        request = json.loads(data)
        self.requests.append(request)
        response = ({"subtype": "success", "request_id": request["request_id"], "response": self.answer} if self.ok
                    else {"subtype": "error", "request_id": request["request_id"], "error": "endpoint down"})
        self.stdout.feed_data((json.dumps({"type": "control_response", "response": response}) + "\n").encode())

    async def drain(self):
        pass

    def kill(self):
        self.returncode = -9
        self.stdout.feed_eof()

    async def wait(self):
        return self.returncode


class LimitedProcess(FakeProcess):
    """A turn whose API response carried the plan-limit headers."""

    def __init__(self):
        super().__init__(auto_finish=False)
        self.feed({"type": "rate_limit_event", "rate_limit_info": {"status": "allowed", "unifiedWindows": {
            "five_hour": {"utilization": 0.42, "resetsAt": 1793190000, "status": "allowed_warning"},
            "seven_day": {"utilization": 0.1, "resetsAt": 1793600000}}}})
        self.finish("success")


class PlanLimitsTest(HarnessBase):
    def setUp(self):
        super().setUp()
        p = patch.dict(claude_chat._limits, {"data": None, "at": 0.0, "stale": False, "error": None})
        p.start()
        self.addCleanup(p.stop)
        self.calls = []

    def spawner(self, answer, ok=True):
        async def spawn(*cmd, **kwargs):
            self.calls.append((cmd, kwargs, ControlProcess(answer, ok)))
            return self.calls[-1][2]
        return spawn

    async def test_get_usage_becomes_windows_shared_by_every_page(self):
        with patch("app.claude_chat.asyncio.create_subprocess_exec", new=self.spawner(USAGE_ANSWER)):
            first = await claude_chat.plan_limits()
            self.assertEqual(await claude_chat.plan_limits(), first)
            await claude_chat.plan_limits(refresh=True)  # too soon even for a refresh
            self.assertEqual(len(self.calls), 1)
            claude_chat._limits["at"] -= claude_chat.LIMITS_TTL
            await claude_chat.plan_limits()
            self.assertEqual(len(self.calls), 2)
        cmd, kwargs, proc = self.calls[0]
        self.assertEqual(proc.requests[0]["request"], {"subtype": "get_usage", "skip_behaviors": True})
        self.assertIn("--no-session-persistence", cmd)
        self.assertNotIn("router", json.dumps(kwargs["env"]), "always the official login, never a provider")
        self.assertTrue(first["available"])
        self.assertEqual(first["subscription"], "pro")
        self.assertIsNone(first["error"])
        self.assertEqual([(w["key"], w["label"], w["percent"], w["severity"]) for w in first["windows"]], [
            ("five_hour", "5-hour", 67.0, "normal"), ("seven_day", "Weekly", 37.0, "normal"),
            ("weekly_scoped:Fable", "Weekly · Fable", 81.0, "warning")])
        self.assertEqual(first["windows"][0]["resets_at"], 1793190000)
        self.assertTrue(first["windows"][0]["active"])

    async def test_api_key_login_has_no_plan_limits(self):
        answer = {"subscription_type": None, "rate_limits_available": False, "rate_limits": None}
        with patch("app.claude_chat.asyncio.create_subprocess_exec", new=self.spawner(answer)):
            limits = await claude_chat.plan_limits()
        self.assertEqual((limits["available"], limits["windows"], limits["error"]), (False, [], None))

    async def test_failed_probe_keeps_the_last_answer_and_says_why(self):
        with patch("app.claude_chat.asyncio.create_subprocess_exec", new=self.spawner(USAGE_ANSWER)):
            good = await claude_chat.plan_limits()
        claude_chat._limits["at"] = 0.0
        with patch("app.claude_chat.asyncio.create_subprocess_exec", new=self.spawner(None, ok=False)):
            limits = await claude_chat.plan_limits()
        self.assertEqual(limits["windows"], good["windows"])
        self.assertEqual(limits["fetched_at"], good["fetched_at"])
        self.assertIn("endpoint down", limits["error"])

    async def test_official_turn_moves_the_limits_live_and_custom_turn_does_not(self):
        async def spawn(*cmd, **kwargs):
            return LimitedProcess()

        ws = Socket([
            (None, {"type": "resume", "session_id": SID}),
            (None, {"type": "user", "text": "official", "model": "opus", "provider_id": None}),
            (idle_count(1), {"type": "user", "text": "custom", "model": "gemini-x", "provider_id": self.pid}),
            (idle_count(2), {"type": "ping"}),
        ])
        with patch("app.claude_chat.asyncio.create_subprocess_exec", new=spawn):
            await claude_chat.handle_ws(ws)
        pushed = [e for e in ws.sent if e.get("type") == "plan_limits"]
        self.assertEqual(len(pushed), 1)
        self.assertEqual([(w["key"], w["percent"], w["resets_at"], w["severity"]) for w in pushed[0]["windows"]],
                         [("five_hour", 42.0, 1793190000, "warning"), ("seven_day", 10.0, 1793600000, "normal")])
        self.assertTrue(claude_chat._limits["stale"], "the next read asks Claude Code for the scoped rows")


class FolderGuardTest(unittest.TestCase):
    def test_refuses_writes_that_resolve_outside_the_folder(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "proj"
            (root / "sub").mkdir(parents=True)
            (root / "link").symlink_to(tmp)

            def decide(path):
                return folder_guard.decide({"tool_name": "Write", "tool_input": {"file_path": path}, "cwd": str(root)},
                                           [str(root)])

            self.assertIsNone(decide(f"{root}/a.txt"))
            self.assertIsNone(decide("sub/b.txt"))
            self.assertIsNone(decide(f"{root}/sub/../c.txt"))
            for outside in (f"{tmp}/x.txt", f"{root}/../x.txt", f"{root}/link/x.txt", f"{root}X/a.txt"):
                self.assertIn("locked", decide(outside), outside)
            self.assertIsNotNone(folder_guard.decide({"tool_input": {}}, [str(root)]))


class UsageTest(unittest.TestCase):
    def test_official_cost_comes_from_the_cli_and_custom_models_are_priced_here(self):
        summary = claude_transcript.usage_summary({
            "claude-sonnet-5-5": {"inputTokens": 4, "outputTokens": 14, "cacheReadInputTokens": 21959,
                                  "cacheCreationInputTokens": 24524, "costUSD": 0.1004},
            "ag/gemini-3.8-flash-low": {"inputTokens": 1_000_000, "outputTokens": 0, "costUSD": 4.0},
        })
        models = {m["model"]: m for m in summary["models"]}
        self.assertEqual((models["claude-sonnet-5-5"]["cost_usd"], models["claude-sonnet-5-5"]["estimated"]), (0.1004, False))
        self.assertEqual((models["ag/gemini-3.8-flash-low"]["cost_usd"], models["ag/gemini-3.8-flash-low"]["estimated"]), (0.075, True))
        self.assertEqual(summary["cache_creation_input_tokens"], 24524)
        self.assertAlmostEqual(summary["total_cost_usd"], 0.1754)
        self.assertTrue(summary["estimated"])
        self.assertTrue(claude_transcript.usage_summary({"claude-opus-5-5": {"input_tokens": 5}})["unpriced"])

    def test_thread_prefers_the_cli_cost_state(self):
        thread = claude_transcript.Thread()
        thread.add({"type": "assistant", "message": {"id": "m1", "model": "gemini-n", "usage": {"input_tokens": 10, "cache_read_input_tokens": 90},
                                                     "content": [{"type": "text", "text": "hi"}]}})
        self.assertEqual((thread.usage["input_tokens"], thread.usage["context_tokens"]), (10, 100))
        thread.add({"type": "cost-state", "modelUsage": {"ag/gemini-3.8-flash-low": {"inputTokens": 12, "outputTokens": 3}}})
        self.assertEqual([m["model"] for m in thread.usage["models"]], ["ag/gemini-3.8-flash-low"])
        self.assertEqual(thread.usage["context_tokens"], 100)


class TranscriptTest(unittest.TestCase):
    def test_commands_bash_tools_meta_and_titles(self):
        lines = [
            {"type": "user", "isMeta": True, "message": {"content": "<local-command-caveat>x</local-command-caveat>"}},
            {"type": "user", "message": {"content": "<command-name>/context</command-name><command-message>context</command-message><command-args>full</command-args>"}},
            {"type": "user", "message": {"content": "<local-command-stdout>\u001b[1m42k tokens\u001b[0m</local-command-stdout>"}},
            {"type": "user", "message": {"content": "<bash-input>ls</bash-input>"}},
            {"type": "user", "message": {"content": "<bash-stdout>a.txt</bash-stdout><bash-stderr></bash-stderr>"}},
            {"type": "assistant", "message": {"id": "m1", "model": "claude-opus-5-5", "usage": {"input_tokens": 5, "output_tokens": 2},
                                              "content": [{"type": "thinking", "thinking": "hmm", "signature": "s"}]}},
            {"type": "assistant", "message": {"id": "m1", "model": "claude-opus-5-5", "usage": {"input_tokens": 5, "output_tokens": 2},
                                              "content": [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "pwd"}}]}},
            {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "content": "/home"}]}},
            {"type": "assistant", "message": {"id": "m2", "model": "gemini-x", "content": [{"type": "text", "text": "done"}]}},
            {"type": "custom-title", "customTitle": "Renamed"},
        ]
        thread = claude_transcript.Thread()
        for line in lines:
            thread.add(line)
        roles = [(m["role"], [p["kind"] for p in m["parts"]]) for m in thread.messages]
        self.assertEqual(roles, [("user", ["command"]), ("assistant", ["command_output"]), ("user", ["bash"]),
                                 ("assistant", ["thinking", "tool"]), ("assistant", ["text"])])
        self.assertEqual(thread.messages[0]["parts"][0], {"kind": "command", "name": "/context", "args": "full"})
        self.assertEqual(thread.messages[1]["parts"][0]["text"], "42k tokens")
        self.assertEqual(thread.messages[2]["parts"][0]["stdout"], "a.txt")
        tool = thread.messages[3]["parts"][1]
        self.assertEqual((tool["summary"], tool["output"], tool["done"]), ("pwd", "/home", True))
        self.assertEqual([m.get("model") for m in thread.messages[3:]], ["claude-opus-5-5", "gemini-x"])
        self.assertEqual(thread.usage["input_tokens"], 5, "usage is counted once per API message")
        self.assertEqual(thread.custom_title, "Renamed")
        self.assertEqual(claude_transcript.first_prompt_title(lines[1]["message"]["content"]), "/context full")

    def test_interrupt_placeholder_is_hidden(self):
        thread = claude_transcript.Thread()
        thread.add({"type": "user", "message": {"content": [{"type": "text", "text": "[Request interrupted by user]"}]}})
        thread.add({"type": "assistant", "message": {"model": "<synthetic>",
                                                     "content": [{"type": "text", "text": "No response requested."}]}})
        thread.add({"type": "assistant", "message": {"model": "<synthetic>", "content": [{"type": "text", "text": "Context: 42k"}]}})
        self.assertEqual([(m["role"], m.get("model"), [p["kind"] for p in m["parts"]]) for m in thread.messages],
                         [("system", None, ["notice"]), ("assistant", "local", ["text"])])


class WorkspaceTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for target, value in (("cwd", self.root), ("home", self.root / "home")):
            p = patch.object(claude_workspace, target, return_value=value)
            p.start()
            self.addCleanup(p.stop)

    def test_memory_note_appends_bullet_and_rejects_unknown_scope(self):
        (self.root / "CLAUDE.md").write_text("# Notes")
        claude_workspace.append_memory("project", "  use   pnpm ")
        claude_workspace.append_memory("user", "prefer short answers")
        self.assertEqual((self.root / "CLAUDE.md").read_text(), "# Notes\n- use pnpm\n")
        self.assertEqual((self.root / "home/.claude/CLAUDE.md").read_text(), "- prefer short answers\n")
        with self.assertRaises(ValueError):
            claude_workspace.append_memory("../etc", "x")

    def test_file_search_lists_folders_and_matches_paths(self):
        (self.root / "app/src/pages").mkdir(parents=True)
        (self.root / "app/src/pages/Claude.tsx").write_text("")
        (self.root / "node_modules/x").mkdir(parents=True)
        (self.root / "node_modules/x/Claude.tsx").write_text("")
        self.assertEqual(claude_workspace.search_files("app/s"), [{"path": "app/src/", "dir": True}])
        self.assertEqual([r["path"] for r in claude_workspace.search_files("claude")], ["app/src/pages/Claude.tsx"])
        self.assertEqual([r["path"] for r in claude_workspace.search_files("pages/Cla")], ["app/src/pages/Claude.tsx"])


if __name__ == "__main__":
    unittest.main()
