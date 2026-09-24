"""Irodori-TTS-Server バックエンドの単体テスト。

    python -m unittest server.test_irodori_server_backend

実際のモデルや外部ネットワークは使わず、ローカルの模擬HTTPサーバで
認証、health、リクエスト変換、音声応答を確認する。
"""

from __future__ import annotations

import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .backends import BackendError, VoiceConfig
from .backends.irodori_server_backend import IrodoriServerBackend


class Handler(BaseHTTPRequestHandler):
    requests = []

    def log_message(self, format, *args):  # noqa: A002
        pass

    def do_GET(self):  # noqa: N802
        if self.path != "/health":
            self.send_error(404)
            return
        body = json.dumps({
            "status": "ok",
            "model": {"id": "irodori-tts", "hf_checkpoint": "test/v3"},
            "runtime": {"loaded": False, "loading": False},
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        type(self).requests.append((self.path, self.headers, payload))
        body = b"RIFF-test-wave"
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class IrodoriServerBackendTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = "http://127.0.0.1:%d" % cls.server.server_port

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def setUp(self):
        Handler.requests.clear()

    def test_health_and_synthesis(self):
        with tempfile.TemporaryDirectory(prefix="irodori-server-test-") as tmp:
            ref = Path(tmp) / "ref.wav"
            ref.write_bytes(b"reference")
            voice = VoiceConfig(
                name="test",
                ref_audio=ref,
                params={"duration_scale": 0.8, "num_steps": 16, "seed_raw": 1234},
            )
            backend = IrodoriServerBackend(self.url, api_key="secret")

            backend.load()
            self.assertTrue(backend.model_loaded)
            self.assertFalse(backend.health_details()["runtime_loaded"])
            self.assertEqual(backend.synthesize("テストです。", voice), b"RIFF-test-wave")

            path, headers, payload = Handler.requests[0]
            self.assertEqual(path, "/v1/audio/speech")
            self.assertEqual(headers["Authorization"], "Bearer secret")
            self.assertEqual(payload["model"], "irodori-tts")
            self.assertEqual(payload["input"], "テストです。")
            self.assertEqual(payload["voice"], "none")
            self.assertEqual(payload["speed"], 1.25)
            self.assertEqual(payload["irodori"]["ref_wav"], str(ref.resolve()))
            self.assertEqual(payload["irodori"]["num_steps"], 16)
            self.assertEqual(payload["irodori"]["seed"], 1234)
            self.assertFalse(payload["irodori"]["chunking_enabled"])
            self.assertTrue(backend.health_details()["runtime_loaded"])



if __name__ == "__main__":
    unittest.main()
