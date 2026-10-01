import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PoolLogReader, STATE_SIZE_MODEL } from '../lib/poollog.mjs';

function tmpLog(lines = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-log-'));
  const p = path.join(dir, 'ollama.log');
  fs.writeFileSync(p, lines.join('\n') + (lines.length ? '\n' : ''));
  return p;
}

const CACHE = (prompts, mib) =>
  `srv        update:  - cache state: ${prompts} prompts, ${mib} MiB (limits: 8192.000 MiB, 65536 tokens, 208383 est)`;
const SAVE = (len, mib) =>
  `srv   prompt_save:  - saving prompt with length ${len}, total state size = ${mib} MiB (draft: 0.000 MiB)`;
const PER = (addr, tok, ckpt, mib) =>
  `srv        update:    - prompt ${addr}: ${tok} tokens, checkpoints:  ${ckpt}, ${mib} MiB`;

test('1リクエストごとの prompt_save を拾う', () => {
  const p = tmpLog([SAVE(20248, '316.587'), CACHE(21, '6035.065')]);
  const r = new PoolLogReader({ path: p, fromStart: true });
  const s = r.poll();
  assert.equal(s.saveCount, 1);
  assert.equal(s.lastSave.tokens, 20248);
  assert.equal(s.lastSave.stateMiB, 316.587);
});

test('プールの内訳一覧を拾い、合計が cache state と一致する', () => {
  const p = tmpLog([
    CACHE(3, '300.0'),
    PER('0xaaa', 10896, 1, '100.0'),
    PER('0xbbb', 93, 1, '50.0'),
    PER('0xccc', 28378, 4, '150.0'),
    'srv  update_slots: all slots are idle',
  ]);
  const r = new PoolLogReader({ path: p, fromStart: true });
  const s = r.poll();
  assert.equal(s.promptCount, 3);
  assert.equal(s.prompts, 3, 'cache state 行が言う本数は別フィールドのまま');
  const sum = s.promptList.reduce((a, x) => a + x.stateMiB, 0);
  assert.equal(sum, 300.0, '内訳の合計が cache state の合計と一致する');
  assert.equal(s.promptList[2].checkpoints, 4);
});

test('cache state の行から圧力を読む', () => {
  const p = tmpLog([CACHE(20, '5714.027')]);
  const r = new PoolLogReader({ path: p, fromStart: true });
  const s = r.poll();
  assert.equal(s.ok, true);
  assert.equal(s.prompts, 20);
  assert.equal(s.usedMiB, 5714.027);
  assert.equal(s.limitMiB, 8192);
  assert.ok(Math.abs(s.ratio - 5714.027 / 8192) < 1e-9);
});

test('読めなかったとき 0 を返さない（§7.5）', () => {
  const p = tmpLog(['なにか別の行', 'また別の行']);
  const r = new PoolLogReader({ path: p, fromStart: true, seedBytes: 0 });
  const s = r.poll();
  assert.equal(s.ok, false);
  assert.equal(s.reason, 'never_seen');
  assert.equal(s.ratio, undefined, '比率を 0 として返してはいけない');
});

test('ログが無いときも失敗として返す', () => {
  const r = new PoolLogReader({ path: '/存在しない/ollama.log' });
  const s = r.poll();
  assert.equal(s.ok, false);
  assert.equal(s.reason, 'log_unreadable');
});

test('書式が変わったら失敗になる（値0にならない）', () => {
  // フィールド名が変わった想定
  const p = tmpLog(['srv update: - cache stats: 20 entries, 5714 MB']);
  const r = new PoolLogReader({ path: p, fromStart: true, seedBytes: 0 });
  assert.equal(r.poll().ok, false);
});

test('増えた分だけを読む', () => {
  const p = tmpLog([CACHE(10, '1000.0')]);
  const r = new PoolLogReader({ path: p, fromStart: true });
  assert.equal(r.poll().prompts, 10);
  fs.appendFileSync(p, CACHE(30, '7000.0') + '\n');
  const s = r.poll();
  assert.equal(s.prompts, 30);
  assert.equal(s.fresh, true);
});

test('前処理のやり直しを数える', () => {
  const p = tmpLog([CACHE(10, '1000.0')]);
  const r = new PoolLogReader({ path: p, fromStart: true });
  r.poll();
  fs.appendFileSync(p, 'srv: forcing full prompt re-processing\n' + CACHE(11, '1100.0') + '\n');
  const s = r.poll();
  assert.equal(s.forcingDelta, 1);
  assert.equal(s.forcingTotal, 1);
});

test('ログが入れ替わっても追随する', () => {
  const p = tmpLog([CACHE(10, '1000.0')]);
  const r = new PoolLogReader({ path: p, fromStart: true });
  r.poll();
  fs.rmSync(p);
  fs.writeFileSync(p, CACHE(1, '100.0') + '\n');
  const s = r.poll();
  assert.equal(s.ok, true);
  assert.equal(s.prompts, 1);
});

test('起動時に拾った値は「古い」印が付く', () => {
  const p = tmpLog([CACHE(20, '5000.0')]);
  const r = new PoolLogReader({ path: p });
  const s = r.poll();
  assert.equal(s.ok, true);
  assert.equal(s.seeded, true);
  assert.equal(s.stale, true, '拾った値の鮮度は不明なので古い扱いにする');
});

// ollama.log の prompt_save 行から直接取った17点（2026-09-05）。
// 前のセッションの報告を写したものではなく、ログを読み直して集めた。
const REAL_POINTS = [
  [17, 1.941], [252, 28.769], [2813, 135.482], [3191, 139.409], [3493, 142.546],
  [4617, 154.221], [4764, 155.748], [5935, 167.912], [7050, 179.494],
  [14761, 259.591], [20248, 316.587], [20355, 317.698], [20691, 321.189],
  [20736, 321.656], [20885, 323.204], [20936, 323.733], [21044, 324.855],
];

test('状態サイズの式が実測17点すべてに合う', () => {
  for (const [tok, actual] of REAL_POINTS) {
    const est = STATE_SIZE_MODEL.estimateMiB(tok);
    assert.ok(Math.abs(est - actual) < 0.01, `${tok}tok: 予測${est.toFixed(3)} 実測${actual}`);
  }
});

test('古い式（106.262 + 10.64KiB×tok）は短いプロンプトで大きく外れる', () => {
  // この試験は「直したことが本物か」を固定するために置いてある。
  // 古い式は 2,000トークン以上だけで直線を引いたので、切片を定数と読み違えていた。
  const old = (tok) => 106.262 + (10.64 * tok) / 1024;
  assert.ok(old(17) - 1.941 > 100, '17トークンで100 MiB以上ずれる');
  assert.ok(old(252) - 28.769 > 75, '252トークンで75 MiB以上ずれる');
  // 大きいところでは両方合う。だから大きい点だけ見ていると気づけない。
  assert.ok(Math.abs(old(20355) - 317.698) < 0.1);
});

test('106.262 MiB は定数ではなく SWA窓（1024トークン）が埋まった値', () => {
  const m = STATE_SIZE_MODEL;
  assert.equal(m.swaWindowTokens, 1024);
  // 窓が埋まる直前まではトークン数に比例して増える
  assert.ok(m.estimateMiB(512) < m.estimateMiB(1024) * 0.6);
  // 埋まった後の増え方は10分の1になる
  const beforeCap = m.estimateMiB(1000) - m.estimateMiB(999);
  const afterCap = m.estimateMiB(2000) - m.estimateMiB(1999);
  assert.ok(beforeCap / afterCap > 10, `窓の中と外で${(beforeCap / afterCap).toFixed(1)}倍違う`);
});

test('丸ごと追い出すのと、縮めるのは桁が違う', () => {
  const m = STATE_SIZE_MODEL;
  // 20,000トークンを丸ごと追い出すと 314 MiB 浮く
  assert.ok(Math.abs(m.evictMiB(20000) - 314.0) < 1);
  // 半分に縮めても 104 MiB しか浮かない（窓の分は残るため）
  assert.ok(Math.abs(m.shrinkMiB(20000, 10000) - 103.9) < 1);
  assert.ok(m.evictMiB(20000) > m.shrinkMiB(20000, 10000) * 3);
});
