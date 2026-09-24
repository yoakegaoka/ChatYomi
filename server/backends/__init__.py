"""バックエンド生成。通常利用はIrodori-TTS-Server、dummyは自動検証専用。"""

from __future__ import annotations

from .base import Backend, BackendError, VoiceConfig

__all__ = ["Backend", "BackendError", "VoiceConfig", "create_backend"]


def create_backend(cfg) -> Backend:
    kind = (cfg.backend or "irodori_server").lower()

    if kind == "dummy":
        from .dummy import DummyBackend
        return DummyBackend()

    if kind == "irodori_server":
        from .irodori_server_backend import IrodoriServerBackend
        return IrodoriServerBackend(
            url=cfg.irodori_server_url,
            api_key=cfg.irodori_server_api_key,
            model=cfg.irodori_server_model,
        )

    raise ValueError("未対応のbackend: %s（irodori_server または dummy を指定）" % kind)
