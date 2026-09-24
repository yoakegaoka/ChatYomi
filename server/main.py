"""TTS ラッパーサーバ本体。

起動:
    python -m server.main
    python -m server.main --backend irodori_server
"""

from __future__ import annotations

import argparse
import asyncio
import ipaddress
import logging
import os
import re
import signal
import sys
import time
from pathlib import Path
from urllib.parse import quote

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, Response
from pydantic import BaseModel, Field

from . import audio, config as config_mod
from .backends import BackendError, create_backend
from .readings import Readings
from .voices import VoiceStore

# 音声名に日本語が使えるので、ログが cp932 で化けないようにする。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:  # 再設定できない環境では諦める
        pass

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("tts.server")

HERE = Path(__file__).resolve().parent


# ---------------------------------------------------------------- 状態

class State:
    """プロセス全体で 1 つ。GPU が 1 つなので合成は直列化する。"""

    def __init__(self, cfg):
        self.cfg = cfg
        self.backend = create_backend(cfg)
        self.voices = VoiceStore(cfg.voices_path)
        self.readings = Readings(
            cfg.readings_paths,
            cfg.readings_unknown_path,
            collect_unknown=cfg.readings_collect_unknown,
        )
        self.sem = asyncio.Semaphore(1)
        self.pending = 0          # キューの長さ（待ち + 実行中）

    @property
    def model_loaded(self) -> bool:
        return self.backend.model_loaded


state: State = None  # type: ignore  # startup で差し込む


# ---------------------------------------------------------------- 認証

def _header_safe(value: str | None) -> str:
    """HTTP ヘッダに載せられる形にする。

    ヘッダは latin-1 しか通らないため、日本語の音声名をそのまま入れると
    レスポンス構築時に落ちる。読む側は decodeURIComponent で戻せる。
    """
    if not value:
        return ""
    return quote(str(value), safe="")


def _is_loopback(request: Request) -> bool:
    host = request.client.host if request.client else ""
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return host in ("localhost", "")


def require_token(request: Request) -> None:
    """ループバック以外からのアクセスには X-Api-Token を要求する。"""
    if _is_loopback(request):
        return
    if request.headers.get("X-Api-Token") != state.cfg.api_token:
        raise HTTPException(status_code=401, detail="invalid or missing X-Api-Token")


# ---------------------------------------------------------------- アプリ

app = FastAPI(title="Irodori-TTS 読み上げラッパー", docs_url="/docs")


@app.on_event("startup")
async def _startup():
    # Irodori-TTS-Server の接続状態を起動時に確認する。
    if state.cfg.backend != "dummy":
        log.info("Irodori-TTS-Server への接続を確認中")
        t0 = time.time()
        await asyncio.to_thread(state.backend.load)
        log.info("Irodori-TTS-Server への接続を確認 %.1fs", time.time() - t0)
    log.info("ready: http://127.0.0.1:%d/admin", state.cfg.port)


# ------------------------------------------------------------ /synthesize

# ユーザースクリプトが対応しているサイト。管理UIに並べるために持っておく。
# config.yaml に未知のサイトが書かれていればそれも足す（先に増やしておける）
KNOWN_SITES = ("claude", "copilot", "gemini", "chatgpt")
SITE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")


def _site_ids() -> list[str]:
    ids = list(KNOWN_SITES)
    for k in state.cfg.site_voices:
        if k not in ids:
            ids.append(k)
    return ids


class SynthesizeRequest(BaseModel):
    text: str
    # クライアントが明示した音声。空ならサーバのサイト割り当てに従う
    voice: str | None = None
    # 依頼元のサイト（claude / copilot / gemini）。音声の選択はサーバ側で行う
    site: str | None = None
    request_id: str | None = None
    seq: int | None = None
    format: str | None = None
    num_candidates: int = Field(default=1, ge=1, le=8)


@app.post("/synthesize", dependencies=[Depends(require_token)])
async def synthesize(req: SynthesizeRequest):
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is empty")
    if not state.model_loaded:
        raise HTTPException(status_code=503, detail="model is not loaded")

    # 投げすぎに対する保護
    if state.pending >= state.cfg.queue_limit:
        raise HTTPException(status_code=429, detail="queue is full")

    # 音声の決定はサーバの責任。クライアントは「どのサイトか」を伝えるだけでよい
    voice = state.voices.resolve(req.voice, state.cfg.voice_for_site(req.site))
    fmt = req.format or state.cfg.default_format

    # 合成に渡す直前で読みを置き換える。
    # ここが落ちても読み上げは止めない。prepare が例外を握る
    spoken = state.readings.prepare(text) if state.cfg.readings_enabled else text

    state.pending += 1
    t0 = time.time()
    try:
        async with state.sem:
            wav = await asyncio.to_thread(state.backend.synthesize, spoken, voice)
        data, ctype = audio.convert(wav, fmt)
    except audio.UnsupportedFormat as e:
        raise HTTPException(status_code=400, detail=str(e))
    except BackendError as e:
        log.error("synthesize failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        state.pending -= 1

    # 合成結果の診断情報。本文はログに残さない。
    log.info("seq=%s site=%s voice=%s chars=%d bytes=%d %.2fs%s",
             req.seq, req.site or "-", voice.name, len(text), len(data), time.time() - t0,
             "" if spoken == text else "  読み替えあり")

    return Response(content=data, media_type=ctype, headers={
        "X-Request-Id": _header_safe(req.request_id),
        "X-Seq": "" if req.seq is None else str(req.seq),
        # 音声名には日本語が使える。HTTP ヘッダは latin-1 しか通らないので百分率符号化する
        "X-Voice": _header_safe(voice.name),
    })


# ---------------------------------------------------------------- /health

@app.get("/health")
async def health():
    details = await asyncio.to_thread(state.backend.refresh_health)
    return {
        "status": "ok",
        "model_loaded": state.model_loaded,
        "current_voice": state.cfg.current_voice or "default",
        "model": details.get("checkpoint") or state.cfg.irodori_server_model,
        "queue_length": state.pending,
        "backend": state.backend.name,
        "backend_details": details,
    }


# ---------------------------------------------------------------- /voices

@app.get("/voices", dependencies=[Depends(require_token)])
async def list_voices():
    return {
        "voices": state.voices.as_dicts(),
        "current": state.cfg.current_voice or "default",
    }


class CurrentVoiceRequest(BaseModel):
    name: str


@app.put("/voices/current", dependencies=[Depends(require_token)])
async def set_current_voice(req: CurrentVoiceRequest):
    if not state.voices.get(req.name):
        raise HTTPException(status_code=404, detail="unknown voice: %s" % req.name)
    state.cfg.current_voice = req.name
    state.cfg.save()
    log.info("current_voice -> %s", req.name)
    return {"current": req.name}


class SiteVoiceRequest(BaseModel):
    # 空文字なら割り当てを外し、既定音声に戻す
    name: str = ""


@app.get("/sites", dependencies=[Depends(require_token)])
async def list_sites():
    """サイトごとの音声割り当て。管理UIが表示に使う。"""
    return {
        "sites": [{"id": sid, "voice": state.cfg.site_voices.get(sid, "")}
                  for sid in _site_ids()],
        "current": state.cfg.current_voice,
    }


@app.put("/sites/{site}/voice", dependencies=[Depends(require_token)])
async def set_site_voice(site: str, req: SiteVoiceRequest):
    if not SITE_ID_RE.match(site):
        raise HTTPException(status_code=400, detail="invalid site id: %s" % site)
    if req.name:
        if not state.voices.get(req.name):
            raise HTTPException(status_code=404, detail="unknown voice: %s" % req.name)
        state.cfg.site_voices[site] = req.name
    else:
        state.cfg.site_voices.pop(site, None)
    state.cfg.save()
    log.info("site_voice %s -> %s", site, req.name or "(既定に従う)")
    return {"site": site, "voice": req.name}


class VoiceParamsRequest(BaseModel):
    params: dict


@app.put("/voices/{name}/params", dependencies=[Depends(require_token)])
async def update_voice_params(name: str, req: VoiceParamsRequest):
    """voice.yaml の生成パラメータを書き換える。"""
    try:
        v = state.voices.update_params(name, dict(req.params))
    except KeyError:
        raise HTTPException(status_code=404, detail="unknown voice: %s" % name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    log.info("voice params updated: %s %s", name, req.params)
    return {"name": v.name, "params": v.params}


@app.post("/voices/reload", dependencies=[Depends(require_token)])
async def reload_voices():
    n = state.voices.reload()
    return {"count": n, "voices": state.voices.as_dicts()}


@app.post("/voices", dependencies=[Depends(require_token)])
async def create_voice(name: str = Form(...), file: UploadFile | None = File(None)):
    data = await file.read() if file else None
    try:
        v = state.voices.create(name, data, file.filename if file else "ref.wav")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    log.info("voice created: %s", v.name)
    return {"name": v.name, "voices": state.voices.as_dicts()}


@app.delete("/voices/{name}", dependencies=[Depends(require_token)])
async def delete_voice(name: str):
    try:
        state.voices.delete(name)
    except KeyError:
        raise HTTPException(status_code=404, detail="unknown voice: %s" % name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if state.cfg.current_voice == name:
        state.cfg.current_voice = ""
    state.cfg.site_voices = {site: voice for site, voice in state.cfg.site_voices.items()
                             if voice != name}
    state.cfg.save()
    return {"voices": state.voices.as_dicts()}


# -------------------------------------------------------------- /readings

@app.get("/readings", dependencies=[Depends(require_token)])
async def list_readings():
    """読み替え辞書の一覧。"""
    return state.readings.as_dicts()


@app.post("/readings/reload", dependencies=[Depends(require_token)])
async def reload_readings():
    """辞書を読み直す。readings.local.yaml を手で足したときに使う。"""
    n = state.readings.reload()
    return {"count": n, **state.readings.as_dicts()}


class ReadingsPreviewRequest(BaseModel):
    text: str


@app.post("/readings/preview", dependencies=[Depends(require_token)])
async def preview_readings(req: ReadingsPreviewRequest):
    """置換の結果だけを返す。音は作らない。

    規則を足したときの確認用。GPU を使わないので待たずに済む。
    """
    out, hits = state.readings.apply(req.text or "")
    return {"text": out, "hits": hits}


@app.get("/readings/unknown", dependencies=[Depends(require_token)])
async def list_unknown():
    """辞書に無かった英単語を多い順に返す。tools/make_readings.py の入力。"""
    state.readings.flush()
    items = sorted(state.readings.unknown.values(),
                   key=lambda u: (-u.count, u.form.casefold()))
    return {"words": [{"form": u.form, "count": u.count,
                       "first": u.first, "last": u.last} for u in items]}


# ----------------------------------------------------------------- /admin

@app.get("/admin", response_class=HTMLResponse)
async def admin_page():
    return (HERE / "admin.html").read_text(encoding="utf-8")


# --- ユーザースクリプトの配信 -------------------------------------------
# .user.js で終わる URL を開くとマネージャがインストール画面を出す。
# 手作業のコピー＆ペーストより確実で、スマホでも同じ手が使える。
# 認証は掛けない。スクリプト自体に秘密は含まれていない。

USERSCRIPTS = {
    "tts-readaloud.user.js": HERE.parent / "userscript" / "tts-readaloud.user.js",
}


# 既定のサーバURL。配信時に「実際にアクセスされた URL」へ書き換える
_DEFAULT_URL_RE = re.compile(r"(serverUrl: )'http://127\.0\.0\.1:8080'")


def _with_server_url(source: str, request: Request) -> str:
    """スクリプト内の既定サーバURLを、実際にアクセスされた URL に差し替える。

    スマホから http://192.168.x.x:8080/... で入れた場合、そのアドレスが既定になる。
    小さな画面で IP を手入力させずに済ませるため。
    設定パネルで保存済みの値があればそちらが優先されるので、既存の環境は変わらない。
    """
    base = str(request.base_url).rstrip("/")
    if not base:
        return source
    return _DEFAULT_URL_RE.sub(lambda m: m.group(1) + "'" + base + "'", source, count=1)


@app.get("/{name}.user.js")
async def serve_userscript(name: str, request: Request):
    path = USERSCRIPTS.get(name + ".user.js")
    if not path or not path.exists():
        raise HTTPException(status_code=404, detail="unknown userscript: %s" % name)
    return Response(
        content=_with_server_url(path.read_text(encoding="utf-8"), request),
        # マネージャに認識させるため text/javascript で返す
        media_type="text/javascript; charset=utf-8",
    )


class DebugReport(BaseModel):
    text: str
    site: str | None = None


@app.post("/debug", dependencies=[Depends(require_token)])
async def debug_report(req: DebugReport):
    """クライアントの診断結果をサーバのログに出す。

    Android の Firefox では開発者コンソールが見られないため、
    スマホ側の切り分けにはこの経路が要る。
    """
    body = (req.text or "")[:8000]          # 事故で巨大な本文が来ても落とさない
    log.info("---- クライアント診断 site=%s ----", req.site or "-")
    for line in body.splitlines():
        log.info("  %s", line)
    log.info("---- ここまで ----")
    return {"received": len(body)}


class PreviewRequest(BaseModel):
    text: str
    voice: str | None = None
    num_candidates: int = Field(default=1, ge=1, le=4)
    # voice.yaml に保存する前に耳で比べるための一時的な上書き
    duration_scale: float | None = Field(default=None, ge=2 / 3, le=2.0)
    # 生成ステップ数。小さいほど速いが音質が落ちる。実測（1文・参照音声あり）:
    # 未指定 1.99秒 / 32 1.78秒 / 24 1.59秒 / 20 1.54秒 / 16 1.40秒 / 12 1.31秒
    num_steps: int | None = Field(default=None, ge=4, le=40)


@app.post("/admin/preview", dependencies=[Depends(require_token)])
async def preview(req: PreviewRequest):
    """管理UIの試聴。複数候補を base64 で返す。"""
    import base64
    import dataclasses

    if not state.model_loaded:
        raise HTTPException(status_code=503, detail="model is not loaded")

    voice = state.voices.resolve(req.voice, state.cfg.current_voice)
    spoken = state.readings.prepare(req.text) if state.cfg.readings_enabled else req.text
    overrides = {k: v for k, v in (("duration_scale", req.duration_scale),
                                   ("num_steps", req.num_steps)) if v is not None}
    if overrides:
        voice = dataclasses.replace(voice, params={**voice.params, **overrides})
    t0 = time.time()
    try:
        async with state.sem:
            wavs = await asyncio.to_thread(
                state.backend.synthesize_candidates, spoken, voice, req.num_candidates
            )
    except BackendError as e:
        raise HTTPException(status_code=500, detail=str(e))

    log.info("preview voice=%s candidates=%d %.2fs", voice.name, len(wavs), time.time() - t0)
    return {
        "voice": voice.name,
        "elapsed": round(time.time() - t0, 2),
        "candidates": [base64.b64encode(w).decode("ascii") for w in wavs],
    }


@app.post("/admin/shutdown", dependencies=[Depends(require_token)])
async def shutdown():
    log.info("shutdown requested")
    state.readings.flush()

    async def _stop():
        await asyncio.sleep(0.3)  # レスポンスを返しきってから落とす
        os.kill(os.getpid(), signal.SIGINT)

    asyncio.create_task(_stop())
    return {"status": "shutting down"}


# ------------------------------------------------------------------ 起動

def build(cfg) -> FastAPI:
    global state
    state = State(cfg)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cfg.cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["X-Seq", "X-Request-Id", "X-Voice"],
    )
    return app


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=None)
    ap.add_argument("--backend", default=None,
                    choices=["dummy", "irodori_server"])
    ap.add_argument("--port", type=int, default=None)
    args = ap.parse_args()

    cfg = config_mod.load(args.config)
    if args.backend:
        cfg.backend = args.backend
    if args.port:
        cfg.port = args.port

    build(cfg)

    import uvicorn
    log.info("backend=%s voices=%s", cfg.backend, cfg.voices_path)
    uvicorn.run(app, host=cfg.host, port=cfg.port, log_level="warning")


if __name__ == "__main__":
    main()
