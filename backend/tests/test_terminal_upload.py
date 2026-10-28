"""Files sent to the terminal: stored on the server, path returned for the page to paste."""
import os
import struct
import tempfile
import time
import unittest
import zlib
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import auth, terminal
from app.main import app


def png() -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"\x00\xff\x00\x00")) + chunk(b"IEND", b""))


class UploadTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp()) / "uploads"
        self.patches = [patch.object(terminal, "UPLOAD_DIR", self.dir),
                        patch.object(auth, "valid_session", return_value=True)]
        for p in self.patches:
            p.start()
        self.client = TestClient(app)  # no `with`: the sampler and speedtest tasks stay off

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def post(self, data: bytes, name="", origin="http://testserver"):
        return self.client.post("/api/terminal/upload", params={"name": name}, content=data,
                                headers={"Content-Type": "application/octet-stream", "Origin": origin})

    def files(self):
        return sorted(p.name for p in self.dir.iterdir()) if self.dir.exists() else []

    def test_image_types_by_content(self):
        self.assertEqual(terminal.image_ext(png()), "png")
        self.assertEqual(terminal.image_ext(b"\xff\xd8\xff\xe0rest"), "jpg")
        self.assertEqual(terminal.image_ext(b"GIF89a..."), "gif")
        self.assertEqual(terminal.image_ext(b"RIFF\x10\x00\x00\x00WEBPVP8 "), "webp")
        self.assertIsNone(terminal.image_ext(b"<svg xmlns='http://www.w3.org/2000/svg'/>"))
        self.assertIsNone(terminal.image_ext(b"%PDF-1.7"))

    def test_names_become_one_word(self):
        name = terminal.upload_name
        self.assertEqual(name("Laporan Keuangan (final).pdf", b"%PDF"), "Laporan_Keuangan_final_.pdf")
        self.assertEqual(name("../../etc/passwd", b""), "passwd")
        self.assertEqual(name("C:\\Users\\me\\notes.txt", b""), "notes.txt")
        self.assertEqual(name("foto keluarga.png", b""), "foto_keluarga.png")
        self.assertEqual(name("照片.txt", b""), "照片.txt")
        self.assertEqual(name("", b""), "file")
        self.assertEqual(name("...", b""), "file")
        long = name("x" * 300 + ".tar.gz", b"")
        self.assertTrue(long.endswith(".tar.gz") and len(long.encode()) <= 120)
        self.assertLessEqual(len(name("照" * 100 + ".txt", b"").encode()), 120)

    def test_images_get_the_extension_of_their_content(self):
        # Claude Code attaches a pasted path only if the extension says image and the content agrees
        self.assertEqual(terminal.upload_name("photo.jpeg", b"\xff\xd8\xff\xe0"), "photo.jpg")
        self.assertEqual(terminal.upload_name("shot.PNG", png()), "shot.png")
        self.assertEqual(terminal.upload_name("image", png()), "image.png")

    def test_upload_returns_a_pasteable_path(self):
        r = self.post(png(), name="Screen Shot 2026-10-26.png")
        self.assertEqual(r.status_code, 200, r.text)
        path = Path(r.json()["path"])
        self.assertEqual(path.parent, self.dir)
        self.assertRegex(path.name, r"^\d{8}-\d{6}-[0-9a-f]{6}-Screen_Shot_2026-10-26\.png$")
        self.assertEqual(path.read_bytes(), png())
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.dir.stat().st_mode & 0o777, 0o700)

    def test_any_file_type(self):
        data = b"%PDF-1.7\n" + os.urandom(200_000)  # several chunks
        r = self.post(data, name="laporan.pdf")
        self.assertEqual(r.status_code, 200, r.text)
        path = Path(r.json()["path"])
        self.assertTrue(path.name.endswith("-laporan.pdf"))
        self.assertEqual(path.read_bytes(), data)
        self.assertEqual(self.files(), [path.name])  # no temp file left behind

    def test_refuses_oversized_uploads_and_cleans_up(self):
        with patch.object(terminal, "MAX_UPLOAD", 64):
            self.assertEqual(self.post(b"\x00" * 100, name="big.bin").status_code, 413)
        self.assertEqual(self.files(), [])

    def test_refuses_other_sites(self):
        self.assertEqual(self.post(png(), origin="https://evil.lufria.tech").status_code, 403)
        self.assertEqual(self.files(), [])

    def test_old_uploads_are_dropped(self):
        self.dir.mkdir(parents=True)
        old, fresh = self.dir / "old.png", self.dir / "fresh.png"
        old.write_bytes(png())
        fresh.write_bytes(png())
        week_ago = time.time() - terminal.UPLOAD_TTL - 60
        os.utime(old, (week_ago, week_ago))
        self.assertEqual(self.post(png()).status_code, 200)
        self.assertFalse(old.exists())
        self.assertTrue(fresh.exists())


if __name__ == "__main__":
    unittest.main()
