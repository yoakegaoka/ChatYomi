"""voices/ ディレクトリの管理。

  voices/
    <name>/
      ref.wav               リファレンス音声
      speaker.safetensors   話者埋め込み（あればこちらを優先）
      voice.yaml            表示名と生成パラメータ（省略可）

ディレクトリを置くだけで声が増える。単一の対応表ファイルは持たない。
"""

from __future__ import annotations

import logging
import math
import shutil
import threading
import wave
from pathlib import Path

import yaml

from .backends import VoiceConfig

log = logging.getLogger("tts.voices")

REF_AUDIO_NAMES = ("ref.wav", "reference.wav")

# 参照音声がこれより長いと警告する。
# 長い参照音声はメモリ使用量と合成時間を増やす場合がある。
# 60 秒を超えたら利用者に知らせる。自動では切り詰めない。
REF_WARN_SEC = 60.0


def _warn_if_long(ref: Path) -> None:
    """参照音声が長すぎないか見る。読むだけで、勝手に切らない。

    切ると声が変わる。どこを使うかは人が耳で決めることなので、
    ここでは気づける形にするに留める。
    """
    try:
        with wave.open(str(ref)) as w:
            sec = w.getnframes() / float(w.getframerate() or 1)
    except Exception:
        return          # wav 以外や壊れたファイルは黙って諦める
    if sec > REF_WARN_SEC:
        log.warning("%s は %.0f 秒ある。%.0f 秒以下への短縮を検討すること。"
                    "長い参照音声はメモリ使用量や合成時間を増やす場合がある",
                    ref.parent.name + "/" + ref.name, sec, REF_WARN_SEC)
EMBEDDING_SUFFIX = ".safetensors"
DEFAULT_VOICE = "default"  # 話者条件付けなし＝モデル既定の声


class VoiceStore:
    def __init__(self, root: Path):
        self.root = root
        self._voices: dict[str, VoiceConfig] = {}
        self._lock = threading.Lock()
        self.reload()

    # ------------------------------------------------------------ 走査

    def reload(self) -> int:
        """voices/ を再スキャンする。"""
        found: dict[str, VoiceConfig] = {}

        # 参照音声を持たない既定の声。voices/ が空でも合成できるようにする
        found[DEFAULT_VOICE] = VoiceConfig(
            name=DEFAULT_VOICE, display_name="デフォルト（参照音声なし）"
        )

        if self.root.exists():
            for d in sorted(p for p in self.root.iterdir() if p.is_dir()):
                v = self._load_one(d)
                if v:
                    found[v.name] = v
        else:
            log.warning("voices ディレクトリが無い: %s", self.root)

        with self._lock:
            self._voices = found
        log.info("voices: %d 件 (%s)", len(found), ", ".join(found))
        return len(found)

    def _load_one(self, d: Path) -> VoiceConfig | None:  # noqa: D401
        params: dict = {}
        display = ""

        yml = d / "voice.yaml"
        if yml.exists():
            try:
                data = yaml.safe_load(yml.read_text(encoding="utf-8")) or {}
                display = data.pop("display_name", "") or ""
                params = data
            except Exception as e:
                log.warning("%s の読み込みに失敗: %s", yml, e)

        ref = next((d / n for n in REF_AUDIO_NAMES if (d / n).exists()), None)
        emb = next(iter(sorted(d.glob("*" + EMBEDDING_SUFFIX))), None)
        if ref is not None:
            _warn_if_long(ref)

        if ref is None and emb is None and not yml.exists():
            return None  # 空ディレクトリは無視する

        return VoiceConfig(
            name=d.name, display_name=display,
            ref_audio=ref, speaker_embedding=emb, params=params,
        )

    # ------------------------------------------------------------ 参照

    def names(self) -> list[str]:
        with self._lock:
            return sorted(self._voices)

    def get(self, name: str) -> VoiceConfig | None:
        with self._lock:
            return self._voices.get(name)

    def resolve(self, name: str | None, current: str) -> VoiceConfig:
        """voice 未指定なら current_voice を使う。"""
        for candidate in (name, current, DEFAULT_VOICE):
            if candidate:
                v = self.get(candidate)
                if v:
                    return v
        # DEFAULT_VOICE は reload() で必ず作られるのでここには来ない
        return VoiceConfig(name=DEFAULT_VOICE)

    def as_dicts(self) -> list[dict]:
        with self._lock:
            vs = list(self._voices.values())
        return [
            {
                "name": v.name,
                "display_name": v.display_name,
                "has_ref_audio": bool(v.ref_audio),
                "has_speaker_embedding": bool(v.speaker_embedding),
                "source": ("speaker_embedding" if v.speaker_embedding
                           else "ref_audio" if v.ref_audio else "none"),
                "params": v.params,
            }
            for v in sorted(vs, key=lambda x: x.name)
        ]

    # ------------------------------------------------------------ 更新

    def create(self, name: str, ref_audio: bytes | None,
               filename: str = "ref.wav", params: dict | None = None) -> VoiceConfig:
        safe = _safe_name(name)
        d = self.root / safe
        if safe == DEFAULT_VOICE:
            raise ValueError("標準の声と同じ名前は使えません")
        if ref_audio is not None and Path(filename).suffix.lower() not in (".wav", EMBEDDING_SUFFIX):
            raise ValueError("WAVまたはsafetensors形式のファイルを選んでください")
        try:
            d.mkdir(parents=True, exist_ok=False)
        except FileExistsError as e:
            raise ValueError("同じ名前の声が既にあります") from e

        if ref_audio:
            suffix = Path(filename).suffix.lower()
            if suffix == EMBEDDING_SUFFIX:
                (d / ("speaker" + EMBEDDING_SUFFIX)).write_bytes(ref_audio)
            else:
                (d / "ref.wav").write_bytes(ref_audio)

        if params or not ref_audio:
            (d / "voice.yaml").write_text(
                yaml.safe_dump(params or {"display_name": name}, allow_unicode=True, sort_keys=False),
                encoding="utf-8",
            )

        self.reload()
        v = self.get(safe)
        if not v:
            raise ValueError("音声を作成できなかった: %s" % safe)
        return v

    def update_params(self, name: str, params: dict) -> VoiceConfig:
        v = self.get(name)
        if not v or v.name == DEFAULT_VOICE:
            raise KeyError(name)
        scale = params.get("duration_scale")
        if scale is not None and (
            isinstance(scale, bool) or not isinstance(scale, (int, float))
            or not math.isfinite(scale) or not 2 / 3 <= scale <= 2
        ):
            raise ValueError("話す速さは0.5～1.5倍で指定してください")
        steps = params.get("num_steps")
        if steps is not None and (
            isinstance(steps, bool) or not isinstance(steps, int) or not 4 <= steps <= 40
        ):
            raise ValueError("生成ステップ数は4～40で指定してください")
        d = self.root / v.name
        display = params.pop("display_name", v.display_name)
        data = dict(params)
        if display and display != v.name:
            data["display_name"] = display
        (d / "voice.yaml").write_text(
            yaml.safe_dump(data, allow_unicode=True, sort_keys=False), encoding="utf-8"
        )
        self.reload()
        return self.get(name)

    def delete(self, name: str) -> None:
        if name == DEFAULT_VOICE:
            raise ValueError("既定の声は削除できない")
        v = self.get(name)
        if not v:
            raise KeyError(name)
        shutil.rmtree(self.root / v.name)
        self.reload()


def _safe_name(name: str) -> str:
    """ディレクトリ名に使える形に正規化する。パス区切りは通さない。"""
    cleaned = "".join(c for c in name.strip() if c.isalnum() or c in "-_ぁ-んァ-ヶ一-龠")
    cleaned = cleaned.strip().replace(" ", "_")
    if not cleaned:
        raise ValueError("音声名が空、または使えない文字だけで構成されている")
    return cleaned
