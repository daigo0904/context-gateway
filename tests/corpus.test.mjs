import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Corpus, KINDS, makeSummaryContent, parseSummaryContent } from '../lib/corpus.mjs';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gw-corpus-'));
}

test('原文がそのまま戻る（無加工 §2.3）', () => {
  const c = new Corpus({ dir: tmp() });
  const content = '  改行\nと\t空白\nを含む   \n\n<think>タグも消さない</think>';
  const rec = c.append({ kind: 'user_turn', sender: 'daigo', content });
  assert.equal(c.get(rec.record_id).content, content);
  assert.equal(rec.byte_len, Buffer.byteLength(content, 'utf8'));
});

test('IDは時刻順に並ぶ', () => {
  const c = new Corpus({ dir: tmp() });
  const ids = [];
  for (let i = 0; i < 50; i++) ids.push(c.append({ kind: 'user_turn', sender: 'x', content: String(i) }).record_id);
  assert.deepEqual(ids, [...ids].sort());
});

test('要約を作っても元レコードは消えない（§2.3）', () => {
  const c = new Corpus({ dir: tmp() });
  const a = c.append({ kind: 'assistant_turn', sender: 'model', content: '長い返答' });
  c.appendDerived(a.record_id, { kind: 'summary', sender: 'gw', content: '短い要約' });
  assert.equal(c.get(a.record_id).content, '長い返答');
  assert.equal(c.stats().records, 2);
});

test('指し先の無い parent_id は受け付けない', () => {
  const c = new Corpus({ dir: tmp() });
  assert.throws(
    () => c.appendDerived('01ARZ3NDEKTSV4RRFFQ69G5FAV', { kind: 'summary', sender: 'gw', content: 'x' }),
    /派生元が見つかりません/,
  );
});

test('知らない kind と文字列でない content は拒否する', () => {
  const c = new Corpus({ dir: tmp() });
  assert.throws(() => c.append({ kind: 'unknown_kind', sender: 'x', content: 'a' }), /知らない kind/);
  assert.throws(() => c.append({ kind: 'user_turn', sender: 'x', content: { a: 1 } }), /文字列で渡して/);
  assert.throws(() => c.append({ kind: 'user_turn', sender: '', content: 'a' }), /sender/);
});

test('索引が壊れていても全走査で読める（安全側への縮退）', () => {
  const dir = tmp();
  const c = new Corpus({ dir });
  const rec = c.append({ kind: 'user_turn', sender: 'daigo', content: '索引を壊す' });
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.idx')) fs.writeFileSync(path.join(dir, f), 'ゴミ\txxx\tyyy\n');
  }
  const c2 = new Corpus({ dir });
  assert.equal(c2.get(rec.record_id).content, '索引を壊す');
});

test('途中の行が壊れていても、他の行は読める', () => {
  const dir = tmp();
  const c = new Corpus({ dir });
  const a = c.append({ kind: 'user_turn', sender: 'x', content: '1件目' });
  const seg = c.segmentPath(Corpus.segmentOf(Date.now()));
  fs.appendFileSync(seg, '{壊れたJSON\n');
  const b = c.append({ kind: 'user_turn', sender: 'x', content: '3件目' });
  const all = [...c.read()];
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((r) => r.content), ['1件目', '3件目']);
  assert.ok(c.get(a.record_id) && c.get(b.record_id));
});

test('派生をたどって原文まで戻れる', () => {
  const c = new Corpus({ dir: tmp() });
  const raw = c.append({ kind: 'fetched_data', sender: 'web', content: '原文' });
  const filtered = c.appendDerived(raw.record_id, { kind: 'fetched_data', sender: '耳A', content: '整えた' });
  const sum = c.appendDerived(filtered.record_id, { kind: 'summary', sender: 'gw', content: '要約' });
  assert.deepEqual(c.lineage(sum.record_id).map((r) => r.content), ['要約', '整えた', '原文']);
});

test('要約は source_range が無いと作れない（§5.2）', () => {
  const c = new Corpus({ dir: tmp() });
  const a = c.append({ kind: 'user_turn', sender: 'x', content: 'あ' });
  const b = c.append({ kind: 'user_turn', sender: 'x', content: 'い' });
  const content = makeSummaryContent({ text: 'まとめ', sourceFromId: a.record_id, sourceToId: b.record_id, sourceCount: 2 });
  const parsed = parseSummaryContent(content);
  assert.equal(parsed.source_range.from, a.record_id);
  assert.throws(() => makeSummaryContent({ text: '', sourceFromId: a.record_id, sourceToId: b.record_id }), /要約が空/);
  assert.throws(() => makeSummaryContent({ text: 'x', sourceFromId: b.record_id, sourceToId: a.record_id }), /順序が逆/);
});

test('kind と sender で絞り込める', () => {
  const c = new Corpus({ dir: tmp() });
  c.append({ kind: 'user_turn', sender: 'daigo', content: 'a' });
  c.append({ kind: 'assistant_turn', sender: 'model', content: 'b' });
  c.append({ kind: 'assistant_turn', sender: 'model', content: 'c' });
  assert.equal([...c.read({ kinds: ['assistant_turn'] })].length, 2);
  assert.equal([...c.read({ sender: 'daigo' })].length, 1);
  assert.equal(c.tail(2).length, 2);
});
