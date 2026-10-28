"""Live usage analytics: one event per request, incremental reads, cost split from the CLI's per-model totals."""
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from app import claude_analytics, claude_sessions, db

SID = "12345678-1234-1234-1234-123456789abc"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _msg(mid: str, model: str, **usage) -> str:
    u = {"input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0, **usage}
    return json.dumps({"type": "assistant", "timestamp": _now(), "message": {"id": mid, "model": model, "usage": u}}) + "\n"


def _cost_state(models: dict) -> str:
    return json.dumps({"type": "cost-state", "modelUsage": models}) + "\n"


def _usage(inp=0, out=0, cost=0.0) -> dict:
    return {"inputTokens": inp, "outputTokens": out, "cacheReadInputTokens": 0, "cacheCreationInputTokens": 0, "costUSD": cost}


class AnalyticsTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: [p.unlink() for p in self.dir.iterdir()] and self.dir.rmdir())
        self.path = self.dir / f"{SID}.jsonl"
        claude_analytics._files.clear()
        self.addCleanup(claude_analytics._files.clear)
        for target, value in ((claude_sessions, "_transcripts"), (db, "get_settings")):
            original = getattr(target, value)
            self.addCleanup(setattr, target, value, original)
        claude_sessions._transcripts = lambda: [self.path]
        db.get_settings = lambda: {"timezone": "Asia/Jakarta"}

    def write(self, text: str, mode: str = "w") -> None:
        with self.path.open(mode) as fh:
            fh.write(text)

    def test_requests_tokens_and_cost_follow_the_cli_totals(self):
        self.write(
            _msg("a", "claude-opus-5-5", input_tokens=10, output_tokens=20)
            + _msg("b", "claude-sonnet-5-5", input_tokens=1, output_tokens=3)
            + _msg("b", "claude-sonnet-5-5", input_tokens=4, output_tokens=8)   # same request written again: replaces
            + _cost_state({"claude-opus-5-5": _usage(10, 20, 0.001), "claude-sonnet-5-5": _usage(4, 8, 0.002),
                           "claude-haiku-5-5": _usage(0, 100, 0.0005)}))        # haiku only ran as a subagent
        snap = claude_analytics.snapshot("today")
        totals = snap["totals"]
        self.assertEqual(totals["requests"], 2)
        self.assertEqual(totals["output_tokens"], 20 + 8 + 100)
        self.assertAlmostEqual(totals["cost_usd"], 0.0035, places=6)
        by_model = {m["model"]: m for m in snap["by_model"]}
        self.assertEqual(by_model["claude-haiku-5-5"]["requests"], 0)
        self.assertEqual(by_model["claude-sonnet-5-5"]["requests"], 1)
        self.assertEqual(sum(s["requests"] for s in snap["series"]), 2)
        self.assertEqual({r["model"] for r in snap["recent"]}, {"claude-opus-5-5", "claude-sonnet-5-5"})
        self.assertEqual(snap["live_models"], ["claude-opus-5-5", "claude-sonnet-5-5"])

    def test_reads_only_new_complete_lines(self):
        self.write(_msg("a", "claude-opus-5-5", input_tokens=5))
        self.assertEqual(claude_analytics.snapshot("today")["totals"]["requests"], 1)
        self.write(_msg("b", "claude-opus-5-5", input_tokens=5)[:-20], "a")      # a line still being written
        self.assertEqual(claude_analytics.snapshot("today")["totals"]["requests"], 1)
        self.write(_msg("b", "claude-opus-5-5", input_tokens=5), "w")            # file rewritten from scratch
        self.write(_msg("c", "claude-opus-5-5", input_tokens=5), "a")
        self.assertEqual(claude_analytics.snapshot("today")["totals"]["requests"], 2)

    def test_official_model_without_a_cost_record_is_unpriced(self):
        self.write(_msg("a", "claude-opus-5-5", input_tokens=5, output_tokens=5))
        snap = claude_analytics.snapshot("24h")
        self.assertTrue(snap["unpriced"])
        self.assertEqual(snap["totals"]["cost_usd"], 0)
        self.assertEqual(len(snap["series"]), 24)


if __name__ == "__main__":
    unittest.main()
