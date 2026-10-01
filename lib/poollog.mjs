// プール圧をログから読む — 仕様 §6.2 ／ 訂正2
//
// なぜログを読むのか：
//   /slots の n_ctx / n_prompt_tokens は「いま処理中の会話が文脈をどれだけ使っているか」。
//   この機械で実際に詰まっているのは別の資源で、そちらはログにしか出ない。
//
//     srv update:  - cache state: 20 prompts, 5714.027 MiB (limits: 8192.000 MiB, 65536 tokens, 208383 est)
//
//   保存されたプロンプトの合計が 8192 MiB の枠を超えると、古い会話が押し出されて
//   forcing full prompt re-processing（前処理のやり直し）になる。これが体感の遅さの正体。
//
//   /slots だけを見る実装は、プールが溢れている最中でも「圧力なし」と答える。
//   §7.5 が名指しで警告している「安全機構が動作しないまま動作しているように見える」状態。
//
// 弱点を明記しておく：
//   この行が出るのは ollama が llama-server を --log-verbosity 4 で起動しているため。
//   ollama を更新すると消えうる。消えたら「値0」ではなく「取得失敗」になるよう作る。

import fs from 'node:fs';

export const DEFAULT_LOG_PATH = '/opt/homebrew/var/log/ollama.log';

const CACHE_STATE_RE =
  /cache state:\s*(\d+)\s*prompts?,\s*([\d.]+)\s*MiB\s*\(limits:\s*([\d.]+)\s*MiB,\s*(\d+)\s*tokens/;
const FORCING_RE = /forcing full prompt re-processing/;

// リクエストごとに1回出る。cache state と同じ場面で、こちらは「今回保存した1本」の実測値。
//   srv prompt_save: - saving prompt with length 20248, total state size = 316.587 MiB
const PROMPT_SAVE_RE = /saving prompt with length\s+(\d+), total state size = ([\d.]+)\s*MiB/;

// cache state のすぐ後に、プールに入っている1本ずつの内訳が並ぶ。
//   srv update:    - prompt 0x7050580b0:   10896 tokens, checkpoints:  1,   325.706 MiB
// 追い出す対象を選ぶには、合計ではなくこの一覧が要る。
const PER_PROMPT_RE = /prompt (0x[0-9a-f]+):\s+(\d+) tokens, checkpoints:\s+(\d+),\s+([\d.]+)\s*MiB/;

export class PoolLogReader {
  /**
   * @param {object} [opts]
   * @param {string}  [opts.path]          読むログ
   * @param {number}  [opts.softStaleMs]   この時間を超えたら「古い値」と印を付ける
   * @param {number}  [opts.hardStaleMs]   この時間を超えたら取得失敗として扱う
   * @param {number}  [opts.maxReadBytes]  1回に読む上限
   * @param {boolean} [opts.fromStart]     既存のログを最初から読むか（既定 false = 末尾から）
   * @param {number}  [opts.seedBytes]     起動時に遡って直近の値を1つ拾う量（0 で拾わない）
   */
  constructor({
    path = DEFAULT_LOG_PATH,
    softStaleMs = 120_000,
    hardStaleMs = 900_000,
    maxReadBytes = 4 * 1024 * 1024,
    fromStart = false,
    seedBytes = 512 * 1024,
  } = {}) {
    this.path = path;
    this.softStaleMs = softStaleMs;
    this.hardStaleMs = hardStaleMs;
    this.maxReadBytes = maxReadBytes;
    this.seedBytes = seedBytes;

    this.pos = 0;
    this.ino = null;
    this.partial = '';
    this.opened = false;
    this.fromStart = fromStart;

    this.last = null;          // 最後に読めた cache state
    this.lastAt = 0;
    this.forcingTotal = 0;     // 監視を始めてからの前処理やり直し回数
    this.everSeen = false;     // 一度でも cache state 行を見たか
    this.seeded = false;       // 起動時に過去のログから拾った値をまだ使っているか

    this.lastSave = null;      // 直近の prompt_save（トークン数と実測サイズ）
    this.saveCount = 0;
    this.promptList = [];      // 直近の cache state に続いていた内訳一覧
    this._collecting = null;   // 内訳を集めている途中の入れ物
  }

  // 起動した瞬間に「直前の値」を1つ拾っておく。
  //
  // 拾わないと、ollama が暇なあいだ（＝新しい行が出ないあいだ）ずっと取得失敗になる。
  // ただし、その行がいつ書かれたのかは分からない（ログに時刻が入っていない設定のため）。
  // ファイルの更新時刻から出せるのは「少なくともこれだけ古い」という下限だけなので、
  // 拾った値には seeded の印を付けて、鮮度は不明として扱う。
  _seed(st) {
    if (!this.seedBytes || st.size === 0) return;
    const want = Math.min(this.seedBytes, st.size);
    let text = '';
    try {
      const fd = fs.openSync(this.path, 'r');
      try {
        const buf = Buffer.alloc(want);
        const read = fs.readSync(fd, buf, 0, want, st.size - want);
        text = buf.subarray(0, read).toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return;
    }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = CACHE_STATE_RE.exec(lines[i]);
      if (m) {
        this.last = {
          prompts: Number(m[1]),
          usedMiB: Number(m[2]),
          limitMiB: Number(m[3]),
          limitTokens: Number(m[4]),
        };
        this.lastAt = st.mtimeMs;
        this.everSeen = true;
        this.seeded = true;
        return;
      }
    }
  }

  _openIfNeeded() {
    let st;
    try {
      st = fs.statSync(this.path);
    } catch (err) {
      return { ok: false, reason: 'log_unreadable', detail: String(err && err.code) };
    }
    if (!this.opened) {
      // 監視を始めた時点より前のログは読まない（起動のたびに数MBを舐めることになるため）
      this.pos = this.fromStart ? 0 : st.size;
      this.ino = st.ino;
      this.opened = true;
      if (!this.fromStart) this._seed(st);
      return { ok: true, st };
    }
    // ログが入れ替わった／切り詰められた場合は先頭から読み直す
    if (st.ino !== this.ino || st.size < this.pos) {
      this.pos = 0;
      this.ino = st.ino;
      this.partial = '';
    }
    return { ok: true, st };
  }

  /**
   * 前回の poll 以降に増えた分を読む。
   * @returns {{ok:true, fresh:boolean, ageMs:number, prompts:number, usedMiB:number,
   *            limitMiB:number, ratio:number, forcingDelta:number, forcingTotal:number, stale:boolean}
   *         | {ok:false, reason:string, detail?:string, lastKnown?:object}}
   */
  poll(now = Date.now()) {
    const opened = this._openIfNeeded();
    if (!opened.ok) return { ...opened, lastKnown: this.last };
    const st = opened.st;

    let forcingDelta = 0;
    let saveDelta = 0;
    let sawCacheState = false;

    if (st.size > this.pos) {
      const want = Math.min(st.size - this.pos, this.maxReadBytes);
      const from = st.size - this.pos > this.maxReadBytes ? st.size - this.maxReadBytes : this.pos;
      let text = '';
      try {
        const fd = fs.openSync(this.path, 'r');
        try {
          const buf = Buffer.alloc(want);
          const read = fs.readSync(fd, buf, 0, want, from);
          text = buf.subarray(0, read).toString('utf8');
        } finally {
          fs.closeSync(fd);
        }
      } catch (err) {
        return { ok: false, reason: 'log_read_failed', detail: String(err && err.code), lastKnown: this.last };
      }
      this.pos = st.size;

      const chunk = this.partial + text;
      const lines = chunk.split('\n');
      this.partial = lines.pop(); // 途中で切れている最後の行は次回へ持ち越す

      for (const line of lines) {
        if (FORCING_RE.test(line)) { forcingDelta++; this.forcingTotal++; }

        const ps = PROMPT_SAVE_RE.exec(line);
        if (ps) {
          this.lastSave = { tokens: Number(ps[1]), stateMiB: Number(ps[2]), at: now };
          this.saveCount++;
          saveDelta++;
        }

        const pp = PER_PROMPT_RE.exec(line);
        if (pp && this._collecting) {
          this._collecting.push({
            addr: pp[1], tokens: Number(pp[2]),
            checkpoints: Number(pp[3]), stateMiB: Number(pp[4]),
          });
          continue;
        }
        if (pp === null && this._collecting && !CACHE_STATE_RE.test(line)) {
          // 内訳の並びが終わった
          if (this._collecting.length) this.promptList = this._collecting;
          this._collecting = null;
        }

        const m = CACHE_STATE_RE.exec(line);
        if (m) {
          this._collecting = [];
          sawCacheState = true;
          this.everSeen = true;
          this.last = {
            prompts: Number(m[1]),
            usedMiB: Number(m[2]),
            limitMiB: Number(m[3]),
            limitTokens: Number(m[4]),
          };
          this.lastAt = now;
          this.seeded = false;
        }
      }
    }

    if (!this.last) {
      // 一度も読めていない。ログの書式が変わったか、verbosity が落とされたか。
      // ここで 0 を返すと「圧力なし」に化ける（§7.5）。失敗として返す。
      return {
        ok: false,
        reason: this.everSeen ? 'no_value' : 'never_seen',
        detail: 'cache state 行が見つかりません（ollama の起動引数が変わった可能性）',
      };
    }

    const ageMs = now - this.lastAt;
    if (ageMs > this.hardStaleMs) {
      return { ok: false, reason: 'stale', detail: `${Math.round(ageMs / 1000)}秒前の値しかありません`, lastKnown: this.last };
    }

    const ratio = this.last.limitMiB > 0 ? this.last.usedMiB / this.last.limitMiB : null;
    return {
      ok: true,
      fresh: sawCacheState,
      seeded: this.seeded,
      // 起動時に拾った値は、いつのものか分からないので必ず「古い」扱いにする
      stale: this.seeded || ageMs > this.softStaleMs,
      ageMs,
      prompts: this.last.prompts,
      usedMiB: this.last.usedMiB,
      limitMiB: this.last.limitMiB,
      limitTokens: this.last.limitTokens,
      ratio,
      forcingDelta,
      forcingTotal: this.forcingTotal,
      // 1リクエストごとに出る実測値。プール圧そのものより動きが分かる。
      saveDelta,
      saveCount: this.saveCount,
      lastSave: this.lastSave,
      // プールに入っている1本ずつ。追い出す相手を選ぶのに要る。
      // 上の prompts は cache state 行が言う「本数」なので、名前を分けてある。
      promptCount: this.promptList.length,
      promptList: this.promptList,
    };
  }
}

/**
 * 保存プロンプト1件の大きさ — 実測モデル（2026-09-05、ログ17点から導出）
 *
 *   状態サイズ [MiB] = min(トークン数, 1024) × 106.26 KiB  +  トークン数 × 10.637 KiB
 *                      ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~     ~~~~~~~~~~~~~~~~~~~~~~
 *                      SWA窓（n_swa=1024）が埋まるまでの分      窓の外に伸びていく分
 *
 * 17点すべてで誤差 0.002 MiB 以下（17トークンから 21,044トークンまで）。
 *
 * 前の版（106.262 + 10.64 KiB × tok）との違い：
 *   前の版は 2,000トークン以上の点だけで直線を引いたので、切片 106.262 MiB を
 *   「トークン数によらない定数」と読んでいた。実際には定数ではなく、
 *   min(tok, 1024) × 106.26 KiB が 1024 トークンで頭打ちになったもの。
 *   17トークンでは 104 MiB、252トークンでは 80 MiB ずれる。
 *
 *   106.262 / 0.10626 = 1024.0 ちょうど。n_swa=1024 と一致する。
 *   つまりこの値は測って出た謎の定数ではなく、SWA窓そのものの大きさ。
 *
 * 効いてくる違い：
 *   1トークン目の値段は 116.9 KiB、1025トークン目からは 10.6 KiB。**11倍違う。**
 *   短いプロンプトを何本も抱えるほうが、トークンあたりでは高くつく。
 */
export const STATE_SIZE_MODEL = Object.freeze({
  swaWindowTokens: 1024,
  windowKiBPerToken: 106.26,   // 窓が埋まるまで
  tailKiBPerToken: 10.637,     // 窓の外
  /** 窓が埋まりきったときの頭打ち値。前の版が「定数」と呼んでいたもの */
  checkpointMiB: (1024 * 106.26) / 1024,

  /** トークン数から状態サイズ [MiB] */
  estimateMiB(tokens) {
    const t = Math.max(0, tokens);
    return (Math.min(t, this.swaWindowTokens) * this.windowKiBPerToken + t * this.tailKiBPerToken) / 1024;
  },

  /** そのプロンプトを丸ごと追い出したときに浮く [MiB] */
  evictMiB(tokens) {
    return this.estimateMiB(tokens);
  },

  /**
   * プロンプトを縮めたときに浮く [MiB]。
   * 1024トークンより長いまま縮めるぶんには 10.637 KiB/tok しか浮かない。
   * 丸ごと追い出すのとは桁が違うので、混同しないこと。
   */
  shrinkMiB(fromTokens, toTokens) {
    return this.estimateMiB(fromTokens) - this.estimateMiB(toTokens);
  },

  /** 枠 [MiB] に、このトークン数のプロンプトが何本入るか */
  capacity(tokensEach, limitMiB = 8192) {
    return Math.floor(limitMiB / this.estimateMiB(tokensEach));
  },
});
