// 圧力の判定 — 仕様 §6.3
//
// この部品は §9 手順5「判定のみを試験運転する（介入なし）」のために置いてある。
// 既定では無効。閾値は実測から決めるもので、いま入っている数字は仮の値。
// 介入（要約の実行、文脈上限の引き下げ）はここには入れない。
//
// 仕様が名指しで警告している実装の罠（§6.3）：
//   「復帰閾値は、設定値として定義するだけでは機能しない。現在の状態を保持する変数が
//     存在し、遷移判定がその変数を参照して初めてヒステリシスが成立する」
//   毎回独立に閾値と比べる書き方だと、復帰閾値はどこからも参照されず、
//   実質的に単一閾値と同じ挙動になる。だからここは必ず状態変数から出発する。

export const STATE = Object.freeze({
  NORMAL: 'NORMAL',
  PRESSURE: 'PRESSURE',
  CRITICAL: 'CRITICAL',
});

// 仮の値。§9 手順4 の実測で置き換える。
export const PROVISIONAL_THRESHOLDS = Object.freeze({
  enter: 0.75,        // これを超えた状態が続いたら PRESSURE
  critical: 0.90,     // これを超えたら CRITICAL
  recover: 0.55,      // これを下回ったら NORMAL へ戻す（発動と20ポイント離す）
  tpsCritical: 0.60,  // 基準 tok/s のこの割合を下回ったら CRITICAL
  consecutive: 3,     // 単発の跳ねで誤発動しないための連続回数
  cooldownMs: 30_000, // 発動直後は再判定しない
  provisional: true,
});

export class PressureJudge {
  /**
   * @param {object} [opts]
   * @param {object} [opts.thresholds]
   * @param {boolean} [opts.enabled]  既定 false（§9 手順5 まで動かさない）
   */
  constructor({ thresholds = PROVISIONAL_THRESHOLDS, enabled = false } = {}) {
    this.th = { ...PROVISIONAL_THRESHOLDS, ...thresholds };
    this.enabled = enabled;

    // ここが状態変数。すべての遷移判定はこの値から出発する。
    this.state = STATE.NORMAL;
    this.since = 0;
    this.lastTransitionAt = 0;
    // 「まだ一度も実行していない」を 0 で表すと、起動から30秒間は
    // クールダウン中とみなされて発動できない。初回だけ抜ける穴になるので -Infinity にする。
    this.lastFireAt = -Infinity;

    this.overEnter = 0;    // enter を超えた連続回数
    this.underRecover = 0; // recover を下回った連続回数
    this.history = [];
  }

  /**
   * 標本を1つ入れて、状態を更新する。
   *
   * @param {object} s
   * @param {number} s.at
   * @param {number|null} s.poolRatio  プール圧（使用 MiB / 上限 MiB）。null は取得失敗
   * @param {number|null} s.tpsRatio   いまの tok/s ÷ 基準 tok/s。null は不明
   * @param {boolean} [s.unknown]      いずれかの系統が取得できていない
   * @param {boolean} [s.assumeHigh]   連続失敗が続いていて、保守的に高いとみなす
   * @returns {{state:string, changed:boolean, reason:string, canFire:boolean}}
   */
  update({ at, poolRatio, tpsRatio = null, unknown = false, assumeHigh = false }) {
    const prev = this.state;
    let reason = '';

    // 1. 取得できていないときは、圧力を下げる方向へは動かさない（§7.5）。
    //    「不明」を「圧力なし」と読み替えると、安全機構は動かないまま動いて見える。
    if (poolRatio === null || poolRatio === undefined) {
      if (assumeHigh && this.state === STATE.NORMAL) {
        this._transition(STATE.PRESSURE, at);
        reason = '監視が連続して失敗しているため、保守的に PRESSURE とみなす';
      } else {
        reason = '圧力が取得できないため、状態を据え置く';
      }
      return this._result(prev, reason, at);
    }

    // 2. 連続回数を数える。単発の跳ねは正常動作の範囲（§6.3）。
    this.overEnter = poolRatio > this.th.enter ? this.overEnter + 1 : 0;
    this.underRecover = poolRatio < this.th.recover ? this.underRecover + 1 : 0;

    const inCooldown = at - this.lastTransitionAt < this.th.cooldownMs;

    // 3. 遷移。必ず現在の状態から分岐する。
    switch (this.state) {
      case STATE.NORMAL:
        if (this.overEnter >= this.th.consecutive) {
          this._transition(STATE.PRESSURE, at);
          reason = `プール圧 ${(poolRatio * 100).toFixed(1)}% が ${this.th.consecutive} 回続いた`;
        } else {
          reason = '平常';
        }
        break;

      case STATE.PRESSURE:
        if (poolRatio > this.th.critical) {
          this._transition(STATE.CRITICAL, at);
          reason = `プール圧 ${(poolRatio * 100).toFixed(1)}% が上限に近い`;
        } else if (tpsRatio !== null && tpsRatio < this.th.tpsCritical) {
          this._transition(STATE.CRITICAL, at);
          reason = `生成速度が基準の ${(tpsRatio * 100).toFixed(0)}% まで落ちた`;
        } else if (this.underRecover >= this.th.consecutive && !inCooldown) {
          // 復帰閾値を参照しているのはここ。状態変数が PRESSURE のときだけ意味を持つ。
          this._transition(STATE.NORMAL, at);
          reason = `プール圧が ${(this.th.recover * 100).toFixed(0)}% を下回って戻った`;
        } else {
          reason = '圧力あり';
        }
        break;

      case STATE.CRITICAL:
        if (this.underRecover >= this.th.consecutive && !inCooldown) {
          this._transition(STATE.PRESSURE, at);
          reason = '危険域を脱した';
        } else {
          reason = '危険域';
        }
        break;
    }

    if (unknown && this.state === STATE.NORMAL && prev !== STATE.NORMAL) {
      // 片方の系統だけで NORMAL へ戻すのは早い。据え置く。
      this.state = prev;
      reason = '一部の系統が取得できていないため、復帰を保留した';
    }

    return this._result(prev, reason, at);
  }

  _transition(next, at) {
    this.state = next;
    this.since = at;
    this.lastTransitionAt = at;
    this.overEnter = 0;
    this.underRecover = 0;
  }

  _result(prev, reason, at) {
    const changed = this.state !== prev;
    // 実際に何かを実行してよいか。クールダウン中は false。
    // 要約処理そのものが一時的にメモリを食うので、直後の測定は必ず高く出る（§6.3）。
    const canFire =
      this.enabled &&
      this.state !== STATE.NORMAL &&
      at - this.lastFireAt >= this.th.cooldownMs;
    if (changed) this.history.push({ at, from: prev, to: this.state, reason });
    return { state: this.state, changed, reason, canFire, at };
  }

  /** 介入を実行したことを記録する（クールダウンの起点）。 */
  markFired(at) { this.lastFireAt = at; }

  snapshot() {
    return {
      enabled: this.enabled,
      state: this.state,
      thresholds: this.th,
      transitions: this.history.length,
      history: this.history.slice(-10),
    };
  }
}

/**
 * 発動をユーザーに見せる1行（§6.5）。
 * 対処しようとしている問題が「原因不明の性能劣化」なので、
 * 対策のほうが不透明に品質を落としてはいけない。
 */
export function formatNotice({ turns, records, savedMiB }) {
  const parts = ['文脈を圧縮しました。'];
  if (turns) parts.push(`${turns}ターン分を要約1件に置き換えました。`);
  if (records) parts.push(`原文${records}件はディスクに残っています。`);
  if (savedMiB) parts.push(`約${savedMiB.toFixed(0)}MiB を解放しました。`);
  return parts.join('');
}
