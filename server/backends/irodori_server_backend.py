"""Irodori-TTS-Server の公開 API を使うバックエンド。

Irodori-TTS の Gradio 内部 API には依存せず、公式の /health と
/v1/audio/speech だけを使う。初期段階ではラッパーと Server が同じ Windows
PC 上で動く前提とし、既存 voices/ の参照ファイルを絶対パスで渡す。
"""

from __future__ import annotations

import json
import logging
import socket
import threading
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .base import Backend, BackendError, VoiceConfig

log = logging.getLogger("tts.irodori_server")

# Server のモデル遅延ロード上限（既定 300 秒）より長く待つ。
SYNTH_TIMEOUT = 330.0
HEALTH_TIMEOUT = 2.0

# Gradio と Server で名前が同じパラメーターだけを通す。
SERVER_PARAMS = {
    "num_steps", "cfg_scale_text", "cfg_scale_speaker",
    "cfg_guidance_mode", "t_schedule_mode", "sway_coeff",
    "caption", "cfg_scale_caption", "max_caption_len", "max_ref_seconds",
}


class IrodoriServerBackend(Backend):
    name = "irodori_server"

    def __init__(self, url: str, api_key: str = "", model: str = "irodori-tts",
                 timeout: float = SYNTH_TIMEOUT):
        self.url = url.rstrip("/")
        self.api_key = api_key
        self.model = model or "irodori-tts"
        self.timeout = timeout
        self._available = False
        self._health: dict[str, Any] = {}
        self._last_error = ""
        self._lock = threading.Lock()

    def _headers(self, json_body: bool = False) -> dict[str, str]:
        headers = {"Accept": "application/json"}
        if json_body:
            headers["Content-Type"] = "application/json"
        if self.api_key:
            headers["Authorization"] = "Bearer " + self.api_key
        return headers

    @staticmethod
    def _error_message(body: bytes, fallback: str) -> str:
        try:
            data = json.loads(body.decode("utf-8"))
            error = data.get("error") if isinstance(data, dict) else None
            if isinstance(error, dict) and error.get("message"):
                return str(error["message"])
            if isinstance(data, dict) and data.get("detail"):
                return str(data["detail"])
        except (UnicodeDecodeError, json.JSONDecodeError):
            pass
        return fallback

    def _request(self, path: str, *, payload: dict | None = None,
                 timeout: float) -> tuple[bytes, str]:
        body = None if payload is None else json.dumps(
            payload, ensure_ascii=False).encode("utf-8")
        req = Request(
            self.url + path,
            data=body,
            headers=self._headers(json_body=payload is not None),
            method="POST" if payload is not None else "GET",
        )
        try:
            with urlopen(req, timeout=timeout) as response:
                return response.read(), response.headers.get_content_type()
        except HTTPError as e:
            detail = self._error_message(e.read(), "HTTP %d" % e.code)
            raise BackendError("Irodori-TTS-Server がエラーを返した: %s" % detail) from e
        except (URLError, TimeoutError, socket.timeout, OSError) as e:
            reason = getattr(e, "reason", e)
            raise BackendError(
                "Irodori-TTS-Server に接続できない（%s）: %s" % (self.url, reason)
            ) from e

    def probe(self) -> dict[str, Any]:
        body, _ = self._request("/health", timeout=HEALTH_TIMEOUT)
        try:
            health = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as e:
            raise BackendError("Irodori-TTS-Server の /health が不正なJSONを返した") from e
        if not isinstance(health, dict) or health.get("status") != "ok":
            raise BackendError("Irodori-TTS-Server の状態が正常ではない")
        self._health = health
        self._available = True
        self._last_error = ""
        return health

    def load(self) -> None:
        """接続を確認する。モデル本体はServerの設定に従い遅延ロードされる。"""
        health = self.probe()
        runtime = health.get("runtime") or {}
        model = health.get("model") or {}
        log.info(
            "connected to %s model=%s checkpoint=%s runtime.loaded=%s",
            self.url, model.get("id", self.model), model.get("hf_checkpoint", "-"),
            runtime.get("loaded", False),
        )

    @property
    def model_loaded(self) -> bool:
        # Serverは初回の音声合成でモデルを遅延ロードできる。ここでは
        # 「現在合成を依頼できるか」を返し、実際のロード状態はhealth_detailsへ出す。
        return self._available

    def health_details(self) -> dict:
        runtime = self._health.get("runtime") or {}
        model = self._health.get("model") or {}
        return {
            "url": self.url,
            "reachable": self._available,
            "runtime_loaded": bool(runtime.get("loaded", False)),
            "runtime_loading": bool(runtime.get("loading", False)),
            "model": model.get("id", self.model),
            "checkpoint": model.get("hf_checkpoint") or runtime.get("checkpoint"),
            "error": self._last_error,
        }

    def refresh_health(self) -> dict:
        try:
            self.probe()
        except BackendError as e:
            self._available = False
            self._last_error = str(e)
        return self.health_details()

    def _payload(self, text: str, voice: VoiceConfig) -> dict[str, Any]:
        irodori: dict[str, Any] = {"chunking_enabled": False}

        if voice.speaker_embedding and voice.speaker_embedding.exists():
            irodori["ref_embed"] = str(voice.speaker_embedding.resolve())
        elif voice.ref_audio and voice.ref_audio.exists():
            irodori["ref_wav"] = str(voice.ref_audio.resolve())

        params = voice.params or {}
        for key in SERVER_PARAMS:
            if key in params:
                irodori[key] = params[key]
        if "seed_raw" in params:
            irodori["seed"] = params["seed_raw"]
        if "lora_adapter_raw" in params:
            irodori["lora_adapter"] = params["lora_adapter_raw"]

        payload: dict[str, Any] = {
            "model": self.model,
            "input": text,
            "voice": "none",
            "response_format": "wav",
            "irodori": irodori,
        }
        duration_scale = params.get("duration_scale")
        if duration_scale is not None:
            try:
                scale = float(duration_scale)
                if scale > 0:
                    payload["speed"] = 1.0 / scale
            except (TypeError, ValueError):
                log.warning("voice=%s の duration_scale を無視: %r",
                            voice.name, duration_scale)
        return payload

    def synthesize(self, text: str, voice: VoiceConfig) -> bytes:
        payload = self._payload(text, voice)
        try:
            with self._lock:
                audio, content_type = self._request(
                    "/v1/audio/speech", payload=payload, timeout=self.timeout)
        except BackendError as e:
            self._last_error = str(e)
            raise
        if not audio:
            raise BackendError("Irodori-TTS-Server から音声が返らなかった")
        if content_type not in ("audio/wav", "audio/x-wav", "application/octet-stream"):
            raise BackendError(
                "Irodori-TTS-Server が音声以外を返した: %s" % content_type)
        self._available = True
        self._last_error = ""
        runtime = self._health.setdefault("runtime", {})
        if isinstance(runtime, dict):
            runtime["loaded"] = True
            runtime["loading"] = False
        return audio
