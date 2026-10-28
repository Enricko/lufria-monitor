"""Routing/session metadata regressions; subprocess I/O is the only fake."""
import asyncio
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from app import claude_chat, claude_sessions, providers

SID = "12345678-1234-1234-1234-123456789abc"


class FakeInput:
    def __init__(self):
        self.lines = []
        self.closed = False
    def write(self, data):
        self.data = data
        self.lines.append(data)
    async def drain(self):
        pass
    def close(self):
        self.closed = True
    def is_closing(self):
        return self.closed


class FakeProcess:
    def __init__(self):
        self.stdin = FakeInput()
        self.stdout = asyncio.StreamReader()
        self.stdout.feed_data((json.dumps({"type": "system", "subtype": "init", "session_id": SID, "model": "cli-reported-model"}) + "\n").encode())
        self.stdout.feed_eof()
        self.returncode = 0
    async def wait(self):
        return 0
    def kill(self):
        pass


class ClaudeRoutingTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.registry = providers.ProviderRegistry(root / "providers.json", builtins=[])
        self.pid = self.registry.create(name="Selected", base_url="https://selected.test/v1", api_key="selected-key")["id"]
        for obj, attr, value in ((providers, "_registry", self.registry),
                                 (claude_sessions, "BINDINGS_FILE", root / "bindings.json"),
                                 (claude_sessions, "SESSIONS_DIR", root / "sessions"),
                                 (claude_sessions, "HISTORY_FILE", root / "history.jsonl")):
            p = patch.object(obj, attr, value, create=True)
            p.start()
            self.addCleanup(p.stop)
        claude_sessions.SESSIONS_DIR.mkdir()
        (claude_sessions.SESSIONS_DIR / f"{SID}.jsonl").write_text(json.dumps({"type": "assistant", "message": {"model": "cli-reported-model", "content": "hello"}}) + "\n")

    async def test_explicit_claude_model_routes_exact_and_binding_is_saved_before_init_forward(self):
        async def send(raw):
            if json.loads(raw).get("subtype") == "init":
                self.assertEqual(claude_sessions.get_session_binding(SID)["provider_id"], self.pid)
        with patch("app.claude_chat.asyncio.create_subprocess_exec", new=AsyncMock(return_value=FakeProcess())) as spawn:
            sid, _ = await claude_chat._run_turn("hello", [], None, "claude-custom", send, provider_id=self.pid)
        self.assertEqual(sid, SID)
        self.assertIn("claude-custom", spawn.call_args.args)
        self.assertEqual(spawn.call_args.kwargs["env"]["ANTHROPIC_BASE_URL"], "https://selected.test")
        self.assertEqual(spawn.call_args.kwargs["env"]["ANTHROPIC_API_KEY"], "selected-key")
        for result in (claude_sessions.list_sessions()[0], claude_sessions.get_session(SID)):
            self.assertEqual((result["model"], result["provider_id"], result["provider"]), ("claude-custom", self.pid, "Selected"))
        self.assertEqual(stat.S_IMODE(claude_sessions.BINDINGS_FILE.stat().st_mode), 0o600)
        self.assertNotIn("selected-key", claude_sessions.BINDINGS_FILE.read_text())

    async def test_explicit_provider_preserves_native_looking_default_raw_model_ids(self):
        for model in ("default", "claude-default"):
            with patch("app.claude_chat.asyncio.create_subprocess_exec", new=AsyncMock(return_value=FakeProcess())) as spawn:
                await claude_chat._run_turn("hello", [], None, model, AsyncMock(), provider_id=self.pid)
            self.assertIn(model, spawn.call_args.args)
            self.assertEqual(claude_sessions.get_session_binding(SID)["model"], model)
            self.assertEqual(claude_sessions.get_session_binding(SID)["provider_id"], self.pid)

    async def test_invalid_or_disabled_explicit_provider_does_not_spawn_native_fallback(self):
        for pid in ("invalid", self.pid):
            self.registry.update(self.pid, enabled=False)
            with patch("app.claude_chat.asyncio.create_subprocess_exec", new=AsyncMock()) as spawn:
                with self.assertRaises(providers.ProviderError):
                    await claude_chat._run_turn("hello", [], None, "claude-custom", AsyncMock(), provider_id=pid)
                spawn.assert_not_called()

    async def test_no_auth_provider_clears_inherited_anthropic_credentials_but_keeps_route(self):
        pid = self.registry.create(name="No Auth", base_url="http://127.0.0.1:9999/v1")["id"]
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "wrong", "ANTHROPIC_AUTH_TOKEN": "wrong", "ANTHROPIC_BASE_URL": "https://wrong"}), patch("app.claude_chat.asyncio.create_subprocess_exec", new=AsyncMock(return_value=FakeProcess())) as spawn:
            await claude_chat._run_turn("hello", [], None, "claude-custom", AsyncMock(), provider_id=pid)
        env = spawn.call_args.kwargs["env"]
        self.assertEqual(env["ANTHROPIC_BASE_URL"], "http://127.0.0.1:9999")
        self.assertEqual(env.get("ANTHROPIC_API_KEY"), "monitor-no-auth")
        self.assertFalse(env.get("ANTHROPIC_AUTH_TOKEN"))
        self.assertEqual(claude_sessions.get_session_binding(SID)["provider_id"], pid)

    async def test_websocket_resume_restores_binding_explicit_change_wins_and_empty_resets(self):
        claude_sessions.set_session_binding(SID, "claude-saved", self.pid, "Selected")
        ws_messages = [
            {"type": "resume", "session_id": SID},
            {"type": "user", "text": "saved"},
            {"type": "user", "text": "changed", "model": "claude-new", "provider_id": None},
            {"type": "user", "text": "still changed"},
            {"type": "resume", "session_id": ""},
            {"type": "user", "text": "new chat"},
        ]
        calls = []
        bindings = []
        idle = asyncio.Event()
        idle.set()
        class WebSocket:
            async def accept(self):
                pass
            async def send_text(self, raw):
                event = json.loads(raw)
                if event.get("subtype") == "init":
                    bindings.append(claude_sessions.get_session_binding(SID))
                if event.get("type") == "status" and event.get("state") == "idle":
                    idle.set()
            async def receive_text(self):
                await asyncio.wait_for(idle.wait(), timeout=5)
                if ws_messages:
                    message = ws_messages.pop(0)
                    if message["type"] == "user":
                        idle.clear()
                    return json.dumps(message)
                raise claude_chat.WebSocketDisconnect()
        async def spawn(*cmd, **kwargs):
            calls.append((cmd, kwargs["env"]))
            return FakeProcess()
        with patch("app.claude_chat.asyncio.create_subprocess_exec", new=spawn):
            await claude_chat.handle_ws(WebSocket())
        self.assertEqual(len(calls), 4)
        self.assertEqual([cmd[cmd.index("--model") + 1] if "--model" in cmd else None for cmd, env in calls],
                         ["claude-saved", "claude-new", "claude-new", None])
        self.assertEqual([cmd[cmd.index("--resume") + 1] if "--resume" in cmd else None for cmd, env in calls],
                         [SID, SID, SID, None])
        self.assertEqual(calls[0][1]["ANTHROPIC_BASE_URL"], "https://selected.test")
        self.assertEqual([binding["provider_id"] for binding in bindings], [self.pid, None, None, None])
        self.assertEqual([binding["model"] for binding in bindings], ["claude-saved", "claude-new", "claude-new", "cli-reported-model"])

    async def test_provider_errors_cannot_echo_selected_credential_to_client(self):
        proc=FakeProcess()
        proc.stdout=asyncio.StreamReader()
        proc.stdout.feed_data((json.dumps({"type":"assistant","error":"upstream echoed selected-key","message":{"content":[{"type":"text","text":"selected-key"}]}})+"\n").encode())
        proc.stdout.feed_eof()
        sent=[]
        async def send(raw):sent.append(raw)
        with patch("app.claude_chat.asyncio.create_subprocess_exec",new=AsyncMock(return_value=proc)):
            await claude_chat._run_turn("hello",[],None,"custom-model",send,provider_id=self.pid)
        self.assertTrue(sent)
        self.assertNotIn("selected-key","".join(sent))
        self.assertIn("[redacted]","".join(sent))

    async def test_sidecar_binding_update_and_delete_are_persistent(self):
        claude_sessions.set_session_binding(SID, "same", self.pid, "Selected")
        claude_sessions.set_session_binding(SID, "claude-native", None, None)
        self.assertEqual(claude_sessions.get_session(SID)["model"], "claude-native")
        self.assertIsNone(claude_sessions.list_sessions()[0]["provider_id"])
        claude_sessions.delete_session(SID)
        self.assertIsNone(claude_sessions.get_session_binding(SID))


if __name__ == "__main__":
    unittest.main()
