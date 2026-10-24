"""Terminal launcher tests with synthetic sessions and credentials only."""
import importlib.util
from pathlib import Path
from unittest.mock import patch
import unittest

PATH = Path(__file__).resolve().parents[2] / "bin" / "claude-session.py"

class SessionLauncherTest(unittest.TestCase):
    def load(self):
        self.assertTrue(PATH.exists(), "Dashboard session launcher must exist")
        spec=importlib.util.spec_from_file_location("session_launcher",PATH)
        assert spec is not None and spec.loader is not None
        module=importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_bound_session_uses_exact_provider_model_without_exposing_key(self):
        m=self.load()
        binding={"model":"default","provider_id":"fixture-router","provider":"Fixture"}
        with patch.object(m.claude_sessions,"get_session",return_value={"id":"test","model":"reported-model"}), patch.object(m.claude_sessions,"get_session_binding",return_value=binding), patch.object(m.providers,"resolve_model",return_value=("https://fixture.test/v1","fixture-key","Fixture")) as resolve:
            command,env,info=m.prepare("test")
        resolve.assert_called_once_with("default","fixture-router")
        self.assertEqual(command[-2:],["--model","default"])
        self.assertEqual(env["ANTHROPIC_BASE_URL"],"https://fixture.test")
        self.assertEqual(env["ANTHROPIC_API_KEY"],"fixture-key")
        self.assertNotIn("fixture-key",str(info))
        self.assertEqual(info["provider"],"Fixture")

    def test_legacy_custom_model_resolves_existing_route(self):
        m=self.load()
        with patch.object(m.claude_sessions,"get_session",return_value={"model":"gemini-custom"}), patch.object(m.claude_sessions,"get_session_binding",return_value=None), patch.object(m.providers,"resolve_model",return_value=("https://legacy.test/v1","fixture-key","Legacy")) as resolve:
            command,env,info=m.prepare("test")
        resolve.assert_called_once_with("gemini-custom",None)
        self.assertEqual(command[-1],"gemini-custom")
        self.assertEqual(info["provider"],"Legacy")

    def test_native_session_does_not_resolve_custom_route(self):
        m=self.load()
        with patch.object(m.claude_sessions,"get_session",return_value={"model":"claude-native"}), patch.object(m.claude_sessions,"get_session_binding",return_value=None), patch.object(m.providers,"resolve_model") as resolve:
            command,env,info=m.prepare("test")
        resolve.assert_not_called()
        self.assertEqual(command[-1],"claude-native")
        self.assertNotIn("fixture-key",str(info))

if __name__ == "__main__":unittest.main()
