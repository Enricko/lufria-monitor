"""Claude Code transcript (.jsonl) -> structured chat thread for the dashboard.

The page never renders HTML from transcripts: every message is a list of typed parts
(text, thinking, tool, command, command_output, bash, image, notice) that the frontend
draws itself. The same helpers summarise tool calls for the live stream.
"""
import json
import re
from pathlib import Path

from . import pricing

TOOL_OUTPUT_LIMIT = 20_000
_COMMAND_RE = re.compile(r"<command-name>\s*(.*?)\s*</command-name>", re.S)
_ARGS_RE = re.compile(r"<command-args>(.*?)</command-args>", re.S)
_TAG_RE = {tag: re.compile(rf"<{tag}>(.*?)</{tag}>", re.S)
           for tag in ("local-command-stdout", "local-command-stderr", "bash-input", "bash-stdout", "bash-stderr")}
_INTERRUPTED = ("[Request interrupted by user", "[Request interrupted")
NO_RESPONSE = "No response requested."


def tool_summary(name: str, inp) -> str:
    """One line describing a tool call, like the Claude Code terminal shows it."""
    if not isinstance(inp, dict):
        return str(inp)[:300]
    for key in ("command", "file_path", "notebook_path", "path", "pattern", "url", "query", "skill",
                "description", "prompt", "subject", "task_id", "message"):
        value = inp.get(key)
        if isinstance(value, str) and value.strip():
            first = value.strip().splitlines()[0]
            if key == "pattern" and isinstance(inp.get("path"), str):
                first += f"  in {inp['path']}"
            return first[:300]
    if name == "TodoWrite" and isinstance(inp.get("todos"), list):
        return f"{len(inp['todos'])} todos"
    if name == "ExitPlanMode":
        return "Plan ready for review"
    questions = _questions(inp) if name == "AskUserQuestion" else []
    if questions:
        first = questions[0]["question"].strip()
        return first.splitlines()[0][:300] if first else "Questions for you"
    text = json.dumps(inp, ensure_ascii=False)
    return text[:300]


def _questions(inp: dict) -> list[dict]:
    """AskUserQuestion's questions, reduced to what the page draws."""
    out = []
    for q in inp.get("questions") if isinstance(inp.get("questions"), list) else []:
        if not isinstance(q, dict) or not isinstance(q.get("question"), str):
            continue
        options = [{"label": str(o.get("label", ""))[:300], "description": str(o.get("description") or "")[:1000]}
                   for o in q.get("options") or [] if isinstance(o, dict)]
        out.append({"question": q["question"][:2000], "header": str(q.get("header") or "")[:60],
                    "multiSelect": q.get("multiSelect") is True, "options": options[:8]})
    return out[:8]


def question_answers(result) -> dict | None:
    """The answers an AskUserQuestion result recorded ({question: answer}), if any."""
    answers = result.get("answers") if isinstance(result, dict) else None
    if not isinstance(answers, dict):
        return None
    return {str(k)[:2000]: str(v)[:4000] for k, v in list(answers.items())[:20]}


def tool_part(block: dict) -> dict:
    name = str(block.get("name") or "Tool")
    inp = block.get("input") if isinstance(block.get("input"), dict) else {}
    part = {"kind": "tool", "id": str(block.get("id") or ""), "name": name,
            "summary": tool_summary(name, inp), "output": "", "is_error": False, "done": False}
    if name == "ExitPlanMode" and isinstance(inp.get("plan"), str):
        part["plan"] = inp["plan"][:TOOL_OUTPUT_LIMIT]
    if name == "AskUserQuestion" and _questions(inp):
        part["questions"] = _questions(inp)
    if name == "TodoWrite" and isinstance(inp.get("todos"), list):
        part["todos"] = [{"content": str(t.get("content", ""))[:300], "status": str(t.get("status", ""))}
                         for t in inp["todos"][:50] if isinstance(t, dict)]
    path = inp.get("file_path") or inp.get("notebook_path")
    if isinstance(path, str) and path.strip():
        part["path"] = path.strip()  # the page can open it in the file viewer
    if name in ("Edit", "Write", "MultiEdit") and isinstance(inp.get("file_path"), str):
        diff = _edit_preview(inp)
        if diff:
            part["diff"] = diff
    return part


def _edit_preview(inp: dict) -> str:
    """A small -/+ preview of an Edit/Write, enough to see what changed."""
    lines = []
    edits = inp.get("edits") if isinstance(inp.get("edits"), list) else [inp]
    for edit in edits[:5]:
        if not isinstance(edit, dict):
            continue
        old, new = edit.get("old_string"), edit.get("new_string", edit.get("content"))
        if isinstance(old, str):
            lines += [f"- {l}" for l in old.splitlines()[:40]]
        if isinstance(new, str):
            lines += [f"+ {l}" for l in new.splitlines()[:40]]
    return "\n".join(lines)[:8000]


def tool_result_text(content) -> str:
    if isinstance(content, list):
        out = []
        for item in content:
            if isinstance(item, dict):
                if item.get("type") == "text":
                    out.append(str(item.get("text", "")))
                elif item.get("type") == "image":
                    out.append("[image]")
            else:
                out.append(str(item))
        content = "\n".join(out)
    text = str(content or "")
    return text if len(text) <= TOOL_OUTPUT_LIMIT else text[:TOOL_OUTPUT_LIMIT] + "\n… (truncated)"


def parse_user_string(text: str) -> list[dict]:
    """User strings carry local commands, bash mode and their output as XML-ish tags."""
    parts: list[dict] = []
    m = _COMMAND_RE.search(text)
    if m and "<command-name>" in text:
        name = m.group(1).strip()
        args = _ARGS_RE.search(text)
        parts.append({"kind": "command", "name": name if name.startswith("/") else f"/{name}",
                      "args": args.group(1).strip() if args else ""})
        return parts
    for tag, kind in (("local-command-stdout", "command_output"), ("local-command-stderr", "command_output")):
        found = _TAG_RE[tag].search(text)
        if found:
            parts.append({"kind": kind, "text": _strip_ansi(found.group(1)).strip(), "is_error": tag.endswith("stderr")})
    if parts:
        return parts
    bash_in = _TAG_RE["bash-input"].findall(text)
    bash_out = _TAG_RE["bash-stdout"].findall(text)
    bash_err = _TAG_RE["bash-stderr"].findall(text)
    if bash_in or bash_out or bash_err:
        for i in range(max(len(bash_in), len(bash_out), len(bash_err))):
            parts.append({"kind": "bash",
                          "command": bash_in[i] if i < len(bash_in) else None,
                          "stdout": _strip_ansi(bash_out[i]) if i < len(bash_out) else None,
                          "stderr": _strip_ansi(bash_err[i]) if i < len(bash_err) else None})
        rest = re.sub(r"<(bash-input|bash-stdout|bash-stderr)>.*?</\1>", "", text, flags=re.S).strip()
        if rest:
            parts.append({"kind": "text", "text": rest})
        return parts
    if text.startswith(_INTERRUPTED):
        return [{"kind": "notice", "text": "Interrupted by user", "level": "warn"}]
    return [{"kind": "text", "text": text}] if text.strip() else []


def _strip_ansi(text: str) -> str:
    return re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)", "", text)


TOKEN_KEYS = ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")
_CLI_KEYS = dict(zip(TOKEN_KEYS, ("inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens")))


def usage_summary(per_model: dict[str, dict], context_tokens: int = 0) -> dict:
    """Session or turn usage from per-model counts (CLI camelCase or our snake_case), with a cost.

    Official Claude models keep the CLI's own costUSD; anything else (custom providers) is priced from
    pricing.py, because the CLI only guesses for models it doesn't know.
    """
    models = []
    for name, raw in per_model.items():
        if not isinstance(raw, dict):
            continue
        counts = {key: int(raw.get(key, raw.get(_CLI_KEYS[key])) or 0) for key in TOKEN_KEYS}
        cli_cost = raw.get("costUSD")
        if pricing.cli_knows_price(name):
            # Without a cost-state (older sessions) an official model's price is unknown here.
            cost, estimated = (None if cli_cost is None else float(cli_cost)), False
        else:
            cost, estimated = pricing.estimate_cost_usd(name, counts["input_tokens"], counts["output_tokens"],
                                                        counts["cache_read_input_tokens"],
                                                        counts["cache_creation_input_tokens"]), True
        models.append({"model": name, **counts, "cost_usd": None if cost is None else round(cost, 6), "estimated": estimated})
    out = {key: sum(m[key] for m in models) for key in TOKEN_KEYS}
    return {**out, "total_cost_usd": round(sum(m["cost_usd"] or 0 for m in models), 6),
            "estimated": any(m["estimated"] for m in models), "unpriced": any(m["cost_usd"] is None for m in models),
            "context_tokens": context_tokens, "models": models}


def _is_no_response(content) -> bool:
    texts = [content] if isinstance(content, str) else [
        b.get("text") for b in content if isinstance(b, dict) and b.get("type") == "text"] if isinstance(content, list) else []
    return bool(texts) and all(str(t).strip() == NO_RESPONSE for t in texts)


class Thread:
    """Incrementally folds transcript entries into chat messages."""

    def __init__(self):
        self.messages: list[dict] = []
        self.tools: dict[str, dict] = {}
        self.seen_usage: set[str] = set()
        self.model_tokens: dict[str, dict[str, int]] = {}  # main thread, per model: fallback without cost-state
        self.cost_state: dict | None = None  # the CLI's running per-model totals, subagents included
        self.context_tokens = 0
        self.title: str | None = None
        self.custom_title: str | None = None
        self.model: str | None = None

    @property
    def usage(self) -> dict:
        return usage_summary(self.cost_state if self.cost_state else self.model_tokens, self.context_tokens)

    def _push(self, role: str, parts: list[dict], ts=None, model=None) -> None:
        if not parts:
            return
        last = self.messages[-1] if self.messages else None
        # Bash output is written as its own user entry right after the command: join them.
        if role == "user" and last and last["role"] == "user" and parts[0]["kind"] == "bash" \
                and parts[0]["command"] is None and last["parts"] and last["parts"][-1]["kind"] == "bash":
            prev = last["parts"][-1]
            prev["stdout"] = parts[0]["stdout"] if parts[0]["stdout"] is not None else prev["stdout"]
            prev["stderr"] = parts[0]["stderr"] if parts[0]["stderr"] is not None else prev["stderr"]
            parts = parts[1:]
            if not parts:
                return
        if role == "assistant" and last and last["role"] == "assistant" and last.get("model") == model:
            for part in parts:
                if part["kind"] == "text" and last["parts"] and last["parts"][-1]["kind"] == "text":
                    last["parts"][-1]["text"] += "\n\n" + part["text"]
                else:
                    last["parts"].append(part)
            return
        msg = {"role": role, "parts": parts, "ts": ts}
        if model:
            msg["model"] = model
        self.messages.append(msg)

    def add(self, obj: dict) -> None:
        t = obj.get("type")
        ts = obj.get("timestamp")
        if t == "custom-title":
            self.custom_title = str(obj.get("customTitle") or "")[:80] or self.custom_title
        elif t == "ai-title":
            self.title = str(obj.get("aiTitle") or "")[:80] or self.title
        elif t == "cost-state":
            if isinstance(obj.get("modelUsage"), dict):
                self.cost_state = obj["modelUsage"]
        elif t == "system":
            self._system(obj, ts)
        elif t == "user" and not obj.get("isSidechain"):
            self._user(obj, ts)
        elif t == "assistant" and not obj.get("isSidechain"):
            self._assistant(obj, ts)

    def _system(self, obj, ts):
        sub = obj.get("subtype")
        if sub == "compact_boundary":
            self._push("system", [{"kind": "notice", "text": "Conversation compacted", "level": "info"}], ts)
        elif sub == "api_error":
            err = obj.get("error") or {}
            text = (err.get("formatted") or err.get("message") or "API error") if isinstance(err, dict) else str(err)
            self._push("system", [{"kind": "notice", "text": str(text)[:500], "level": "error"}], ts)
        elif sub in ("informational", "model_refusal_fallback") and obj.get("content"):
            self._push("system", [{"kind": "notice", "text": str(obj["content"])[:500], "level": "warn"}], ts)
        elif sub == "local_command" and isinstance(obj.get("content"), str):
            parts = parse_user_string(obj["content"])
            output = [p for p in parts if p["kind"] == "command_output"]
            if output:
                self._push("assistant", output, ts, model="local")
            else:
                self._push("user", parts, ts)

    def _user(self, obj, ts):
        msg = obj.get("message") or {}
        content = msg.get("content", "")
        if obj.get("isCompactSummary"):
            text = content if isinstance(content, str) else "".join(
                b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
            self._push("system", [{"kind": "notice", "text": "Conversation compacted", "level": "info",
                                   "detail": text[:TOOL_OUTPUT_LIMIT]}], ts)
            return
        if obj.get("isMeta"):
            return
        if isinstance(content, str):
            parts = parse_user_string(content)
            output = [p for p in parts if p["kind"] == "command_output"]
            if output:
                self._push("assistant", output, ts, model="local")
                return
            notice = [p for p in parts if p["kind"] == "notice"]
            self._push("system" if notice and len(parts) == 1 else "user", parts, ts)
            return
        if not isinstance(content, list):
            return
        parts = []
        for block in content:
            if not isinstance(block, dict):
                continue
            kind = block.get("type")
            if kind == "tool_result":
                tool = self.tools.get(str(block.get("tool_use_id", "")))
                if tool is not None:
                    tool["output"] = tool_result_text(block.get("content"))
                    tool["is_error"] = bool(block.get("is_error"))
                    tool["done"] = True
                    answers = question_answers(obj.get("toolUseResult")) if tool["name"] == "AskUserQuestion" else None
                    if answers is not None:
                        tool["answers"] = answers
            elif kind == "text":
                parts += parse_user_string(str(block.get("text", "")))
            elif kind == "image":
                parts.append({"kind": "image"})
        output = [p for p in parts if p["kind"] == "command_output"]
        if output:
            self._push("assistant", output, ts, model="local")
            parts = [p for p in parts if p["kind"] != "command_output"]
        if parts:
            notice_only = all(p["kind"] == "notice" for p in parts)
            self._push("system" if notice_only else "user", parts, ts)

    def _assistant(self, obj, ts):
        msg = obj.get("message") or {}
        model = msg.get("model") or None
        if model == "<synthetic>":
            if _is_no_response(msg.get("content")):
                return  # the CLI's placeholder after an interrupt; the TUI doesn't show it either
            model = "local"
        elif model:
            self.model = model
        usage = msg.get("usage") or {}
        mid = msg.get("id")
        if usage and mid and mid not in self.seen_usage and model != "local":
            # Claude Code writes one line per content block, all carrying the same usage.
            self.seen_usage.add(mid)
            counts = {key: int(usage.get(key) or 0) for key in TOKEN_KEYS}
            total = self.model_tokens.setdefault(model or "unknown", dict.fromkeys(TOKEN_KEYS, 0))
            for key, n in counts.items():
                total[key] += n
            self.context_tokens = counts["input_tokens"] + counts["cache_read_input_tokens"] + counts["cache_creation_input_tokens"]
        parts = []
        content = msg.get("content", [])
        if isinstance(content, str):
            content = [{"type": "text", "text": content}]
        for block in content if isinstance(content, list) else []:
            if not isinstance(block, dict):
                continue
            kind = block.get("type")
            if kind == "text" and str(block.get("text", "")).strip():
                part = {"kind": "text", "text": str(block["text"])}
                if obj.get("isApiErrorMessage") or obj.get("error"):
                    part["is_error"] = True
                parts.append(part)
            elif kind == "thinking" and str(block.get("thinking", "")).strip():
                parts.append({"kind": "thinking", "text": str(block["thinking"])[:TOOL_OUTPUT_LIMIT]})
            elif kind == "tool_use":
                part = tool_part(block)
                self.tools[part["id"]] = part
                parts.append(part)
        self._push("assistant", parts, ts, model=model)


def read_thread(path: Path, max_bytes: int | None = None) -> Thread:
    """Fold a transcript; max_bytes stops at the size it had when a running turn began."""
    thread = Thread()
    read = 0
    with path.open("rb") as fh:
        for raw in fh:
            read += len(raw)
            if max_bytes is not None and read > max_bytes:
                break
            try:
                obj = json.loads(raw)
            except (ValueError, UnicodeDecodeError):
                continue
            if isinstance(obj, dict):
                thread.add(obj)
    return thread


def first_prompt_title(content) -> str | None:
    """Sidebar title from a user entry: '/cmd args' for commands, else the text."""
    if isinstance(content, list):
        content = next((b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"), "")
    if not isinstance(content, str) or not content.strip():
        return None
    parts = parse_user_string(content)
    if not parts:
        return None
    first = parts[0]
    if first["kind"] == "command":
        return f"{first['name']} {first['args']}".strip()[:60]
    if first["kind"] == "bash":
        return f"! {first['command'] or ''}".strip()[:60]
    if first["kind"] == "text":
        return first["text"].strip().splitlines()[0][:60] if first["text"].strip() else None
    return None
