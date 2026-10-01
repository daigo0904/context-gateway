// 原文ストア（Corpus Store）— 仕様 §2
//
// この部品がやることは一つだけ。「受け取った文章を、そのまま、消さずに、追記して残す」。
// 加工も要約も削除もしない。IDを付けて番号順に並べておくだけ。
//
// なぜこれが全体の土台なのか（§2.4）：
//   Layer 2 の参照渡しも、Layer 3 の索引付き要約も、第7章の安全機構も、
//   ぜんぶ「原文がどこかに残っている」ことを前提にしている。
//   ここが無いと、他のどの機構も「消していい」判断ができない。
//
// 保存先はファイル。1行に1レコードの JSONL。日付ごとに別ファイルへ分ける。
// どのファイルに入っているかは record_id（ULID）から時刻を取り出して決まるので、
// 全体を舐める索引は要らない。

import fs from 'node:fs';
import path from 'node:path';
import { monotonicFactory, decodeTime, isUlid, ULID_LEN } from './ulid.mjs';

// §2.2 の kind。ここに無い種類は受け付けない。
// 綴り間違いを黙って通すと、あとで「探しても出てこない」になるため。
export const KINDS = Object.freeze([
  'user_turn',       // 利用者の入力
  'assistant_turn',  // モデルの出力
  'fetched_data',    // 外から取ってきたデータ（Web、ファイル、コマンド出力）
  'agent_artifact',  // エージェント間で受け渡す成果物
  'summary',         // 要約（Layer 3 が作る。元レコードは消さない）
]);
const KIND_SET = new Set(KINDS);

export class CorpusError extends Error {}

export class Corpus {
  /**
   * @param {object} opts
   * @param {string} opts.dir       保存先ディレクトリ
   * @param {boolean} [opts.fsync]  1件ごとにディスクへ確実に書き出すか（既定 false）
   * @param {function} [opts.newId] IDの発行器（試験で差し替えるため）
   */
  constructor({ dir, fsync = false, newId = null } = {}) {
    if (!dir) throw new CorpusError('Corpus: dir を指定してください');
    this.dir = dir;
    this.fsync = fsync;
    this.newId = newId || monotonicFactory();
    this._idxCache = new Map(); // segment名 -> { mtimeMs, size, map }
    fs.mkdirSync(this.dir, { recursive: true });
  }

  // ---- 置き場所の決定 ------------------------------------------------

  // 日付は UTC で切る。ローカル時刻で切ると、夏時間や時差の設定変更があったとき
  // 「IDから引いたファイル名」と「書き込んだファイル名」がずれて、原文が行方不明になる。
  static segmentOf(ms) {
    return new Date(ms).toISOString().slice(0, 10); // YYYY-MM-DD
  }

  segmentPath(segment) {
    return path.join(this.dir, `${segment}.jsonl`);
  }

  indexPath(segment) {
    return path.join(this.dir, `${segment}.idx`);
  }

  // ---- 書き込み ------------------------------------------------------

  /**
   * 原文を1件追記する。§2.3 の不変条件：
   *   - 追記のみ。既存の行は書き換えない
   *   - content は無加工で保存する
   *
   * @returns {object} 保存したレコード（record_id 入り）
   */
  append({ kind, sender, content, parent_id = null, ts = null }) {
    if (!KIND_SET.has(kind)) {
      throw new CorpusError(`Corpus: 知らない kind です: ${kind}（使えるのは ${KINDS.join(', ')}）`);
    }
    if (typeof content !== 'string') {
      // オブジェクトを渡されたら、どう文字列にするかは呼び出し側の判断。
      // ここで勝手に JSON.stringify すると「無加工で保存」が破れる。
      throw new CorpusError('Corpus: content は文字列で渡してください（加工の判断はこの層でしない）');
    }
    if (typeof sender !== 'string' || sender === '') {
      throw new CorpusError('Corpus: sender は空でない文字列で渡してください');
    }
    if (parent_id !== null && !isUlid(parent_id)) {
      throw new CorpusError(`Corpus: parent_id が ULID ではありません: ${parent_id}`);
    }

    const record_id = this.newId();
    const ms = decodeTime(record_id);
    const record = {
      record_id,
      ts: ts || new Date(ms).toISOString(),
      kind,
      sender,
      content,
      parent_id,
      byte_len: Buffer.byteLength(content, 'utf8'),
    };

    const segment = Corpus.segmentOf(ms);
    const file = this.segmentPath(segment);
    const line = JSON.stringify(record) + '\n';
    const buf = Buffer.from(line, 'utf8');

    // 追記モードで開く。O_APPEND なので、他のプロセスが同じファイルに書いていても
    // 行の途中に割り込まれない。offset は書く直前の大きさ。
    const fd = fs.openSync(file, 'a');
    try {
      const offset = fs.fstatSync(fd).size;
      fs.writeSync(fd, buf, 0, buf.length);
      if (this.fsync) fs.fsyncSync(fd);
      this._appendIndex(segment, record_id, offset, buf.length);
    } finally {
      fs.closeSync(fd);
    }
    return record;
  }

  /**
   * 派生レコードを追記する。フィルタ後の文章、要約、差し戻しなど。
   * §2.3「フィルタ適用後のテキストは別レコードとして保存し、parent_id で元を指す」。
   * 元が実在することをここで確かめる。指し先の無い parent_id は、
   * あとから原文へ戻れないという意味で、原文を失ったのと同じになる。
   */
  appendDerived(parent_id, { kind, sender, content }) {
    const parent = this.get(parent_id);
    if (!parent) {
      throw new CorpusError(`Corpus: 派生元が見つかりません: ${parent_id}`);
    }
    return this.append({ kind, sender, content, parent_id });
  }

  // 索引は「あれば速い」もの。壊れていても全走査で答えが出るので、
  // 書き込みに失敗しても本体の追記は成功扱いにする（安全側への縮退 §1.5）。
  _appendIndex(segment, record_id, offset, length) {
    try {
      fs.appendFileSync(this.indexPath(segment), `${record_id}\t${offset}\t${length}\n`, 'utf8');
      this._idxCache.delete(segment);
    } catch {
      /* 索引が書けなくても原文は残っている。無視してよい。 */
    }
  }

  // ---- 読み出し ------------------------------------------------------

  _loadIndex(segment) {
    const file = this.indexPath(segment);
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      return null;
    }
    const cached = this._idxCache.get(segment);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.map;

    const map = new Map();
    try {
      const text = fs.readFileSync(file, 'utf8');
      for (const line of text.split('\n')) {
        if (!line) continue;
        const [id, off, len] = line.split('\t');
        if (id && off && len) map.set(id, [Number(off), Number(len)]);
      }
    } catch {
      return null;
    }
    this._idxCache.set(segment, { mtimeMs: st.mtimeMs, size: st.size, map });
    return map;
  }

  /**
   * record_id で1件読む。IDから日付が分かるので、その日のファイルだけを見る。
   * 索引があれば直接その位置を読む。無ければその日のファイルを走査する。
   * @returns {object|null}
   */
  get(record_id) {
    if (!isUlid(record_id)) return null;
    const segment = Corpus.segmentOf(decodeTime(record_id));
    const file = this.segmentPath(segment);
    if (!fs.existsSync(file)) return null;

    const idx = this._loadIndex(segment);
    const hit = idx && idx.get(record_id);
    if (hit) {
      const [offset, length] = hit;
      try {
        const fd = fs.openSync(file, 'r');
        try {
          const buf = Buffer.alloc(length);
          fs.readSync(fd, buf, 0, length, offset);
          const rec = JSON.parse(buf.toString('utf8'));
          if (rec.record_id === record_id) return rec;
          // 索引がずれている。走査へ落ちる。
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        /* 走査へ落ちる */
      }
    }

    for (const rec of this.readSegment(segment)) {
      if (rec.record_id === record_id) return rec;
    }
    return null;
  }

  getMany(ids) {
    return ids.map((id) => this.get(id));
  }

  /** その日のファイルを1件ずつ返す。壊れた行は飛ばす（1行の破損で全部を失わない）。 */
  *readSegment(segment) {
    const file = this.segmentPath(segment);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line);
      } catch {
        /* 途中で電源が落ちた等で行が欠けることがある。その行だけ捨てる。 */
      }
    }
  }

  /** 保存されている日付の一覧（古い順）。 */
  segments() {
    let names;
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    return names
      .filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
      .map((n) => n.slice(0, 10))
      .sort();
  }

  /**
   * 範囲読み。kinds / sender / 期間で絞る。
   * @param {object} [opts]
   * @param {string[]} [opts.kinds]
   * @param {string} [opts.sender]
   * @param {string} [opts.fromId]  このID以降（含む）
   * @param {string} [opts.toId]    このIDまで（含む）
   * @param {number} [opts.limit]
   */
  *read({ kinds = null, sender = null, fromId = null, toId = null, limit = Infinity } = {}) {
    const kindSet = kinds ? new Set(kinds) : null;
    let from = null, to = null;
    if (fromId) from = Corpus.segmentOf(decodeTime(fromId));
    if (toId) to = Corpus.segmentOf(decodeTime(toId));

    let n = 0;
    for (const segment of this.segments()) {
      if (from && segment < from) continue;
      if (to && segment > to) break;
      for (const rec of this.readSegment(segment)) {
        if (fromId && rec.record_id < fromId) continue;
        if (toId && rec.record_id > toId) return;
        if (kindSet && !kindSet.has(rec.kind)) continue;
        if (sender && rec.sender !== sender) continue;
        yield rec;
        if (++n >= limit) return;
      }
    }
  }

  /** 直近 n 件。 */
  tail(n = 20, opts = {}) {
    const out = [];
    for (const segment of this.segments().reverse()) {
      const seg = [];
      for (const rec of this.readSegment(segment)) {
        if (opts.kinds && !opts.kinds.includes(rec.kind)) continue;
        if (opts.sender && rec.sender !== opts.sender) continue;
        seg.push(rec);
      }
      out.unshift(...seg.slice(Math.max(0, seg.length - (n - out.length))));
      if (out.length >= n) break;
    }
    return out.slice(-n);
  }

  /** 派生をたどって根の原文まで戻る。要約から原文へ戻るときに使う。 */
  lineage(record_id, maxDepth = 32) {
    const chain = [];
    let id = record_id;
    for (let i = 0; i < maxDepth && id; i++) {
      const rec = this.get(id);
      if (!rec) break;
      chain.push(rec);
      id = rec.parent_id;
    }
    return chain;
  }

  stats() {
    let records = 0, bytes = 0;
    const byKind = {};
    for (const segment of this.segments()) {
      for (const rec of this.readSegment(segment)) {
        records++;
        bytes += rec.byte_len || 0;
        byKind[rec.kind] = (byKind[rec.kind] || 0) + 1;
      }
    }
    return { dir: this.dir, segments: this.segments().length, records, bytes, byKind };
  }
}

/**
 * 要約レコードを作る。§5.2 の source_range を必ず持たせる。
 *
 * 要約本文と一緒に「どのレコードを要約したのか」の範囲を残すのが、v0.2.0 からの
 * 実質的な変更点。要約に何を書き残すか間違えても、範囲さえ残っていれば原文へ戻れる。
 * だから要約の品質要求が下がる。
 */
export function makeSummaryContent({ text, sourceFromId, sourceToId, sourceCount }) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new CorpusError('要約が空です');
  }
  if (!isUlid(sourceFromId) || !isUlid(sourceToId)) {
    throw new CorpusError('source_range が ULID ではありません');
  }
  if (sourceFromId > sourceToId) {
    throw new CorpusError('source_range の順序が逆です');
  }
  return JSON.stringify({
    summary: text,
    source_range: { from: sourceFromId, to: sourceToId, count: sourceCount },
  });
}

export function parseSummaryContent(content) {
  const obj = JSON.parse(content);
  if (typeof obj.summary !== 'string' || !obj.source_range) {
    throw new CorpusError('要約レコードの形式が違います');
  }
  return obj;
}
