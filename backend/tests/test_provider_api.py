"""Exercise the actual app routes without startup samplers or live credentials."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, AsyncMock

from fastapi.testclient import TestClient
from app import auth, providers
from app.main import app


class ProviderAPITest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.registry = providers.ProviderRegistry(root / "providers.json", builtins=[])
        self.patch_registry = patch.object(providers, "_registry", self.registry)
        self.patch_registry.start()
        self.addCleanup(self.patch_registry.stop)
        auth_file = root / "auth.json"
        auth_file.write_text(json.dumps({"secret": "test-session-secret"}))
        self.auth_path = patch.object(auth, "AUTH_FILE", auth_file)
        self.auth_path.start()
        self.addCleanup(self.auth_path.stop)
        self.client = TestClient(app)
        self.client.cookies.set(auth.COOKIE, auth.make_session())

    def test_provider_crud_refresh_and_compatibility_catalog_share_public_contract(self):
        with patch("app.providers.httpx.get", return_value=providers.httpx.Response(200, json={"data": [{"id": "same"}]})):
            result = self.client.post("/api/providers", json={"name": "A", "base_url": "https://a.test/v1", "api_key": "api-secret"})
            self.assertEqual(result.status_code, 200, result.text)
            self.assertEqual(result.json(), self.client.get("/api/providers").json())
            pid = result.json()["providers"][0]["id"]
            self.client.post("/api/providers", json={"name": "B", "base_url": "https://b.test/v1"})
            result = self.client.post("/api/providers/refresh")
            self.assertEqual(len(result.json()["models"]), 2)
            self.assertEqual(self.client.get("/api/router/models").json(), result.json()["models"])
            self.assertEqual(self.client.get("/api/providers").json(), result.json())
            self.assertEqual(self.client.post(f"/api/providers/{pid}/refresh").status_code, 200)
            edited = self.client.put(f"/api/providers/{pid}", json={"name": "Renamed", "api_key": ""})
            self.assertEqual(edited.status_code, 200)
            self.assertEqual(self.registry.resolve_model("same", pid)[1], "api-secret")
            self.assertNotIn("api-secret", edited.text)
            provider = edited.json()["providers"][0]
            self.assertEqual(set(provider), {"id", "name", "base_url", "enabled", "api_key_configured", "model_count", "last_refreshed", "error"})
            self.assertEqual(set(edited.json()["models"][0]), {"id", "name", "provider", "provider_id"})
            deleted = self.client.delete(f"/api/providers/{pid}")
            self.assertNotIn(pid, [p["id"] for p in deleted.json()["providers"]])
            self.assertEqual(self.client.put(f"/api/providers/{pid}", json={}).status_code, 404)

    def test_chat_websockets_reject_cross_origin_before_handler(self):
        from starlette.websockets import WebSocketDisconnect
        for path, handler in (("/ws/claude", "app.main.claude_chat.handle_ws"), ("/ws/router", "app.main.router_chat.handle_ws")):
            with self.subTest(path=path), patch(handler, new=AsyncMock()) as mocked:
                with self.assertRaises(WebSocketDisconnect) as closed:
                    with self.client.websocket_connect(path, headers={"Origin":"https://sibling.test"}):
                        pass
                self.assertEqual(closed.exception.code, 4403)
                mocked.assert_not_called()

    def test_authentication_cross_origin_and_validation_errors_do_not_echo_secrets(self):
        self.client.cookies.clear()
        self.assertEqual(self.client.get("/api/providers").status_code, 401)
        self.client.cookies.set(auth.COOKIE, auth.make_session())
        for method, path in (("POST", "/api/providers"), ("POST", "/api/providers/refresh"),
                             ("POST", "/api/providers/id/refresh"), ("PUT", "/api/providers/id"), ("DELETE", "/api/providers/id")):
            result = self.client.request(method, path, headers={"Origin": "https://sibling.test"}, json={"api_key": "secret-value"})
            self.assertEqual(result.status_code, 403, result.text)
            self.assertNotIn("secret-value", result.text)
        for body in ({"name": "A", "base_url": "https://u:secret-value@host", "api_key": "secret-value"},
                     {"name": ["secret-value"], "base_url": "https://host", "api_key": "secret-value"},
                     {"name": "A", "base_url": "https://host", "api_key": {"secret-value": 1}},
                     {"name": "A", "base_url": "https://host", "enabled": "secret-value"},
                     {"name": "A", "base_url": "https://host", "key_env": "secret-value"}):
            result = self.client.post("/api/providers", json=body)
            self.assertEqual(result.status_code, 400, result.text)
            self.assertNotIn("secret-value", result.text)
        result = self.client.post("/api/providers", content='{"api_key":"secret-value",')
        self.assertEqual(result.status_code, 400)
        self.assertNotIn("secret-value", result.text)


if __name__ == "__main__":
    unittest.main()
