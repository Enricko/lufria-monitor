"""Provider registry regressions. All persistence is isolated from live config."""
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

from app import providers


class RegistryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "providers.json"

    def registry(self, **kwargs):
        return providers.ProviderRegistry(self.path, builtins=[], **kwargs)

    def test_crud_persists_key_without_exposing_it_and_blank_edit_preserves_it(self):
        registry = self.registry()
        created = registry.create(name="Private router", base_url="http://localhost:9000/v1/", api_key="test-secret")
        pid = created["id"]
        self.assertEqual(created["base_url"], "http://localhost:9000/v1")
        self.assertTrue(created["api_key_configured"])
        registry.update(pid, name="Renamed", api_key="")
        restored = self.registry()
        self.assertEqual(restored.resolve_model("same-model", pid), ("http://localhost:9000/v1", "test-secret", "Renamed"))
        restored.update(pid, enabled=False)
        self.assertFalse(self.registry().catalog(discover=False)["providers"][0]["enabled"])
        public = json.dumps(restored.catalog(discover=False))
        for forbidden in ("test-secret", '"api_key"', '"key_env"', '"headers"'):
            self.assertNotIn(forbidden, public)
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        restored.delete(pid)
        self.assertEqual(self.registry().catalog(discover=False), {"providers": [], "models": []})

    def test_refresh_keeps_duplicate_raw_ids_per_provider_and_persists_snapshots(self):
        registry = self.registry()
        first = registry.create(name="A", base_url="https://a.test/v1", api_key="a-key")["id"]
        second = registry.create(name="B", base_url="https://b.test/v1")["id"]
        with patch("app.providers.httpx.get", return_value=providers.httpx.Response(200, json={"data": [{"id": " raw/id ", "name": "Named"}]})) as get:
            catalog = registry.refresh()
            self.assertEqual(get.call_count, 2)
            self.assertEqual(get.call_args.kwargs["headers"], {})
            self.assertIs(get.call_args.kwargs["follow_redirects"], False)
        self.assertEqual([(m["id"], m["provider_id"]) for m in catalog["models"]], [(" raw/id ", first), (" raw/id ", second)])
        self.assertEqual(registry.resolve_model(" raw/id ", second), ("https://b.test/v1", "", "B"))
        with patch("app.providers.httpx.get", side_effect=AssertionError("must use persisted TTL")):
            self.assertEqual(self.registry().catalog(), catalog)
        self.assertEqual(registry.resolve_model("unknown-legacy-model"), ("https://a.test/v1", "a-key", "A"))

    def test_failed_refresh_retains_last_good_and_sanitizes_errors_then_empty_replaces(self):
        registry = self.registry()
        pid = registry.create(name="A", base_url="https://a.test/v1", api_key="dont-leak")["id"]
        with patch("app.providers.httpx.get", return_value=providers.httpx.Response(200, json={"data": [{"id": "old"}]})):
            before = registry.refresh(pid)
        for failure in (providers.httpx.Response(302, headers={"Location": "https://evil.test"}),
                        providers.httpx.Response(401, text="dont-leak"),
                        providers.httpx.Response(200, json={"not-data": []}),
                        providers.httpx.Response(200, json={"data": [{}]})):
            with patch("app.providers.httpx.get", return_value=failure):
                failed = registry.refresh(pid)
            self.assertEqual(failed["models"], before["models"])
            self.assertEqual(failed["providers"][0]["last_refreshed"], before["providers"][0]["last_refreshed"])
            self.assertTrue(failed["providers"][0]["error"])
            self.assertNotIn("dont-leak", json.dumps(failed))
        with patch("app.providers.httpx.get", side_effect=RuntimeError("Bearer dont-leak https://secret")):
            failed = registry.refresh(pid)
        self.assertEqual(failed["models"], before["models"])
        self.assertNotIn("dont-leak", json.dumps(failed))
        for ids in ([], ["new"]):
            with patch("app.providers.httpx.get", return_value=providers.httpx.Response(200, json={"data": [{"id": mid} for mid in ids]})):
                after = registry.refresh(pid)
            self.assertEqual([m["id"] for m in after["models"]], ids)
            self.assertIsNone(after["providers"][0]["error"])
        with patch("app.providers.httpx.get", side_effect=AssertionError("cached")):
            self.assertEqual(self.registry().catalog(), after)

    def test_url_validation_rejects_credentials_queries_fragments_and_bad_schemes(self):
        registry = self.registry()
        for url in ("file:///tmp/config", "https://user:secret@host/v1", "https://host/v1?key=secret",
                    "https://host/v1#secret", "https://", "https://host:wrong/v1", "https://host/\nfoo", "https://host?", "https://host#"):
            with self.subTest(url=url), self.assertRaises(providers.ProviderError):
                registry.create(name="A", base_url=url)
        with self.assertRaises(providers.ProviderError):
            registry.create(name=" ", base_url="https://a.test/v1")
        valid = registry.create(name="A", base_url="http://127.0.0.1:9000/v1")["id"]
        with self.assertRaises(providers.ProviderError):
            registry.update(valid, base_url="https://u:p@host")
        registry.update(valid, enabled=False)
        with self.assertRaises(providers.ProviderError):
            registry.resolve_model("x", valid)
        with self.assertRaises(providers.ProviderNotFound):
            registry.resolve_model("x", "invalid")
        self.assertEqual(registry.catalog(discover=False)["models"], [])

    def test_legacy_exact_model_and_prefix_fallback_stay_enabled_and_force_refresh_works(self):
        registry = providers.ProviderRegistry(self.path)
        with patch("app.providers.get_api_key", return_value="env-key"), patch("app.providers.httpx.get") as get:
            get.side_effect = [providers.httpx.Response(200, json={"data": []}),
                               providers.httpx.Response(200, json={"data": [{"id": "only-lufria"}]}),
                               providers.httpx.Response(200, json={"data": []})]
            registry.refresh()
            self.assertEqual(registry.resolve_model("only-lufria")[2], "Lufria Router")
            self.assertEqual(registry.resolve_model("omop/custom")[2], "Binav Router")
            self.assertEqual(registry.resolve_model("glm-5.3-flash")[2], "OMO API HUB")
            self.assertEqual(registry.resolve_model("unknown")[2], "Binav Router")
            get.side_effect = None
            get.return_value = providers.httpx.Response(200, json={"data": [{"id": "forced-new"}]})
            with patch.object(providers, "_registry", registry):
                self.assertEqual(len(providers.get_all_models(force_refresh=True)), 3)
            registry.delete("binav")
            self.assertEqual(providers.ProviderRegistry(self.path).catalog(discover=False)["providers"][0]["id"], "lufria")

    def test_refresh_failure_is_isolated_and_ttl_retries_without_poisoning_other_providers(self):
        registry = self.registry()
        a = registry.create(name="A", base_url="https://a.test/v1")["id"]
        b = registry.create(name="B", base_url="https://b.test/v1")["id"]
        with patch("app.providers.httpx.get", side_effect=[providers.httpx.ConnectError("private-key"), providers.httpx.Response(200, json={"data": [{"id": "b-model"}]})]) as get:
            catalog = registry.refresh()
            self.assertEqual(get.call_count, 2)
        self.assertTrue(catalog["providers"][0]["error"])
        self.assertEqual([m["provider_id"] for m in catalog["models"]], [b])
        with patch("app.providers.httpx.get", side_effect=AssertionError("failure TTL")) as get:
            registry.catalog()
            get.assert_not_called()
        with patch("app.providers.time.time", return_value=__import__("time").time() + 301), patch("app.providers.httpx.get", return_value=providers.httpx.Response(200, json={"data": []})) as get:
            catalog = registry.catalog()
            self.assertEqual(get.call_count, 2)
            self.assertEqual(catalog["models"], [])
        self.assertIsNone(catalog["providers"][0]["error"])

    def test_origin_change_requires_explicit_credential_not_previous_host_key(self):
        registry = self.registry()
        pid = registry.create(name="A",base_url="https://old.test/v1",api_key="old-key")["id"]
        with self.assertRaises(providers.ProviderError):
            registry.update(pid,base_url="https://replacement.test/v1",api_key="")
        self.assertEqual(registry.resolve_model("x",pid)[0],"https://old.test/v1")
        registry.update(pid,base_url="https://replacement.test/v1",api_key="new-key")
        self.assertEqual(registry.resolve_model("x",pid)[:2],("https://replacement.test/v1","new-key"))
        registry.update(pid,base_url="https://replacement.test/other/v1",api_key="")
        self.assertEqual(registry.resolve_model("x",pid)[1],"new-key")

    def test_builtin_credentials_use_env_then_file_without_exposing_sources(self):
        env_file = Path(self.temp.name) / "fixture.env"
        env_file.write_text('MONITOR_TEST_KEY="file-test-key"\n')
        with patch.object(providers, "ENV_FILE", env_file), patch.dict(os.environ, {"MONITOR_TEST_KEY": ""}):
            self.assertEqual(providers.get_api_key("MONITOR_TEST_KEY"), "file-test-key")
            with patch.dict(os.environ, {"MONITOR_TEST_KEY": "env-test-key"}):
                self.assertEqual(providers.get_api_key("MONITOR_TEST_KEY"), "env-test-key")
        registry = providers.ProviderRegistry(self.path, builtins=[{"id": "builtin", "name": "Builtin", "base_url": "https://b.test/v1", "key_env": "MONITOR_TEST_KEY"}])
        with patch.object(providers, "ENV_FILE", env_file), patch.dict(os.environ, {"MONITOR_TEST_KEY": ""}):
            self.assertTrue(registry.catalog(discover=False)["providers"][0]["api_key_configured"])
            registry.update("builtin", name="Persisted", api_key="")
            self.assertEqual(providers.ProviderRegistry(self.path).resolve_model("x", "builtin")[1], "file-test-key")


if __name__ == "__main__":
    unittest.main()
