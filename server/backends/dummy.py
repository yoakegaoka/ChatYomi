"""開発用バックエンド。

Irodori-TTS を起動しなくてもクライアント側の開発を進められるようにする。
無音は返さない。再生キューの順序や先読みの確認ができなくなるため。
"""

from __future__ import annotations

import io
import math
import struct
import wave

from .base import Backend, VoiceConfig

SAMPLE_RATE = 48000  # Irodori-TTS の出力に合わせる


class DummyBackend(Backend):
    name = "dummy"

    def synthesize(self, text: str, voice: VoiceConfig) -> bytes:
        seconds = max(0.8, min(8.0, len(text) * 0.12))
        n = int(SAMPLE_RATE * seconds)

        # 文ごとに音程を変える。読み上げ順が入れ替わっていないか耳で追えるようにするため
        base = 380.0 + (hash(voice.name) % 5) * 30
        freq = base + (len(text) % 7) * 40

        frames = bytearray()
        for i in range(n):
            env = min(1.0, i / 480, (n - i) / 480)  # 前後のクリック音を防ぐ
            frames += struct.pack("<h", int(11000 * env * math.sin(2 * math.pi * freq * i / SAMPLE_RATE)))

        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SAMPLE_RATE)
            w.writeframes(bytes(frames))
        return buf.getvalue()
