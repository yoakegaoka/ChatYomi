"""読み替え辞書と、未知の英単語の記録。

Irodori-TTS は日本語の読み上げには強いが、英単語や記号の読みを外すことが多い。
「Claude」を「クロード」と読ませられないのが典型で、合成に渡す直前に
テキストを置き換えて精度を上げる。

置換をサーバに置く理由は 3 つ。

- 辞書が 1 か所で済む。4 サイト分のクライアントに配る必要がない
- 語を足すのにユーザースクリプトの入れ直しが要らない
- 置換前後をサーバのログで追える

**ここで例外が出ても読み上げは止めない。** 読みの精度は本質ではなく、
音が出ないことの方が困る。失敗したら元のテキストをそのまま返す。
"""

from __future__ import annotations

import logging
import re
import threading
import time
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

import yaml

log = logging.getLogger("tts.readings")

# 未知語ファイルの書き出し間隔。逐次読み上げでは 1 文ごとにここを通るため、
# 合成のたびにディスクへ書かない
FLUSH_SEC = 30.0

# 未知語として拾う英単語。内側の . ' - は語の一部として残す（Node.js, Wi-Fi）
WORD_RE = re.compile(r"[A-Za-z]+(?:[.'’-][A-Za-z]+)*")

# 1 文字の英字は読み違えても実害が小さいので数えない
MIN_WORD_LEN = 2

# 置換先に英字が残っていると、後段の規則に二重で当たりうる。読み込み時に警告する
ASCII_RE = re.compile(r"[A-Za-z]")


@dataclass
class Rule:
    """1 件の置換規則。"""

    src: str
    dst: str
    # 元ファイル。どちらの辞書から来たかを一覧に出すために持つ
    origin: str = ""


@dataclass
class Unknown:
    """辞書に無かった英単語 1 件。"""

    # 一番多く現れた表記。Claude と claude は畳んで数え、多い方を残す
    form: str
    count: int = 0
    first: str = ""
    last: str = ""
    # 表記ごとの出現数。form を決めるためだけに持つ
    forms: dict[str, int] = field(default_factory=dict)


def _is_acronym(src: str) -> bool:
    """全部大文字の語か。

    大文字小文字を区別するかの判断に使う。区別せずに当てると
    `IT` の規則が `it` に当たるような事故が起きる。
    """
    return src.isupper() and any(c.isalpha() for c in src)


def _literal_pattern(src: str) -> str:
    """語の規則 1 件を正規表現にする。

    英数字で始まる／終わる語には境界を付ける。`Claude` が `Claudette` の
    中に当たってはいけない。日本語には \\b が効かないので、
    「英数字が隣接していないこと」を見る。「Claudeは」は当ててよい。
    """
    body = re.escape(src)
    if not _is_acronym(src):
        body = "(?i:" + body + ")"
    head = r"(?<![A-Za-z0-9])" if src[0].isalnum() else ""
    tail = r"(?![A-Za-z0-9])" if src[-1].isalnum() else ""
    return head + body + tail


class Readings:
    """辞書の読み込み・置換・未知語の記録。プロセスに 1 つ。"""

    def __init__(self, paths: list[Path], unknown_path: Path | None = None,
                 collect_unknown: bool = True):
        self.paths = paths
        self.unknown_path = unknown_path
        self.collect_unknown = collect_unknown

        self.rules: list[Rule] = []
        self.patterns: list[Rule] = []
        self.ignore: set[str] = set()

        self._lit: dict[str, str] = {}
        self._re: re.Pattern | None = None
        self._pats: list[tuple[re.Pattern, str]] = []

        self.unknown: dict[str, Unknown] = {}
        self._dirty = False
        self._flushed_at = 0.0
        self._lock = threading.Lock()

        self.reload()

    # ------------------------------------------------------------ 読み込み

    def reload(self) -> int:
        """辞書を読み直す。返すのは規則の総数。

        後から読んだファイルが勝つ。readings.local.yaml で
        同梱辞書の読みを上書きできるようにするため。
        """
        rules: dict[str, Rule] = {}
        patterns: list[Rule] = []
        ignore: set[str] = set()

        for p in self.paths:
            if not p.exists():
                continue
            try:
                raw = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
            except Exception as e:
                log.warning("%s を読めないので飛ばす: %s", p.name, e)
                continue

            for section in ("words", "symbols"):
                for src, dst in (raw.get(section) or {}).items():
                    # 読みが空なら読み飛ばす。YAML で値を書き忘れると None が来るが、
                    # str(None) は "None" になり、そのまま読み上げてしまう（実機で確認）
                    src = str(src)
                    dst = "" if dst is None else str(dst)
                    if not src:
                        continue
                    key = src.casefold()
                    if key in rules and rules[key].src != src:
                        log.warning("%s: %s と %s は同じ規則として扱われる",
                                    p.name, rules[key].src, src)
                    rules[key] = Rule(src, dst, p.name)

            for item in (raw.get("patterns") or []):
                try:
                    src, dst = str(item["from"]), str(item["to"])
                    re.compile(src)
                except Exception as e:
                    log.warning("%s: 正規表現を飛ばす %r: %s", p.name, item, e)
                    continue
                patterns.append(Rule(src, dst, p.name))

            for w in (raw.get("ignore") or []):
                ignore.add(str(w).casefold())

        for r in rules.values():
            if ASCII_RE.search(r.dst):
                log.warning("%s の読み %r に英字が残っている。別の規則に当たりうる",
                            r.src, r.dst)

        # 長い語から先に当てる。Claude Code が Claude で切られないようにするため
        ordered = sorted(rules.values(), key=lambda r: (-len(r.src), r.src))
        self.rules = ordered
        self.patterns = patterns
        self.ignore = ignore
        self._lit = {r.src.casefold(): r.dst for r in ordered}
        self._re = (re.compile("|".join(_literal_pattern(r.src) for r in ordered))
                    if ordered else None)
        self._pats = [(re.compile(r.src), r.dst) for r in patterns]

        if self.unknown_path and not self.unknown:
            self._load_unknown()

        log.info("読み替え辞書: 語 %d 件 正規表現 %d 件 除外 %d 件",
                 len(ordered), len(patterns), len(ignore))
        return len(ordered) + len(patterns)

    # -------------------------------------------------------------- 置換

    def apply(self, text: str) -> tuple[str, list[str]]:
        """読みを置き換えたテキストと、当たった語の一覧を返す。

        正規表現の規則を先に、語の規則を後に当てる。
        **語の規則どうしは 1 回の走査で片付ける。**
        順に置換すると、置換結果がさらに別の規則に当たって壊れるため。
        """
        hits: list[str] = []

        for pat, dst in self._pats:
            text = pat.sub(dst, text)

        if self._re is not None:
            def swap(m: re.Match) -> str:
                s = m.group(0)
                hits.append(s)
                return self._lit.get(s.casefold(), s)

            text = self._re.sub(swap, text)

        return text, hits

    def prepare(self, text: str) -> str:
        """合成に渡す直前の処理。置換して、残った英単語を数える。

        **例外を外へ出さない。** 辞書の不備で読み上げが止まってはいけない。
        """
        if not text:
            return text
        try:
            out, hits = self.apply(text)
            if hits:
                log.debug("読み替え %d 件: %s", len(hits), " ".join(hits[:8]))
            self.note_unknown(out)
            return out
        except Exception as e:
            log.warning("読み替えに失敗したので元の文を使う: %s", e)
            return text

    # ---------------------------------------------------------- 未知語

    def note_unknown(self, text: str) -> None:
        """置換後に残った英単語を数える。

        置換済みのテキストを見るので、辞書に載っている語は自然に外れる。
        **文脈は残さない。** 会話の断片をファイルに落とさないため。
        """
        if not self.collect_unknown or not self.unknown_path:
            return
        today = date.today().isoformat()
        for w in WORD_RE.findall(text):
            if len(w) < MIN_WORD_LEN:
                continue
            key = w.casefold()
            if key in self.ignore or key in self._lit:
                continue
            u = self.unknown.get(key)
            if u is None:
                u = self.unknown[key] = Unknown(form=w, first=today)
            u.count += 1
            u.last = today
            u.forms[w] = u.forms.get(w, 0) + 1
            u.form = max(u.forms.items(), key=lambda kv: (kv[1], kv[0]))[0]
            self._dirty = True
        self._flush_if_due()

    def _flush_if_due(self) -> None:
        now = time.monotonic()
        if not self._dirty or now - self._flushed_at < FLUSH_SEC:
            return
        self._flushed_at = now
        self.flush()

    def flush(self) -> None:
        """未知語ファイルを書き出す。多い順に並べる。"""
        if not self.unknown_path or not self._dirty:
            return
        data = {
            u.form: {"count": u.count, "first": u.first, "last": u.last}
            for u in sorted(self.unknown.values(),
                            key=lambda u: (-u.count, u.form.casefold()))
        }
        try:
            with self._lock:
                tmp = self.unknown_path.with_suffix(".yaml.tmp")
                tmp.write_text(
                    "# 辞書に無かった英単語。tools/make_readings.py が読む。\n"
                    "# 手で消してよい。消えても読み上げには影響しない。\n"
                    + yaml.safe_dump(data, allow_unicode=True, sort_keys=False),
                    encoding="utf-8",
                )
                tmp.replace(self.unknown_path)
            self._dirty = False
        except Exception as e:
            log.warning("未知語ファイルを書けない: %s", e)

    def _load_unknown(self) -> None:
        """前回までの数を引き継ぐ。サーバを起動し直すたびに 0 に戻ると溜まらない。"""
        p = self.unknown_path
        if not p or not p.exists():
            return
        try:
            raw = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
        except Exception as e:
            log.warning("%s を読めない: %s", p.name, e)
            return
        for form, v in raw.items():
            v = v or {}
            u = Unknown(form=str(form), count=int(v.get("count", 0)),
                        first=str(v.get("first", "")), last=str(v.get("last", "")))
            u.forms[u.form] = u.count
            self.unknown[u.form.casefold()] = u
        log.info("未知語を %d 件引き継いだ", len(self.unknown))

    # ------------------------------------------------------------ 一覧

    def as_dicts(self) -> dict:
        return {
            "words": [{"from": r.src, "to": r.dst, "origin": r.origin}
                      for r in self.rules],
            "patterns": [{"from": r.src, "to": r.dst, "origin": r.origin}
                         for r in self.patterns],
            "ignore": sorted(self.ignore),
            "unknown_count": len(self.unknown),
        }
