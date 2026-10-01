// 口 — 出力フィルタ 仕様 §3.3
//
// モデルが出した文章から、情報量がゼロの部分だけを落とす。
//   1. 考え中の独り言（<think>…</think>）。閉じ忘れているものも落とす
//   2. 定型のあいさつ（「承知しました」「以下のコードをご覧ください」など）
//   3. 空行の連続、行末の余分な空白
//
// なぜ3層のうちここから作るのか（§3.3）：
//   落とす対象がどれも「消しても情報が減らない」ものだから。しかも出力は人が読むので、
//   消しすぎていたらその場で気づける。3層で一番安全な場所。
//
// 絶対にやらないこと：
//   - コードブロックの中身に触る
//   - 意味を読んで要る／要らないを判断する（それは §3.2 で実装しないと決めた領域）
//
// 壊れたときの振る舞い（§1.5 / §7.7）：
//   例外が出たら、その時点から素通しに切り替える。フィルタは減らす機構なので、
//   止まったときに「何もしない」が一番安全な壊れ方になる。

const DEFAULT_THINK_TAGS = ['think', 'thinking', 'reasoning', 'scratchpad', 'analysis'];

// 行まるごとがこれに一致したときだけ落とす。文中には触らない。
const BOILERPLATE_PATTERNS = [
  // 日本語の前置き
  /^(承知(いた)?しました|了解(いた)?しました|かしこまりました|わかりました|はい、?承知(いた)?しました)[。！!.\s]*$/,
  /^(以下のコードをご覧ください|以下に(コードを)?示します|以下の通りです|以下のようになります|こちらが(修正後の)?コードです)[。：:！!.\s]*$/,
  // 日本語の後置き
  /^(何か(ご)?(不明|質問|要望)(な点)?が(あれ|ござい)ば[^\n]{0,30})[。！!.\s]*$/,
  /^(お気軽に[^\n]{0,20}(ください|下さい))[。！!.\s]*$/,
  /^(他に(何か|ご要望が)[^\n]{0,25})[。？?！!.\s]*$/,
  /^(以上です|参考になれば幸いです|お役に立てれば幸いです)[。！!.\s]*$/,
  // 英語
  /^(sure|certainly|of course|absolutely|got it|understood)[!,.\s]*$/i,
  /^(here('s| is) the (code|updated code|implementation)|here you go)[:.\s]*$/i,
  /^(let me know if you (need|have) [^\n]{0,40}|i hope this helps)[!.\s]*$/i,
];

function isBlank(line) {
  return line.trim() === '';
}

function looksLikeBoilerplate(line) {
  const t = line.trim();
  if (t === '' || t.length > 60) return false; // 長い行は本文とみなす
  return BOILERPLATE_PATTERNS.some((re) => re.test(t));
}

// 行頭のコードフェンス（``` または ~~~）を見つける
function fenceMarkerOf(line) {
  const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
  return m ? m[1][0].repeat(m[1].length) : null;
}

export class Mouth {
  /**
   * @param {object} [opts]
   * @param {string[]} [opts.thinkTags]      独り言タグの名前
   * @param {boolean}  [opts.dropBoilerplate] 定型のあいさつを落とすか（既定 true）
   * @param {boolean}  [opts.normalize]      空行と行末空白を整えるか（既定 true）
   * @param {number}   [opts.maxHold]        改行が来ないまま抱え込む上限の文字数
   * @param {function} [opts.onError]        壊れたときの通知
   */
  constructor(opts = {}) {
    this.tags = opts.thinkTags || DEFAULT_THINK_TAGS;
    this.dropBoilerplate = opts.dropBoilerplate !== false;
    this.normalize = opts.normalize !== false;
    this.maxHold = opts.maxHold || 8192;
    this.onError = opts.onError || null;

    this.openRe = new RegExp(`<\\s*(${this.tags.join('|')})(\\s[^>]*)?>`, 'i');
    this.closeReOf = new Map(
      this.tags.map((t) => [t.toLowerCase(), new RegExp(`<\\s*/\\s*${t}\\s*>`, 'i')]),
    );

    this.buf = '';            // 改行がまだ来ていない途中の行
    this.inThink = false;
    this.thinkTag = null;
    this.inFence = false;
    this.fenceMarker = null;

    // 出力を1行ぶん遅らせて持つ。理由は2つ。
    //   ・最後の行かどうかが確定してから、末尾の定型あいさつを判定するため
    //   ・空行が続いたときに、後ろの本文が来るまで出すかどうかを決められるため
    this.held = null;         // { text, inFence, hadNewline }
    this.pendingBlanks = 0;   // held のうしろに溜まっている空行の数
    this.pendingGap = 0;      // 次に出す行の「前」に付ける空行（0か1）
    this.emittedContent = false;
    this.failed = false;

    this.stats = {
      inChars: 0, outChars: 0,
      thinkChars: 0, boilerplateChars: 0, blankChars: 0,
      unterminatedThink: false, errors: 0,
    };
  }

  /** 届いた断片を渡すと、出してよい部分が返る。 */
  push(chunk) {
    if (chunk == null) return '';
    const text = String(chunk);
    this.stats.inChars += text.length;
    if (this.failed) { this.stats.outChars += text.length; return text; }
    try {
      this.buf += text;
      let out = '';
      let nl;
      while ((nl = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        out += this._feedLine(line, true);
      }
      // 改行が来ないまま長くなりすぎたら、途中まで出す。
      // タグを真ん中で切らないよう、末尾は少し残しておく。
      if (!this.inThink && this.buf.length > this.maxHold) {
        const keep = 64;
        const safe = this.buf.slice(0, this.buf.length - keep);
        this.buf = this.buf.slice(this.buf.length - keep);
        out += this._flushHeld(false);
        out += '\n'.repeat(this.pendingGap);
        this.pendingGap = 0;
        out += safe;
        if (!isBlank(safe)) this.emittedContent = true;
      }
      this.stats.outChars += out.length;
      return out;
    } catch (err) {
      return this._degrade(err, text);
    }
  }

  /** 出力の終わり。抱えている分を全部出す。 */
  end() {
    if (this.failed) { const rest = this.buf; this.buf = ''; this.stats.outChars += rest.length; return rest; }
    try {
      let out = '';
      if (this.buf !== '') {
        const line = this.buf;
        this.buf = '';
        out += this._feedLine(line, false);
      }
      out += this._flushHeld(true);
      if (this.inThink) this.stats.unterminatedThink = true;
      this.stats.outChars += out.length;
      return out;
    } catch (err) {
      return this._degrade(err, '');
    }
  }

  _degrade(err, passthrough) {
    this.failed = true;
    this.stats.errors++;
    if (this.onError) { try { this.onError(err); } catch { /* 通知の失敗で止まらない */ } }
    const heldText = this.held ? this.held.text + (this.held.hadNewline ? '\n' : '') : '';
    const rest = '\n'.repeat(this.pendingGap) + heldText + '\n'.repeat(this.pendingBlanks)
      + this.buf + (passthrough || '');
    this.held = null;
    this.pendingBlanks = 0;
    this.pendingGap = 0;
    this.buf = '';
    this.stats.outChars += rest.length;
    return rest;
  }

  // 1行ぶんを処理する。hadNewline は、その行が改行で終わっていたかどうか。
  _feedLine(rawLine, hadNewline) {
    let line = rawLine;

    // 1. 独り言の途中なら、閉じタグを探す。無ければ行ごと捨てる。
    if (this.inThink) {
      const closeRe = this.closeReOf.get(this.thinkTag);
      const m = closeRe ? closeRe.exec(line) : null;
      if (!m) {
        this.stats.thinkChars += line.length + 1;
        return '';
      }
      this.stats.thinkChars += m.index + m[0].length;
      line = line.slice(m.index + m[0].length);
      this.inThink = false;
      this.thinkTag = null;
      // 閉じタグのあとに何も残らなければ、この行自体が独り言の残骸なので出さない。
      if (line.trim() === '') return '';
    }

    // 2. コードブロックの中は、中身を一切いじらない。
    if (this.inFence) {
      const marker = fenceMarkerOf(line);
      if (marker && marker[0] === this.fenceMarker[0] && marker.length >= this.fenceMarker.length) {
        this.inFence = false;
        this.fenceMarker = null;
      }
      return this._offer(line, true, hadNewline);
    }

    const openFence = fenceMarkerOf(line);
    if (openFence) {
      this.inFence = true;
      this.fenceMarker = openFence;
      return this._offer(line, true, hadNewline);
    }

    // 3. 行の中の独り言タグを外す。
    const before = line;
    line = this._stripThinkInline(line);
    // タグを外した結果、空になった行は捨てる（元から空だった行は空行として扱う）
    if (before !== line && line.trim() === '') return '';

    // 4. 行末の余分な空白（コードの外だけ）。
    if (this.normalize) line = line.replace(/[ \t]+$/, '');

    return this._offer(line, false, hadNewline);
  }

  _stripThinkInline(line) {
    let out = '';
    let rest = line;
    for (;;) {
      const m = this.openRe.exec(rest);
      if (!m) { out += rest; break; }
      out += rest.slice(0, m.index);
      const tag = m[1].toLowerCase();
      const after = rest.slice(m.index + m[0].length);
      const closeRe = this.closeReOf.get(tag);
      const c = closeRe ? closeRe.exec(after) : null;
      if (c) {
        this.stats.thinkChars += m[0].length + c.index + c[0].length;
        rest = after.slice(c.index + c[0].length);
      } else {
        // 閉じていない。この行の残りは全部独り言。次の行以降も追いかける。
        this.stats.thinkChars += m[0].length + after.length;
        this.inThink = true;
        this.thinkTag = tag;
        break;
      }
    }
    return out;
  }

  // 出力候補の行を受け取る。空行はいったん数えるだけにして、
  // 後ろに本文が来たときに1行だけ復活させる。
  _offer(text, inFence, hadNewline) {
    // コードブロックの中の空行は中身なので、まとめない。
    const collapsible = this.normalize && !inFence && isBlank(text);
    if (collapsible) {
      if (this.held !== null) this.pendingBlanks++;
      else this.stats.blankChars += text.length + 1; // 文章の先頭に付いた空行
      return '';
    }
    const out = this._flushHeld(false);
    this.held = { text, inFence, hadNewline };
    return out;
  }

  // 抱えていた行を出す。isFinal のときだけ「末尾の定型あいさつ」を判定する。
  //
  // 空行は「前の行のうしろ」ではなく「次の行の手前」に付ける。
  // こうしておくと、次の行が落ちる行（末尾のあいさつなど）だったときに、
  // すでに出してしまった空行が取り消せない、という事故が起きない。
  _flushHeld(isFinal) {
    if (this.held === null) {
      if (isFinal) {
        this.stats.blankChars += this.pendingBlanks + this.pendingGap;
        this.pendingBlanks = 0;
        this.pendingGap = 0;
      }
      return '';
    }
    const h = this.held;
    this.held = null;
    const blanks = this.pendingBlanks;
    this.pendingBlanks = 0;
    const gapBefore = this.pendingGap;
    this.pendingGap = 0;

    let drop = false;
    if (this.dropBoilerplate && !h.inFence && looksLikeBoilerplate(h.text)) {
      // 先頭のあいさつ：後ろに本文が続くときだけ落とす
      if (!isFinal && !this.emittedContent) drop = true;
      // 末尾のあいさつ：前に本文があるときだけ落とす
      if (isFinal && this.emittedContent) drop = true;
    }
    if (drop) {
      this.stats.boilerplateChars += h.text.length + 1;
      // 落とした行の前後の空行はくっつけて1つにする。
      // ただし本文をまだ1行も出していないなら、それは文章の先頭の空行なので残さない。
      const merged = (isFinal || !this.emittedContent) ? 0 : Math.min(gapBefore + (blanks > 0 ? 1 : 0), 1);
      this.stats.blankChars += gapBefore + blanks - merged;
      this.pendingGap = merged;
      return '';
    }

    // 文章の先頭に付いた空行は出さない
    const gap = this.emittedContent ? gapBefore : 0;
    this.stats.blankChars += gapBefore - gap;
    const out = '\n'.repeat(gap) + h.text + (h.hadNewline ? '\n' : '');
    if (isFinal) {
      this.stats.blankChars += blanks; // 文末の空行は残さない
    } else {
      const keep = Math.min(blanks, 1);
      this.stats.blankChars += blanks - keep;
      this.pendingGap = keep;
    }
    if (!isBlank(h.text)) this.emittedContent = true;
    return out;
  }
}

/**
 * 一度に全文を渡す使い方。壊れたら原文をそのまま返す（安全側への縮退）。
 * @returns {{text: string, stats: object}}
 */
export function filterOutput(text, opts = {}) {
  const input = text == null ? '' : String(text);
  try {
    const m = new Mouth(opts);
    let out = m.push(input);
    out += m.end();
    // 中身があったのに空になった場合。
    // 独り言を消した結果として空になったのなら、それが正しい動作（全部が独り言だった）。
    // そうではなく、あいさつ判定や空行整理だけで空になったのなら、それは判定の誤り。
    // 後者のときだけ原文へ戻す。
    if (input.trim() !== '' && out.trim() === '' && m.stats.thinkChars === 0) {
      return { text: input, stats: { ...m.stats, revertedEmpty: true } };
    }
    return { text: out, stats: m.stats };
  } catch (err) {
    if (opts.onError) { try { opts.onError(err); } catch { /* noop */ } }
    return { text: input, stats: { errors: 1, passthrough: true } };
  }
}

export function createMouth(opts = {}) {
  return new Mouth(opts);
}

export { DEFAULT_THINK_TAGS, looksLikeBoilerplate };
