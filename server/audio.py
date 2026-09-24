"""音声フォーマットの変換。wav48 と wav24 に対応し、Opus は未実装。"""

from __future__ import annotations

import io
import logging
import wave

log = logging.getLogger("tts.audio")

SUPPORTED = ("wav48", "wav24")

try:  # audioop は Python 3.13 で削除された
    import audioop  # type: ignore
except Exception:  # pragma: no cover
    audioop = None


class UnsupportedFormat(ValueError):
    pass


def convert(wav_bytes: bytes, fmt: str | None) -> tuple[bytes, str]:
    """(データ, Content-Type) を返す。"""
    fmt = (fmt or "wav48").lower()

    if fmt == "wav48":
        return wav_bytes, "audio/wav"

    if fmt == "wav24":
        return _resample(wav_bytes, 24000), "audio/wav"

    if fmt == "opus":
        raise UnsupportedFormat(
            "opus は未実装。対応形式は wav48 または wav24"
        )

    raise UnsupportedFormat("未知の format: %s（対応: %s）" % (fmt, ", ".join(SUPPORTED)))


def _resample(wav_bytes: bytes, target_rate: int) -> bytes:
    if audioop is None:
        log.warning("audioop が使えないため 48kHz のまま返す")
        return wav_bytes

    with wave.open(io.BytesIO(wav_bytes), "rb") as r:
        ch, width, rate = r.getnchannels(), r.getsampwidth(), r.getframerate()
        frames = r.readframes(r.getnframes())

    if rate == target_rate:
        return wav_bytes

    converted, _ = audioop.ratecv(frames, width, ch, rate, target_rate, None)

    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(ch)
        w.setsampwidth(width)
        w.setframerate(target_rate)
        w.writeframes(converted)
    return out.getvalue()
