// 監視 — 仕様 §6.2 ／ 実装順 §9 手順3「監視のみ。介入はしない」
//
// 1秒に1回、2つの系統から状態を取って記録する。
//   系統A /slots      … いま処理中の会話の文脈使用量と、プロンプトキャッシュの命中率
//   系統B ログの cache state … 保存プロンプトのプール圧（8192 MiB の枠にどれだけ入っているか）
//
// 2つ要る理由（訂正2）：系統Aだけを見ると、プールが溢れて前処理のやり直しが
// 起きている最中でも「圧力なし」に見える。
//
// この部品は何も止めないし、何も消さない。数字を並べるだけ。
// 圧縮が本当に要るのかを、介入を入れる前に確かめるための工程だから（§9 手順3〜5）。
//
// 取得に失敗したときの扱い（§7.5）：
//   失敗を 0 として返さない。直前の有効値を保持して「古い値である」と印を付け、
//   連続して失敗したら警告を出し、さらに続いたら「圧力が高い」側へ倒す。

import fs from 'node:fs';
import path from 'node:path';
import { fetchSlots, discoverBackend } from './backend.mjs';
import { PoolLogReader, DEFAULT_LOG_PATH } from './poollog.mjs';

export const PHASE = Object.freeze({
  IDLE: 'idle',
  PREFILL: 'prefill',
  DECODE: 'decode',
  BUSY: 'busy', // 処理中だがどちらか判別できない
});

function median(arr) {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

class Ring {
  constructor(size) { this.size = size; this.items = []; }
  push(v) { this.items.push(v); if (this.items.length > this.size) this.items.shift(); }
  get length() { return this.items.length; }
  mean() { return this.items.length ? this.items.reduce((a, b) => a + b, 0) / this.items.length : null; }
  median() { return median(this.items); }
  clear() { this.items = []; }
}

// 取得に失敗しても 0 を返さない入れ物。
class Channel {
  constructor(name, { warnAfter = 3, conservativeAfter = 10 } = {}) {
    this.name = name;
    this.warnAfter = warnAfter;
    this.conservativeAfter = conservativeAfter;
    this.lastGood = null;
    this.lastGoodAt = 0;
    this.consecutiveFailures = 0;
    this.totalFailures = 0;
    this.warned = false;
  }
  succeed(value, at) {
    this.lastGood = value;
    this.lastGoodAt = at;
    this.consecutiveFailures = 0;
    this.warned = false;
  }
  fail() {
    this.consecutiveFailures++;
    this.totalFailures++;
  }
  get shouldWarn() { return this.consecutiveFailures >= this.warnAfter && !this.warned; }
  /** 連続失敗が続いたら「不明」ではなく「高い」として扱う（保守的に倒す） */
  get assumeHighPressure() { return this.consecutiveFailures >= this.conservativeAfter; }
}

export class Monitor {
  /**
   * @param {object} [opts]
   * @param {number}   [opts.intervalMs]      標本の間隔（既定 1000 = 1Hz）
   * @param {string}   [opts.logPath]         ollama のログ
   * @param {string}   [opts.outPath]         記録先の JSONL（省略で記録しない）
   * @param {number}   [opts.warmupMs]        起動直後の除外時間（初回のTTFTが必ず大きいため）
   * @param {number}   [opts.baselineWindowMs] 基準 tok/s を取る窓
   * @param {function} [opts.onSample]
   * @param {function} [opts.onWarn]
   */
  constructor(opts = {}) {
    this.intervalMs = opts.intervalMs ?? 1000;
    this.warmupMs = opts.warmupMs ?? 5000;
    this.baselineWindowMs = opts.baselineWindowMs ?? 10_000;
    this.outPath = opts.outPath || null;
    this.onSample = opts.onSample || null;
    this.onWarn = opts.onWarn || null;
    this.slotsTimeoutMs = opts.slotsTimeoutMs ?? 1500;

    this.pool = new PoolLogReader({ path: opts.logPath || DEFAULT_LOG_PATH });
    this.chSlots = new Channel('slots', opts.channel);
    this.chPool = new Channel('pool', opts.channel);

    // フェーズごとに別のバッファ。prefill と decode は速度が桁違いなので、
    // まぜて平均を取ると数字が意味を失う（§6.2）。
    this.decodeTps = new Ring(32);
    this.prefillTps = new Ring(32);

    this.baseline = null;          // セッション内で固定する基準 tok/s
    this._baselineSamples = [];
    this.startedAt = 0;
    this.samples = 0;

    this._prev = null;
    this._timer = null;
    this._inFlight = false;
    this._out = null;
  }

  start() {
    if (this._timer) return this;
    this.startedAt = Date.now();
    if (this.outPath) {
      fs.mkdirSync(path.dirname(this.outPath), { recursive: true });
      this._out = fs.openSync(this.outPath, 'a');
    }
    // 独立したタスクとして常時回す。推論の前後だけ測る方式では、
    // 生成中に伸びて閾値を超えた場合を取り逃がす（§6.2）。
    this._timer = setInterval(() => { this._tick(); }, this.intervalMs);
    this._tick();
    return this;
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._out !== null) { try { fs.closeSync(this._out); } catch { /* noop */ } this._out = null; }
    return this;
  }

  unref() { if (this._timer && this._timer.unref) this._timer.unref(); return this; }

  _warn(code, message) {
    if (this.onWarn) { try { this.onWarn({ code, message, at: Date.now() }); } catch { /* noop */ } }
  }

  async _tick() {
    if (this._inFlight) return; // 前回の取得が終わっていない。重ねない。
    this._inFlight = true;
    try {
      const at = Date.now();
      const [slots, pool] = [await fetchSlots({ timeoutMs: this.slotsTimeoutMs }), this.pool.poll(at)];

      if (slots.ok) this.chSlots.succeed(slots, at); else this.chSlots.fail();
      if (pool.ok) this.chPool.succeed(pool, at); else this.chPool.fail();

      if (this.chSlots.shouldWarn) {
        this.chSlots.warned = true;
        this._warn('slots_unavailable',
          `/slots を ${this.chSlots.consecutiveFailures} 回連続で取得できません（${slots.reason}）。圧力は「不明」として扱っています。`);
      }
      if (this.chPool.shouldWarn) {
        this.chPool.warned = true;
        this._warn('pool_unavailable',
          `ログからプール圧を ${this.chPool.consecutiveFailures} 回連続で読めません（${pool.reason}）。ollama の起動引数が変わった可能性があります。`);
      }

      const sample = this._derive(at, slots, pool);
      this.samples++;
      this._record(sample);
      if (this.onSample) { try { this.onSample(sample); } catch { /* noop */ } }
      this._prev = slots.ok ? slots : this._prev;
    } catch (err) {
      this._warn('monitor_error', String(err && err.message));
    } finally {
      this._inFlight = false;
    }
  }

  _derive(at, slots, pool) {
    let phase = null;
    let tps = null;

    if (slots.ok) {
      if (!slots.is_processing) {
        phase = PHASE.IDLE;
      } else if (this._prev && this._prev.ok && this._prev.id_task === slots.id_task) {
        const dt = (at - this._prev.at) / 1000;
        const dDecoded = (slots.n_decoded ?? 0) - (this._prev.n_decoded ?? 0);
        const dProcessed = slots.n_prompt_tokens_processed - this._prev.n_prompt_tokens_processed;
        if (dt > 0 && dDecoded > 0) {
          phase = PHASE.DECODE;
          tps = dDecoded / dt;
          this.decodeTps.push(tps);
        } else if (dt > 0 && dProcessed > 0) {
          phase = PHASE.PREFILL;
          tps = dProcessed / dt;
          this.prefillTps.push(tps);
        } else {
          phase = PHASE.BUSY;
        }
      } else {
        phase = PHASE.BUSY; // 新しい仕事の1標本目。差分が取れない。
      }
    }

    // 基準 tok/s は、起動直後を除いた最初の安定区間の中央値をセッション内で固定する。
    // 絶対値で閾値を決めない（環境差が大きいため §6.3）。
    if (this.baseline === null && phase === PHASE.DECODE && tps !== null) {
      const since = at - this.startedAt;
      if (since >= this.warmupMs) {
        this._baselineSamples.push({ at, tps });
        const first = this._baselineSamples[0].at;
        if (at - first >= this.baselineWindowMs && this._baselineSamples.length >= 5) {
          this.baseline = median(this._baselineSamples.map((s) => s.tps));
        }
      }
    }

    const slotsView = slots.ok
      ? {
          ok: true,
          n_prompt_tokens: slots.n_prompt_tokens,
          n_ctx: slots.n_ctx,
          ctx_use_rate: slots.ctx_use_rate,
          cache_hit_rate: slots.cache_hit_rate,
          is_processing: slots.is_processing,
          n_decoded: slots.n_decoded,
        }
      : {
          ok: false,
          reason: slots.reason,
          consecutiveFailures: this.chSlots.consecutiveFailures,
          // 直前の有効値を保持する。0 では**ない**。
          heldAgeMs: this.chSlots.lastGoodAt ? at - this.chSlots.lastGoodAt : null,
          held: this.chSlots.lastGood
            ? { ctx_use_rate: this.chSlots.lastGood.ctx_use_rate, cache_hit_rate: this.chSlots.lastGood.cache_hit_rate }
            : null,
        };

    const poolView = pool.ok
      ? {
          ok: true, ratio: pool.ratio, usedMiB: pool.usedMiB, limitMiB: pool.limitMiB,
          prompts: pool.prompts, stale: pool.stale, seeded: pool.seeded,
          fresh: pool.fresh, ageMs: pool.ageMs,
          forcingDelta: pool.forcingDelta, forcingTotal: pool.forcingTotal,
          // プール圧はリクエストの切れ目でしか動かない。1秒ごとに見ても同じ値が並ぶだけなので、
          // 「いま1本保存された」という出来事のほうを記録に残す。
          saveDelta: pool.saveDelta, saveCount: pool.saveCount, lastSave: pool.lastSave,
          promptCount: pool.promptCount,
        }
      : {
          ok: false, reason: pool.reason,
          consecutiveFailures: this.chPool.consecutiveFailures,
          heldAgeMs: this.chPool.lastGoodAt ? at - this.chPool.lastGoodAt : null,
          held: this.chPool.lastGood ? { ratio: this.chPool.lastGood.ratio } : null,
        };

    return {
      t: new Date(at).toISOString(),
      at,
      phase,
      tps,
      decode_tps_avg32: this.decodeTps.mean(),
      baseline_tps: this.baseline,
      tps_vs_baseline: this.baseline && this.decodeTps.mean() ? this.decodeTps.mean() / this.baseline : null,
      slots: slotsView,
      pool: poolView,
      // 判定はまだしない（§9 手順3）。ただし「取得できていない」ことは記録に残す。
      unknown: !slots.ok || !pool.ok,
      assume_high: this.chSlots.assumeHighPressure || this.chPool.assumeHighPressure,
    };
  }

  _record(sample) {
    if (this._out === null) return;
    try {
      fs.writeSync(this._out, JSON.stringify(sample) + '\n');
    } catch {
      /* 記録に失敗しても監視は続ける */
    }
  }

  /** いまの状態のまとめ。 */
  snapshot() {
    return {
      samples: this.samples,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      baseline_tps: this.baseline,
      decode_tps_avg32: this.decodeTps.mean(),
      prefill_tps_avg32: this.prefillTps.mean(),
      slots: { failures: this.chSlots.totalFailures, consecutive: this.chSlots.consecutiveFailures, last: this.chSlots.lastGood },
      pool: { failures: this.chPool.totalFailures, consecutive: this.chPool.consecutiveFailures, last: this.chPool.lastGood },
    };
  }
}

export { discoverBackend };
