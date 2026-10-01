// フェイルセーフの試験 — 仕様 §9.2
//
// 第7章の機構は、正常系の試験では一度も発現しない。
// 「動いているように見えて実は動いていない」を捕まえるには、意図的に壊すしかない。
//
// いま実装がある範囲（§9 手順3まで）で試験できるのは §7.5（監視の失敗）。
// §7.6（要約の失敗）と §5.3（要約中の中断）は Layer 3 の実装後に追加する。

import test from 'node:test';
import assert from 'node:assert/strict';
import { Monitor } from '../lib/monitor.mjs';
import { _resetBackendCache } from '../lib/backend.mjs';

// 処理中の slot。is_processing: false にすると命中率は null になる（実機がそうなので）。
const SLOT_OK = [{
  id: 0, n_ctx: 65536, is_processing: true, id_task: 1,
  n_prompt_tokens: 1000, n_prompt_tokens_cache: 800, n_prompt_tokens_processed: 200,
  next_token: [{ n_decoded: 5 }],
}];

function fakeFetch(behaviour) {
  return async () => {
    const b = behaviour();
    if (b === 'throw') throw new Error('接続できません');
    return { ok: true, json: async () => b };
  };
}

async function runMonitor(monitor, ms) {
  monitor.start();
  await new Promise((r) => setTimeout(r, ms));
  monitor.stop();
}

test('監視エンドポイントが死んでいると警告が出る（§7.5 / §9.2）', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch(() => 'throw');
  _resetBackendCache();
  const warns = [];
  const samples = [];
  const m = new Monitor({
    intervalMs: 40,
    logPath: '/存在しないログ/ollama.log',
    channel: { warnAfter: 2, conservativeAfter: 4 },
    onWarn: (w) => warns.push(w),
    onSample: (s) => samples.push(s),
  });
  try {
    await runMonitor(m, 450);
  } finally {
    globalThis.fetch = realFetch;
    _resetBackendCache();
  }

  assert.ok(samples.length >= 3, `標本が取れている(${samples.length})`);
  assert.ok(warns.some((w) => w.code === 'slots_unavailable'), '/slots の失敗が警告される');
  assert.ok(warns.some((w) => w.code === 'pool_unavailable'), 'ログの失敗が警告される');

  for (const s of samples) {
    assert.equal(s.slots.ok, false);
    assert.equal(s.pool.ok, false);
    // ここが本題。取得できなかったものを 0 として報告してはいけない。
    assert.equal(s.slots.ctx_use_rate, undefined, 'KV使用率を0として報告していない');
    assert.equal(s.pool.ratio, undefined, 'プール圧を0として報告していない');
    assert.equal(s.unknown, true, '「不明」であることが記録に残る');
  }
  assert.ok(samples[samples.length - 1].assume_high, '失敗が続いたら保守的に「高い」とみなす');
});

test('取得できていたものが取れなくなったら、直前の値を保持する（§7.5）', async () => {
  const realFetch = globalThis.fetch;
  let alive = true;
  globalThis.fetch = fakeFetch(() => (alive ? SLOT_OK : 'throw'));
  _resetBackendCache();
  const samples = [];
  const m = new Monitor({
    intervalMs: 40,
    logPath: '/存在しないログ/ollama.log',
    onSample: (s) => samples.push(s),
  });
  try {
    m.start();
    await new Promise((r) => setTimeout(r, 200));
    alive = false;
    await new Promise((r) => setTimeout(r, 250));
    m.stop();
  } finally {
    globalThis.fetch = realFetch;
    _resetBackendCache();
  }

  const good = samples.filter((s) => s.slots.ok);
  const bad = samples.filter((s) => !s.slots.ok);
  assert.ok(good.length > 0 && bad.length > 0, `両方の標本が取れている(良${good.length}/不良${bad.length})`);
  assert.equal(good[0].slots.cache_hit_rate, 0.8);
  const held = bad[bad.length - 1];
  assert.ok(held.slots.held, '直前の有効値が保持されている');
  assert.equal(held.slots.held.cache_hit_rate, 0.8);
  assert.ok(held.slots.heldAgeMs > 0, 'いつの値かが分かる');
});

test('応答の形が変わったら「値がない」ではなく「取得失敗」になる（§7.5 最終段落）', async () => {
  const realFetch = globalThis.fetch;
  // 将来のバージョンでフィールド名が変わった想定
  globalThis.fetch = fakeFetch(() => [{ id: 0, ctx_size: 65536, prompt_tokens: 1000 }]);
  _resetBackendCache();
  const samples = [];
  const m = new Monitor({ intervalMs: 40, logPath: '/存在しないログ/x.log', onSample: (s) => samples.push(s) });
  try {
    await runMonitor(m, 150);
  } finally {
    globalThis.fetch = realFetch;
    _resetBackendCache();
  }
  assert.ok(samples.length > 0);
  assert.equal(samples[0].slots.ok, false);
  assert.equal(samples[0].slots.reason, 'field_missing');
});

test('記録先が書けなくても監視は止まらない', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch(() => SLOT_OK);
  _resetBackendCache();
  const samples = [];
  const m = new Monitor({ intervalMs: 40, logPath: '/存在しないログ/x.log', onSample: (s) => samples.push(s) });
  try {
    m.start();
    m._out = 99999; // 使えない書き込み先に差し替える
    await new Promise((r) => setTimeout(r, 150));
    m._out = null;
    m.stop();
  } finally {
    globalThis.fetch = realFetch;
    _resetBackendCache();
  }
  assert.ok(samples.length >= 2, '記録に失敗しても標本は取り続ける');
});

test('処理していないあいだは命中率を数字にしない（§7.5）', async () => {
  const realFetch = globalThis.fetch;
  // 実測で見た形：アイドル中は cache だけ 0 に戻り、n_prompt_tokens は残る
  globalThis.fetch = fakeFetch(() => [{
    id: 0, n_ctx: 65536, is_processing: false, id_task: 1,
    n_prompt_tokens: 4708, n_prompt_tokens_cache: 0, n_prompt_tokens_processed: 0,
    next_token: [{ n_decoded: 8 }],
  }]);
  _resetBackendCache();
  const samples = [];
  const m = new Monitor({ intervalMs: 40, logPath: '/存在しないログ/x.log', onSample: (s) => samples.push(s) });
  try {
    await runMonitor(m, 150);
  } finally {
    globalThis.fetch = realFetch;
    _resetBackendCache();
  }
  assert.ok(samples.length > 0);
  assert.equal(samples[0].slots.ok, true);
  assert.equal(samples[0].slots.cache_hit_rate, null,
    'アイドル中の 0% は「当たらなかった」ではなく「分からない」');
});

test('処理中なら命中率が数字になる', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch(() => [{
    id: 0, n_ctx: 65536, is_processing: true, id_task: 2,
    n_prompt_tokens: 4707, n_prompt_tokens_cache: 4197, n_prompt_tokens_processed: 510,
    next_token: [{ n_decoded: 0 }],
  }]);
  _resetBackendCache();
  const samples = [];
  const m = new Monitor({ intervalMs: 40, logPath: '/存在しないログ/x.log', onSample: (s) => samples.push(s) });
  try {
    await runMonitor(m, 150);
  } finally {
    globalThis.fetch = realFetch;
    _resetBackendCache();
  }
  assert.ok(Math.abs(samples[0].slots.cache_hit_rate - 4197 / 4707) < 1e-9);
});
