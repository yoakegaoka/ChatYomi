"""管理画面が使うAPIと音声登録の回帰確認。"""

from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from pydantic import ValidationError

from . import main
from .config import Config
from .voices import VoiceStore


ROOT = Path(__file__).resolve().parent.parent


class AdminTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temp_root = ROOT / ".tmp"
        temp_root.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=temp_root)
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.cfg = Config(path=root / "config.yaml", voices_dir=str(root / "voices"),
                          backend="dummy", current_voice="声A",
                          site_voices={"claude": "声A", "gemini": "声B"})
        self.voices = VoiceStore(self.cfg.voices_path)
        self.voices.create("声A", None)
        self.voices.create("声B", None)
        self.inputs = []
        readings = SimpleNamespace(prepare=lambda value: value.replace("ABC", "エービーシー"))
        backend = SimpleNamespace(synthesize_candidates=self.synthesize)
        state = SimpleNamespace(cfg=self.cfg, voices=self.voices, readings=readings,
                                backend=backend, model_loaded=True, sem=asyncio.Semaphore(1))
        self.state_patch = patch.object(main, "state", state)
        self.state_patch.start()
        self.addCleanup(self.state_patch.stop)

    def synthesize(self, content, voice, count):
        self.inputs.append((content, voice.name, count))
        return [b"wav"] * count

    def test_register_without_file_and_reject_duplicate(self):
        self.assertIsNotNone(self.voices.get("声A"))
        with self.assertRaisesRegex(ValueError, "同じ名前"):
            self.voices.create("声A", b"replacement", "ref.wav")
        self.assertIsNone(self.voices.get("声A").ref_audio)
        with self.assertRaisesRegex(ValueError, "標準の声"):
            self.voices.create("default", None)
        with self.assertRaisesRegex(ValueError, "WAV"):
            self.voices.create("不正", b"content", "sample.txt")

    async def test_preview_uses_reading_rules(self):
        result = await main.preview(main.PreviewRequest(text="ABC", voice="声A",
                                                         num_candidates=2))
        self.assertEqual(self.inputs, [("エービーシー", "声A", 2)])
        self.assertEqual(len(result["candidates"]), 2)

    def test_preview_limits_match_admin_controls(self):
        main.PreviewRequest(text="test", duration_scale=2 / 3, num_steps=40)
        main.PreviewRequest(text="test", duration_scale=2, num_steps=4)
        with self.assertRaises(ValidationError):
            main.PreviewRequest(text="test", num_steps=41)
        with self.assertRaises(ValidationError):
            main.PreviewRequest(text="test", duration_scale=0.5)
        with self.assertRaisesRegex(ValueError, "4～40"):
            self.voices.update_params("声A", {"num_steps": 41})
        with self.assertRaisesRegex(ValueError, "0.5～1.5"):
            self.voices.update_params("声A", {"duration_scale": 0.5})
        self.voices.update_params("声A", {"num_steps": 40, "duration_scale": 2 / 3})

    async def test_delete_clears_assignments_for_deleted_voice(self):
        await main.delete_voice("声A")
        self.assertEqual(self.cfg.current_voice, "")
        self.assertEqual(self.cfg.site_voices, {"gemini": "声B"})
        self.assertTrue(self.cfg.path.exists())


if __name__ == "__main__":
    unittest.main()
