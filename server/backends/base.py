"""バックエンドの共通インターフェース。

Irodori-TTS の呼び出しはこのモジュール配下に閉じ込める。
アプリ本体は synthesize() だけを知っていればよい。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class VoiceConfig:
    """voices/<name>/ 1 つ分の設定。"""

    name: str
    display_name: str = ""
    ref_audio: Path | None = None            # ref.wav
    speaker_embedding: Path | None = None    # speaker.safetensors（あればこちらを優先）
    params: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self):
        if not self.display_name:
            self.display_name = self.name

    @property
    def has_speaker(self) -> bool:
        """話者条件付けを行うか。どちらも無ければモデル既定の声になる。"""
        return self.speaker_embedding is not None or self.ref_audio is not None

class BackendError(RuntimeError):
    pass


class Backend:
    """実装は synthesize() だけ必須。"""

    name = "base"

    def synthesize(self, text: str, voice: VoiceConfig) -> bytes:
        """テキストを wav バイナリに変換して返す"""
        raise NotImplementedError

    def synthesize_candidates(self, text: str, voice: VoiceConfig, n: int) -> list[bytes]:
        """管理UIの試聴用に複数候補を返す。

        既定は synthesize() の繰り返し。まとめて生成できるバックエンドは上書きする。
        """
        return [self.synthesize(text, voice) for _ in range(max(1, n))]

    # --- モデルの常駐制御。対応しないバックエンドは何もしない ---

    def load(self) -> None:
        pass

    @property
    def model_loaded(self) -> bool:
        return True

    def health_details(self) -> dict:
        """管理・診断用のバックエンド固有情報。"""
        return {}

    def refresh_health(self) -> dict:
        """外部状態を更新し、管理・診断用の情報を返す。"""
        return self.health_details()
