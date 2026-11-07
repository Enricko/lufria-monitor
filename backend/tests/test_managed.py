"""Services controlled from the dashboard: list validation, and the tree actions on real transient units."""
import secrets
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import auth, managed
from app.main import app


def svc(sid, **kw):
    return {"id": sid, "name": kw.pop("name", sid), "kind": kw.pop("kind", "command"),
            "command": kw.pop("command", "sleep 600"), **kw}


class ValidateTest(unittest.TestCase):
    def test_normalizes_and_drops_fields_of_other_kinds(self):
        [s] = managed.validate([{"id": "web", "name": "Web", "kind": "systemd", "target": "nginx",
                                 "command": "rm -rf /", "match": "x"}])
        self.assertEqual(s["target"], "nginx.service")
        self.assertEqual((s["command"], s["match"], s["parent"], s["stop_timeout"]), ("", "", None, 30))

    def test_rejects(self):
        cases = {
            "id must be": [svc("Bad_ID")],
            "two services": [svc("a"), svc("a")],
            "not in the list": [svc("a", parent="ghost")],
            "on top of itself": [svc("a", parent="b"), svc("b", parent="a")],
            "unit name": [{"id": "a", "name": "A", "kind": "systemd", "target": "-H evil"}],
            "container name": [{"id": "a", "name": "A", "kind": "docker", "target": "--rm"}],
            "can't be parsed": [svc("a", command="echo 'unterminated")],
            "command is required": [svc("a", command="  ")],
            "absolute path": [svc("a", cwd="relative/dir")],
            "does not exist": [svc("a", cwd="/nonexistent-dir-xyz")],
            "valid regex": [svc("a", match="(")],
            "host:port": [svc("a", ready="nope")],
            "between 1 and 600": [svc("a", stop_timeout=9999)],
            "single line": [svc("a", name="two\nlines")],
        }
        for msg, items in cases.items():
            with self.subTest(msg), self.assertRaisesRegex(ValueError, msg):
                managed.validate(items)

    def test_refuses_the_dashboard_unit(self):
        with patch.object(managed, "OWN_UNIT", "lufria-monitor.service"), self.assertRaisesRegex(ValueError, "this dashboard"):
            managed.validate([{"id": "m", "name": "M", "kind": "systemd", "target": "lufria-monitor"}])

    def test_tree_order(self):
        items = managed.validate([svc("db"), svc("api", parent="db"), svc("sim", parent="api"),
                                  svc("web", parent="api"), svc("other")])
        by_id = {s["id"]: s for s in items}
        self.assertEqual([s["id"] for s in managed._chain("sim", by_id)], ["db", "api", "sim"])
        self.assertEqual([s["id"] for s in managed._subtree("db", by_id)], ["db", "api", "sim", "web"])

    def test_ready_targets(self):
        self.assertEqual(managed._ready_target("5173"), ("127.0.0.1", 5173))
        self.assertEqual(managed._ready_target("host:99999"), None)
        self.assertEqual(managed._ready_target("localhost:3000"), ("localhost", 3000))
        self.assertEqual(managed._ready_target("http://127.0.0.1:3000/api/health"), "http://127.0.0.1:3000/api/health")


class RoutesTest(unittest.TestCase):
    def setUp(self):
        self.file = Path(tempfile.mkdtemp()) / "services.json"
        self.patches = [patch.object(managed, "SERVICES_FILE", self.file),
                        patch.object(auth, "valid_session", return_value=True)]
        for p in self.patches:
            p.start()
        self.client = TestClient(app)

    def tearDown(self):
        for p in self.patches:
            p.stop()
        shutil.rmtree(self.file.parent, ignore_errors=True)

    def test_save_and_read_back(self):
        r = self.client.put("/api/managed", json={"services": [svc("a"), svc("b", parent="a")]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual([s["id"] for s in r.json()["services"]], ["a", "b"])
        self.assertEqual(r.json()["services"][0]["status"]["state"], "stopped")
        self.assertEqual(self.file.stat().st_mode & 0o777, 0o600)

    def test_bad_list_is_400_and_not_saved(self):
        r = self.client.put("/api/managed", json={"services": [svc("a", parent="zzz")]})
        self.assertEqual(r.status_code, 400)
        self.assertFalse(self.file.exists())

    def test_cross_site_requests_are_refused(self):
        evil = {"origin": "https://evil.lufria.tech"}
        self.assertEqual(self.client.put("/api/managed", json={"services": []}, headers=evil).status_code, 403)
        self.assertEqual(self.client.post("/api/managed/a/start", headers=evil).status_code, 403)

    def test_unknown_service_and_action(self):
        self.assertEqual(self.client.post("/api/managed/nope/start").status_code, 404)
        self.assertEqual(self.client.post("/api/managed/nope/explode").status_code, 404)


def _user_systemd() -> bool:
    try:
        return subprocess.run(["systemctl", "--user", "is-system-running"], env=managed.USER_ENV,
                              capture_output=True, timeout=5).returncode in (0, 1)
    except (OSError, subprocess.TimeoutExpired):
        return False


@unittest.skipUnless(shutil.which("systemd-run") and _user_systemd(), "needs a user systemd manager")
class ActionsTest(unittest.TestCase):
    """Real transient units running `sleep`, so it touches nothing but its own lufria-svc-t*-* units."""

    def setUp(self):
        self.tag = "t" + secrets.token_hex(3)
        self.secs = 7000 + secrets.randbelow(900)  # unique argv so `match` only sees this test's processes
        self.file = Path(tempfile.mkdtemp()) / "services.json"
        self.patches = [patch.object(managed, "SERVICES_FILE", self.file), patch.object(managed, "SETTLE", 0.5)]
        for p in self.patches:
            p.start()
        self.ids = []

    def tearDown(self):
        units = [managed.unit_of(i) for i in self.ids] + [f"{self.tag}-outside.service"]
        subprocess.run(["systemctl", "--user", "stop", *units], env=managed.USER_ENV, capture_output=True)
        subprocess.run(["systemctl", "--user", "reset-failed", *units], env=managed.USER_ENV, capture_output=True)
        for p in self.patches:
            p.stop()
        shutil.rmtree(self.file.parent, ignore_errors=True)

    def use(self, *items):
        managed.save(list(items))
        self.ids = [s["id"] for s in items]

    def act(self, sid, action):
        managed.request(sid, action, background=False)
        return managed.overview()

    def states(self, ov):
        return {s["id"]: s["status"]["state"] for s in ov["services"]}

    def test_tree_lifecycle(self):
        api, sim, web = f"{self.tag}-api", f"{self.tag}-sim", f"{self.tag}-web"
        self.use(svc(api, command=f"sleep {self.secs}"),
                 svc(sim, parent=api, command=f"sleep {self.secs + 1}"),
                 svc(web, parent=api, command=f"sleep {self.secs + 2}"))

        ov = self.act(sim, "start")  # starts the API underneath first
        self.assertEqual(self.states(ov), {api: "running", sim: "running", web: "stopped"})
        self.assertIsNone(next(s for s in ov["services"] if s["id"] == sim)["error"])

        ov = self.act(api, "restart")  # sim was running: back on top; web wasn't: stays down
        self.assertEqual(self.states(ov), {api: "running", sim: "running", web: "stopped"})

        ov = self.act(api, "stop")  # children go too
        self.assertEqual(self.states(ov), {api: "stopped", sim: "stopped", web: "stopped"})
        self.assertFalse(managed._busy)

    def test_takes_over_a_copy_started_outside(self):
        sid = f"{self.tag}-sim"
        self.use(svc(sid, command=f"sleep {self.secs}", match=rf"(^|/)sleep {self.secs}$"))  # systemd runs it as /usr/bin/sleep
        subprocess.run(["systemd-run", "--user", "--quiet", f"--unit={self.tag}-outside", "sleep", str(self.secs)],
                       env=managed.USER_ENV, check=True)
        time.sleep(0.5)
        self.assertEqual(self.states(managed.overview()), {sid: "external"})

        self.assertEqual(self.states(self.act(sid, "restart")), {sid: "running"})
        outside = subprocess.run(["systemctl", "--user", "is-active", f"{self.tag}-outside"],
                                 env=managed.USER_ENV, capture_output=True, text=True).stdout.strip()
        self.assertNotEqual(outside, "active")
        self.assertEqual(self.states(self.act(sid, "stop")), {sid: "stopped"})

    def test_failed_start_is_reported(self):
        bad = f"{self.tag}-bad"
        self.use(svc(bad, command="sh -c 'echo boom-from-test >&2; exit 3'"))
        ov = self.act(bad, "start")
        err = ov["services"][0]["error"]
        self.assertEqual(err["action"], "start")
        self.assertIn("exited right after starting", err["message"])
        self.assertIn("boom-from-test", err["message"])

    def test_ready_check_blocks_children(self):
        api, sim = f"{self.tag}-api", f"{self.tag}-sim"
        self.use(svc(api, command=f"sleep {self.secs}", ready="127.0.0.1:1"),
                 svc(sim, parent=api, command=f"sleep {self.secs + 1}"))
        with patch.object(managed, "READY_TIMEOUT", 2):
            ov = self.act(sim, "start")
        self.assertIn("did not answer", next(s for s in ov["services"] if s["id"] == api)["error"]["message"])
        self.assertEqual(self.states(ov)[sim], "stopped")

    def test_overlapping_actions_are_refused(self):
        api, sim = f"{self.tag}-api", f"{self.tag}-sim"
        self.use(svc(api), svc(sim, parent=api))
        managed._busy[api] = "starting"
        try:
            with self.assertRaises(managed.Busy):
                managed.request(sim, "start", background=False)
        finally:
            managed._busy.clear()


if __name__ == "__main__":
    unittest.main()
