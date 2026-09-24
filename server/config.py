"""config.yaml の読み書き。"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from pathlib import Path

import yaml

log = logging.getLogger("tts.config")
ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PATH = ROOT / "config.yaml"
_save_lock = threading.Lock()


@dataclass
class Config:
    host: str = "0.0.0.0"
    port: int = 8080
    api_token: str = "change-me"

    # 通常利用はIrodori-TTS-Server。dummyは自動検証専用。
    backend: str = "irodori_server"
    irodori_server_url: str = "http://127.0.0.1:8088"
    irodori_server_api_key: str = ""
    irodori_server_model: str = "irodori-tts"

    voices_dir: str = "./voices"
    current_voice: str = ""
    site_voices: dict[str, str] = field(default_factory=dict)

    readings_enabled: bool = True
    readings_collect_unknown: bool = True

    default_format: str = "wav48"
    queue_limit: int = 10
    cors_origins: list[str] = field(default_factory=lambda: ["https://claude.ai"])

    path: Path = field(default=DEFAULT_PATH, repr=False)

    @property
    def voices_path(self) -> Path:
        p = Path(self.voices_dir)
        return p if p.is_absolute() else (ROOT / p).resolve()

    @property
    def readings_paths(self) -> list[Path]:
        """読み替え辞書。後から読んだ方が勝つ。"""
        return [ROOT / "readings.yaml"] + sorted(ROOT.glob("readings.local*.yaml"))

    @property
    def readings_unknown_path(self) -> Path:
        return ROOT / "readings.unknown.yaml"

    def voice_for_site(self, site: str | None) -> str:
        if site:
            name = self.site_voices.get(site)
            if name:
                return name
        return self.current_voice

    def save(self) -> None:
        """管理UIから変更できる設定をconfig.yamlへ保存する。"""
        data = {
            "host": self.host,
            "port": self.port,
            "api_token": self.api_token,
            "backend": self.backend,
            "irodori_server_url": self.irodori_server_url,
            "irodori_server_api_key": self.irodori_server_api_key,
            "irodori_server_model": self.irodori_server_model,
            "voices_dir": self.voices_dir,
            "current_voice": self.current_voice,
            "site_voices": self.site_voices,
            "readings_enabled": self.readings_enabled,
            "readings_collect_unknown": self.readings_collect_unknown,
            "default_format": self.default_format,
            "queue_limit": self.queue_limit,
            "cors_origins": self.cors_origins,
        }
        with _save_lock:
            tmp = self.path.with_suffix(".yaml.tmp")
            tmp.write_text(
                yaml.safe_dump(data, allow_unicode=True, sort_keys=False),
                encoding="utf-8",
            )
            tmp.replace(self.path)


def load(path: Path | str | None = None) -> Config:
    p = Path(path) if path else DEFAULT_PATH
    if not p.exists():
        log.warning("%s が無いので既定値で起動する", p)
        return Config(path=p)

    raw = yaml.safe_load(p.read_text(encoding="utf-8-sig")) or {}
    known = {f for f in Config.__dataclass_fields__ if f != "path"}
    unknown = set(raw) - known
    if unknown:
        log.warning("廃止済みの設定を無視する: %s", ", ".join(sorted(unknown)))
    values = {k: v for k, v in raw.items() if k in known}
    if values.get("backend") in ("gradio", "python"):
        log.warning("廃止済みbackend=%sをirodori_serverとして扱う", values["backend"])
        values["backend"] = "irodori_server"
    return Config(**values, path=p)
