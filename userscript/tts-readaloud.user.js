// ==UserScript==
// @name         ChatYomi — AIチャットの回答を読み上げる
// @namespace    tts-readaloud
// @version      1.26.8
// @description  ChatYomi: Claude / Microsoft Copilot / Gemini / ChatGPT の応答を自宅PCのIrodori-TTSで読み上げる
// @match        https://claude.ai/*
// @match        https://copilot.microsoft.com/*
// @match        https://m365.cloud.microsoft/*
// @match        https://gemini.google.com/*
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @connect      127.0.0.1
// @connect      localhost
// @connect      *
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// ==/UserScript==

/*
 * PC とスマホの両方で使う。
 *   - 通信は最初から GM_xmlhttpRequest
 *   - サーバURLは設定値。127.0.0.1 を決め打ちしない
 *     （サーバから配信された場合、その URL が既定値になる。スマホでの手入力を避けるため）
 *   - AudioContext の解放はユーザー操作起点
 *   - UI はボタン1つ + 設定パネル
 *
 * @connect に * を入れてあるのは、スマホから LAN の IP（192.168.x.x など）を指すため。
 * 接続先は設定パネルで指定した1つだけで、そこ以外には繋がない。
 * メタデータブロックには @ で始まる行以外を書かないこと（マネージャによって解釈が分かれる）。
 */

(function () {
  'use strict';

  // ============================================================ サイト定義
  //
  // サイトごとの差分はこのテーブルだけに閉じ込める。
  // 新しいサイトを足すときも、UI改修で壊れたときも、直すのはここだけでよい。
  //
  //   sel.row       応答1件のコンテナ
  //   sel.userRow   利用者の発言1件のコンテナ。省略可。
  //                 「いま送信した」ことを知るために使う
  //   sel.body      本文要素。行全体を読むと余計なテキストが混ざる
  //   sel.prose     本文要素の中で「地の文」だけを指すセレクタ。省略可。
  //                 指定すると検索結果や思考ブロックを読まずに済む。
  //                 一致が無いときは本文要素をそのまま読むが、生成中だけは待つ
  //   sel.complete  生成完了後に現れる要素（コピーボタン等）。省略可
  //   sel.streaming ページ内にあれば生成中とみなす要素。省略可
  //   sel.drop      本文から取り除く要素（引用マーカー、ツールバー等）。省略可
  //   sel.code      PRE 以外の形で組まれたコードブロック。省略可。
  //                 PRE と同じ扱いになるので、読むかどうかは設定（codeMode）に従う
  //   streamingAttr 生成状態を示す属性。あればこれを最優先の判定に使う
  //   completeIsFinal sel.complete の出現だけで確定とみなす。settleMs を待たない
  //   settleMs      上記で決まらないとき、本文が伸びなくなってから確定とみなすまでの時間。
  //                 completeIsFinal のサイトでは「完了要素が二度と出なかったとき」の
  //                 保険であり、通常は使われない。短いと生成の一時停止を完了と
  //                 誤判定するので長く取る

  /*
   * stream: 生成の途中でも読み始めてよいサイト。
   *
   * 本文が「末尾に足されるだけ」であることが前提になる。マークダウンが後から
   * 整形される、表やコードブロックが後から組み上がる、といった作りのサイトでは
   * 既に読んだ文が書き換わる。鳴らした音は取り消せないので、そういうサイトは
   * false にして従来どおり完了を待つ。
   *
   * 実行時にも守りを入れてあり（advance()）、先出しした文と食い違いを検知したら
   * その応答は自動的に従来の動きへ落ちる。false にするのは、それが頻発する場合。
   */
  const SITES = {
    claude: {
      label: 'Claude',
      host: /(^|\.)claude\.ai$/,
      sel: {
        row: '[data-testid="transcript-row"][data-perf-row="assistant"]',
        body: '.font-claude-response',
        // 地の文はマークダウンのコンテナに入る。生成中は progressive、確定後は standard。
        // ここを指定することで、Web検索の結果や思考ブロックが自然に外れる
        prose: '.standard-markdown, .progressive-markdown',
        complete: '[data-testid="action-bar-copy"]',
        // Web検索の出典元は、段落の中にインライン要素として埋め込まれる。
        // sel.prose の内側なので抽出では外れず、サイト名は任意の文字列なので
        // 文字列除去でも消せない（実機で発覚。「出典サイト名」等が読み上げられた）。
        // Claude 自身が「地の文ではない」と印を付けているので、それをそのまま使う。
        // class 名（.inline-flex 等）より意味が明確で、UI改修にも強い
        drop: '[data-not-prose]',
        // 利用者の発言（実機確認済み）。sel.row の assistant と対になる値で、
        // 会話3往復で3個に一致した。短い応答の取りこぼしを塞ぐ
        userRow: '[data-testid="transcript-row"][data-perf-row="human"]',
      },
      // 思考ブロックの見出し（「6秒間思考しました」等）は本文ではないので読まない。
      // 行ごと落とす。英語UIの "Thought for 6 seconds" にも対応する。
      stripText: [
        /^[ \t]*(?:\d+\s*(?:秒|分)間?)?\s*思考しました[ \t]*$/gm,
        /^[ \t]*Thought for .*$/gm,
      ],
      streamingAttr: 'data-perf-row-streaming',
      settleMs: 0,   // 属性で判定できる。800ms停止判定は誤検知するので使わない
      // 生成中に読み始めてよい。属性で生成中を確実に見分けられるので4サイトの中で最も相性がよい
      stream: true,
    },

    // m365.cloud.microsoft/chat で実機確認した DOM に基づく。
    // Claude と違い生成状態を示す属性が無く、代わりに loading-message 要素が出る。
    copilot: {
      label: 'Microsoft Copilot',
      host: /(^|\.)copilot\.microsoft\.com$|(^|\.)cloud\.microsoft$/,
      sel: {
        row: '[data-testid="copilot-message-div"]',
        body: '[data-testid="copilot-message-reply-div"]',
        complete: '[data-testid="CopyButtonTestId"]',
        // streaming は指定しない。
        // loading-message は生成中インジケータに見えるが、実機で確認したところ
        // 全メッセージに1個ずつ「表示状態のまま」常駐していた（5件中5件が表示中）。
        // これを使うと isGenerating() が常に true になり、読み上げが永久に始まらない。
        // 完了判定は sel.complete と settleMs に任せる。
        // 引用マーカーと操作ボタンは読み上げない
        // memory-* は「思い出が更新されました。」の通知（実機で発覚）。本文要素の
        // 中にあり、しかも本文より前に置かれるため、読み上げの先頭に紛れ込む。
        // 前方一致にしてあるのは、同じ通知の部品が memory-updated-text /
        // memory-manage-link のように増えるため
        // foot-note-div は本文末尾の「ソース」ボタン（実機の診断で発覚）。
        // 本文要素の中にあるため抽出では外れず、末尾に「ソース」と読み上げられる。
        // 中の sources-button-testid ごと落とせる外側を指定する
        drop: '[data-citation-group-id],[data-testid="CopyButtonContainerTestId"],' +
              '[data-testid="FeedbackContainerTestId"],[role="toolbar"],' +
              '[data-testid="foot-note-div"],[data-testid^="memory-"]',
        // コードは PRE ではなく専用のビューアで組まれており、行番号・コード本文・
        // 言語ラベルが別々の要素に入っている。そのままだと行番号まで読み上げる
        // （実機で発覚）。祖先をたどって、3つすべてを含む要素を選んである。
        //
        // class 名はほとんどがハッシュ（r1f29ykk のような）で当てにならないが、
        // scriptor-component-code-block だけは意味のある名前なのでこれを使う。
        // role のほうは保険。class が変わってもコード本文と行番号は落ちる
        // （言語ラベルだけが残る）。aria-label は表示言語で変わるので使わない
        code: '.scriptor-component-code-block,[role="textbox"]',
        // 利用者の発言（実機確認済み）。中の文字は "You said: ..." で始まる。
        // 短い応答を取りこぼさないために使う
        userRow: '[data-testid="chatQuestion"]',
      },
      // スクリーンリーダー用のラベルを落とす。
      // 文字列の先頭だけを見ると、前に別の要素（思い出の通知など）が入った瞬間に
      // 素通りして読み上げられる（実機で発生）。行頭ならどこでも落とす
      stripText: [/^[ \t]*Copilot said:[ \t]*/gmi, /^[ \t]*You said:[ \t]*/gmi],
      streamingAttr: null,
      // completeIsFinal は付けない。一度付けて実測したが速くならなかった。
      //
      // 生成中は complete=false（確認済み）なので付ける条件は満たすが、
      // コピーボタンが出るのが遅い。実測では最後に本文が伸びてから約 1.7 秒。
      // settleMs 1500 より遅いので、どちらの設定でもボタンの出現が律速になる
      // （1.60 秒 → 1.68 秒。差は応答ごとのばらつきの範囲）。
      //
      // 速くならないうえ、付けるとコピーボタンが静止判定の前提条件でなくなり、
      // Web検索などによる生成の一時停止を完了と誤判定するようになる。
      // 得るものが無く失うものだけがあるので、付けない
      completeIsFinal: false,
      stream: true,
      // 生成中インジケータが使えないため、静止判定が唯一の時間的な歯止めになる。
      // Web検索などで生成が一時停止するので、短すぎると途中で読み始める
      settleMs: 1500,
    },

    // gemini.google.com/app。Angular のカスタム要素で組まれている。
    // Copilot と同じく生成状態を示す属性が無いので静止判定を使う。
    // ここのセレクタは未検証。合わなければ設定パネルの「診断」で特定して直すこと。
    gemini: {
      label: 'Gemini',
      host: /(^|\.)gemini\.google\.com$/,
      sel: {
        row: 'model-response',
        body: 'message-content',
        // 地の文はマークダウンのコンテナに入る。Claude と同じ考え方で、
        // 思考プロセスやソース一覧はこの外側にあるため自然に外れる
        prose: '.markdown',
        // 生成完了後に出る操作ボタン群（実機確認済み）。
        // Gemini には data-test-id が無く aria-label しか手がかりが無いため、
        // 表示言語で変わる。日本語UIと英語UIの両方を並べておく。
        // 推定で入れた [data-test-id="copy-button"] は実機に存在せず、
        // 完了判定が永久に false になった過去がある。ここは実機で確認した値だけ書く
        complete: '[aria-label="コピー"],[aria-label="Copy"]',
        // prose が効かなかった場合の保険。思考プロセス・ソース・操作ボタン
        drop: 'model-thoughts,sources-list,[data-test-id="sources-list"],' +
              '[data-test-id="thoughts-content"],.response-footer,[role="toolbar"]',
        // 利用者の発言（実機確認済み）。中の文字は「あなたのプロンプト …」で始まり、
        // 会話3往復で3個に一致した。短い応答の取りこぼしを塞ぐ。
        //
        // 名前に collapsed とあるのが気がかり。長い発言は折りたたまれる作りなので、
        // 展開時に別の値になるかもしれない（未確認）。外れても取りこぼしが
        // 元に戻るだけで、過去の応答を読む方向へは倒れない
        userRow: '[data-test-id="luminous-collapsed-bubble"]',
      },
      streamingAttr: null,
      stream: true,
      // コピーボタンの出現をもって完了とみなす。静止時間を待たない
      completeIsFinal: true,
      // completeIsFinal の逃げ道。UI改修で sel.complete が合わなくなっても、
      // この時間だけ待てば読み上げは始まる（遅くなるだけで、止まりはしない）
      settleMs: 1200,
    },

    // chatgpt.com（旧 chat.openai.com）。
    //
    // streaming はあえて空にしてある。外すと isGenerating() が真のまま固まり、
    // どの応答も読まれなくなる（Copilot の loading-message がそうだった）。
    // 未設定なら静止判定へ落ちるだけで、遅くなっても止まりはしない。
    chatgpt: {
      label: 'ChatGPT',
      host: /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/,
      sel: {
        // 応答1件のコンテナは会話のターン（実機確認済み）。
        // 操作ボタンは本文の div の外、このターンの中にあるため、
        // 後で sel.complete を入れられるようにここを行とする。
        // 利用者側のターンにも一致するが、本文が空の行は読まれない。
        //
        // タグ名は付けない。推定で article と書いたが実物は section だった。
        // 目印は data-testid のほうであり、タグは変わりうる
        row: '[data-testid^="conversation-turn-"]',
        // 行の直下には "ChatGPT:" というスクリーンリーダー用のラベルが付くが、
        // それはこの本文要素の外にあるので、本文だけを読めば混ざらない（実機確認済み）
        body: '[data-message-author-role="assistant"]',
        // 地の文はマークダウンのコンテナに入る。Claude / Gemini と同じ考え方
        prose: '.markdown',
        // 生成完了後に出るコピーボタン（実機確認済み）。行の中にある。
        // aria-label は "回答をコピーする" だが表示言語で変わるので使わない
        complete: '[data-testid="copy-turn-action-button"]',
        // Web検索の出典元。段落の中にインライン要素として埋め込まれるため、
        // sel.prose の内側にあって抽出では外れない。サイト名は任意の文字列なので
        // 文字列除去でも消せない（実機で発覚。サイト名と「+1」が読み上げられた）。
        // Claude の [data-not-prose] と同じ考え方で、要素ごと落とす。
        //
        // 2つ指定してある。webpage-citation-pill が実体で、
        // data-content-reference-start はそれを包む印。どちらか片方が
        // UI改修で変わっても、もう片方で落ちる。実機ではどちらの要素も
        // 出典元だけを含んでおり、地の文を巻き込まないことを確認した
        drop: '[data-testid="webpage-citation-pill"],[data-content-reference-start]',
        // 利用者の発言（実機確認済み）。本文と同じ属性の値違いで、
        // 会話3往復で3個に一致することを確かめた。短い応答の取りこぼしを塞ぐ
        userRow: '[data-message-author-role="user"]',
      },
      streamingAttr: null,
      stream: true,
      // 生成中に診断して complete=false を確認済み。コピーボタンは生成が
      // 終わってから出るので、出現をもって確定とみなしてよい（Gemini と同じ）
      completeIsFinal: true,
      // ここは「コピーボタンが二度と出なかったとき」の保険であって、通常の経路ではない。
      // 実測ではボタンが即座に出るため、この時間を待つことはない（初音 0.01 秒）。
      // 短くすると生成の一時停止を完了と誤判定するので、長く取る
      settleMs: 8000,
    },
  };

  function detectSite() {
    for (const [id, s] of Object.entries(SITES)) {
      if (s.host.test(location.hostname)) return Object.assign({ id }, s);
    }
    return null;
  }

  const site = detectSite();
  const siteReady = !!(site && site.sel.row && site.sel.body);

  // ============================================================ 設定

  const DEFAULTS = {
    serverUrl: 'http://127.0.0.1:8080',
    apiToken: '',
    // 空 = サーバに任せる。どのサイトでどの声を使うかはサーバ側の設定で決まる。
    // ここで指定するのはこの端末だけの一時的な上書き
    voice: '',
    prefetch: 2,          // 先読み数
    codeMode: 'skip',     // skip | label | full
    tableMode: 'skip',    // skip | label | full
    format: '',           // 空 = サーバの既定
    autoRead: false,      // 新しい応答を自動で読むか
    maxChars: 200,        // これを超える文は読点で再分割
    // 文と文のあいだに置く無音（ミリ秒）。
    // 文を連続再生すると息継ぎが無く聞き取りにくい場合がある。
    // 1文目の前には入れないので、初音までの時間は変わらない
    gapMs: 300,
    speculate: true,      // 完了を待つ間に先に合成しておく
    // 生成の途中でも、確定した文から順に読み始める。
    // サイト側が対応していない場合（SITES の stream:false）はこの設定に関わらず働かない
    streamRead: true,
    // ボタンの位置（画面の右端・下端からの px）。-1 は未設定で、既定値を使う。
    // スマホでは入力欄の送信ボタンと重なるので、既定を上にずらす
    btnRight: -1,
    btnBottom: -1,
  };

  const cfg = Object.assign({}, DEFAULTS);
  for (const k of Object.keys(DEFAULTS)) {
    const v = GM_getValue(k, undefined);
    if (v !== undefined && v !== null) cfg[k] = v;
  }
  function saveCfg() {
    for (const k of Object.keys(DEFAULTS)) GM_setValue(k, cfg[k]);
  }

  // ============================================================ 通信

  const inflight = new Set();   // 中断できるように保持する

  function request(opts) {
    return new Promise((resolve, reject) => {
      const headers = Object.assign({}, opts.headers);
      if (cfg.apiToken) headers['X-Api-Token'] = cfg.apiToken;
      const handle = GM_xmlhttpRequest(Object.assign({}, opts, {
        headers,
        timeout: opts.timeout || 60000,
        onload: (r) => { inflight.delete(handle); resolve(r); },
        onerror: () => { inflight.delete(handle); reject(new Error('接続できない')); },
        onabort: () => { inflight.delete(handle); reject(new Error('中断')); },
        ontimeout: () => { inflight.delete(handle); reject(new Error('タイムアウト')); },
      }));
      inflight.add(handle);
    });
  }

  function abortAll() {
    for (const h of inflight) { try { h.abort(); } catch (e) { /* 済み */ } }
    inflight.clear();
  }

  async function checkHealth() {
    // 読み上げ開始のたびに確認する。サーバは手動起動なので停止が常態
    const r = await request({ method: 'GET', url: cfg.serverUrl + '/health', timeout: 5000 });
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
    return JSON.parse(r.responseText);
  }

  async function fetchVoices() {
    const r = await request({ method: 'GET', url: cfg.serverUrl + '/voices', timeout: 5000 });
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
    return JSON.parse(r.responseText);
  }

  async function synthesize(text, seq, requestId) {
    // どの声を使うかはサーバが決める。クライアントは依頼元のサイトを伝えるだけ
    const body = { text, seq, request_id: requestId, site: site.id };
    if (cfg.voice) body.voice = cfg.voice;   // 端末側の一時的な上書き
    if (cfg.format) body.format = cfg.format;

    const r = await request({
      method: 'POST',
      url: cfg.serverUrl + '/synthesize',
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify(body),
      responseType: 'arraybuffer',
      timeout: 120000,
    });
    if (r.status !== 200) {
      throw new Error('合成に失敗 (HTTP ' + r.status + ')');
    }
    if (seq === 0) {
      // どの音声が使われたか。voice 未指定でサーバの既定に従った場合の確認用
      console.log('[tts] voice=' + decodeHeader(r.responseHeaders, 'X-Voice'));
    }
    return r.response;
  }

  /**
   * レスポンスヘッダを1つ取り出す。
   * X-Voice は日本語の音声名を載せられるよう百分率符号化されている
   * （サーバ側 _header_safe）ので復号する。
   */
  function decodeHeader(rawHeaders, name) {
    const m = new RegExp('^' + name + ':\\s*(.*)$', 'im').exec(rawHeaders || '');
    if (!m) return '';
    try { return decodeURIComponent(m[1].trim()); } catch (e) { return m[1].trim(); }
  }

  // ============================================================ 音声

  let audioCtx = null;
  let currentSource = null;

  /**
   * AudioContext を用意し、再生できる状態まで待つ。
   *
   * ユーザー操作を伴わずに作った AudioContext は suspended で始まる。
   * その状態で start() を呼ぶと、音は出ないのに onended も来ないため、
   * 再生ループが永久に待ち続けて「ボタンは赤いのに無音」になる。
   * resume() は Promise を返すので、必ず待ってから状態を確かめる。
   */
  async function ensureAudio() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') {
      try { await audioCtx.resume(); } catch (e) { /* 状態で判定する */ }
    }
    return audioCtx;
  }

  /** 次のユーザー操作で AudioContext を解放する。自動読み上げが先に走った場合の保険。 */
  function resumeOnGesture() {
    const on = () => { if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume(); };
    for (const ev of ['pointerdown', 'keydown']) {
      document.addEventListener(ev, on, { capture: true });
    }
  }

  function playBuffer(buf, token) {
    return new Promise((resolve) => {
      if (token !== session) { resolve(); return; }
      const src = audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(audioCtx.destination);
      src.onended = () => { if (currentSource === src) currentSource = null; resolve(); };
      currentSource = src;
      src.start();
    });
  }

  function stopPlayback() {
    if (currentSource) {
      try { currentSource.onended = null; currentSource.stop(); } catch (e) { /* 済み */ }
      currentSource = null;
    }
  }

  // ============================================================ 抽出

  const BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
                              'BLOCKQUOTE', 'TR', 'SECTION', 'ARTICLE']);
  const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'BUTTON', 'SVG', 'NOSCRIPT']);

  /**
   * 本文要素からテキストを組み立てる。
   *
   * 行(transcript-row)の innerText を使ってはならない。スクリーンリーダー用の
   * 読み上げ文とツール使用の表示が混じり、本文が二重になる。
   * cloneNode + innerText も使えない（切り離した要素では改行が失われる）ので、
   * 自前で走査して改行を組み立てる。
   */
  function nodeToText(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const tag = node.tagName;
    if (DROP_TAGS.has(tag)) return '';
    // サイト固有の除外（引用マーカー、操作ボタン等）
    if (site.sel.drop && node.matches && node.matches(site.sel.drop)) return '';
    if (tag === 'BR') return '\n';

    // 独自のコードビューアで組むサイトがある。PRE と同じ扱いにして、
    // 読むかどうかは設定に従わせる（drop に入れると設定が効かなくなる）
    if (tag === 'PRE' ||
        (site.sel.code && node.matches && node.matches(site.sel.code))) {
      if (cfg.codeMode === 'skip') return '\n';
      if (cfg.codeMode === 'label') return '\n。コードブロック。\n';
      // full はそのまま読む
    }

    // 表はセルの文字列が並ぶだけになり、行と列の対応が音では伝わらない。
    // 「配列 固定長 高速」のように読まれても聞く側には意味が取れないので、
    // コードブロックと同じ扱いにする。role="table" は表を div で組む作りのサイト用
    if (tag === 'TABLE' || (node.matches && node.matches('[role="table"]'))) {
      if (cfg.tableMode === 'skip') return '\n';
      if (cfg.tableMode === 'label') return '\n。表。\n';
      // full はそのまま読む
    }

    let out = '';
    for (const child of node.childNodes) out += nodeToText(child);
    if (BLOCK_TAGS.has(tag)) out += '\n';
    return out;
  }

  /**
   * 応答から読み上げ対象のテキストを取り出す。
   *
   * sel.prose を指定したサイトでは、本文要素の中でも「地の文」だけを読む。
   * Claude の応答には Web検索の結果や思考ブロックが本文要素の中に同居しており、
   * 除外したい要素を1つずつ数え上げるのは UI 改修に弱い。
   * 逆に「読む場所」を指定するほうが、知らない種類のブロックが増えても巻き込まれない。
   *
   * sel.prose に一致する要素が1つも無い場合は本文要素をそのまま読む。
   * セレクタが古くなっても無音にはならないようにするため。
   */
  function extractText(row) {
    const bodies = row.querySelectorAll(site.sel.body);
    if (!bodies.length) return '';
    return [...bodies].map((body) => {
      if (site.sel.prose) {
        const proses = body.querySelectorAll(site.sel.prose);
        // **生成中だけ入れ物が割れることがある。** 確定後に診断しても
        // 1個に戻っていて何も分からないので、割れている瞬間を控えておく
        if (proses.length > 1) noteProseSplit(row);
        if (proses.length) return [...proses].map(nodeToText).join('\n');

        // **地の文の容れ物がまだ無いなら、生成中は何も読まない。**
        //
        // Claude は Web検索や思考が終わってから本文の容れ物を作る。
        // それまで本文要素ごと読む保険に落ちると、進行表示（「処理中」
        // 「ウェブを検索しました」）と検索結果の見出しを読み上げる
        // （実機で発覚。先行合成が「処理中」を4文ぶん合成していた）。
        //
        // **落とすのは生成中だけ。** 確定後は今までどおり本文要素を読む。
        // セレクタが古くなったときに無音になっては困る。
        // 行ごとの生成状態を確実に見分けられるサイトでのみ効かせる
        if (site.streamingAttr && row.getAttribute(site.streamingAttr) === 'true') {
          noteProseMissing(row);
          return '';
        }
      }
      return nodeToText(body);
    }).join('\n');
  }

  /**
   * 地の文の入れ物が複数に割れた瞬間の構造を控える。
   *
   * Claude の Web検索では、検索の段取りを示す見出しが本文と同じ
   * マークダウンの容れ物で組まれ、**生成中だけ**本文と一緒に抽出される。
   * 読み終わるころには消えているため、診断を後から回しても写らない
   * （実機で発覚。英語のサイト説明文が先行合成で読まれた）。
   *
   * 控えるのは応答1件につき1回だけ。読み上げの経路に毎回 DOM 走査を
   * 足すわけにはいかない。
   */
  let proseSplitSnapshot = '';
  const proseSplitSeen = new WeakSet();

  function noteProseSplit(row) {
    if (proseSplitSeen.has(row)) return;
    proseSplitSeen.add(row);
    try {
      proseSplitSnapshot = proseSurveyLines(row).join('\n      ');
    } catch (e) {
      proseSplitSnapshot = '記録に失敗: ' + e.message;
    }
  }

  // 地の文の容れ物が出来る前に読もうとした回数。診断に出す。
  // 保険に落ちていた頃は、ここで進行表示を読み上げていた
  let proseMissed = 0;
  const proseMissSeen = new WeakSet();

  function noteProseMissing(row) {
    if (proseMissSeen.has(row)) return;
    proseMissSeen.add(row);
    proseMissed++;
    console.log('[tts] 地の文の容れ物がまだ無い。出来るまで読まない'
                + '（検索や思考の進行表示を読み上げないため）');
  }

  // ============================================================ 整形

  function normalize(raw) {
    let t = raw;
    // スクリーンリーダー用のラベル（"Copilot said:" 等）を落とす。
    // 本文要素の中に入っているので、抽出だけでは取り除けない
    if (site.stripText) {
      for (const re of site.stripText) t = t.replace(re, '');
    }
    t = t.replace(/https?:\/\/\S+/g, 'リンク');          // URL
    t = t.replace(/^[ \t]*#{1,6}[ \t]*/gm, '');           // 見出し記号
    t = t.replace(/[*_`~|]+/g, '');                       // Markdown 記号
    t = t.replace(/^[ \t]*[-+][ \t]+/gm, '');             // 箇条書きの先頭
    t = t.replace(/[ \t]+/g, ' ');
    t = t.replace(/\n{2,}/g, '\n');
    return t.trim();
  }

  function splitSentences(text) {
    const rough = [];
    let buf = '';
    for (const ch of text) {
      buf += ch;
      if (ch === '。' || ch === '！' || ch === '？' || ch === '!' || ch === '?' || ch === '\n') {
        rough.push(buf); buf = '';
      }
    }
    if (buf) rough.push(buf);

    // 長すぎる文は読点でさらに分割する
    const out = [];
    for (const s of rough) {
      if (s.length <= cfg.maxChars) { out.push(s); continue; }
      let cur = '';
      for (const part of s.split('、')) {
        const piece = cur ? cur + '、' + part : part;
        if (piece.length > cfg.maxChars && cur) { out.push(cur); cur = part; }
        else { cur = piece; }
      }
      if (cur) out.push(cur);
    }

    // 整形後に空・記号だけになった文は破棄する
    return out
      .map((s) => s.trim())
      .filter((s) => s && /[\p{L}\p{N}]/u.test(s));
  }

  // ============================================================ 先行合成

  /**
   * 合成済みの音声を文をキーにして持っておく。
   *
   * 静止判定のサイトでは完了を確かめるまでに settleMs だけ待つ必要があり、
   * その間 GPU は遊んでいる。実測では待ち 1.20 秒・合成 1.66 秒で、
   * 直列に足して初音まで 2.88 秒かかっていた。
   * 待っている間に合成しておけば、合成時間を待ち時間の裏に隠せる。
   *
   * 投機なので外れることがある。外れても捨てるだけで、正しさには影響しない。
   */
  const warm = new Map();      // 文 -> Promise<AudioBuffer>
  const WARM_MAX = 4;

  /**
   * 「もう一度読む」用に、鳴らした音を持っておく。
   *
   * 48kHz float32 で 1 秒あたり約 192KB ある。全文を持つとスマホでは重いので
   * 上限を決め、超えた文は捨てる。捨てた分は再生し直しのときに
   * サーバへ再合成を依頼する。
   */
  const REPLAY_MAX_SEC = 60;
  let lastSpoken = null;       // { sentences, buffers: Map<seq, AudioBuffer>, secs }

  /** 合成して AudioBuffer にする。session に依存しないので投機からも呼べる。 */
  async function fetchAudio(text, seq, requestId, marks) {
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await synthesize(text, seq, requestId);
        if (marks) marks.fetch0 = performance.now();
        // decodeAudioData は ArrayBuffer を消費するのでコピーを渡す
        const buf = await audioCtx.decodeAudioData(raw.slice(0));
        if (marks) marks.decode0 = performance.now();
        return buf;
      } catch (e) {
        if (e.message === '中断') throw e;
        lastErr = e;
      }
    }
    throw lastErr;
  }

  /** 投機的に合成して持っておく。失敗したら捨てて、本番で普通に合成し直す。 */
  function warmUp(text) {
    if (warm.has(text)) return;
    const p = fetchAudio(text, 0, 'warm');
    p.catch(() => warm.delete(text));   // 失敗を残さない。未処理の拒否も防ぐ
    warm.set(text, p);
    while (warm.size > WARM_MAX) warm.delete(warm.keys().next().value);
  }

  const speculated = new WeakMap();   // 行 -> 先行合成済みの文の並び

  /**
   * デコードに使う AudioContext を用意する。再生できる状態までは求めない。
   *
   * decodeAudioData は suspended でも動くので、ここでは「作られていること」だけを
   * 確かめる。以前は running を求めていたが、自動読み上げの設定は保存されるため、
   * ページを開き直した直後はボタンを押していなくても autoRead=true になる。
   * その状態では AudioContext が未作成で、最初の応答だけ先行合成が丸ごと
   * 飛んでいた（実機で AudioContext=未作成 を確認）。
   * 再生そのものは speak() 側で running を確かめている。
   */
  function ensureCtxForDecode() {
    if (audioCtx) return true;
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      return true;
    } catch (e) {
      return false;    // 作れないなら先出ししない。完了後に普通に合成する
    }
  }

  // ==================================================== 逐次読み上げ

  /**
   * 生成中の文の並びから「もう伸びない」と言い切れる分だけを返す。
   *
   * 末尾の文は書きかけかもしれないので必ず捨てる。次の文が現れて初めて
   * 手前の文を確定とみなす、という先行合成と同じ規則。
   */
  function confirmedSentences(sents) {
    return sents.slice(0, -1);
  }

  /**
   * 先出しした文と、確定後の全文を突き合わせる。
   *
   * matched が false なら、既に読んだ文が後から書き換わったということ。
   * 鳴らした音は取り消せないので、続きは「読んだ数だけ進めた位置」から読む。
   * 取りこぼす可能性は残るが、同じ文をもう一度読むよりは害が小さい。
   */
  function resumeIndex(emitted, final) {
    let i = 0;
    while (i < emitted.length && i < final.length && emitted[i] === final[i]) i++;
    return { from: emitted.length, matched: i === emitted.length };
  }

  /**
   * 差し替わった行が「同じ応答の続き」かを見る。
   *
   * SPA では生成中に行の要素そのものが作り直されることがある。
   * 要素が変わっただけで打ち切ると、鳴らしている文が途中で切れ、
   * 先頭から読み直しになる（Copilot で発生）。しかも先行合成の結果は
   * 使い切っているので、同じ文を合成し直すことになる（音が変わる）。
   *
   * 既に送った文がすべて先頭から一致し、かつ短くなっていなければ続きとみなす。
   */
  function isContinuation(emitted, fixed) {
    return fixed.length >= emitted.length && resumeIndex(emitted, fixed).matched;
  }

  /**
   * 文が後から増える読み上げ対象。
   *
   * 生成の途中で読み始めるには、speak() に「まだ全部は決まっていない並び」を
   * 渡す必要がある。items は増えるだけで、一度入れた文は書き換えない。
   */
  function makeStream() {
    const items = [];
    const waiters = [];
    let closed = false;
    const wake = () => { while (waiters.length) waiters.pop()(); };
    return {
      items,
      get closed() { return closed; },
      push(list) { for (const x of list) items.push(x); wake(); },
      close() { closed = true; wake(); },
      /** i 番目が現れるまで待つ。現れないまま閉じたら false */
      async wait(i) {
        while (items.length <= i) {
          if (closed) return false;
          await new Promise((r) => waiters.push(r));
        }
        return true;
      },
    };
  }

  // 読み始める前に確定させておく文の数。安全側に倒して2文にしてある。
  // 1文で始めれば最速だが、1文目が書き換わる作りのサイトだと取り返しがつかない。
  // 2文目が現れた時点なら、1文目はもう伸びないと言い切れる
  const STREAM_MIN = 2;

  // いま先出ししている応答。生成は同時に1件しか走らないので1つで足りる
  let live = null;    // { row, stream, emitted, started, stopped, breaks, ticks, t0 }

  function streamOn() {
    return cfg.streamRead && site.stream === true;
  }

  function closeLive() {
    if (!live) return;
    live.stream.close();
    live = null;
  }

  /**
   * 行が差し替わっただけなら、同じ応答として追い続ける。
   * 追従できたら true。**打ち切って作り直してはならない**（isContinuation 参照）。
   */
  function relinkLive(list) {
    if (!live || !live.started) return false;
    for (const row of list) {
      const fixed = confirmedSentences(splitSentences(normalize(extractText(row))));
      if (!isContinuation(live.emitted, fixed)) continue;
      console.log('[tts] 逐次読み: 行が差し替わったので追従する（' +
                  live.emitted.length + '文まで送信済み）');
      live.row = row;
      return true;
    }
    return false;
  }

  /**
   * 生成中の応答を1回分進める。checkRows() から毎回呼ばれる。
   *
   * やることは2つ。
   *   1. 確定した文を先に合成しておく（完了を待つ経路のとき初音が速くなる）
   *   2. 逐次読み上げが有効なら、確定した文をそのまま読み上げへ送る
   */
  function advance(row) {
    if (!cfg.autoRead) return;
    const streaming = streamOn();
    if (!cfg.speculate && !streaming) return;
    if (!ensureCtxForDecode()) return;

    const fixed = confirmedSentences(splitSentences(normalize(extractText(row))));
    if (!fixed.length) return;

    // 逐次読み上げの器。読み始める前でも作っておき、確定した文を溜めていく
    //
    // **別の行に見えても、いきなり作り直さない。** 生成中に要素が差し替わる
    // サイトがあり、作り直すと先頭から読み直しになる（Copilot で発生）
    // まだ1文も送っていないなら比べる材料が無い。作り直してよい
    if (streaming && live && live.row !== row && live.emitted.length &&
        isContinuation(live.emitted, fixed)) {
      console.log('[tts] 逐次読み: 行が差し替わったので追従する（' +
                  live.emitted.length + '文まで送信済み）');
      live.row = row;
    }
    if (streaming && (!live || live.row !== row)) {
      if (live) console.log('[tts] 逐次読み: 別の応答が始まったので切り替える');
      closeLive();
      live = { row, stream: makeStream(), emitted: [], started: false, stopped: false,
               breaks: 0, ticks: 0, t0: genStart.get(row) || performance.now() };
    }
    const onAir = streaming && live && live.row === row && live.started;

    // --- 1. 先行合成 ---
    //
    // 以前は1文目だけだった。確定した文をまとめて投げておけば、完了を待つ経路でも
    // 文と文のあいだの待ちが減る。warm は WARM_MAX 件で古いものから捨てるので、
    // 先に鳴る側から順に、入る分だけ持たせる。
    //
    // 読み上げが始まったあとは投げない。warm は取り出すと消えるので、
    // 既に鳴らした文をここで合成し直すことになる（GPU を無駄に占有する）。
    // 始まったあとの先読みは speak() の prefetch が受け持つ
    if (cfg.speculate && !onAir) {
      const head = fixed.slice(0, WARM_MAX);
      const known = speculated.get(row) || [];
      if (head.length !== known.length || head.some((x, i) => x !== known[i])) {
        speculated.set(row, head);
        // 当たったか外れたかは初音の時間を左右する。当たらないときに
        // 「投げていない」のか「投げたが別の文だった」のかを分けられるよう記録する
        console.log('[tts] 先行合成 ' + head.length + '文 "' + head[0].slice(0, 24) + '"');
      }
      for (const x of head) warmUp(x);
    }

    // --- 2. 逐次読み上げ ---
    if (!streaming || live.stopped) return;
    live.ticks++;

    // 先出しした分が書き換わっていないか。崩れたら以降は先出しをやめ、
    // 残りは完了後にまとめて読む（従来の動きへ落ちる）
    if (!resumeIndex(live.emitted, fixed).matched) {
      live.breaks++;
      live.stopped = true;
      console.log('[tts] 逐次読み: 本文が書き換わったので先出しをやめる（' +
                  live.emitted.length + '文まで送信済み）');
      return;
    }

    const next = fixed.slice(live.emitted.length);
    if (!next.length) return;
    // 読み始める前は STREAM_MIN 文まで待つ。始まったあとは1文ずつでよい
    if (!live.started && live.emitted.length + next.length < STREAM_MIN) return;

    live.emitted.push.apply(live.emitted, next);
    live.stream.push(next);
    if (!live.started) {
      live.started = true;
      speak(live.stream, { t0: live.t0, streaming: true });
    }
  }

  /**
   * 逐次読み上げ中の応答が確定したときの締め。残りを足して閉じる。
   * 先頭から読み直さないので、既に鳴らした文が二度読まれることはない。
   */
  function finishLive(row) {
    const final = splitSentences(normalize(extractText(row)));
    const r = resumeIndex(live.emitted, final);
    const rest = final.slice(r.from);
    if (!r.matched) {
      console.log('[tts] 逐次読み: 先出しした文と確定後の本文が食い違う。' +
                  '重複を避ける側に倒して ' + r.from + '文目から続ける');
    }
    console.log('[tts] 逐次読み: 先出し ' + live.emitted.length + '文 + 残り ' +
                rest.length + '文  破綻 ' + live.breaks + '回');
    if (rest.length) live.stream.push(rest);
    closeLive();
  }

  // ============================================================ 読み上げ

  let session = 0;      // 中断の判定に使う。値が変わったら古い処理は捨てる
  let speaking = false;

  /**
   * 文を順に読み上げる。
   *
   * source は配列でも、あとから文が増える makeStream() でもよい。
   * 逐次読み上げでは後者を渡し、生成の途中から鳴らし始める。
   */
  async function speak(source, marks, cached) {
    // 配列で渡されたときは「もう増えない並び」として扱う。従来の呼び方はそのまま動く
    const stream = Array.isArray(source)
      ? { items: source, closed: true, wait: async (i) => i < source.length }
      : source;
    const sentences = stream.items;
    if (!sentences.length && stream.closed) return;

    session++;
    // 前の応答を鳴らしている最中に次の応答が確定することがある。session++ だけでは
    // 再生中の1文が最後まで鳴り続け、新しい応答の1文目と重なる。
    // 先行合成が当たると新しい側がほぼ即座に鳴るため、必ず重なる
    stopPlayback();
    const token = session;
    speaking = true;
    updateButton();

    // 計測用。テスト読み上げなど起点が無い場合は今を起点にする
    const t = marks || { t0: performance.now() };
    if (!t.extract) t.extract = t.t0;

    try {
      const health = await checkHealth();
      t.health = performance.now();
      if (!health.model_loaded) throw new Error('モデル未ロード');
    } catch (e) {
      const msg = e.message === '接続できない' ? 'サーバ未起動' : e.message;
      showError(msg);
      speaking = false; updateButton();
      return;
    }

    await ensureAudio();
    if (audioCtx.state !== 'running') {
      // ここで進むと合成だけ走って無音のまま固まる。手前で止めて理由を出す
      showError('ブラウザが再生をブロックしている。ボタンを1回クリックすること');
      speaking = false; updateButton();
      return;
    }
    const requestId = String(Date.now());
    const reqs = new Map();   // seq -> Promise<AudioBuffer>
    let nextPlay = 0;

    // 再生し直しのときは、すでに持っているものを使うので溜め直さない
    const keep = cached ? null : { sentences: sentences, buffers: new Map(), secs: 0 };
    if (keep) lastSpoken = keep;

    // 1文だけ失敗しても2回目までは試す。無限リトライで電池を消費させない
    async function fetchOne(i) {
      // 再生し直しなら、前に鳴らした音がそのまま残っている
      if (cached && cached.has(i)) return cached.get(i);
      // 完了待ちの間に先行合成できていれば、それを使う
      const hit = warm.get(sentences[i]);
      if (hit) {
        warm.delete(sentences[i]);
        const buf = await hit;
        if (i === 0) {
          // 投機は fetchAudio の中で合成もデコードも済ませている。
          // ここでの待ちは「投機がまだ終わっていなかった残り時間」であって
          // デコード時間ではない。await の前に fetch0 を打つと、その残りが
          // まるごとデコード時間として計上されて読み違える（実機で発生）
          t.fetch0 = performance.now();
          t.decode0 = t.fetch0;
          t.warm = true;
        }
        return buf;
      }
      return fetchAudio(sentences[i], i, requestId, i === 0 ? t : null);
    }

    function prefetch() {
      const end = Math.min(sentences.length, nextPlay + 1 + Math.max(0, cfg.prefetch));
      for (let i = nextPlay; i < end; i++) {
        if (reqs.has(i)) continue;
        const p = fetchOne(i);
        // 再生が追いつく前に失敗すると未処理の拒否になるので、ここで受け止めておく。
        // 拒否そのものは残るため、再生ループ側で await したときに検知できる
        p.catch(() => {});
        reqs.set(i, p);
      }
    }

    try {
      while (true) {
        if (token !== session) return;
        // まだ生成中なら、次の文が届くまでここで待つ。届かないまま閉じたら終わり
        if (!(await stream.wait(nextPlay))) break;
        if (token !== session) return;
        prefetch();
        // 到着順ではなく seq 順に再生する
        const buf = await reqs.get(nextPlay);
        if (token !== session) return;
        if (nextPlay === 0) { t.play0 = performance.now(); reportTiming(t, sentences.length, stream.closed); }
        if (keep && keep.secs + buf.duration <= REPLAY_MAX_SEC) {
          keep.buffers.set(nextPlay, buf);
          keep.secs += buf.duration;
        }
        // 文と文のあいだに息継ぎを入れる。1文目の前には入れない（初音を遅らせない）
        if (nextPlay > 0 && cfg.gapMs > 0) {
          await new Promise((r) => setTimeout(r, cfg.gapMs));
          if (token !== session) return;
        }
        await playBuffer(buf, token);
        nextPlay++;
      }
      setStatus('読み上げ完了');
    } catch (e) {
      if (token === session && e.message !== '中断') {
        showError(e.message === '接続できない' ? 'サーバ未起動' : e.message);
      }
    } finally {
      if (token === session) { speaking = false; updateButton(); }
    }
  }

  function stopSpeaking() {
    session++;              // 進行中のループを無効化する
    abortAll();             // 送信済みリクエストを中断する
    stopPlayback();
    // 逐次読み上げの途中で止めた場合、その応答は読み終えたものとして扱う。
    // そうしないと、生成が完了した時点で先頭から読み直してしまう
    if (live) { done.add(live.row); closeLive(); }
    speaking = false;
    updateButton();
  }

  function readRow(row) {
    // 生成の途中から読み始めていたなら、残りを足して閉じるだけでよい。
    // ここで普通に読むと、既に鳴らした文が先頭から二度読まれる
    if (live && live.row === row) {
      if (live.started) { finishLive(row); return; }
      closeLive();   // STREAM_MIN に届かない短い応答。従来どおり全部読む
    }

    // 属性判定のサイトは属性が変わった瞬間、静止判定のサイトは伸びが止まった瞬間が起点
    const marks = { t0: completedAt.get(row) || lastChange.get(row) || performance.now() };
    const text = normalize(extractText(row));
    const sentences = splitSentences(text);
    marks.extract = performance.now();
    // 鳴らしている最中にここへ来たら、前の応答は途中で切られる。
    // 同じ応答を二重に読んでいる可能性があるので、必ず記録に残す
    if (speaking) {
      console.warn('[tts] 読み上げ中に別の応答を読み始める。' +
                   '同じ応答が二重に読まれていないか確認すること');
    }
    console.log('[tts] 読み上げ', sentences.length, '文', sentences);
    if (!sentences.length) { setStatus('読み上げる本文がない'); return; }
    speak(sentences, marks);
  }

  /**
   * 直前に読み上げた応答をもう一度鳴らす。
   *
   * 持っている分は再合成しないので、聞き逃したときにすぐ鳴らし直せる。
   * 上限を超えて捨てた分だけサーバに取りに行く。
   */
  function replay() {
    if (!lastSpoken) { setStatus('まだ読み上げていない'); return; }
    console.log('[tts] 再生し直し ' + lastSpoken.sentences.length + '文' +
                '（うち' + lastSpoken.buffers.size + '文は合成済み）');
    speak(lastSpoken.sentences, null, lastSpoken.buffers);
  }

  /** 応答確定から初音までを計測し、遅延の内訳を出す。 */
  function reportTiming(m, count, closed) {
    const d = (a, b) => (b - a).toFixed(0) + 'ms';
    const total = (m.play0 - m.t0) / 1000;

    // 逐次読み上げでは起点が「応答の確定」ではなく「生成の始まり」になる。
    // 待ち時間の中身も変わる（合成ではなく、STREAM_MIN 文が出そろうまでの生成時間が
    // 大半を占める）ので、完了を待つ経路の内訳をそのまま出しても読み違える
    if (m.streaming) {
      console.log(
        '[tts] 逐次読み: 生成開始から初音まで ' + total.toFixed(2) + '秒' +
        '  先出し=' + count + '文' + (closed ? '' : '（生成中）') + '\n' +
        '      うち合成    ' + d(m.health, m.fetch0) +
          (m.warm ? '  ← 先行合成の結果を使用' : '  ← 先行合成なし') + '\n' +
        '      残りは ' + STREAM_MIN + '文が出そろうまでの生成時間'
      );
      setStatus('初音まで ' + total.toFixed(2) + '秒（逐次）', total > 3);
      return;
    }

    console.log(
      '[tts] 初音まで ' + total.toFixed(2) + '秒（目標3秒）  文数=' + count + '\n' +
      '      確定→抽出   ' + d(m.t0, m.extract) + '  (MutationObserver のデバウンス120msを含む)\n' +
      '      health確認   ' + d(m.extract, m.health) + '\n' +
      '      1文目の合成  ' + d(m.health, m.fetch0) +
        // 外れたときは、そもそも投機していないのか、別の文を投機したのかを分ける。
        // 手元に何を持っているかを出せば、上の「先行合成」のログと突き合わせられる
        // 投機に当たったときの数字は「投機の残り待ち」。0 に近ければ間に合っており、
        // 大きければ投機は走ったが終わっていなかった、と読む
        (m.warm ? '  ← 先行合成の結果を使用（0 に近いほど間に合っている）'
                : '  ← 先行合成なし（保持 ' + warm.size + ' 件）') + '\n' +
      '      デコード     ' + d(m.fetch0, m.decode0) + '\n' +
      '      再生開始     ' + d(m.decode0, m.play0)
    );
    setStatus('初音まで ' + total.toFixed(2) + '秒', total > 3);
  }

  // ============================================================ 監視

  const seenAtInit = new WeakSet();   // 起動時に既にあった応答は読まない
  const preexisting = new WeakSet();  // 初めて見た時点で既に完成していた応答も読まない
  const active = new WeakSet();       // 起動後に生成を観測した応答
  const done = new WeakSet();
  const lastLen = new WeakMap();      // 本文の長さ。伸びていれば生成中
  const lastChange = new WeakMap();   // 最後に伸びた時刻

  // 応答が確定した時刻。初音までの遅延の計測起点になる。
  // checkRows() は 120ms のデバウンス後に走るので、そこを起点にすると
  // 自分の遅延を計測から外してしまう。属性が変化した瞬間を記録する。
  const completedAt = new WeakMap();

  // 生成が始まった時刻。逐次読み上げの「生成開始から初音まで」の起点になる。
  // lastChange は最後に伸びた時刻なので、途中で読み始める経路では起点に使えない
  const genStart = new WeakMap();

  /**
   * 利用者の発言行の増え方を、送信か履歴の読み込みかに分ける。
   *
   * 送信すれば末尾に1件だけ増える。リロードやチャット切り替えでは
   * まとめて流れ込むので、増えた数で見分けられる。
   */
  function userRowEvent(fresh, lastIsFresh) {
    if (fresh === 0) return 'none';
    if (fresh > 1) return 'flood';        // 履歴の読み込み。送信ではない
    return lastIsFresh ? 'send' : 'none';
  }

  /**
   * 初めて見た行を「新しい応答」と断じてよいか。
   *
   * now > armedAt を求めているのが要点。履歴の読み込みでは利用者の発言と
   * 応答が同じ観測で現れるため、同じ時刻なら受け付けない。
   *
   * 一度この条件を外したが、Gemini のリロードで過去の応答を読み上げた（実機で発生）。
   * 履歴が1行ずつ流れ込むため flood 判定が効かず、1件ずつの追加が送信に見える。
   * 初見の時点では完了要素もまだ出ていないので looksDone でも止められない。
   * この条件だけが最後の砦になっていた。外してはならない。
   *
   * 代償として、送信と同じ観測で出そろう短い応答は取りこぼす（実機の Gemini）。
   * 取りこぼしのほうが害が小さいので、こちらを選ぶ。
   *
   * hasBody は ChatGPT のように sel.row が利用者のターンにも一致するサイト用。
   * 利用者のターンで消費してしまうと、肝心の応答に効かなくなる。
   */
  function acceptsAsNew(armedAt, now, isLast, hasBody) {
    return !!armedAt && now > armedAt && isLast && hasBody;
  }

  /**
   * 「読み込み中」とみなす時間帯。
   *
   * SPA では会話履歴が起動後・URL変化後に段階的に描画される。Gemini はこれが
   * 顕著で、行が現れた時点ではまだ中身も完了要素も揃っていない。そのため
   * looksDone では過去の応答と見分けられず、次の観測で「伸びた」と見えて
   * 生成中と誤認する。実機で3行まとめて同じ時刻に伸び、最後の1件が
   * 読み上げられた。描画の速さ次第なので、起きる回と起きない回がある。
   *
   * 描画の速さで判断するのをやめ、時間で切る。
   * **リロード直後に新しい応答が完成することは原理的に無い。** 利用者が入力して
   * 送信する時間が必ず要るためで、この非対称性は描画の実装に依存しない。
   *
   * 代償は、リロード直後 LOAD_GRACE_MS 以内に送信した1回が読まれないこと。
   */
  const LOAD_GRACE_MS = 3000;
  let loadingUntil = 0;      // この時刻までに初めて見た行は履歴とみなす
  let lastPath = '';

  function beginLoading(why) {
    loadingUntil = performance.now() + LOAD_GRACE_MS;
    armedAt = 0;             // 読み込み中の送信待ちは持ち越さない
    closeLive();
    console.log('[tts] 読み込み中とみなす（' + why + '）。' +
                (LOAD_GRACE_MS / 1000) + '秒間は新しい応答として扱わない');
  }

  /**
   * 新規チャットで最初に送信すると、URL に会話の ID が振られる。
   * **これを切り替えと同じに扱ってはならない。** ChatGPT では1回の送信で
   * URL が5回変わることを実機で確認しており、読み込み中の窓が開き続けて
   * 1往復目が丸ごと読まれなかった。
   */
  const NEW_CHAT_URL_MS = 5000;
  const NAVIGATION_SETTLE_MS = 1200;
  let lastSendAt = 0;        // 送信を観測した時刻。armedAt と違い使い切っても残す
  let lastSendGestureAt = 0;
  const SEND_GESTURE_MS = 10000;
  let pendingNavigationAt = 0;

  function noteSendGesture(e) {
    if (!e.isTrusted) return;
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (e.type === 'keydown') {
      if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
      if (!target.closest('textarea,[contenteditable="true"],[role="textbox"]')) return;
    } else if (e.type === 'click') {
      const button = target.closest('button,[role="button"]');
      if (!button) return;
      const label = [button.getAttribute('aria-label'), button.getAttribute('title'),
                     button.getAttribute('data-testid'), button.textContent].filter(Boolean).join(' ');
      if (button.getAttribute('type') !== 'submit' &&
          !(button instanceof HTMLButtonElement && button.type === 'submit') &&
          !/(?:送信|送る|send|submit)/i.test(label)) return;
    }
    lastSendGestureAt = performance.now();
    recordDetection('送信操作を捕捉: ' + e.type);
  }

  function recentSendGesture(now) {
    return lastSendGestureAt > 0 && now - lastSendGestureAt <= SEND_GESTURE_MS;
  }

  function pendingNavigationVerdict(userEvent, elapsed, sinceSend) {
    if (userEvent === 'send' || sinceSend <= NEW_CHAT_URL_MS) return 'newchat';
    if (userEvent === 'flood' || elapsed >= NAVIGATION_SETTLE_MS) return 'switch';
    return 'wait';
  }

  /**
   * URL が変わった理由を決める。
   *
   *   'newchat' … 新規チャットに ID が振られただけ。履歴は流れ込まない
   *   'switch'  … 別のチャットを開いた。読み込み中の窓を開く
   *
   * 送信の直後かどうかで見分ける。**利用者が送信と切り替えを同時に行うことは無い。**
   */
  function navigationVerdict(o) {
    // **生成中の応答が生きているなら、切り替えではない。**
    // 切り替えれば行ごと DOM から消えるので、残っていること自体が
    // 同じ会話にいる証拠になる。時間で測るより確実。
    //
    // Copilot は応答が長いと、送信から5秒以上たってから URL に ID が振られる。
    // 時間だけで見ていたため切り替えと誤判定し、読み上げ中の応答が打ち切られて
    // 先頭から読み直しになっていた（実機で発生）
    if (o.generating) return 'newchat';
    // 送信を観測済みの場合。ID が振られるのは応答が始まる時なので直後に来る
    if (o.sinceSend <= o.graceMs) return 'newchat';
    // まだ観測していない場合。URL の変化のほうが先に届くことがあるため、
    // 発言の並びを直接見る。切り替えなら過去の発言ごと入れ替わるので、
    // 「未見が末尾の1件だけ」という形にはならない
    if (o.userEvent === 'send') return 'newchat';
    return 'switch';
  }

  /**
   * 送信が起きたかだけを覗く。**seenUser を変えない。**
   * ここで印を付けると checkUserRows が同じ発言を二度と見られなくなる。
   */
  function peekUserEvent() {
    if (!site.sel.userRow) return 'none';
    const list = document.querySelectorAll(site.sel.userRow);
    let fresh = 0, lastIsFresh = false;
    for (const r of list) {
      if (seenUser.has(r)) continue;
      fresh++;
      lastIsFresh = (r === list[list.length - 1]);
    }
    return userRowEvent(fresh, lastIsFresh);
  }

  /** チャットの切り替えを拾う。SPA なので URL の変化を自分で見るしかない。 */
  function checkNavigation(now) {
    // クエリやハッシュだけの変化は切り替えではない。パスだけを見る
    const path = location.origin + location.pathname;
    if (path !== lastPath) {
      const first = !lastPath;
      lastPath = path;
      if (first) return false;
      const verdict = navigationVerdict({
        generating: !!(live && live.row && live.row.isConnected),
        sinceSend: lastSendAt ? now - lastSendAt
                               : (recentSendGesture(now) ? 0 : Infinity),
        graceMs: NEW_CHAT_URL_MS,
        userEvent: peekUserEvent(),
      });
      if (verdict === 'newchat') {
        console.log('[tts] URL が変わったが、送信の直後なので新規チャットの ID 付与とみなす');
        return false;
      }
      // ChatGPT などは新規チャットの URL が利用者の発言行より先に変わる。
      // すぐ切り替えと断定すると読み込み猶予が送信後まで残り、初回応答を履歴扱いする。
      pendingNavigationAt = now;
      recordDetection('URL変更を検知: 発言行を' + NAVIGATION_SETTLE_MS + 'ms確認');
    }
    if (!pendingNavigationAt) return false;

    const navVerdict = pendingNavigationVerdict(
      peekUserEvent(), now - pendingNavigationAt,
      lastSendAt ? now - lastSendAt : Infinity);
    if (navVerdict === 'wait') return true;
    pendingNavigationAt = 0;
    if (navVerdict === 'newchat') {
      console.log('[tts] URL 変更後に送信を確認。新規チャットの ID 付与とみなす');
      recordDetection('URL変更後に送信を確認: 新規チャット');
      return false;
    }
    beginLoading('チャットの切り替え');
    return false;
  }

  /**
   * 初めて見た行をどう扱うか決める。
   *
   *   'preexisting' … 過去の応答。二度と読まない
   *   'new'         … 新しい応答。生成中として追う
   *   'wait'        … まだ決められない。次の観測に持ち越す
   *
   * ここは2度こじらせている（過去の応答を読み上げる不具合を2回出した）ので、
   * 判断だけを切り出して単体テストできるようにしてある。順序に意味がある。
   */
  function firstSightVerdict(o) {
    // 読み込み中は、出来上がって見えるかに関わらず履歴とみなす。
    // 描画の速さに依存しない唯一の判断材料
    if (o.loading) return o.len > 0 ? 'preexisting' : 'wait';
    if (acceptsAsNew(o.armedAt, o.now, o.isLast, o.hasBody) ||
        (o.trustedSend && o.afterUser && o.armedAt === o.now && o.isLast && o.hasBody)) return 'new';
    // 初見で既に出来上がっているなら過去の応答
    if (o.len > 0 && !o.active && o.looksDone) return 'preexisting';
    // 判断が付かないときは持ち越す。読み上げが遅れるほうが、
    // 読まれなくなるより害が小さい
    return 'wait';
  }

  const seenUser = new WeakSet();
  let userSeeded = false;   // 起動時にあった発言は送信ではない
  let armedAt = 0;          // 送信を観測した時刻。0 なら応答を待っていない
  const detectionEvents = []; // 診断用。本文や発言の内容は保存しない
  function recordDetection(event) {
    detectionEvents.push(Math.round(performance.now()) + 'ms ' + event);
    if (detectionEvents.length > 20) detectionEvents.shift();
  }

  // 送信したのに応答が来ないまま放置された場合の時効。
  // 残したままだと、あとで開いた別のチャットの履歴を新しい応答と誤認しうる
  const ARM_MAX_MS = 120000;

  /** 利用者が送信したかを見る。checkRows の先頭で1回だけ呼ぶ。 */
  function checkUserRows(now) {
    if (!site.sel.userRow) return false;
    const list = document.querySelectorAll(site.sel.userRow);
    let fresh = 0, lastIsFresh = false;
    for (const r of list) {
      if (seenUser.has(r)) continue;
      seenUser.add(r);
      fresh++;
      // 末尾かどうかは足す前に見る。全部足したあとでは見分けられない
      lastIsFresh = (r === list[list.length - 1]);
    }

    // 起動時に既にある発言は送信ではない。数えるだけ数えて捨てる
    if (!userSeeded) {
      userSeeded = true;
      recordDetection('初回の発言行確認: 新規=' + fresh + '（起動時の履歴として除外）');
      return false;
    }

    // 読み込み中は送信待ちを立てない。履歴が1行ずつ流れ込むサイトでは
    // 1件ずつの追加が送信に見えるため（Gemini で確認）。ここで立てた印が
    // 読み込みの終わりぎわまで残ると、窓の外で現れた履歴を新しい応答と
    // 誤認しうる。読み込み中に本当に送信することは無いので、捨ててよい
    const trustedSend = recentSendGesture(now);
    if (now < loadingUntil && !trustedSend) {
      if (fresh) recordDetection('読み込み中の発言行: 新規=' + fresh + '（送信判定を保留）');
      return false;
    }

    const ev = userRowEvent(fresh, lastIsFresh);
    if (ev === 'send') {
      armedAt = now;
      lastSendAt = now;      // URL の変化を切り替えと誤認しないために残す
      recordDetection('送信を観測');
      if (trustedSend) loadingUntil = now;
      lastSendGestureAt = 0;
      console.log('[tts] 送信を観測。次の応答は新しいものとして扱う');
    } else if (ev === 'flood') {
      // 履歴が流れ込んだ。待っていた応答はもう来ない
      armedAt = 0;
      recordDetection('発言行をまとめて観測: 新規=' + fresh + '（履歴と判定）');
    }
    if (armedAt && now - armedAt > ARM_MAX_MS) armedAt = 0;
    return ev === 'send' && trustedSend ? list[list.length - 1] : null;
  }

  function rows() {
    return site.sel.row ? document.querySelectorAll(site.sel.row) : [];
  }

  function markExisting() {
    for (const r of rows()) seenAtInit.add(r);
  }

  /**
   * ページ全体で生成中か。生成は同時に1件しか走らないので文書全体で見てよい。
   *
   * 要素の「存在」では判定しない。Copilot の loading-message は全メッセージに
   * 1個ずつ常駐しており、存在の有無では区別できないため、表示状態を見る。
   * 仮にこの要素が常に非表示でも isGenerating() が false を返すだけで、
   * settleMs による静止判定へ安全に縮退する。
   */
  function isGenerating() {
    if (!site.sel.streaming) return false;
    for (const el of document.querySelectorAll(site.sel.streaming)) {
      if (el.offsetParent !== null || el.getClientRects().length) return true;
    }
    return false;
  }

  /**
   * 生成が確定したか。
   *
   * 判定材料は3つあり、確実な順に使う。
   *   1. streamingAttr … 属性が false になったら確定（Claude）
   *   2. sel.complete  … 完了後に現れる要素。completeIsFinal ならこれ単独で確定（Gemini）
   *   3. settleMs      … 本文が伸びなくなってからの経過時間
   *
   * completeIsFinal のサイトでも、要素が見つからないときは settleMs へ落とす。
   * セレクタが古くなったときに永久に読まれなくなるのを避けるため。
   */
  function isComplete(row, now) {
    const seen = site.sel.complete ? !!row.querySelector(site.sel.complete) : null;

    if (site.streamingAttr) {
      if (seen === false) return false;
      return row.getAttribute(site.streamingAttr) === 'false';
    }
    if (isGenerating()) return false;

    // 完了要素の出現そのものを確定とみなす。settleMs の待ちを丸ごと省ける
    if (site.completeIsFinal && seen) return true;
    // 従来どおり「完了要素あり」を静止判定の前提条件として使う（Copilot）
    if (!site.completeIsFinal && seen === false) return false;

    const t = lastChange.get(row);
    return t !== undefined && (now - t) >= site.settleMs;
  }

  /**
   * 初めて見た時点で、この行が既に出来上がっているか。
   *
   * isComplete() と違い静止時間は見ない。初見では経過時間が無く、
   * 「まだ判断できない」と「完成している」を区別できないため。
   * 判断が付かないときは false を返す。読み上げが遅れることはあっても、
   * 読まれなくなるよりはよい。
   *
   * これだけでは履歴と見分けられない。履歴を段階的に描画するサイトでは、
   * 行が現れた時点でまだ完了要素が出ておらず false になる（Gemini）。
   * そのために LOAD_GRACE_MS の窓がある。**この関数を過信しないこと。**
   */
  function looksDone(row) {
    if (site.streamingAttr) return row.getAttribute(site.streamingAttr) === 'false';
    if (isGenerating()) return false;
    if (site.sel.complete) return !!row.querySelector(site.sel.complete);
    return false;
  }

  function checkRows() {
    const now = performance.now();
    const ready = [];
    // チャットの切り替えと送信は、応答の判定より前に見る
    const navigationPending = checkNavigation(now);
    const trustedUserRow = checkUserRows(now);
    if (navigationPending) return;
    const list = [...rows()];

    // チャットを切り替えると、生成中だった行ごと DOM から消える。
    // 放っておくと再生ループが次の文を待ち続け、ボタンが赤いまま固まる
    if (live && !live.row.isConnected && !relinkLive(list)) {
      console.log('[tts] 逐次読み: 対象の行が消えたので打ち切る');
      closeLive();
    }

    for (const row of list) {
      if (done.has(row) || seenAtInit.has(row) || preexisting.has(row)) continue;

      // 本文が伸びている間は生成中とみなす（属性が無いサイト用の判定材料）
      const len = (row.textContent || '').length;
      if (!lastLen.has(row)) {
        // この行を見るのは今が初めて。ここで決め切る。
        //
        // markExisting() は init() の時点でしか走らない。SPA では会話履歴が
        // あとから DOM に入るため、リロードやチャット切り替えの直後は
        // seenAtInit が空のまま履歴が流れ込んでくる。
        //
        // 「あとで長さが変わったら active」という持ち越し方をしてはならない。
        // 送信時の再描画で過去の応答が復活して読まれる（実機で発生）。
        //
        // 判断そのものは firstSightVerdict() にある。順序に意味があり、
        // ここを緩めて過去の応答を読み上げる事故を3回起こしている
        const verdict = firstSightVerdict({
          loading: now < loadingUntil,
          len,
          armedAt,
          trustedSend: !!trustedUserRow,
          afterUser: !!(trustedUserRow &&
            (trustedUserRow.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING)),
          now,
          isLast: row === list[list.length - 1],
          hasBody: !!row.querySelector(site.sel.body),
          active: active.has(row),
          looksDone: looksDone(row),
        });
        if (row === list[list.length - 1]) {
          recordDetection('末尾の応答行: 判定=' + verdict +
                          ' 読み込み中=' + (now < loadingUntil) +
                          ' 送信待ち=' + !!armedAt +
                          ' 本文要素=' + !!row.querySelector(site.sel.body));
        }
        if (verdict === 'preexisting') {
          preexisting.add(row);
        } else if (verdict === 'new') {
          active.add(row);
          if (!genStart.has(row)) genStart.set(row, now);
          armedAt = 0;      // 使い切る。次の送信まで効かせない
          console.log('[tts] 送信後の新しい応答として扱う');
        }
        lastLen.set(row, len);
        lastChange.set(row, now);
        continue;
      }
      if (lastLen.get(row) !== len) {
        const grew = len > lastLen.get(row);
        lastLen.set(row, len);
        lastChange.set(row, now);
        // 生成中とみなすのは伸びたときだけ。ボタンの出し入れなどで本文以外が
        // 縮むことがあり、それを生成と誤認しないため。
        // 中身が空のうちも「生成を観測した」とみなさない。応答の入れ物だけ
        // 先に作られる作りのサイトがあり、そこで active にすると
        // 本文が届く前に静止判定が成立してしまう
        if (grew && len > 0) {
          active.add(row);
          if (!genStart.has(row)) genStart.set(row, now);
        }
      }

      if (site.streamingAttr && row.getAttribute(site.streamingAttr) === 'true') {
        active.add(row);
        advance(row);
        continue;
      }
      // 生成中の行は対象にしつつ、確定するまで読まない
      if (isGenerating()) { active.add(row); advance(row); continue; }

      // 起動前からあった応答は対象外。生成を観測したものだけ読む
      if (!active.has(row)) continue;
      // まだ生成中。確定した文を先に合成し、逐次読み上げへ送る
      if (!isComplete(row, now)) { advance(row); continue; }

      // 読む中身があることまで確かめてから確定させる。
      // ここで done にしてしまうと、あとから本文が届いても二度と読まれない。
      // 静止判定のサイトでは、生成開始が遅れた応答がこれに当たる（実機で発生）
      if (!normalize(extractText(row)).length) continue;

      ready.push(row);
    }

    if (!ready.length) return;

    // 複数がまとめて条件を満たすことがある（読み上げを後から有効にした場合など）。
    // 過去の応答を遡って読み上げても邪魔なだけなので、最新の1件だけ読む。
    for (const row of ready) done.add(row);
    if (cfg.autoRead) readRow(ready[ready.length - 1]);
  }

  /**
   * 診断結果をサーバのログへ送る。
   *
   * Android の Firefox では開発者コンソールが見られない。
   * スマホ側で起きたことを PC 側で読むには、この経路しかない。
   * 失敗しても診断そのものは成立しているので、握りつぶしてよい。
   */
  function sendReport(text) {
    request({
      method: 'POST',
      url: cfg.serverUrl + '/debug',
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ text, site: site.id }),
      timeout: 8000,
    }).then(
      (r) => setStatus(r.status === 200 ? '診断結果をサーバに送った'
                                        : 'サーバへの送信に失敗 (HTTP ' + r.status + ')',
                       r.status !== 200),
      () => setStatus('サーバへ送れなかった（コンソールには出ている）', true)
    );
  }

  /**
   * 読み上げが始まらないときに、どの条件で止まっているかを出す。
   * 検知の問題か、抽出の問題かをここで切り分ける。
   */
  /**
   * 動いているスクリプトの版。**ログに必ず入れること。**
   * 入れ直したつもりで古い版が残っていた、という切り分けに毎回要る。
   */
  function scriptVersion() {
    try {
      return (GM_info && GM_info.script && GM_info.script.version) || '不明';
    } catch (e) {
      return '不明';
    }
  }

  function diagnoseRows() {
    const now = performance.now();
    const list = [...rows()];
    const lines = [];

    lines.push('版=' + scriptVersion() +
               '  site=' + site.label + '  autoRead=' + cfg.autoRead +
               '  AudioContext=' + (audioCtx ? audioCtx.state : '未作成') +
               '  読み上げ中=' + speaking);
    // 逐次読み上げが働いているか、働いていないならどの段階で止まっているか
    lines.push('逐次読み上げ: 設定=' + cfg.streamRead + '  サイト対応=' +
               (site.stream === true) + '  → ' + (streamOn() ? '有効' : '無効') +
               (live ? '  進行中: 先出し ' + live.emitted.length + '文/観測 ' +
                       live.ticks + '回/破綻 ' + live.breaks + '回' +
                       (live.stopped ? '（先出し停止中）' : '')
                     : '  進行中の応答なし'));
    lines.push('row セレクタ: ' + site.sel.row + ' → ' + list.length + ' 個');
    // 短い応答の取りこぼしはここが原因になる
    lines.push('userRow セレクタ: ' + (site.sel.userRow || '未設定') +
               (site.sel.userRow
                 ? ' → ' + document.querySelectorAll(site.sel.userRow).length + ' 個'
                 : '（短い応答を取りこぼす可能性あり）') +
               '  送信待ち=' + (armedAt ? 'あり' : 'なし') +
               (now < loadingUntil
                 ? '  読み込み中（あと' + (loadingUntil - now).toFixed(0) + 'ms）'
                 : ''));
    lines.push('直近の検知経過（本文なし）:');
    lines.push(...(detectionEvents.length ? detectionEvents : ['記録なし']));

    if (site.sel.streaming) {
      const all = [...document.querySelectorAll(site.sel.streaming)];
      const vis = all.filter((e) => e.offsetParent !== null || e.getClientRects().length);
      lines.push('streaming 要素: ' + all.length + ' 個 / 表示中 ' + vis.length + ' 個'
                 + '  → isGenerating()=' + isGenerating());
    }

    if (site.sel.prose) {
      const n = [...list].reduce((acc, r) => acc + r.querySelectorAll(site.sel.prose).length, 0);
      // 行の中を数えている。row が 0 個ならここも必ず 0 になるので、
      // 文書全体の数も併せて出す。セレクタ自体が合っているかを切り分けるため
      const all = document.querySelectorAll(site.sel.prose).length;
      lines.push('prose セレクタ: ' + site.sel.prose + ' → 行の中 ' + n + ' 個'
                 + ' / 文書全体 ' + all + ' 個'
                 + (n ? '（地の文だけを読む）' : '（行の中に無い。本文要素をそのまま読む）'));
    }

    list.forEach((row, i) => {
      const bodies = row.querySelectorAll(site.sel.body);
      const txt = normalize(extractText(row));
      const settled = lastChange.has(row)
        ? (now - lastChange.get(row)).toFixed(0) + 'ms'
        : '未計測';
      lines.push(
        'row[' + i + '] 対象外=' + (seenAtInit.has(row) || preexisting.has(row)) +
        ' 生成観測=' + active.has(row) +
        ' 読了=' + done.has(row) +
        ' complete=' + (!site.sel.complete || !!row.querySelector(site.sel.complete)) +
        ' 静止=' + settled +
        ' body=' + bodies.length + ' 個' +
        ' 抽出=' + txt.length + '字');
    });

    // 最後の行が読まれない理由を名指しする
    const last = list[list.length - 1];
    if (!list.length) {
      lines.push('→ row が 0 個。sel.row が合っていない');
      // ここで終わると次の手が無い。設定に頼らず DOM を調べて候補を出す
      lines.push(surveyDom());
    } else if (audioCtx && audioCtx.state !== 'running') {
      lines.push('→ AudioContext が ' + audioCtx.state +
                 '。ブラウザが再生をブロックしている。ボタンを1回クリックすること');
    } else if (!cfg.autoRead) {
      lines.push('→ 自動読み上げが無効。ボタンを1回クリックすること');
    } else if (isGenerating()) {
      lines.push('→ isGenerating() が true のまま。生成していないならこれが原因');
    } else if (seenAtInit.has(last) || preexisting.has(last)) {
      lines.push('→ 最後の行は初めて見た時点で完成していた（過去の応答とみなした）。' +
                 'ページを再読み込みせずに質問すること');
    } else if (!active.has(last)) {
      lines.push('→ 生成を観測していない。リロードやチャット切り替えで読み込まれた' +
                 '過去の応答ならこれで正しい。新しい応答なら本文の伸びを検知できていない');
    } else if (site.sel.complete && !last.querySelector(site.sel.complete)) {
      // 生成中は完了要素が無いのが正常。セレクタ不一致と区別する（実機で紛らわしかった）
      const t = lastChange.get(last);
      lines.push(t !== undefined && (now - t) < site.settleMs
        ? '→ まだ生成中（本文が伸びている）。完了要素が出れば読まれる'
        : '→ complete 要素が無い。sel.complete が合っていない');
    } else if (!normalize(extractText(last)).length) {
      lines.push('→ 本文が空。生成待ちならこのままでよい。' +
                 '生成が終わっているのに空なら sel.body / sel.prose が合っていない');
    } else if (done.has(last)) {
      lines.push('→ 読了済み。抽出も成功している。再生側の問題の可能性');
    } else {
      lines.push('→ 条件は満たしている。次の checkRows で読まれるはず');
    }

    // 実際に読み上げる文そのものを載せる。
    // 「何が読まれているか」は、これを見ないと分からない（不要な文言の調査に要る）
    if (last) {
      const inline = findInlineElements(last);
      if (inline) lines.push(inline);
      const txt = normalize(extractText(last));
      lines.push('読み上げ対象（先頭400字）:');
      lines.push('  ' + txt.slice(0, 400).replace(/\n/g, '\n  '));
    }

    const report = lines.join('\n      ');
    console.log('[tts] 診断\n      ' + report);
    // 調査は1つでも例外を投げると以降が全部出なくなる。診断は壊れているときに
    // 使うものなので、失敗した調査だけを飛ばして残りは必ず出す（実機で発生）
    const survey = (name, fn) => {
      try { fn(); } catch (e) { console.warn('[tts] ' + name + ' の調査に失敗:', e.message); }
    };
    if (last) survey('地の文の入れ物', () => findProseBlocks(last));
    if (last) survey('不要文言', () => findNoise(last));
    if (last) survey('コードブロック', () => findCodeBlocks(last));
    // 未設定なら候補を出す。短い応答の取りこぼしはこれが無いと直せない
    if (!site.sel.userRow) survey('利用者の発言', findUserRowCandidates);
    // 完了判定の手がかりが無いサイトでは、候補を探すところまで面倒を見る。
    //
    // 設定済みでも当たっていなければ同じこと。むしろ気付きにくい。
    // 静止判定へ黙って落ちるので動きはするが、待ち時間が戻る（実機で Gemini が
    // これだった。1.2 秒の待ちが復活していた）。生成が終わっている行で
    // 完了要素が見つからないなら、候補を出す
    const settledLong = last && lastChange.has(last)
      && (now - lastChange.get(last)) >= site.settleMs;
    if (last && (!site.sel.complete
                 || (settledLong && !last.querySelector(site.sel.complete)))) {
      findCompleteCandidates(last);
    }
    sendReport(report);
  }

  /**
   * sel.row が合っていないときに、応答の入れ物になりそうな要素を探す。
   *
   * 通常の診断は「設定済みのセレクタが何個に当たったか」しか見ない。
   * row が 0 個のときは何も分からないので、設定に頼らず DOM を直接調べる。
   *
   * 目印になる属性を持ち、かつ本文と言える長さのテキストを含む要素を、
   * 形ごとにまとめて数える。連番は N に潰す（conversation-turn-3 と -4 を同じ形とみなす）。
   */
  function surveyDom() {
    const ATTRS = ['data-testid', 'data-test-id', 'data-message-author-role',
                   'data-message-id', 'data-role', 'data-author', 'role'];
    const MIN_LEN = 20;          // これ未満は応答の入れ物ではない
    // 数字を N に潰したあと、16進数字とハイフンだけで長いものは識別子とみなす。
    // "conversation-turn-N" のような意味のある値は英字が残るので当たらない
    const ID_LIKE = /^[0-9a-fN-]{16,}$/i;

    const seen = new Map();
    for (const el of document.body.querySelectorAll('*')) {
      const attrs = [];
      for (const name of ATTRS) {
        const v = el.getAttribute(name);
        if (!v) continue;
        const norm = v.slice(0, 40).replace(/\d+/g, 'N');
        // 一意な識別子は値を出さない。値まで含めると1要素ごとに別の形になり、
        // まとめて数えられなくなる（実機で data-message-id がそうなった）
        attrs.push(ID_LIKE.test(norm) ? '[' + name + ']' : '[' + name + '="' + norm + '"]');
      }
      if (!attrs.length) continue;
      const text = (el.textContent || '').trim();
      if (text.length < MIN_LEN) continue;

      const sig = el.tagName.toLowerCase() + attrs.join('');
      const cur = seen.get(sig) || { count: 0, maxLen: 0, sample: '' };
      cur.count++;
      if (text.length > cur.maxLen) {
        cur.maxLen = text.length;
        cur.sample = text.slice(0, 30);
      }
      seen.set(sig, cur);
    }

    const lines = ['DOM 調査（sel.row / sel.body の候補）:'];
    if (!seen.size) {
      lines.push('  目印になる属性を持つ要素が見つからない。');
      lines.push('  class 名しか手がかりが無いサイトかもしれない。');
      return lines.join('\n      ');
    }

    // 数が多く、長い本文を含むものほど応答の入れ物らしい
    const sorted = [...seen.entries()].sort((a, b) =>
      (b[1].count - a[1].count) || (b[1].maxLen - a[1].maxLen));
    for (const [sig, v] of sorted.slice(0, 25)) {
      lines.push('  ' + sig + '  ×' + v.count +
                 '  最大' + v.maxLen + '字  文字="' + v.sample + '"');
    }
    if (sorted.length > 25) lines.push('  ... 他 ' + (sorted.length - 25) + ' 種類');

    // 地の文のコンテナはクラス名で付くことが多い。代表的なものを数えておく
    const proseCounts = ['.markdown', '.prose', '[class*="markdown"]']
      .map((s) => s + '=' + document.querySelectorAll(s).length);
    lines.push('  文書全体: ' + proseCounts.join('  '));

    lines.push('→ 応答1件ぶんを包む形を sel.row に、その中の本文を sel.body にする');
    return lines.join('\n      ');
  }

  /**
   * sel.userRow に使えそうな要素を探す。
   *
   * 短い応答は本文の伸びを一度も観測できず、対象外のまま終わる。
   * 「自分が送信した」ことが分かれば、その後の応答は新しいと断じられる。
   *
   * 応答の入れ物（sel.body を含む要素）は除いて数える。残ったもののうち、
   * 応答と同じくらいの数だけ繰り返し現れるものが利用者の発言である見込みが高い。
   */
  function findUserRowCandidates() {
    const ATTRS = ['data-testid', 'data-test-id', 'data-message-author-role',
                   'data-perf-row', 'data-role', 'data-author', 'role'];
    // 本文を含む行だけを数える。ChatGPT のように sel.row が利用者のターンにも
    // 一致するサイトでは、そのまま数えると倍になり並び順が狂う（実機で発生）
    const answers = [...rows()].filter((r) => r.querySelector(site.sel.body)).length;

    const seen = new Map();
    for (const el of document.body.querySelectorAll('*')) {
      // 応答を含む要素は利用者の発言ではない
      if (el.querySelector(site.sel.body)) continue;
      // 応答の内側にある要素も違う。本文の一部やツールバーが候補に紛れる。
      // ChatGPT のように sel.row が利用者のターンにも一致するサイトがあるので、
      // 「行に属している」ではなく「応答の行に属している」で除く
      const owner = el.closest(site.sel.row);
      if (owner && owner.querySelector(site.sel.body)) continue;
      const text = (el.textContent || '').trim();
      if (text.length < 2) continue;

      const attrs = [];
      for (const name of ATTRS) {
        const v = el.getAttribute(name);
        if (v) attrs.push('[' + name + '="' + v.slice(0, 40).replace(/\d+/g, 'N') + '"]');
      }
      if (!attrs.length) continue;

      const sig = el.tagName.toLowerCase() + attrs.join('');
      const cur = seen.get(sig) || { count: 0, sample: '' };
      cur.count++;
      if (!cur.sample) cur.sample = text.slice(0, 24);
      seen.set(sig, cur);
    }

    const lines = ['sel.userRow に使えそうな要素（応答は ' + answers + ' 件）:'];
    // 1往復だけだと画面の部品まで同数になり、数では絞り込めない
    if (answers < 2) lines.push('  ※ 応答が少ない。2〜3往復してから実行すると絞り込める');
    if (!seen.size) {
      lines.push('  目印になる属性を持つ要素が見つからなかった');
      console.log('[tts] 利用者の発言の調査' + '\n' + '      ' + lines.join('\n' + '      '));
      return;
    }

    // 応答と同じ数だけ現れるものを上に出す。会話は交互に並ぶため
    const sorted = [...seen.entries()].sort((a, b) =>
      Math.abs(a[1].count - answers) - Math.abs(b[1].count - answers));
    for (const [sig, v] of sorted.slice(0, 15)) {
      lines.push('  ' + sig + '  ×' + v.count +
                 (v.count === answers ? '  ← 応答と同数' : '') +
                 '  文字="' + v.sample + '"');
    }
    lines.push('→ 発言1件ぶんを包む形を SITES.' + site.id + '.sel.userRow に入れる。');
    lines.push('   応答と同数か、応答＋1（まだ返答が来ていない）になるはず');
    console.log('[tts] 利用者の発言の調査' + '\n' + '      ' + lines.join('\n' + '      '));
  }

  /**
   * 地の文（sel.prose）の入れ物を1つずつ並べる。
   *
   * **sel.prose が複数当たるとき、その全部が地の文とは限らない。**
   * Claude の Web検索では、検索の段取りを示す見出しが本文と同じ
   * マークダウンの容れ物で組まれており、区別が付かないまま読み上げられた
   * （実機で発覚。英語のサイト説明文が本文の前に読まれた）。
   *
   * どれが本物の地の文かは中身を見ないと分からないので、
   * 入れ物ごとに祖先と冒頭の文字を並べて、除外の手がかりを出す。
   */
  function proseSurveyLines(row) {
    const blocks = [];
    for (const body of row.querySelectorAll(site.sel.body)) {
      for (const el of body.querySelectorAll(site.sel.prose)) blocks.push({ el, body });
    }

    const sig = (el) => {
      const testid = el.getAttribute('data-testid');
      const cls = (typeof el.className === 'string' ? el.className : '')
        .split(/\s+/).filter(Boolean).slice(0, 4).join('.');
      // 属性は名前だけ出す。値には会話の中身が入りうるので載せない
      const attrs = [...el.attributes].map((a) => a.name)
        .filter((n) => n.startsWith('data-') && n !== 'data-testid').slice(0, 3);
      return el.tagName.toLowerCase() + (cls ? '.' + cls : '')
        + (testid ? ' [data-testid="' + testid + '"]' : '')
        + (attrs.length ? ' [' + attrs.join('][') + ']' : '');
    };

    const lines = ['地の文の入れ物が ' + blocks.length + ' 個ある:'];
    blocks.forEach((b, i) => {
      const txt = (b.el.textContent || '').trim().replace(/\s+/g, ' ');
      lines.push('  [' + i + '] 冒頭="' + txt.slice(0, 50) + '"');
      let el = b.el, depth = 0;
      while (el && depth < 6 && el !== b.body) {
        lines.push('      ' + depth + ') ' + sig(el));
        el = el.parentElement;
        depth++;
      }
    });
    return lines;
  }

  function findProseBlocks(row) {
    if (!site.sel.prose) return;
    const out = [];
    const now = proseSurveyLines(row);
    const split = Number((now[0].match(/\d+/) || [0])[0]) > 1;

    if (split) {
      out.push.apply(out, now);
    } else {
      out.push('いまは ' + now[0].replace('地の文の入れ物が ', '').replace(' 個ある:', '') +
               ' 個。確定後は割れていない');
    }

    // **生成中に割れていたなら、そちらが本命。** 確定後の姿を見ても
    // 何も分からない（実機で、確定後は1個に戻っていた）
    if (proseSplitSnapshot) {
      out.push('生成中に割れていたときの構造:');
      out.push(proseSplitSnapshot);
    }

    // 待った回数は、対処が要る話ではなく効いていることの裏付け。
    // 「祖先を探せ」の促しと混ぜない
    if (proseMissed) {
      out.push('地の文の容れ物が出来る前に読もうとした応答: ' + proseMissed + ' 件');
      out.push('  → 出来るまで待った。対処は要らない');
    }

    if (!split && !proseSplitSnapshot) {
      if (!proseMissed) {
        console.log('[tts] 地の文の入れ物は割れていない。ここは原因ではない');
        return;
      }
    } else {
      out.push('→ 読みたくない入れ物だけを包んでいる祖先を探し、');
      out.push('   SITES.' + site.id + '.sel.drop に足す（本文側に当たらないことを確かめること）');
    }
    console.log("[tts] 地の文の入れ物の調査\n      " + out.join("\n      "));
  }

  /**
   * 読み上げたくない文言が本文のどこに入っているかを突き止める。
   * 思考ブロックの見出しなど、sel.drop に足すべき要素を特定するために使う。
   */
  const NOISE_PATTERNS = /思考しました|Thought for|検索しました|said:|思考プロセス|ソース/;

  function findNoise(row) {
    const hits = [];
    const walk = (node, depth) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = (node.nodeValue || '').trim();
        if (t && NOISE_PATTERNS.test(t)) hits.push({ text: t, el: node.parentElement });
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      for (const c of node.childNodes) walk(c, depth + 1);
    };
    for (const body of row.querySelectorAll(site.sel.body)) walk(body, 0);

    if (!hits.length) {
      console.log('[tts] 読み上げ対象に不要な文言は見つからなかった');
      return;
    }

    const lines = ['本文に混ざっている不要な文言:'];
    for (const h of hits.slice(0, 5)) {
      lines.push('  "' + h.text.slice(0, 40) + '"');
      let el = h.el, depth = 0;
      while (el && depth < 5 && !el.matches(site.sel.body)) {
        const testid = el.getAttribute('data-testid');
        const cls = (typeof el.className === 'string' ? el.className : '')
          .split(/\s+/).filter(Boolean).slice(0, 4).join('.');
        lines.push('    [' + depth + '] ' + el.tagName.toLowerCase() +
                   (cls ? '.' + cls : '') +
                   (testid ? ' [data-testid="' + testid + '"]' : ''));
        el = el.parentElement;
        depth++;
      }
    }
    lines.push('→ この中から安定していそうな属性を SITES.' + site.id + '.sel.drop に足す');
    console.log('[tts] 不要文言の調査\n      ' + lines.join('\n      '));
  }

  /**
   * コードブロックがどの要素で組まれているかを突き止める。
   *
   * PRE 要素なら cfg.codeMode で除去できるが、独自のコードビューアで
   * 組んでいるサイトでは効かない。Copilot は行番号とコード本文が別の要素に
   * 分かれており、行番号まで読み上げていた（実機で発覚）。
   *
   * 除去に使う要素は自分で選ぶしかないので、候補になる祖先を並べて出す。
   */
  function findCodeBlocks(row) {
    // 行番号だけの行と、地の文にはまず出ない書き方を手がかりにする
    const LINE_NO = /^[0-9]{1,4}$/;
    const CODEY = /[;{}]$|^\s*(?:def|class|import|for|while|if|return|const|let|var|function|print)\b|=>|::|\(\)/;

    const hits = [];
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = (node.nodeValue || '').trim();
        if (t && (LINE_NO.test(t) || CODEY.test(t))) {
          hits.push({ text: t, el: node.parentElement, isNum: LINE_NO.test(t) });
        }
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      // 既に扱えている形なら探す必要はない。設定済みの sel.code も同じ。
      // sel.drop で落とす要素も見ない（出典元の「+1」を行番号と誤って拾った）
      if (node.tagName === 'PRE') return;
      if (node.matches && site.sel.code && node.matches(site.sel.code)) return;
      if (node.matches && site.sel.drop && node.matches(site.sel.drop)) return;
      for (const c of node.childNodes) walk(c);
    };
    for (const body of row.querySelectorAll(site.sel.body)) walk(body);

    if (!hits.length) {
      console.log('[tts] コードブロックらしき要素は見つからなかった'
                  + '（PRE で組まれていれば cfg.codeMode で除去済み）');
      return;
    }

    const nums = hits.filter((h) => h.isNum).length;
    const lines = ['PRE ではない形のコードが本文に入っている:'];
    lines.push('  行番号らしき断片 ' + nums + ' 個 / コードらしき断片 '
               + (hits.length - nums) + ' 個');

    // 行番号とコード本文の両方について、祖先をたどって共通の入れ物を探す。
    // どちらか片方だけを消しても、もう片方が読み上げられる
    const samples = [hits.find((h) => h.isNum), hits.find((h) => !h.isNum)].filter(Boolean);
    for (const h of samples) {
      lines.push('  ' + (h.isNum ? '行番号' : 'コード') + ' "' + h.text.slice(0, 30) + '"');
      let el = h.el, depth = 0;
      while (el && depth < 8 && !el.matches(site.sel.body)) {
        const attrs = [];
        for (const name of ['data-testid', 'data-test-id', 'role', 'aria-label']) {
          const v = el.getAttribute(name);
          if (v) attrs.push('[' + name + '="' + v.slice(0, 30) + '"]');
        }
        const cls = (typeof el.className === 'string' ? el.className : '')
          .split(/\s+/).filter(Boolean).slice(0, 3).join('.');
        lines.push('    [' + depth + '] ' + el.tagName.toLowerCase() +
                   (cls ? '.' + cls : '') + (attrs.length ? ' ' + attrs.join('') : '') +
                   '  ' + (el.textContent || '').trim().length + '字');
        el = el.parentElement;
        depth++;
      }
    }
    lines.push('→ 行番号とコード本文の両方を含む祖先を1つ選び、');
    lines.push('   SITES.' + site.id + '.sel.drop に足す（読まなくてよいなら）。');
    lines.push('   class 名がハッシュのようなら data-testid か role を使うこと');
    console.log('[tts] コードブロックの調査' + '\n' + '      ' + lines.join('\n' + '      '));
  }

  /**
   * sel.complete に使えそうな要素を列挙する。
   *
   * 完了を示す属性が無いサイトは settleMs による静止判定に頼るしかなく、
   * その待ち時間がそのまま読み上げ開始の遅延になる。
   * 生成完了後にだけ現れる操作ボタンを1つ見つけられれば、待ち時間はゼロにできる。
   *
   * 生成中に実行しても意味が無い。応答が終わった状態で押すこと。
   */
  function findCompleteCandidates(row) {
    const SEL = 'button,[role="button"]';
    let scope = row;
    let els = [...row.querySelectorAll(SEL)];

    // 操作ボタンが応答コンテナの外（兄弟のフッタ等）に置かれる作りもある。
    // その場合そのままでは sel.complete に使えないので、見つけたうえでその旨を出す
    let outside = false;
    for (let up = row.parentElement, i = 0; !els.length && up && i < 3; up = up.parentElement, i++) {
      els = [...up.querySelectorAll(SEL)];
      if (els.length) { scope = up; outside = true; }
    }

    if (!els.length) {
      console.log('[tts] 完了判定の候補: 応答の周辺にボタンが見つからない。'
                  + '応答が終わった状態で実行しているか確認すること');
      return;
    }

    const lines = ['sel.complete に使えそうな要素（応答が終わった状態で実行すること）:'];
    if (outside) {
      lines.push('  ※ 応答コンテナ(' + site.sel.row + ')の中には無く、'
                 + scope.tagName.toLowerCase() + ' まで遡って見つけた。');
      lines.push('    この場合 sel.complete はそのままでは使えない（行の中を探すため）。');
    }
    for (const el of els.slice(0, 15)) {
      // UI 改修に強い順に拾う。data-* > aria-label > class
      const attrs = [];
      for (const name of ['data-test-id', 'data-testid', 'aria-label', 'jsname']) {
        const v = el.getAttribute(name);
        if (v) attrs.push('[' + name + '="' + v + '"]');
      }
      const cls = (typeof el.className === 'string' ? el.className : '')
        .split(/\s+/).filter(Boolean).slice(0, 3);
      lines.push('  ' + el.tagName.toLowerCase() +
                 (attrs.length ? ' ' + attrs.join(' ') : '') +
                 (cls.length ? '  class=' + cls.join('.') : '') +
                 '  文字="' + (el.textContent || '').trim().slice(0, 12) + '"');
    }
    if (els.length > 15) lines.push('  ... 他 ' + (els.length - 15) + ' 個');
    lines.push('→ コピー系の1つを SITES.' + site.id + '.sel.complete に入れると、');
    lines.push('   settleMs の待ち時間（' + site.settleMs + 'ms）が不要になる');
    console.log('[tts] 完了判定の候補' + '\n' + '      ' + lines.join('\n' + '      '));
  }

  /**
   * 本文（sel.prose の内側）にあるインライン要素を種類ごとに列挙する。
   *
   * 引用マーカーや出典元の表記は、段落の途中や末尾にインライン要素として
   * 埋め込まれる。本文の外に出ていないので sel.prose では外せず、
   * 文字列で消そうにもサイト名は任意の文字列なので消せない。
   * sel.drop に書くべきセレクタを見つけるには、実物の属性を見るしかない。
   *
   * 同じ形のものはまとめて数だけ出す。段落ごとに何十個も並ぶため。
   */
  const INLINE_TAGS = new Set(['A', 'SPAN', 'SUP', 'SUB', 'SMALL', 'BUTTON', 'CITE']);

  function findInlineElements(row) {
    const scope = site.sel.prose
      ? [...row.querySelectorAll(site.sel.body)]
          .flatMap((b) => [...b.querySelectorAll(site.sel.prose)])
      : [...row.querySelectorAll(site.sel.body)];
    if (!scope.length) return '';

    const seen = new Map();   // 署名 -> { count, sample }
    const walk = (node) => {
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (INLINE_TAGS.has(node.tagName)) {
        // 属性は UI 改修に強い順に拾う。data-* は名前だけで十分な手がかりになる
        const attrs = [];
        for (const a of node.attributes || []) {
          if (a.name.startsWith('data-') || a.name === 'href' || a.name === 'aria-label') {
            attrs.push(a.name + (a.name === 'href' ? '' : '="' + a.value.slice(0, 24) + '"'));
          }
        }
        const cls = (typeof node.className === 'string' ? node.className : '')
          .split(/\s+/).filter(Boolean).slice(0, 3).join('.');
        const sig = node.tagName.toLowerCase() + (cls ? '.' + cls : '') +
                    (attrs.length ? ' [' + attrs.join('][') + ']' : '');
        const cur = seen.get(sig) || { count: 0, sample: '' };
        cur.count++;
        if (!cur.sample) cur.sample = (node.textContent || '').trim().slice(0, 24);
        seen.set(sig, cur);
      }
      for (const c of node.childNodes) walk(c);
    };
    for (const el of scope) walk(el);

    if (!seen.size) return '本文の中にインライン要素は無かった';
    const lines = ['本文の中のインライン要素（sel.drop の候補）:'];
    for (const [sig, v] of [...seen.entries()].slice(0, 20)) {
      lines.push('  ' + sig + '  ×' + v.count + '  文字="' + v.sample + '"');
    }
    if (seen.size > 20) lines.push('  ... 他 ' + (seen.size - 20) + ' 種類');
    return lines.join('\n      ');
  }

  /** 検知を飛ばして最後の応答を読む。抽出と再生だけを試すため。 */
  function readLastRow() {
    const list = [...rows()];
    if (!list.length) { showError('応答が見つからない（sel.row が違う）'); return; }
    const last = list[list.length - 1];
    done.add(last);
    const txt = normalize(extractText(last));
    console.log('[tts] 強制読み上げ 抽出=' + txt.length + '字\n' + txt.slice(0, 300));
    if (!txt.length) { showError('本文が取れない（sel.body が違う）'); return; }
    speak(splitSentences(txt), { t0: performance.now() });
  }

  const observer = new MutationObserver((muts) => {
    const now = performance.now();
    if (site.streamingAttr) {
      for (const m of muts) {
        if (m.type !== 'attributes' || m.attributeName !== site.streamingAttr) continue;
        const v = m.target.getAttribute(site.streamingAttr);
        if (v === 'true') {
          active.add(m.target);
        } else if (v === 'false' && active.has(m.target) && !completedAt.has(m.target)) {
          completedAt.set(m.target, now);
        }
      }
    }
    clearTimeout(observer._t);
    observer._t = setTimeout(checkRows, 120);
  });

  function startObserving() {
    markExisting();
    recordDetection('監視開始: 応答行=' + rows().length +
                    ' 発言行=' + (site.sel.userRow
                      ? document.querySelectorAll(site.sel.userRow).length : '未設定'));
    const opts = { childList: true, subtree: true, characterData: true };
    if (site.streamingAttr) {
      opts.attributes = true;
      opts.attributeFilter = [site.streamingAttr];
    }
    observer.observe(document.body, opts);

    // 静止判定のサイトは、変化が止まったあとにも checkRows を回す必要がある
    if (!site.streamingAttr) setInterval(checkRows, 300);
  }

  // ============================================================ UI

  const ui = {};

  function css(el, s) { el.style.cssText = s; }

  /**
   * ボタンの位置。画面の右端・下端からの px で持つ。
   *
   * スマホでは画面下部が入力欄と送信ボタンで埋まっており、右下に置くと重なって
   * どちらも押しにくい（実機で確認）。狭い画面では既定位置を入力欄の上まで上げる。
   * それでも重なるサイトのために、ドラッグで動かせるようにしてある。
   */
  function btnPos() {
    const narrow = window.innerWidth < 600;
    return {
      right: cfg.btnRight >= 0 ? cfg.btnRight : 16,
      bottom: cfg.btnBottom >= 0 ? cfg.btnBottom : (narrow ? 108 : 16),
    };
  }

  /** 画面外に出さない。端末の回転や画面サイズの変化でも見失わないようにする。 */
  function applyBtnPos(right, bottom) {
    const r = Math.max(4, Math.min(right, window.innerWidth - 60));
    const b = Math.max(4, Math.min(bottom, window.innerHeight - 60));
    ui.root.style.right = r + 'px';
    ui.root.style.bottom = b + 'px';
    return { right: r, bottom: b };
  }

  function buildUI() {
    ui.root = document.createElement('div');
    css(ui.root, 'position:fixed;z-index:2147483000;' +
                 'display:flex;flex-direction:column;align-items:flex-end;gap:8px;' +
                 'font:13px/1.5 system-ui,sans-serif');
    const p0 = btnPos();
    applyBtnPos(p0.right, p0.bottom);

    ui.status = document.createElement('div');
    css(ui.status, 'display:none;max-width:260px;padding:6px 10px;border-radius:8px;' +
                   'background:#222;color:#eee;box-shadow:0 2px 8px rgba(0,0,0,.3)');

    ui.btn = document.createElement('button');
    css(ui.btn, 'width:52px;height:52px;border-radius:50%;border:none;cursor:pointer;' +
                'font-size:22px;color:#fff;background:#666;box-shadow:0 2px 10px rgba(0,0,0,.35)');
    ui.btn.style.touchAction = 'none';   // ドラッグ中に画面がスクロールしないように
    ui.btn.title = 'クリック: 読み上げ切替 / 長押し・右クリック: 設定 / ドラッグ: 移動';

    // 長押しで設定（PCでは右クリックでも開く）
    // ドラッグで移動もできる。判定は移動距離で分ける
    let pressTimer = null, longPressed = false, drag = null, dragged = false;
    const DRAG_THRESHOLD = 8;   // これ未満はタップとみなす（指は多少ぶれる）

    const startPress = (e) => {
      longPressed = false;
      dragged = false;
      const p = btnPos();
      drag = { x: e.clientX, y: e.clientY, right: p.right, bottom: p.bottom };
      try { ui.btn.setPointerCapture(e.pointerId); } catch (err) { /* 非対応でも動く */ }
      pressTimer = setTimeout(() => { longPressed = true; toggleSettings(true); }, 550);
    };

    const movePress = (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!dragged && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      dragged = true;
      clearTimeout(pressTimer);          // 移動中に設定パネルを開かない
      // 右端・下端からの距離なので、指の移動とは符号が逆になる
      applyBtnPos(drag.right - dx, drag.bottom - dy);
    };

    const endPress = () => {
      clearTimeout(pressTimer);
      if (drag && dragged) {
        // 画面外に出ないよう補正した後の値を保存する
        cfg.btnRight = parseInt(ui.root.style.right, 10);
        cfg.btnBottom = parseInt(ui.root.style.bottom, 10);
        saveCfg();
        setStatus('ボタンの位置を保存した');
      }
      drag = null;
    };

    ui.btn.addEventListener('pointerdown', startPress);
    ui.btn.addEventListener('pointermove', movePress);
    ui.btn.addEventListener('pointerup', endPress);
    ui.btn.addEventListener('pointercancel', endPress);
    ui.btn.addEventListener('contextmenu', (e) => { e.preventDefault(); toggleSettings(true); });

    // 画面の回転やサイズ変更で枠外に出たら引き戻す
    window.addEventListener('resize', () => {
      const p = btnPos();
      applyBtnPos(p.right, p.bottom);
    });

    ui.btn.addEventListener('click', () => {
      if (longPressed || dragged) return;   // 移動しただけなら切り替えない
      ensureAudio();               // 初回操作で AudioContext を解放する
      if (speaking) { stopSpeaking(); setStatus('停止した'); return; }
      cfg.autoRead = !cfg.autoRead;
      // 読み始める前の溜め込みも捨てる。次に有効にしたとき、
      // 途中まで溜まった古い応答から読み始めないように
      if (!cfg.autoRead) closeLive();
      saveCfg();
      updateButton();
      setStatus(cfg.autoRead ? '読み上げ 有効' : '読み上げ 無効');
    });

    ui.root.appendChild(ui.status);
    ui.root.appendChild(ui.btn);
    document.body.appendChild(ui.root);
    buildSettings();
    updateButton();
  }

  function updateButton() {
    if (!ui.btn) return;
    if (speaking) { ui.btn.textContent = '■'; ui.btn.style.background = '#c0392b'; }
    else if (cfg.autoRead) { ui.btn.textContent = '🔊'; ui.btn.style.background = '#2563eb'; }
    else { ui.btn.textContent = '🔈'; ui.btn.style.background = '#666'; }
  }

  let statusTimer = null;
  function setStatus(msg, isError) {
    if (!ui.status) return;
    ui.status.textContent = msg;
    ui.status.style.display = 'block';
    ui.status.style.background = isError ? '#c0392b' : '#222';
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { ui.status.style.display = 'none'; }, isError ? 8000 : 3000);
  }

  function showError(msg) {
    console.warn('[tts]', msg);
    setStatus(msg, true);
  }

  // ------------------------------------------------------------ 設定

  function field(label, el) {
    const wrap = document.createElement('label');
    css(wrap, 'display:flex;flex-direction:column;gap:3px;font-size:12px;color:#bbb');
    wrap.appendChild(document.createTextNode(label));
    wrap.appendChild(el);
    return wrap;
  }

  function input(value, type) {
    const el = document.createElement('input');
    el.type = type || 'text';
    el.value = value;
    // フォントを 16px 未満にするとモバイルで入力時に画面が拡大される
    css(el, 'padding:8px 7px;border:1px solid #555;border-radius:5px;' +
            'background:#111;color:#eee;font-size:16px');
    return el;
  }

  function select(options, value) {
    const el = document.createElement('select');
    css(el, 'padding:8px 7px;border:1px solid #555;border-radius:5px;' +
            'background:#111;color:#eee;font-size:16px');
    for (const [v, label] of options) {
      const o = document.createElement('option');
      o.value = v; o.textContent = label;
      if (v === value) o.selected = true;
      el.appendChild(o);
    }
    return el;
  }

  function buildSettings() {
    const p = document.createElement('div');
    // スマホの画面でも収まるようにする。項目が増えても縦スクロールで見られる
    css(p, 'display:none;width:min(290px, calc(100vw - 32px));max-height:70vh;overflow-y:auto;' +
           'padding:14px;border-radius:10px;background:#1e1e1e;' +
           'color:#eee;box-shadow:0 4px 20px rgba(0,0,0,.5);flex-direction:column;gap:10px');

    const title = document.createElement('div');
    title.textContent = '読み上げ設定';
    css(title, 'font-weight:600');

    const url = input(cfg.serverUrl);
    const token = input(cfg.apiToken, 'password');
    const voice = select([['', 'サーバの設定に従う（管理UIで指定）']], cfg.voice);
    const gap = select([['0', '入れない'], ['150', '短い（150ms）'],
                        ['300', '標準（300ms）'], ['500', '長い（500ms）']],
                       String(cfg.gapMs));
    const prefetch = input(String(cfg.prefetch), 'number');
    prefetch.min = '0'; prefetch.max = '5';
    const code = select([['skip', '読まない'], ['label', '「コードブロック」と読む'],
                         ['full', '全文読む']], cfg.codeMode);
    const table = select([['skip', '読まない'], ['label', '「表」と読む'],
                          ['full', '全文読む']], cfg.tableMode);
    const fmt = select([['', 'サーバに従う'], ['wav48', 'wav 48kHz'], ['wav24', 'wav 24kHz']],
                       cfg.format);
    const spec = select([['1', '有効（初音が速くなる）'], ['0', '無効']],
                        cfg.speculate ? '1' : '0');
    // サイトが対応していない場合は選んでも働かない。それが分かる文言にしておく
    const strm = select([['1', '有効（生成の途中から読む）'],
                         ['0', '無効（応答が終わってから読む）']],
                        cfg.streamRead ? '1' : '0');

    const voiceRow = field('音声の上書き（通常は不要）', voice);
    const reload = document.createElement('button');
    reload.textContent = '一覧を取得';
    css(reload, 'padding:4px 8px;border:1px solid #555;border-radius:5px;background:#333;color:#eee;cursor:pointer;font:inherit');
    reload.onclick = async () => {
      try {
        const d = await fetchVoices();
        voice.innerHTML = '';
        const opts = [['', 'サーバの設定に従う（管理UIで指定）']]
          .concat(d.voices.map((v) => [v.name, v.display_name]));
        for (const [v, label] of opts) {
          const o = document.createElement('option');
          o.value = v; o.textContent = label;
          if (v === cfg.voice) o.selected = true;
          voice.appendChild(o);
        }
        setStatus('音声一覧を取得した');
      } catch (e) {
        showError('一覧の取得に失敗: ' + e.message);
      }
    };
    voiceRow.appendChild(reload);

    const test = document.createElement('button');
    test.textContent = 'テスト読み上げ';
    css(test, 'padding:6px;border:1px solid #555;border-radius:5px;background:#333;color:#eee;cursor:pointer;font:inherit');
    test.onclick = () => { apply(); speak(['読み上げのテストです。', '正常に動作しています。']); };

    // 読み上げが始まらないときの切り分け用
    const diag = document.createElement('button');
    diag.textContent = '診断（コンソールに出力）';
    css(diag, 'padding:6px;border:1px solid #555;border-radius:5px;background:#333;color:#eee;cursor:pointer;font:inherit');
    diag.onclick = diagnoseRows;

    const force = document.createElement('button');
    force.textContent = '最後の応答を強制的に読む';
    css(force, 'padding:6px;border:1px solid #555;border-radius:5px;background:#333;color:#eee;cursor:pointer;font:inherit');
    force.onclick = () => { apply(); readLastRow(); };

    // 聞き逃したときに鳴らし直す。レアな操作なので専用ボタンは常設しない
    const again = document.createElement('button');
    again.textContent = 'もう一度読む';
    css(again, 'padding:6px;border:1px solid #555;border-radius:5px;background:#333;color:#eee;cursor:pointer;font:inherit');
    again.onclick = () => { apply(); toggleSettings(false); replay(); };

    // 画面外や押しにくい場所に動かしてしまったときの戻し道
    const resetPos = document.createElement('button');
    resetPos.textContent = 'ボタンの位置を初期化';
    css(resetPos, 'padding:6px;border:1px solid #555;border-radius:5px;background:#333;color:#eee;cursor:pointer;font:inherit');
    resetPos.onclick = () => {
      cfg.btnRight = -1; cfg.btnBottom = -1;
      saveCfg();
      const p = btnPos();
      applyBtnPos(p.right, p.bottom);
      setStatus('ボタンの位置を初期化した');
    };

    const save = document.createElement('button');
    save.textContent = '保存して閉じる';
    css(save, 'padding:7px;border:none;border-radius:5px;background:#2563eb;color:#fff;cursor:pointer;font:inherit');

    function apply() {
      cfg.serverUrl = url.value.trim().replace(/\/+$/, '');
      cfg.apiToken = token.value;
      cfg.voice = voice.value;
      cfg.gapMs = Math.max(0, Math.min(2000, Number(gap.value) || 0));
      cfg.prefetch = Math.max(0, Math.min(5, Number(prefetch.value) || 0));
      cfg.codeMode = code.value;
      cfg.tableMode = table.value;
      cfg.format = fmt.value;
      cfg.speculate = spec.value === '1';
      cfg.streamRead = strm.value === '1';
      saveCfg();
    }
    save.onclick = () => { apply(); toggleSettings(false); setStatus('設定を保存した'); };

    p.append(title,
      field('サーバURL', url), field('APIトークン', token), voiceRow,
      field('文と文のあいだの間', gap), field('先読み数', prefetch), field('コードブロック', code), field('表', table), field('音声形式', fmt),
      field('先行合成', spec),
      field('逐次読み上げ' + (site.stream === true ? '' : '（このサイトは非対応）'), strm),
      again, test, diag, force, resetPos, save);

    ui.panel = p;
    ui.root.insertBefore(p, ui.status);
  }

  function toggleSettings(show) {
    if (!ui.panel) return;
    ui.panel.style.display = show ? 'flex' : 'none';
  }

  // ============================================================ 起動

  function init() {
    // 同じページで2回動くと、監視も再生も二重になる。実機の Gemini で
    // 「[tts] 起動」が2回出るのを確認した。フレームの中では動かさない
    if (window.top !== window.self) return;
    if (window.__ttsReadaloudStarted) {
      console.warn('[tts] 既に動いている。ユーザースクリプトが二重に入っていないか確認すること');
      return;
    }
    window.__ttsReadaloudStarted = true;

    if (!site) {
      console.log('[tts] 対応していないサイト:', location.hostname);
      return;
    }

    buildUI();

    if (!siteReady) {
      // セレクタ未設定のサイト。UI は出すが自動読み上げは動かない。
      // 設定パネルの「テスト読み上げ」でサーバとの疎通だけは確認できる
      console.warn('[tts] ' + site.label + ' のセレクタが未設定。' +
                   'サイトの DOM 構造を確認して SITES に記入すること');
      setStatus(site.label + ' のセレクタ未設定', true);
      return;
    }

    document.addEventListener('submit', noteSendGesture, true);
    document.addEventListener('keydown', noteSendGesture, true);
    document.addEventListener('click', noteSendGesture, true);
    resumeOnGesture();
    lastPath = location.origin + location.pathname;
    beginLoading('起動');
    startObserving();
    console.log('[tts] 起動 版=' + scriptVersion() +
                ' site=' + site.label + ' server=' + cfg.serverUrl +
                ' autoRead=' + cfg.autoRead +
                ' voice=' + (cfg.voice || 'サーバの設定に従う'));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
