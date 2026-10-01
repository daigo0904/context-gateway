import test from 'node:test';
import assert from 'node:assert/strict';
import { PressureJudge, STATE, PROVISIONAL_THRESHOLDS, formatNotice } from '../lib/judge.mjs';

function feed(j, values, { start = 0, stepMs = 1000 } = {}) {
  let at = start;
  let last;
  for (const v of values) {
    at += stepMs;
    last = j.update({ at, poolRatio: v });
  }
  return { last, at };
}

test('単発の跳ねでは発動しない（3回連続が要る §6.3）', () => {
  const j = new PressureJudge();
  feed(j, [0.80, 0.50, 0.80, 0.50]);
  assert.equal(j.state, STATE.NORMAL);
});

test('3回続けば PRESSURE へ', () => {
  const j = new PressureJudge();
  feed(j, [0.80, 0.80, 0.80]);
  assert.equal(j.state, STATE.PRESSURE);
});

test('ヒステリシスが効く：発動閾値を下回っただけでは戻らない', () => {
  const j = new PressureJudge();
  const a = feed(j, [0.80, 0.80, 0.80]);
  // 74% は発動閾値(75%)を下回っているが、復帰閾値(55%)には届かない
  feed(j, [0.74, 0.74, 0.74, 0.74, 0.74], { start: a.at + 60_000 });
  assert.equal(j.state, STATE.PRESSURE, '単一閾値の実装ならここで NORMAL に戻ってしまう');
});

test('復帰閾値を下回れば戻る（クールダウン後）', () => {
  const j = new PressureJudge();
  const a = feed(j, [0.80, 0.80, 0.80]);
  feed(j, [0.50, 0.50, 0.50], { start: a.at + 60_000 });
  assert.equal(j.state, STATE.NORMAL);
});

test('発動直後30秒は戻さない（クールダウン §6.3）', () => {
  const j = new PressureJudge();
  feed(j, [0.80, 0.80, 0.80]);
  feed(j, [0.30, 0.30, 0.30, 0.30, 0.30]); // 直後に急落しても
  assert.equal(j.state, STATE.PRESSURE);
});

test('90%超で CRITICAL、生成速度の急落でも CRITICAL', () => {
  const a = new PressureJudge();
  feed(a, [0.80, 0.80, 0.80, 0.95]);
  assert.equal(a.state, STATE.CRITICAL);

  const b = new PressureJudge();
  feed(b, [0.80, 0.80, 0.80]);
  b.update({ at: 100_000, poolRatio: 0.80, tpsRatio: 0.4 });
  assert.equal(b.state, STATE.CRITICAL);
});

test('圧力が取れないとき、状態を下げない（§7.5）', () => {
  const j = new PressureJudge();
  feed(j, [0.80, 0.80, 0.80]);
  for (let i = 0; i < 10; i++) j.update({ at: 100_000 + i * 1000, poolRatio: null });
  assert.equal(j.state, STATE.PRESSURE, '取得失敗を「圧力なし」と読んではいけない');
});

test('連続して取れないときは、保守的に PRESSURE とみなす（§7.5）', () => {
  const j = new PressureJudge();
  assert.equal(j.state, STATE.NORMAL);
  j.update({ at: 1000, poolRatio: null, assumeHigh: true });
  assert.equal(j.state, STATE.PRESSURE);
});

test('既定では介入できない（§9 手順5 まで動かさない）', () => {
  const j = new PressureJudge();
  const { last } = feed(j, [0.95, 0.95, 0.95, 0.95]);
  assert.equal(last.canFire, false);

  const k = new PressureJudge({ enabled: true });
  const r = feed(k, [0.95, 0.95, 0.95, 0.95]);
  assert.equal(r.last.canFire, true);
});

test('閾値は仮の値であると明示されている', () => {
  assert.equal(PROVISIONAL_THRESHOLDS.provisional, true);
  // 発動と復帰は20ポイント離す（§6.3）
  assert.ok(PROVISIONAL_THRESHOLDS.enter - PROVISIONAL_THRESHOLDS.recover >= 0.199);
});

test('発動をユーザーに見せる文が作れる（§6.5）', () => {
  const s = formatNotice({ turns: 12, records: 34, savedMiB: 212 });
  assert.ok(s.includes('12ターン'));
  assert.ok(s.includes('残っています'));
});
