"""溜まった未知の英単語に、LLM で読みを付ける。

    python tools/make_readings.py export            貼り付ける文面を作る
    python tools/make_readings.py import 返答.txt   返答を辞書にする

読み上げのたびに、辞書に無かった英単語が readings.unknown.yaml に溜まる。
それを AI チャットの画面に貼り、返ってきた読みを辞書に取り込む。

**API キーを扱わない。** 貼り付けと取り込みを人が挟む形にしてある
（取り込み前に人が確認する運用）。読み上げの経路に LLM を入れないので、
合成の待ち時間も増えない。

**取り込んだ読みはコメントアウトした状態で書く。** LLM の出力をそのまま
音にしない。管理UIの試聴で耳で確かめてから `#` を外すこと。
"""

from __future__ import annotations

import argparse
import re
import sys
from datetime import date
from pathlib import Path

import yaml

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except Exception:
        pass          # 古い Python では諦める

ROOT = Path(__file__).resolve().parent.parent

# カタカナと長音・中黒だけを認める。英字や漢字が混ざっていたら説明文の紛れ込み
KATAKANA_RE = re.compile(r"^[ァ-ヴー・]+$")

# 1 語あたりの読みの長さの上限。これを超えるのは説明が混ざっている見込み
def max_reading_len(word: str) -> int:
    return max(10, len(word) * 3)

# 1 回に渡す語数。多すぎると LLM の返答が雑になり、少なすぎると往復が増える
DEFAULT_LIMIT = 40

PROMPT = """\
次の英単語を、日本語の音声合成に読ませるためのカタカナ表記に直してください。

規則:
- 出力は「単語<タブ>カタカナ」の1行1件だけ。前置きも説明も書かない
- カタカナ以外の文字を混ぜない（長音「ー」と中黒「・」は使ってよい）
- 日本語話者が普通に読む発音に合わせる
- 1文字ずつ読む略語は、その読みを書く（例: API → エーピーアイ）
- 単位や記号を含む語は、読み下した形にする（例: km → キロメートル）
- 読み方が定まらないものは、その行ごと省く

単語:
"""


# ---------------------------------------------------------------- 読み込み

def load_yaml(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except Exception as e:
        print("%s を読めない: %s" % (path.name, e), file=sys.stderr)
        return {}


def known_words() -> set[str]:
    """既に辞書にある語（小文字化）。二重登録を防ぐために使う。"""
    known: set[str] = set()
    for path in [ROOT / "readings.yaml"] + sorted(ROOT.glob("readings.local*.yaml")):
        raw = load_yaml(path)
        for section in ("words", "symbols"):
            for k in (raw.get(section) or {}):
                known.add(str(k).casefold())
        for w in (raw.get("ignore") or []):
            known.add(str(w).casefold())
    return known


def unknown_words(min_count: int) -> list[tuple[str, int]]:
    """未知語を多い順に返す。既に辞書にある語は外す。"""
    raw = load_yaml(ROOT / "readings.unknown.yaml")
    known = known_words()
    out = []
    for form, v in raw.items():
        form = str(form)
        if form.casefold() in known:
            continue
        count = int((v or {}).get("count", 0))
        if count < min_count:
            continue
        out.append((form, count))
    out.sort(key=lambda kv: (-kv[1], kv[0].casefold()))
    return out


# -------------------------------------------------------------- export

def do_export(args) -> int:
    words = unknown_words(args.min_count)
    if not words:
        print("渡す語が無い。readings.unknown.yaml が空か、全部が辞書にある")
        return 0

    picked = words[:args.limit]
    body = PROMPT + "\n".join(w for w, _ in picked) + "\n"

    out = Path(args.out) if args.out else ROOT / "readings.prompt.txt"
    out.write_text(body, encoding="utf-8")
    print("%d 語を %s に書いた（未知語は全部で %d 語）" % (len(picked), out.name, len(words)))
    print("この中身を AI チャットに貼り、返答をファイルに保存して:")
    print("  python tools/make_readings.py import 返答.txt")
    return 0


# -------------------------------------------------------------- import

# 「英単語 → カタカナ」の組。**行の形を当てにしない。**
# 画面からコピーすると改行が落ちて1行になることがあり（実機で発生）、
# 区切りもタブ・コロン・矢印・空白と揺れる。並びだけを手がかりにする
PAIR_RE = re.compile(
    r"(?<![A-Za-z0-9])"                   # 語の途中から始めない
    r"([A-Za-z][A-Za-z0-9.'\-]*)"        # 英単語
    r"[\s:：\t→=|、\-]*"                   # 区切り。無くてもよい
    r"([ァ-ヴー・]+)"                     # カタカナの並び
)

# 単語を名指しで探すとき用。
#
# **語の境界を見ること。** 見ないと Diffusion の中の on が ON に当たり、
# 「ON: ディフュージョン」のような組ができる（実機で発生）。
# 読み替え辞書側と同じ落とし穴
def _word_re(word: str) -> re.Pattern:
    return re.compile(r"(?<![A-Za-z0-9])" + re.escape(word) + r"(?![A-Za-z0-9])"
                      r"[\s:：\t→=|、\-]*([ァ-ヴー・]+)", re.IGNORECASE)


def read_text_any(path: Path) -> str:
    """文字コードを決め打ちしない。

    **メモ帳や AI チャットからの保存は cp932 になることがある**（実機で発生）。
    utf-8 決め打ちだと、そこで落ちて何も取り込めない。
    """
    b = path.read_bytes()
    for enc in ("utf-8-sig", "utf-8", "cp932", "utf-16"):
        try:
            return b.decode(enc)
        except Exception:
            continue
    return b.decode("utf-8", errors="replace")


def parse_reply(text: str, words: list[str] | None = None) -> list[tuple[str, str]]:
    """LLM の返答から (単語, 読み) を拾う。

    渡した語が分かっているなら、それを名指しで探すほうが確実。
    分からないときは「英単語のあとにカタカナが続く」並びを拾う。
    """
    pairs: list[tuple[str, str]] = []
    seen: set[str] = set()

    for word in (words or []):
        m = _word_re(word).search(text)
        if m:
            pairs.append((word, m.group(1)))
            seen.add(word.casefold())

    for m in PAIR_RE.finditer(text):
        word, reading = m.group(1), m.group(2)
        if word.casefold() in seen:
            continue
        seen.add(word.casefold())
        pairs.append((word, reading))
    return pairs


def check(word: str, reading: str, asked: set[str], known: set[str]) -> str:
    """1 件を見て、通らない理由を返す。通れば空文字。

    **LLM の出力をそのまま辞書にしない。** ここが 1 つ目の関門で、
    2 つ目は「コメントアウトして書き、耳で確かめてから外す」運用。
    """
    if not KATAKANA_RE.match(reading):
        return "カタカナ以外が混ざっている"
    if len(reading) > max_reading_len(word):
        return "読みが長すぎる（説明が混ざっている見込み）"
    if word.casefold() in known:
        return "既に辞書にある"
    if asked and word.casefold() not in asked:
        return "渡していない語"
    return ""


def do_import(args) -> int:
    text = read_text_any(Path(args.reply))
    asked_words = [w for w, _ in unknown_words(1)]
    pairs = parse_reply(text, asked_words)
    if not pairs:
        print("読み取れる行が無かった。「単語<タブ>カタカナ」の形になっているか確認すること")
        return 1

    asked = {w.casefold() for w in asked_words}
    known = known_words()

    ok: list[tuple[str, str]] = []
    ng: list[tuple[str, str, str]] = []
    seen: set[str] = set()
    for word, reading in pairs:
        key = word.casefold()
        if key in seen:
            continue          # 同じ語が2回返ってきた。先に来たほうを使う
        seen.add(key)
        why = check(word, reading, asked, known)
        (ok if not why else ng).append((word, reading) if not why else (word, reading, why))

    for word, reading, why in ng:
        print("  除外 %-24s %-16s %s" % (word[:24], reading[:16], why))

    # 渡したのに返ってこなかった語。LLM が黙って落とすことがある
    missing = sorted(asked - seen)
    if missing:
        print("  返答に無い語 %d 件: %s" % (len(missing), " ".join(missing[:8])))

    if not ok:
        print("取り込める行が無かった")
        return 1

    out = Path(args.out) if args.out else ROOT / ("readings.local.%s.yaml" % date.today())
    lines = [
        "# tools/make_readings.py が %s に作った候補。" % date.today(),
        "#",
        "# **耳で確かめてから # を外すこと。** 外すまで読み上げには効かない。",
        "# 管理UI（http://127.0.0.1:8080/admin）の試聴に読みを貼って聞く。",
        "# 外したら POST /readings/reload で読み直す。",
        "words:",
    ]
    for word, reading in ok:
        lines.append("  #%s: %s" % (word, reading))
    body = "\n".join(lines) + "\n"

    if out.exists() and not args.force:
        print("%s が既にある。--force で上書きする" % out.name)
        return 1
    out.write_text(body, encoding="utf-8")
    print("%d 件を %s に書いた（除外 %d 件）" % (len(ok), out.name, len(ng)))
    print("耳で確かめて # を外すこと。外すまで効かない")
    return 0


# ------------------------------------------------------------------ CLI

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    e = sub.add_parser("export", help="貼り付ける文面を作る")
    e.add_argument("--limit", type=int, default=DEFAULT_LIMIT, help="1回に渡す語数")
    e.add_argument("--min-count", type=int, default=1, help="この回数以上出た語だけ")
    e.add_argument("--out", default=None)
    e.set_defaults(func=do_export)

    i = sub.add_parser("import", help="返答を辞書にする")
    i.add_argument("reply", help="LLM の返答を保存したファイル")
    i.add_argument("--out", default=None)
    i.add_argument("--force", action="store_true", help="出力先が既にあっても上書きする")
    i.set_defaults(func=do_import)

    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
