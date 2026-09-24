"""読み替え辞書の単体テスト。

    python server/test_readings.py

サーバもモデルも要らない。置換の規則は目で追いにくく、
「Claude Code が Claude で切られる」類の壊れ方が静かに起きるため、
規則の順序と境界はここで固定しておく。
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

# 日本語のテスト名を cp932 で化けさせない
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except Exception:
        pass

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from server.readings import Readings  # noqa: E402

passed = 0
failed = 0


def ok(name: str, got, want) -> None:
    global passed, failed
    if got == want:
        passed += 1
    else:
        failed += 1
        print("NG  %s\n    期待 %r\n    実際 %r" % (name, want, got))


def build(doc: str, local: str = "", collect: bool = True) -> Readings:
    """一時ディレクトリに辞書を書いて読ませる。"""
    d = Path(tempfile.mkdtemp(prefix="readings-test-"))
    (d / "readings.yaml").write_text(doc, encoding="utf-8")
    paths = [d / "readings.yaml"]
    if local:
        (d / "readings.local.yaml").write_text(local, encoding="utf-8")
        paths.append(d / "readings.local.yaml")
    return Readings(paths, d / "readings.unknown.yaml", collect_unknown=collect)


BASE = """
words:
  Claude: クロード
  Claude Code: クロードコード
  API: エーピーアイ
  IT: アイティー
  Node.js: ノードジェイエス
  Go: ゴー
  ゴー: ゴーゴー
symbols:
  '→': 'から'
patterns:
  - from: '(?<![A-Za-z0-9])v(\\d+)\\.(\\d+)\\.(\\d+)(?![\\d.])'
    to: 'バージョン\\1点\\2点\\3'
ignore:
  - OK
"""


# ---------------------------------------------------------------- 語の置換

r = build(BASE)

ok("語を置き換える", r.apply("Claudeに聞く")[0], "クロードに聞く")
ok("長い語が先に当たる", r.apply("Claude Codeを使う")[0], "クロードコードを使う")
ok("小文字でも当たる", r.apply("claudeに聞く")[0], "クロードに聞く")
ok("語の途中には当たらない", r.apply("Claudetteの話")[0], "Claudetteの話")
ok("日本語が続く場合は当たる", r.apply("Claudeは賢い")[0], "クロードは賢い")
ok("英数字が続く場合は当たらない", r.apply("Claude2")[0], "Claude2")
ok("ドットを含む語", r.apply("Node.jsで動く")[0], "ノードジェイエスで動く")

# 全部大文字の規則は大文字にだけ当てる。IT が it に当たると文章が壊れる
ok("頭字語は大文字にだけ当たる", r.apply("APIとIT")[0], "エーピーアイとアイティー")
ok("頭字語は小文字には当たらない", r.apply("it is api")[0], "it is api")

# 1 回の走査で片付ける。順に置換すると Go → ゴー → ゴーゴー と壊れる
ok("置換した結果に再度当たらない", r.apply("Goを使う")[0], "ゴーを使う")
ok("元からある語には当たる", r.apply("ゴーを使う")[0], "ゴーゴーを使う")

ok("記号を置き換える", r.apply("AからB→C")[0], "AからBからC")

# 読みを空にすると読み飛ばす。記号は文脈で意味が変わるので、
# 無理に言葉を当てるより読まないほうが自然なことがある
rs = build("symbols:" + chr(10) + "  '→': ' '" + chr(10) +
           "  '⇒': ''" + chr(10) + "  '★':" + chr(10))
ok("空白なら読まずに離す", rs.apply("A→B")[0], "A B")
ok("空文字なら読まずにくっつく", rs.apply("A⇒B")[0], "AB")
# 値を書き忘れると None が来る。str(None) は "None" になり読み上げてしまう
ok("値なしも読み飛ばす", rs.apply("★注意")[0], "注意")
ok("当たった語を返す", r.apply("Claude Codeと API")[1], ["Claude Code", "API"])
ok("何も当たらなければそのまま", r.apply("普通の文です。")[0], "普通の文です。")
ok("空文字", r.apply("")[0], "")


# -------------------------------------------------------------- 正規表現

ok("版番号", r.apply("v1.25.3が出た")[0], "バージョン1点25点3が出た")
ok("形が違えば当たらない", r.apply("v1.25が出た")[0], "v1.25が出た")


# ------------------------------------- カッコの中が英語なら読み飛ばす

# 同梱辞書の規則そのものを試す。ここは実際に配る値なので、
# 別に書き直すと辞書を直したときにテストが素通りする
import yaml  # noqa: E402

SHIPPED = yaml.safe_load((ROOT / "readings.yaml").read_text(encoding="utf-8"))
PARENS = build("patterns:" + chr(10)
               + "  - from: '" + SHIPPED["patterns"][0]["from"].replace("'", "''")
               + "'" + chr(10) + "    to: ''" + chr(10))

ok("英語の併記を落とす",
   PARENS.apply("AGI（Artificial General Intelligence）とは何か。")[0],
   "AGIとは何か。")
ok("半角カッコでも落とす",
   PARENS.apply("AGI (Artificial General Intelligence) is here.")[0],
   "AGI is here.")
ok("記号を含む英語も落とす", PARENS.apply("（Node.js）で動く")[0], "で動く")
ok("アポストロフィも落とす", PARENS.apply("（Moore's Law）に従う")[0], "に従う")
ok("ハイフンと数字も落とす", PARENS.apply("（GPT-4o）を使う")[0], "を使う")
# 日本語が1文字でも混ざれば残す。消すと意味が失われる
ok("日本語が混ざるなら残す", PARENS.apply("（AIの話）をする")[0], "（AIの話）をする")
ok("年号は残す", PARENS.apply("（2024年）に発表")[0], "（2024年）に発表")
ok("数字だけは残す", PARENS.apply("（1000）個")[0], "（1000）個")
ok("日本語だけは残す", PARENS.apply("（重要）な点")[0], "（重要）な点")
# カッコをまたいで飲み込まない
ok("片方だけ落とす", PARENS.apply("A（B）とC（Dの話）")[0], "AとC（Dの話）")
# 前の語は残す。落とすのはカッコの中だけ
ok("前の語は残る", PARENS.apply("汎用人工知能 (AGI) の話")[0], "汎用人工知能 の話")


# ------------------------------------------------------------ local の優先

r2 = build(BASE, "words:\n  Claude: クロード先生\n  Gemini: ジェミニ\n")
ok("local が同梱を上書きする", r2.apply("Claudeに聞く")[0], "クロード先生に聞く")
ok("local の追加も効く", r2.apply("Geminiに聞く")[0], "ジェミニに聞く")
ok("同梱の規則は残る", r2.apply("APIを叩く")[0], "エーピーアイを叩く")


# ---------------------------------------------------------------- 未知語

r3 = build(BASE)
r3.note_unknown("Anthropic の inference は速い")
ok("未知語を拾う", sorted(r3.unknown), ["anthropic", "inference"])

r3.note_unknown("Anthropic をもう一度")
ok("同じ語は数える", r3.unknown["anthropic"].count, 2)

r3.note_unknown("anthropic と ANTHROPIC")
ok("大文字小文字を畳んで数える", r3.unknown["anthropic"].count, 4)
ok("多い表記を残す", r3.unknown["anthropic"].form, "Anthropic")

r4 = build(BASE)
r4.prepare("Claude と API と OK と a")
ok("辞書にある語は未知語にしない", sorted(r4.unknown), [])

r5 = build(BASE)
r5.note_unknown("I am up")
ok("1文字は数えない", "i" in r5.unknown, False)
ok("2文字は数える", sorted(r5.unknown), ["am", "up"])

r6 = build(BASE, collect=False)
r6.prepare("Anthropic の話")
ok("記録を切れる", len(r6.unknown), 0)

r7 = build(BASE)
r7.note_unknown("Wi-Fi と Node.js")
ok("記号を挟む語をまとめて拾う", sorted(r7.unknown), ["wi-fi"])


# ------------------------------------------------------------ 壊れた辞書

r8 = build("words:\n  Claude: クロード\npatterns:\n  - from: '([)'\n    to: 'x'\n")
ok("壊れた正規表現は飛ばす", r8.apply("Claudeだ")[0], "クロードだ")

r9 = build("words: {}\n")
ok("空の辞書でも落ちない", r9.apply("何もしない")[0], "何もしない")

r10 = build(BASE)
r10._re = None
r10._pats = [(None, "x")]          # 合成の直前で例外を起こす
ok("置換が落ちても元の文を返す", r10.prepare("Claudeだ"), "Claudeだ")


# ------------------------------------------------------------ 保存と復帰

d = Path(tempfile.mkdtemp(prefix="readings-test-"))
(d / "readings.yaml").write_text(BASE, encoding="utf-8")
paths = [d / "readings.yaml"]
up = d / "readings.unknown.yaml"

a = Readings(paths, up)
a.note_unknown("Anthropic Anthropic inference")
a.flush()
b = Readings(paths, up)
ok("再起動しても数を引き継ぐ", b.unknown["anthropic"].count, 2)
b.note_unknown("Anthropic")
ok("引き継いだ上に足す", b.unknown["anthropic"].count, 3)
ok("未知語ファイルに文脈を残さない", "速い" in up.read_text(encoding="utf-8"), False)


# ------------------------------------------- 未知語から辞書を作る道具

sys.path.insert(0, str(ROOT / "tools"))
import make_readings as mk  # noqa: E402

# 返答の書式は LLM ごとに揺れる。タブ・コロン・矢印・箇条書きを受ける
ok("タブ区切り", mk.parse_reply("Web\tウェブ"), [("Web", "ウェブ")])
ok("コロン区切り", mk.parse_reply("Web: ウェブ"), [("Web", "ウェブ")])
ok("全角コロン", mk.parse_reply("Web：ウェブ"), [("Web", "ウェブ")])
ok("矢印", mk.parse_reply("Web → ウェブ"), [("Web", "ウェブ")])
ok("箇条書き", mk.parse_reply("- Web: ウェブ"), [("Web", "ウェブ")])
ok("前置きは飛ばす", mk.parse_reply("はい、以下です。\n\nWeb\tウェブ"),
   [("Web", "ウェブ")])
ok("コードフェンスは飛ばす", mk.parse_reply("```\nWeb\tウェブ\n```"),
   [("Web", "ウェブ")])
ok("表でも拾う", mk.parse_reply("| Web | ウェブ |"), [("Web", "ウェブ")])
ok("空白区切りでも拾う", mk.parse_reply("km キロメートル Web ウェブ"),
   [("km", "キロメートル"), ("Web", "ウェブ")])
# 画面からコピーすると改行が落ちて1行になることがある（実機で発生）
ok("1行に全部詰まっていても拾う",
   mk.parse_reply("km キロメートル Switch スイッチ", ["km", "Switch"]),
   [("km", "キロメートル"), ("Switch", "スイッチ")])
# 語の境界を見ないと Diffusion の中の on が ON に当たる（実機で発生）
ok("語の途中には当てない",
   [w for w, _ in mk.parse_reply("Diffusion ディフュージョン", ["ON"])], ["Diffusion"])

# LLM の出力をそのまま辞書にしない。ここが1つ目の関門
asked, known = {"web", "fire", "km"}, {"claude"}
chk = lambda w, r: mk.check(w, r, asked, known)
ok("カタカナだけなら通る", chk("Web", "ウェブ"), "")
ok("長音と中黒は使える", chk("Web", "ウェブ・ページ"), "")
ok("ひらがなが混ざったら弾く", chk("FIRE", "ファイアと読みます"),
   "カタカナ以外が混ざっている")
ok("英字が混ざったら弾く", chk("Web", "ウェブ(Web)"), "カタカナ以外が混ざっている")
ok("長すぎる読みは弾く", chk("Web", "ウェブブラウザーデータホゾンバショノコト"),
   "読みが長すぎる（説明が混ざっている見込み）")
ok("既に辞書にある語は弾く", chk("Claude", "クロード"), "既に辞書にある")
ok("渡していない語は弾く", chk("NotAsked", "ノットアスクド"), "渡していない語")
ok("短い語でも一定の長さは許す", chk("km", "キロメートル"), "")


# ------------------------------------------------------------------ 結果

print("%d passed, %d failed" % (passed, failed))
sys.exit(1 if failed else 0)
