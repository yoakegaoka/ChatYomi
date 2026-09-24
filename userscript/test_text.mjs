/**
 * テキスト抽出・整形・分割の単体テスト。
 *
 * ブラウザなしで確認するため、tts-readaloud.user.js から該当関数だけを取り出して
 * 最小限の DOM スタブ上で動かす。ロジックを二重に持たないよう、実ファイルを読んで
 * 関数本体を切り出している。
 *
 *   node userscript/test_text.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, 'tts-readaloud.user.js'), 'utf8');

// --- 実ファイルから対象の関数を切り出す -------------------------------
function extractFn(name) {
  const start = SRC.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('関数が見つからない: ' + name);
  let depth = 0, i = SRC.indexOf('{', start);
  const from = i;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) break; }
  }
  return SRC.slice(start, i + 1);
}

// --- 最小限の DOM スタブ ----------------------------------------------
const Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 };

function text(value) { return { nodeType: Node.TEXT_NODE, nodeValue: value }; }

// セレクタの照合。タグ名・クラス1個・属性の有無だけ。本物の CSS 解釈はしない
function matchOne(node, sel) {
  sel = sel.trim();
  if (sel.startsWith('[')) {
    const inner = sel.slice(1, -1);
    const m = /^([^^=]+)(\^?)=/.exec(inner);
    if (!m) return inner in (node.attrs || {});      // [attr] 存在するか
    const v = (node.attrs || {})[m[1]];
    if (v === undefined) return false;
    const want = inner.slice(m[0].length).replace(/^"|"$/g, '');
    return m[2] ? v.startsWith(want) : v === want;   // [attr^="x"] / [attr="x"]
  }
  if (sel.startsWith('.')) {
    return (node.className || '').split(/\s+/).filter(Boolean).includes(sel.slice(1));
  }
  return node.tagName === sel.toUpperCase();
}

function el(tagName, children = [], className = '', attrs = {}) {
  const node = {
    nodeType: Node.ELEMENT_NODE, tagName: tagName.toUpperCase(),
    childNodes: children, className, attrs,
    getAttribute(name) { return name in attrs ? attrs[name] : null; },
    matches(sel) { return sel.split(',').some((one) => matchOne(this, one)); },
    // テストで必要なのはクラス1個かタグ名の完全一致だけ。本物の CSS 解釈はしない
    querySelectorAll(sel) {
      const want = sel.split(',').map((x) => x.trim());
      const hit = (n) => want.some((w) => matchOne(n, w));
      const out = [];
      const walk = (n) => {
        if (n.nodeType !== Node.ELEMENT_NODE) return;
        if (hit(n)) out.push(n);
        for (const c of n.childNodes) walk(c);
      };
      for (const c of children) walk(c);
      return out;
    },
  };
  return node;
}

const cfg = { codeMode: 'skip', tableMode: 'skip', maxChars: 200 };
// nodeToText はサイト固有の除外セレクタを見る。テストでは除外なしにする
const site = { sel: { drop: null }, stripText: null };
const src = [
  'const BLOCK_TAGS = new Set(["P","DIV","LI","H1","H2","H3","H4","H5","H6","BLOCKQUOTE","TR","SECTION","ARTICLE"]);',
  'const DROP_TAGS = new Set(["SCRIPT","STYLE","BUTTON","SVG","NOSCRIPT"]);',
  extractFn('nodeToText'),
  extractFn('extractText'),
  extractFn('normalize'),
  extractFn('splitSentences'),
  'return { nodeToText, extractText, normalize, splitSentences };',
].join('\n');

const { nodeToText, extractText, normalize, splitSentences } =
  new Function('Node', 'cfg', 'site', src)(Node, cfg, site);

// --- テスト -------------------------------------------------------------
let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n       期待: ' + e + '\n       実際: ' + a); }
}

console.log('nodeToText — 本文の組み立て');
{
  // 実際の応答に近い構造。段落・リスト・コードブロック
  const body = el('div', [
    el('p', [text('これは1つ目の段落です。')]),
    el('ul', [
      el('li', [text('これは1つ目の項目です。')]),
      el('li', [text('これは2つ目の項目です。')]),
    ]),
    el('pre', [text('print("hello")')]),
    el('p', [text('以上です。')]),
  ]);

  cfg.codeMode = 'skip';
  check('コードブロックを除去', normalize(nodeToText(body)),
        'これは1つ目の段落です。\nこれは1つ目の項目です。\nこれは2つ目の項目です。\n以上です。');

  cfg.codeMode = 'label';
  check('コードブロックを読み替え', normalize(nodeToText(body)).includes('コードブロック'), true);

  cfg.codeMode = 'full';
  check('コードブロックを全文', normalize(nodeToText(body)).includes('print'), true);
  cfg.codeMode = 'skip';
}

console.log('nodeToText — 除外すべき要素');
{
  const body = el('div', [
    el('p', [text('本文です。')]),
    el('button', [text('コピー')]),
    el('script', [text('var x = 1;')]),
  ]);
  check('button と script を除去', normalize(nodeToText(body)), '本文です。');
}

console.log('normalize — 記号とURL');
{
  check('URL をリンクに', normalize('詳細は https://example.com/a?b=1 を参照。'),
        '詳細は リンク を参照。');
  check('見出し記号を除去', normalize('## 見出し\n本文。'), '見出し\n本文。');
  check('強調記号を除去', normalize('これは **重要** です。'), 'これは 重要 です。');
  check('箇条書きの記号を除去', normalize('- 項目一つ目\n- 項目二つ目'), '項目一つ目\n項目二つ目');
}

console.log('splitSentences — 分割');
{
  check('句点で分割', splitSentences('一つ目です。二つ目です。'),
        ['一つ目です。', '二つ目です。']);
  check('感嘆符と疑問符', splitSentences('本当ですか？はい！'), ['本当ですか？', 'はい！']);
  check('改行で分割', splitSentences('一行目\n二行目'), ['一行目', '二行目']);
  check('記号だけの文を破棄', splitSentences('本文です。\n---\n。\n続きです。'),
        ['本文です。', '続きです。']);
  check('空文字', splitSentences(''), []);

  const long = 'あ'.repeat(90) + '、' + 'い'.repeat(90) + '、' + 'う'.repeat(90) + '。';
  const parts = splitSentences(long);
  check('200字超は読点で再分割', parts.length > 1, true);
  check('分割後は全て200字以内', parts.every((s) => s.length <= 200), true);
}

console.log('normalize — サイト固有のラベル除去（Copilot）');
{
  // Copilot の本文要素には "Copilot said:" が入っている（実機確認済み）
  site.stripText = [/^[ 	]*Copilot said:[ 	]*/gmi, /^[ 	]*You said:[ 	]*/gmi];
  // 実機の本文は "Copilot said:" のあと空行が続く
  const NL = String.fromCharCode(10);
  check('先頭のラベルと続く空行を除去',
        normalize(['Copilot said:', '', 'これは本文の1文目です。'].join(NL)),
        'これは本文の1文目です。');
  check('本文中の同じ語は残す',
        normalize('先頭です。Copilot said: は本文中なら残る。'),
        '先頭です。Copilot said: は本文中なら残る。');
  site.stripText = null;
  check('stripText 未設定でも動く', normalize('そのままです。'), 'そのままです。');
}

console.log('normalize — 思考ブロックの除去（Claude）');
{
  const NL2 = String.fromCharCode(10);
  site.stripText = [
    /^[ 	]*(?:\d+\s*(?:秒|分)間?)?\s*思考しました[ 	]*$/gm,
    /^[ 	]*Thought for .*$/gm,
  ];
  check('秒数つきの見出しを行ごと除去',
        normalize(['6秒間思考しました', '結論から申し上げます。'].join(NL2)),
        '結論から申し上げます。');
  check('秒数なしの見出しも除去',
        normalize(['思考しました', '本文です。'].join(NL2)),
        '本文です。');
  check('英語UIの見出しも除去',
        normalize(['Thought for 6 seconds', '本文です。'].join(NL2)),
        '本文です。');
  check('本文中の「思考しました」は残す',
        normalize('私はそう思考しました。次に進みます。'),
        '私はそう思考しました。次に進みます。');
  site.stripText = null;
}

console.log('extractText — 地の文だけを読む（Claude の prose）');
{
  // 実際の応答構造: 検索結果や思考ブロックが本文要素の中に同居している
  const row = el('div', [
    el('div', [text('6秒間思考しました')], 'thinking-block'),
    el('div', [text('ウェブを検索しました'), text('検索結果のサイト名')], 'search-block'),
    el('div', [el('p', [text('これは地の文です。')])], 'standard-markdown'),
  ], 'font-claude-response');
  const rowWrap = el('div', [row]);

  site.sel.body = '.font-claude-response';
  site.sel.prose = '.standard-markdown, .progressive-markdown';
  check('検索結果と思考ブロックを読まない',
        normalize(extractText(rowWrap)), 'これは地の文です。');

  // 生成中は progressive-markdown
  const row2 = el('div', [
    el('div', [text('ウェブを検索しました')], 'search-block'),
    el('div', [el('p', [text('生成中の本文です。')])], 'progressive-markdown'),
  ], 'font-claude-response');
  check('生成中のクラスでも読める',
        normalize(extractText(el('div', [row2]))), '生成中の本文です。');

  // prose が見つからない場合は本文要素をそのまま読む（無音にしない）
  const row3 = el('div', [el('p', [text('マークダウン要素が無い場合。')])], 'font-claude-response');
  check('prose が無ければ本文要素にフォールバック',
        normalize(extractText(el('div', [row3]))), 'マークダウン要素が無い場合。');

  site.sel.prose = null;
  check('prose 未設定なら従来どおり',
        normalize(extractText(el('div', [row3]))), 'マークダウン要素が無い場合。');
  site.sel.body = null;
}

console.log('extractText — 地の文だけを読む（Gemini の prose）');
{
  // Gemini は Angular のカスタム要素。思考プロセスとソースは markdown の外側にある
  const row = el('model-response', [
    el('model-thoughts', [text('思考プロセスを表示')]),
    el('message-content', [
      el('div', [el('p', [text('現在の気温は22度です。')])], 'markdown markdown-main-panel'),
      el('sources-list', [text('ウェザーニュース')]),
    ]),
  ]);

  site.sel.body = 'message-content';
  site.sel.prose = '.markdown';
  check('思考プロセスとソースを読まない',
        normalize(extractText(el('div', [row]))), '現在の気温は22度です。');

  // markdown が無い応答でも無音にならないこと
  const row2 = el('model-response', [
    el('message-content', [el('p', [text('マークダウン要素が無い応答。')])]),
  ]);
  check('Gemini でも prose が無ければフォールバック',
        normalize(extractText(el('div', [row2]))), 'マークダウン要素が無い応答。');

  site.sel.body = null; site.sel.prose = null;
}

console.log('extractText — 地の文だけを読む（ChatGPT の prose）');
{
  // ChatGPT の行は会話のターン。利用者側と応答側が同じ形の要素に入るため、
  // body で応答側だけを選ぶ。操作ボタンは本文の外、ターンの中にある
  const row = el('section', [
    el('div', [
      el('div', [el('p', [text('これは地の文です。')])], 'markdown'),
    ], '', { 'data-message-author-role': 'assistant' }),
    el('div', [el('button', [text('コピー')])]),
  ], '', { 'data-testid': 'conversation-turn-3' });

  site.sel.body = '[data-message-author-role="assistant"]';
  site.sel.prose = '.markdown';
  check('応答の地の文だけを読む',
        normalize(extractText(el('div', [row]))), 'これは地の文です。');

  // 利用者のターンには応答側の要素が無い。空になり、読み上げ対象から外れる
  const mine = el('section', [
    el('div', [el('p', [text('これは利用者の発言です。')])], '',
       { 'data-message-author-role': 'user' }),
  ], '', { 'data-testid': 'conversation-turn-2' });
  check('利用者のターンは空になる', normalize(extractText(el('div', [mine]))), '');

  // markdown が無い応答でも無音にならないこと
  const row2 = el('section', [
    el('div', [el('p', [text('これはマークダウン要素が無い応答です。')])], '',
       { 'data-message-author-role': 'assistant' }),
  ]);
  check('ChatGPT でも prose が無ければフォールバック',
        normalize(extractText(el('div', [row2]))), 'これはマークダウン要素が無い応答です。');

  site.sel.body = null; site.sel.prose = null;
}

console.log('splitSentences — 実応答に近い一連の流れ');
{
  const body = el('div', [
    el('p', [text('設定ファイルの読み込みに失敗しました。')]),
    el('p', [text('既定値を使って処理を続行します。詳細は https://example.com/docs をご覧ください。')]),
  ]);
  check('通し', splitSentences(normalize(nodeToText(body))), [
    '設定ファイルの読み込みに失敗しました。',
    '既定値を使って処理を続行します。',
    '詳細は リンク をご覧ください。',
  ]);
}

console.log('nodeToText — 出典元チップの除去（Claude の data-not-prose）');
{
  // Web検索の出典元は、段落の途中にインライン要素として埋め込まれる。
  // sel.prose の内側なので抽出では外れない（実機で発覚）
  const body = el('div', [
    el('p', [
      text('これは1文目です。'),
      el('span', [
        el('a', [el('span', [text('出典サイト名')])], 'inline-flex'),
      ], '', { 'data-not-prose': '' }),
    ]),
    el('p', [text('これは2文目です。')]),
  ]);

  site.sel.drop = '[data-not-prose]';
  const NL3 = String.fromCharCode(10);
  check('出典元チップを読まない', normalize(nodeToText(body)),
        ['これは1文目です。', 'これは2文目です。'].join(NL3));

  site.sel.drop = null;
  check('drop 未設定なら従来どおり読む',
        normalize(nodeToText(body)).includes('出典サイト名'), true);

  // 印の無い普通の強調は残すこと
  site.sel.drop = '[data-not-prose]';
  const body2 = el('div', [el('p', [text('これは'), el('span', [text('重要')]), text('です。')])]);
  check('印の無いインライン要素は残す', normalize(nodeToText(body2)), 'これは重要です。');
  site.sel.drop = null;
}

console.log('nodeToText — 思い出の通知の除去（Copilot の memory-*）');
{
  // 「思い出が更新されました。」は本文要素の中の、しかも本文より前に入る。
  // 読み上げの先頭に紛れ込むうえ、直後の "Copilot said:" が文字列の先頭では
  // なくなるため、ラベル除去まで素通りしていた（実機で発覚）
  const body = el('div', [
    el('div', [
      el('span', [text('思い出が更新されました。')], '', { 'data-testid': 'memory-updated-text' }),
      el('button', [text('管理')], '', { 'data-testid': 'memory-manage-link' }),
      // 前方一致の確認用。名前の違う memory-* も落ちること
      el('span', [text('別の通知です。')], '', { 'data-testid': 'memory-other-note' }),
    ]),
    el('p', [text('Copilot said:')]),
    el('p', [text('これは本文の1文目です。')]),
  ]);

  site.sel.drop = '[data-testid^="memory-"]';
  site.stripText = [/^[ 	]*Copilot said:[ 	]*/gmi, /^[ 	]*You said:[ 	]*/gmi];
  check('思い出の通知を読まない', normalize(nodeToText(body)), 'これは本文の1文目です。');

  // 前方一致なので、通知の部品が増えても落ちること
  check('memory- で始まる要素はまとめて落ちる',
        normalize(nodeToText(body)).includes('別の通知'), false);

  // drop を外しても、ラベルは行頭一致で落ちること（多重の歯止め）
  site.sel.drop = null;
  check('通知が残ってもラベルは落ちる',
        normalize(nodeToText(body)).includes('Copilot said'), false);

  site.stripText = null;
}

console.log('isComplete — 生成完了の判定');
{
  // isComplete は site / lastChange / isGenerating に依存する。差し替えて単体で回す
  let siteC = null, generating = false;
  const lastChange = new Map();
  const makeIsComplete = new Function('site', 'lastChange', 'isGenerating',
    extractFn('isComplete') + '; return isComplete;');

  // 完了要素の有無と streaming 属性だけを持つ行のスタブ
  const row = (hasComplete, streamingAttr) => ({
    querySelector: () => (hasComplete ? {} : null),
    getAttribute: () => streamingAttr,
  });
  const run = (r, now) => makeIsComplete(siteC, lastChange, () => generating)(r, now);

  // --- 属性方式（Claude）---
  siteC = { sel: { complete: '[copy]' }, streamingAttr: 'data-x', settleMs: 0 };
  check('属性が false なら確定', run(row(true, 'false'), 1000), true);
  check('属性が true なら未確定', run(row(true, 'true'), 1000), false);
  check('完了要素が無ければ未確定', run(row(false, 'false'), 1000), false);

  // --- completeIsFinal（Gemini）---
  siteC = { sel: { complete: '[copy]' }, streamingAttr: null,
            completeIsFinal: true, settleMs: 1200 };
  const r1 = row(true, null), r2 = row(false, null);
  lastChange.set(r1, 0); lastChange.set(r2, 0);
  check('完了要素が出たら静止を待たずに確定', run(r1, 100), true);
  check('完了要素が無ければ静止判定へ落ちる（未達）', run(r2, 100), false);
  check('完了要素が無くても静止すれば確定', run(r2, 1300), true);

  // --- 従来の AND（Copilot）---
  siteC = { sel: { complete: '[copy]' }, streamingAttr: null, settleMs: 1500 };
  const r3 = row(true, null), r4 = row(false, null);
  lastChange.set(r3, 0); lastChange.set(r4, 0);
  check('完了要素があっても静止するまで待つ', run(r3, 100), false);
  check('完了要素があり静止もしたら確定', run(r3, 1600), true);
  check('完了要素が無ければ静止しても確定しない', run(r4, 1600), false);

  // --- 生成中は常に未確定 ---
  generating = true;
  check('生成中は確定しない', run(r3, 9999), false);
  generating = false;

  // --- 完了要素を設定していないサイト ---
  siteC = { sel: {}, streamingAttr: null, settleMs: 500 };
  const r5 = row(false, null);
  lastChange.set(r5, 0);
  check('complete 未設定なら静止判定だけで確定', run(r5, 600), true);
  check('未計測の行は確定しない', run(row(false, null), 9999), false);
}

console.log('nodeToText — 出典元の除去（ChatGPT の引用ピル）');
{
  // 段落の中にインライン要素として埋め込まれる。サイト名は任意の文字列なので
  // 文字列除去では消せず、要素ごと落とすしかない
  const body = el('div', [
    el('p', [
      text('これは本文の1文目です。'),
      el('span', [
        el('span', [text('サイト名+1')], 'ms-1',
           { 'data-testid': 'webpage-citation-pill' }),
      ], 'contents', { 'data-content-reference-start': '10' }),
    ]),
    el('p', [text('これは本文の2文目です。')]),
  ]);

  site.sel.drop = '[data-testid="webpage-citation-pill"],[data-content-reference-start]';
  check('出典元を読まない', normalize(nodeToText(body)),
        'これは本文の1文目です。\nこれは本文の2文目です。');

  // 印が片方だけになっても落ちること（UI改修への備え）
  const onlyPill = el('p', [
    text('これは本文です。'),
    el('span', [text('サイト名+1')], '', { 'data-testid': 'webpage-citation-pill' }),
  ]);
  check('ピルの印だけでも落ちる', normalize(nodeToText(onlyPill)), 'これは本文です。');

  const onlyRef = el('p', [
    text('これは本文です。'),
    el('span', [text('サイト名')], '', { 'data-content-reference-start': '10' }),
  ]);
  check('包みの印だけでも落ちる', normalize(nodeToText(onlyRef)), 'これは本文です。');

  site.sel.drop = null;
  check('drop 未設定なら従来どおり読む',
        normalize(nodeToText(onlyPill)).includes('サイト名'), true);
}

console.log('nodeToText — PRE ではないコードブロック（sel.code）');
{
  // Copilot はコードを専用のビューアで組んでおり、行番号・コード本文・言語ラベルが
  // 別々の要素に入っている。そのままだと行番号まで読み上げる
  const viewer = el('div', [
    el('span', [text('Python')]),
    el('div', [el('div', [text('1')]), el('div', [text('print(1)')])], '',
       { role: 'textbox' }),
  ], 'scriptor-component-code-block');
  const body = el('div', [
    el('p', [text('これはコードの前の段落です。')]),
    viewer,
    el('p', [text('これはコードの後の段落です。')]),
  ]);

  site.sel.code = '.scriptor-component-code-block,[role="textbox"]';
  cfg.codeMode = 'skip';
  check('PRE でなくても読まない', normalize(nodeToText(body)),
        'これはコードの前の段落です。\nこれはコードの後の段落です。');
  check('行番号も読まない', normalize(nodeToText(body)).includes('1'), false);

  cfg.codeMode = 'label';
  check('読み替えもできる', normalize(nodeToText(body)).includes('コードブロック'), true);

  cfg.codeMode = 'skip';
  site.sel.code = null;
  check('sel.code 未設定なら従来どおり読む',
        normalize(nodeToText(body)).includes('print'), true);
}

console.log('nodeToText — 表の扱い');
{
  // セルの文字列が並ぶだけでは、行と列の対応が音では伝わらない
  const body = el('div', [
    el('p', [text('これは表の前の段落です。')]),
    el('table', [
      el('tr', [el('td', [text('項目')]), el('td', [text('値')])]),
      el('tr', [el('td', [text('速度')]), el('td', [text('高速')])]),
    ]),
    el('p', [text('これは表の後の段落です。')]),
  ]);

  cfg.tableMode = 'skip';
  check('表を読まない', normalize(nodeToText(body)),
        'これは表の前の段落です。\nこれは表の後の段落です。');

  cfg.tableMode = 'label';
  check('表を読み替える', normalize(nodeToText(body)).includes('表'), true);
  check('読み替えたらセルは読まない', normalize(nodeToText(body)).includes('高速'), false);

  cfg.tableMode = 'full';
  check('表を全文読む', normalize(nodeToText(body)).includes('高速'), true);
  cfg.tableMode = 'skip';

  // 表を div で組むサイト向け
  const divTable = el('div', [
    el('p', [text('これは表の前の段落です。')]),
    el('div', [el('div', [text('セルの中身')])], '', { role: 'table' }),
  ]);
  check('role=table も読まない', normalize(nodeToText(divTable)), 'これは表の前の段落です。');
}

console.log('短い応答の取りこぼし — 送信の観測');
{
  const userRowEvent = new Function(extractFn('userRowEvent') + '; return userRowEvent;')();
  const acceptsAsNew = new Function(extractFn('acceptsAsNew') + '; return acceptsAsNew;')();

  // 送信すれば末尾に1件だけ増える。履歴の読み込みはまとめて流れ込む
  check('末尾に1件増えたら送信', userRowEvent(1, true), 'send');
  check('まとめて増えたら履歴の読み込み', userRowEvent(5, true), 'flood');
  check('増えていなければ何も起きていない', userRowEvent(0, false), 'none');
  check('1件でも末尾でなければ送信ではない', userRowEvent(1, false), 'none');

  // 同じ観測で現れたものは受け付けない。ここを緩めたら Gemini のリロードで
  // 過去の応答を読み上げた（実機で発生）。履歴が1行ずつ流れ込むため
  // flood 判定が効かず、1件ずつの追加が送信に見える
  check('送信を観測していなければ受け付けない', acceptsAsNew(0, 100, true, true), false);
  check('同じ観測で現れたものは受け付けない', acceptsAsNew(100, 100, true, true), false);
  check('後の観測で現れた末尾の応答は受け付ける', acceptsAsNew(100, 101, true, true), true);
  check('末尾でなければ受け付けない', acceptsAsNew(100, 101, false, true), false);
  check('本文が無い行は受け付けない', acceptsAsNew(100, 101, true, false), false);
}

console.log('行の差し替えへの追従');
{
  const isContinuation = new Function(
    extractFn('resumeIndex') + extractFn('isContinuation') + '; return isContinuation;')();

  // 生成中に行の要素が作り直されるサイトがある。打ち切って作り直すと
  // 鳴らしている文が途中で切れ、先頭から読み直しになる（Copilot で発生）
  check('同じ文が並んでいれば続き', isContinuation(['あ。', 'い。'], ['あ。', 'い。', 'う。']), true);
  check('同じ長さでも続き', isContinuation(['あ。'], ['あ。']), true);
  check('短くなっていたら続きではない', isContinuation(['あ。', 'い。'], ['あ。']), false);
  check('途中が違えば続きではない', isContinuation(['あ。', 'い。'], ['あ。', 'X。', 'う。']), false);
  check('先頭が違えば続きではない', isContinuation(['あ。'], ['X。', 'あ。']), false);
  check('空なら何でも続きに見える', isContinuation([], ['あ。']), true);
}

console.log('URL が変わった理由');
{
  const navigationVerdict = new Function(
    extractFn('navigationVerdict') + '; return navigationVerdict;')();

  const base = { generating: false, sinceSend: Infinity, graceMs: 5000, userEvent: 'none' };
  const v = (over) => navigationVerdict(Object.assign({}, base, over));

  // 新規チャットは送信すると URL に ID が振られる。ChatGPT では1回の送信で
  // 5回変わり、切り替えとみなした結果 1往復目が丸ごと読まれなかった（実機で発生）
  check('送信の直後なら新規チャット', v({ sinceSend: 800 }), 'newchat');
  check('境界ちょうども新規チャット', v({ sinceSend: 5000 }), 'newchat');
  check('時間が経っていれば切り替え', v({ sinceSend: 5001 }), 'switch');
  check('送信を観測していなければ切り替え', v({}), 'switch');

  // 切り替えれば行ごと消えるので、生成中の応答が生きていること自体が
  // 同じ会話にいる証拠になる。Copilot は応答が長いと送信から5秒以上たってから
  // URL に ID が振られ、読み上げ中の応答が打ち切られていた（実機で発生）
  check('生成中なら時間が経っていても新規チャット',
        v({ generating: true, sinceSend: 60000 }), 'newchat');
  check('生成中でなければ従来どおり', v({ generating: false, sinceSend: 60000 }), 'switch');

  // URL の変化のほうが送信の観測より先に届くことがある。
  // そのときは発言の並びで見分ける
  check('未見が末尾の1件だけなら新規チャット', v({ userEvent: 'send' }), 'newchat');
  check('まとめて流れ込んだなら切り替え', v({ userEvent: 'flood' }), 'switch');

  const pendingNavigationVerdict = new Function(
    'const NAVIGATION_SETTLE_MS = 1200; const NEW_CHAT_URL_MS = 5000; ' +
    extractFn('pendingNavigationVerdict') +
    '; return pendingNavigationVerdict;')();
  check('URLが先に変わり発言行がまだ無ければ判定を待つ',
        pendingNavigationVerdict('none', 500), 'wait');
  check('待機中に末尾の発言行が現れたら新規チャット',
        pendingNavigationVerdict('send', 500, Infinity), 'newchat');
  check('待機中に発言行を既に処理済みでも送信時刻で新規チャット',
        pendingNavigationVerdict('none', 500, 250), 'newchat');
  check('待機中に複数の発言行が現れたら履歴切り替え',
        pendingNavigationVerdict('flood', 500, Infinity), 'switch');
  check('発言行が現れないまま猶予を過ぎたら切り替え',
        pendingNavigationVerdict('none', 1200, Infinity), 'switch');
}

console.log('初見の行をどう扱うか');
{
  const firstSightVerdict = new Function(
    extractFn('acceptsAsNew') + extractFn('firstSightVerdict') +
    '; return firstSightVerdict;')();

  const base = { loading: false, len: 50, armedAt: 0, now: 200, isLast: true,
                 hasBody: true, active: false, looksDone: false };
  const v = (over) => firstSightVerdict(Object.assign({}, base, over));

  // 読み込み中は、出来上がって見えるかに関わらず履歴とみなす。
  // Gemini の履歴は段階的に描画され、初見では完了要素が出ていない（実機で発生）
  check('読み込み中は履歴とみなす', v({ loading: true }), 'preexisting');
  check('読み込み中でも中身が無ければ持ち越す', v({ loading: true, len: 0 }), 'wait');
  check('読み込み中は送信待ちより優先', v({ loading: true, armedAt: 100 }), 'preexisting');

  // 送信を観測していれば、その後に現れた末尾の応答は新しい
  check('送信後に現れた末尾の応答は新しい', v({ armedAt: 100 }), 'new');
  check('送信と同じ観測なら持ち越す', v({ armedAt: 200 }), 'wait');
  check('実際の送信操作と発言行の後にある短い回答は受け付ける',
        v({ armedAt: 200, trustedSend: true, afterUser: true }), 'new');
  check('送信操作より前の回答行は受け付けない',
        v({ armedAt: 200, trustedSend: true, afterUser: false }), 'wait');
  check('送信操作があっても末尾以外は受け付けない',
        v({ armedAt: 200, trustedSend: true, afterUser: true, isLast: false }), 'wait');
  check('末尾でなければ新しいとみなさない', v({ armedAt: 100, isLast: false }), 'wait');
  check('本文が無ければ新しいとみなさない', v({ armedAt: 100, hasBody: false }), 'wait');

  // 初見で既に出来上がっていれば過去の応答
  check('初見で完成していれば履歴', v({ looksDone: true }), 'preexisting');
  check('中身が無ければ履歴とみなさない', v({ looksDone: true, len: 0 }), 'wait');
  check('生成を観測済みなら履歴とみなさない',
        v({ looksDone: true, active: true }), 'wait');

  // どちらとも付かないときは持ち越す
  check('判断が付かなければ持ち越す', v({}), 'wait');
}

console.log('逐次読み上げ — 確定した文の切り出し');
{
  const confirmedSentences = new Function(
    extractFn('confirmedSentences') + '; return confirmedSentences;')();

  // 末尾は書きかけかもしれないので必ず捨てる。次が現れて初めて確定とみなす
  check('最後の1文は確定させない', confirmedSentences(['1文目。', '2文目。']), ['1文目。']);
  check('1文だけなら何も確定しない', confirmedSentences(['書きかけ']), []);
  check('空なら空', confirmedSentences([]), []);
  check('3文なら2文が確定', confirmedSentences(['1文目。', '2文目。', '3文']),
        ['1文目。', '2文目。']);
}

console.log('逐次読み上げ — 先出しと確定後の突き合わせ');
{
  const resumeIndex = new Function(extractFn('resumeIndex') + '; return resumeIndex;')();

  check('末尾に足されただけなら一致',
        resumeIndex(['1文目。', '2文目。'], ['1文目。', '2文目。', '3文目。']),
        { from: 2, matched: true });
  check('続きは先出しした数の次から',
        resumeIndex(['1文目。'], ['1文目。', '2文目。']).from, 1);
  check('先出しした文が書き換わったら不一致',
        resumeIndex(['1文目。'], ['1文目です。', '2文目。']).matched, false);
  check('書き換わっても位置は先出しした数に合わせる',
        resumeIndex(['1文目。'], ['1文目です。', '2文目。']).from, 1);
  check('確定後のほうが短くても破綻しない',
        resumeIndex(['1文目。', '2文目。'], ['1文目。']),
        { from: 2, matched: false });
  check('何も先出ししていなければ一致扱い',
        resumeIndex([], ['1文目。']), { from: 0, matched: true });
}

console.log('逐次読み上げ — 後から文が増える並び');
{
  const makeStream = new Function(extractFn('makeStream') + '; return makeStream;')();
  const tick = () => new Promise((r) => setTimeout(r, 0));

  const st = makeStream();
  st.push(['1文目。', '2文目。']);
  check('push した分だけ取り出せる', st.items, ['1文目。', '2文目。']);
  check('既に届いている位置は待たない', await st.wait(1), true);

  // まだ無い分は待つ。あとから push されたら進む
  let resolved = null;
  st.wait(2).then((v) => { resolved = v; });
  await tick();
  check('未着の位置では待つ', resolved, null);
  st.push(['3文目。']);
  await tick();
  check('push されたら待ちが解ける', resolved, true);

  // 閉じたら、以降は待たずに「もう来ない」を返す
  let ended = null;
  st.wait(3).then((v) => { ended = v; });
  st.close();
  await tick();
  check('閉じたら待ちが false で解ける', ended, false);
  check('閉じたあとの未着位置は即座に false', await st.wait(9), false);
  check('閉じても届いた分は読める', await st.wait(2), true);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
