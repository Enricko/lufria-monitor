"""File viewer on the Claude Code page: folder listing, text/image/binary previews, and the routes' origin checks."""
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import auth, claude_transcript, claude_workspace
from app.main import app


class PreviewTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.root)
        (self.root / "src").mkdir()
        (self.root / "src" / "main.py").write_text("print('hi')\n")
        (self.root / "README.md").write_text("# Title\n")
        (self.root / "logo.png").write_bytes(b"\x89PNG\r\n\x1a\n\0\0")
        (self.root / "blob.bin").write_bytes(b"\x00\x01\x02")

    def test_list_dir_folders_first(self):
        listing = claude_workspace.list_dir("", self.root)
        self.assertEqual(listing["path"], str(self.root))
        self.assertEqual([e["name"] for e in listing["entries"]], ["src", "blob.bin", "logo.png", "README.md"])
        self.assertTrue(listing["entries"][0]["dir"])
        self.assertEqual(listing["entries"][3]["size"], 8)

    def test_list_dir_refuses_file(self):
        with self.assertRaises(ValueError):
            claude_workspace.list_dir("README.md", self.root)

    def test_relative_text(self):
        got = claude_workspace.read_preview("src/main.py", self.root)
        self.assertEqual(got["kind"], "text")
        self.assertEqual(got["text"], "print('hi')\n")
        self.assertEqual(got["path"], str(self.root / "src" / "main.py"))
        self.assertFalse(got["truncated"])

    def test_kinds(self):
        self.assertEqual(claude_workspace.read_preview(str(self.root / "src"))["kind"], "dir")
        self.assertEqual(claude_workspace.read_preview("logo.png", self.root)["kind"], "image")
        self.assertEqual(claude_workspace.read_preview("blob.bin", self.root)["kind"], "binary")

    def test_truncated(self):
        (self.root / "big.txt").write_text("a" * (claude_workspace.PREVIEW_TEXT_LIMIT + 10))
        got = claude_workspace.read_preview("big.txt", self.root)
        self.assertTrue(got["truncated"])
        self.assertEqual(len(got["text"]), claude_workspace.PREVIEW_TEXT_LIMIT)

    def test_missing_and_fifo(self):
        with self.assertRaises(ValueError):
            claude_workspace.read_preview("nope.txt", self.root)
        os.mkfifo(self.root / "pipe")
        with self.assertRaisesRegex(ValueError, "regular file"):
            claude_workspace.read_preview("pipe", self.root)  # must not block

    def test_unknown_user_home(self):
        with self.assertRaises(ValueError):
            claude_workspace.read_preview("~nosuchuser-xyz/a.txt", self.root)

    def test_pci_config_refused(self):
        with self.assertRaisesRegex(ValueError, "wake"):
            claude_workspace.read_preview("/sys/devices/pci0000:00/0000:00:01.0/config")

    def test_large_image_not_previewed(self):
        with patch.object(claude_workspace, "PREVIEW_IMAGE_LIMIT", 4):
            self.assertEqual(claude_workspace.read_preview("logo.png", self.root)["kind"], "binary")

    def test_media_kinds(self):
        (self.root / "clip.mp4").write_bytes(b"\0\0\0\x18ftypmp42")
        (self.root / "song.mp3").write_bytes(b"ID3")
        self.assertEqual(claude_workspace.read_preview("clip.mp4", self.root)["kind"], "video")
        self.assertEqual(claude_workspace.read_preview("song.mp3", self.root)["mime"], "audio/mpeg")

    def test_raw_file_inline_only_media(self):
        p, mime, _ = claude_workspace.raw_file("logo.png", self.root)
        self.assertEqual((p, mime), (self.root / "logo.png", "image/png"))
        with self.assertRaises(ValueError):
            claude_workspace.raw_file("README.md", self.root)
        self.assertEqual(claude_workspace.raw_file("README.md", self.root, download=True)[1], "application/octet-stream")
        with self.assertRaises(ValueError):
            claude_workspace.raw_file("src", self.root, download=True)

    def test_stat_files(self):
        got = claude_workspace.stat_files(["logo.png", str(self.root / "README.md"), "gone.zip", "src", "~nosuchuser-xyz/a"], self.root)
        self.assertEqual([g["exists"] for g in got], [True, True, False, False, False])
        self.assertEqual(got[0]["kind"], "image")
        self.assertEqual(got[1]["kind"], "file")
        self.assertEqual(got[0]["resolved"], str(self.root / "logo.png"))
        self.assertEqual(len(claude_workspace.stat_files(["a"] * 50, self.root)), claude_workspace.STAT_LIMIT)
        gone = claude_workspace.stat_files(["logo.png", str(self.root / "logo.png")], None, relative=False)
        self.assertEqual([g["exists"] for g in gone], [False, True])

    def test_tool_part_path(self):
        part = claude_transcript.tool_part({"name": "Read", "id": "t", "input": {"file_path": "/x/y.py"}})
        self.assertEqual(part["path"], "/x/y.py")
        part = claude_transcript.tool_part({"name": "Bash", "id": "t", "input": {"command": "ls"}})
        self.assertNotIn("path", part)


class PreviewRouteTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.root)
        (self.root / "a.txt").write_text("hello")
        (self.root / "b.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'/>")
        self.patch = patch.object(auth, "valid_session", return_value=True)
        self.patch.start()
        self.client = TestClient(app)  # no `with`: the sampler and speedtest tasks stay off

    def tearDown(self):
        self.patch.stop()

    def get(self, url, **headers):
        return self.client.get(url, params={"path": "a.txt" if "raw" not in url else "b.svg", "cwd": str(self.root)},
                               headers={"Origin": "http://testserver", **headers})

    def test_file(self):
        res = self.get("/api/claude/file")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["text"], "hello")

    def test_dir(self):
        res = self.client.get("/api/claude/dir", params={"cwd": str(self.root)}, headers={"Origin": "http://testserver"})
        self.assertEqual([e["name"] for e in res.json()["entries"]], ["a.txt", "b.svg"])

    def test_cross_site_refused(self):
        self.assertEqual(self.get("/api/claude/file", Origin="https://evil.lufria.tech").status_code, 403)
        self.assertEqual(self.get("/api/claude/file/raw", **{"Sec-Fetch-Site": "same-site"}).status_code, 403)
        self.assertEqual(self.get("/api/claude/file", **{"Sec-Fetch-Site": "cross-site"}).status_code, 403)

    def test_raw_svg_sandboxed(self):
        res = self.get("/api/claude/file/raw", **{"Sec-Fetch-Site": "same-origin"})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.headers["content-type"], "image/svg+xml")
        self.assertIn("sandbox", res.headers["content-security-policy"])

    def test_download_any_file(self):
        res = self.client.get("/api/claude/file/raw", params={"path": "a.txt", "cwd": str(self.root), "download": "1"},
                              headers={"Sec-Fetch-Site": "same-origin"})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.content, b"hello")
        self.assertIn("attachment", res.headers["content-disposition"])
        self.assertIn("a.txt", res.headers["content-disposition"])

    def test_video_range(self):
        (self.root / "v.mp4").write_bytes(bytes(range(100)))
        res = self.client.get("/api/claude/file/raw", params={"path": "v.mp4", "cwd": str(self.root)},
                              headers={"Range": "bytes=10-19"})
        self.assertEqual(res.status_code, 206)
        self.assertEqual(res.content, bytes(range(10, 20)))
        self.assertEqual(res.headers["content-type"], "video/mp4")

    def test_stat_route(self):
        res = self.client.post("/api/claude/file/stat", json={"paths": ["a.txt", "nope.png"], "cwd": str(self.root)},
                               headers={"Origin": "http://testserver"})
        self.assertEqual([g["exists"] for g in res.json()], [True, False])
        bad = self.client.post("/api/claude/file/stat", json={"paths": "a.txt"}, headers={"Origin": "http://testserver"})
        self.assertEqual(bad.status_code, 400)
        junk = self.client.post("/api/claude/file/stat", content=b"{", headers={"Origin": "http://testserver", "Content-Type": "application/json"})
        self.assertEqual(junk.status_code, 400)
        cross = self.client.post("/api/claude/file/stat", json={"paths": []}, headers={"Origin": "https://evil.lufria.tech"})
        self.assertEqual(cross.status_code, 403)

    def test_missing_is_400(self):
        res = self.client.get("/api/claude/file", params={"path": str(self.root / "gone")}, headers={"Origin": "http://testserver"})
        self.assertEqual(res.status_code, 400)


if __name__ == "__main__":
    unittest.main()
