// 文脈ゲートウェイ（3L-HCCG v0.4）の入口
//
// qwc / OpenClaw / voice-ai / Omnical から使うときは、ここだけを読み込めばよい。
//
//   import { Gateway } from '/Users/daigo/文脈ゲートウェイ/index.mjs';
//   const gw = new Gateway();
//
//   const rec = gw.recordUserTurn('daigo', 入力);   // ← 何よりも先にこれ
//   ...モデルを呼ぶ...
//   const 見せる文 = gw.filter(出力);
//   gw.recordAssistantTurn('gemma4', 出力, rec.record_id);
//
// いま入っているのは §9 の手順1〜3まで。
//   手順1 原文ストア    … 実装済み
//   手順2 口（出力側）  … 実装済み
//   手順3 監視のみ      … 実装済み（介入はしない）
//   手順4〜6 閾値と発動 … 未実装（先に手順4の計測が要る）
//   手順7 耳A（入力側） … 未実装
//   手順8 参照渡し      … 未実装

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export { Corpus, KINDS, CorpusError, makeSummaryContent, parseSummaryContent } from './lib/corpus.mjs';
export { Mouth, createMouth, filterOutput, DEFAULT_THINK_TAGS } from './lib/mouth.mjs';
export { Monitor, PHASE } from './lib/monitor.mjs';
export { PressureJudge, STATE, PROVISIONAL_THRESHOLDS, formatNotice } from './lib/judge.mjs';
export { discoverBackend, fetchSlots, fetchProps } from './lib/backend.mjs';
export { PoolLogReader, STATE_SIZE_MODEL, DEFAULT_LOG_PATH } from './lib/poollog.mjs';
export { ulid, decodeTime, isUlid } from './lib/ulid.mjs';

import { Corpus } from './lib/corpus.mjs';
import { createMouth, filterOutput } from './lib/mouth.mjs';
import { Monitor } from './lib/monitor.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_CORPUS_DIR = process.env.GW_CORPUS_DIR || path.join(HERE, 'corpus');

/**
 * 3つの部品をまとめた入口。
 *
 * この薄い包みを用意している理由は一つだけで、§2.3 の最後の不変条件
 * 「ユーザー入力は、いかなる加工よりも前に、まず原文ストアへ書き込む」を
 * 破りにくくするため。順序を間違えると、フィルタが情報を落とした時点で原文が消える。
 */
export class Gateway {
  constructor({ corpusDir = DEFAULT_CORPUS_DIR, mouth = {}, fsync = false } = {}) {
    this.corpus = new Corpus({ dir: corpusDir, fsync });
    this.mouthOpts = mouth;
  }

  /** 利用者の入力。加工の前に必ずこれを呼ぶ。 */
  recordUserTurn(sender, content) {
    return this.corpus.append({ kind: 'user_turn', sender, content });
  }

  /** モデルの出力。原文（フィルタ前）を保存する。 */
  recordAssistantTurn(sender, content, parent_id = null) {
    return this.corpus.append({ kind: 'assistant_turn', sender, content, parent_id });
  }

  /** 外から取ってきたデータ。 */
  recordFetched(sender, content, parent_id = null) {
    return this.corpus.append({ kind: 'fetched_data', sender, content, parent_id });
  }

  /**
   * 加工後のテキストを、元を指した別レコードとして残す（§2.3）。
   * 元レコードは書き換えない。
   */
  recordDerived(parent_id, { kind, sender, content }) {
    return this.corpus.appendDerived(parent_id, { kind, sender, content });
  }

  /** 出力を整える（§3.3）。壊れたら原文がそのまま返る。 */
  filter(text, opts = {}) {
    return filterOutput(text, { ...this.mouthOpts, ...opts }).text;
  }

  /** 出力を整える（統計つき）。削減率を測りたいときはこちら。 */
  filterWithStats(text, opts = {}) {
    return filterOutput(text, { ...this.mouthOpts, ...opts });
  }

  /** 逐次出力用。push / end で使う。 */
  stream(opts = {}) {
    return createMouth({ ...this.mouthOpts, ...opts });
  }

  /** 監視を始める（§9 手順3。何も止めないし消さない）。 */
  watch(opts = {}) {
    const m = new Monitor(opts);
    m.start();
    return m;
  }
}

export default Gateway;
