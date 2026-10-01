#!/usr/bin/env node
// 監視の記録を集計する — §9 手順4 の判定材料をつくる
//
//   node bin/gw-report.mjs 計測の記録/監視/xxx.jsonl
//
// 出すのは4つ。
//   1. プール圧の推移（枠 8192 MiB に対して何%まで行ったか）
//   2. プロンプトキャッシュの命中率
//   3. decode の tok/s が基準に対してどう動いたか
//   4. 前処理のやり直しが何回起きたか、そのとき圧力はいくつだったか
//
// 手順4 の判定基準（走らせる前に決めておくもの）：
//   前提仮説「圧力が上がると生成が遅くなる」が成り立つなら、
//   forcing の発生時刻の前後で tok/s が落ちているはず。落ちていなければ、
//   この機械では圧縮機構は要らない、という結論になる。

import fs from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('記録ファイルを指定してください'); process.exit(2); }

const samples = [];
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  try { samples.push(JSON.parse(line)); } catch { /* 壊れた行は飛ばす */ }
}
if (!samples.length) { console.error('標本がありません'); process.exit(1); }

const num = (a) => a.filter((v) => typeof v === 'number' && Number.isFinite(v));
const pct = (v) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`);
const stat = (a) => {
  const s = num(a).sort((x, y) => x - y);
  if (!s.length) return null;
  return { n: s.length, min: s[0], max: s[s.length - 1], med: s[Math.floor(s.length / 2)] };
};

const first = samples[0], last = samples[samples.length - 1];
const durSec = (last.at - first.at) / 1000;

const poolOk = samples.filter((s) => s.pool.ok);
const poolFail = samples.length - poolOk.length;
const slotsOk = samples.filter((s) => s.slots.ok);
const slotsFail = samples.length - slotsOk.length;

const poolRatios = stat(poolOk.map((s) => s.pool.ratio));
const hitRates = stat(slotsOk.map((s) => s.slots.cache_hit_rate));
const decode = samples.filter((s) => s.phase === 'decode');
const decodeTps = stat(decode.map((s) => s.tps));
const prefill = samples.filter((s) => s.phase === 'prefill');

console.log(`記録       : ${file}`);
console.log(`期間       : ${first.t} 〜 ${last.t}（${Math.round(durSec)}秒 / ${samples.length}標本）`);
console.log('');
console.log('--- 取得できたか（§7.5：取れなかったものは0ではない） ---');
console.log(`  /slots   : 成功 ${slotsOk.length} / 失敗 ${slotsFail}`);
console.log(`  ログ     : 成功 ${poolOk.length} / 失敗 ${poolFail}`);
if (poolFail > 0) {
  const reasons = {};
  for (const s of samples) if (!s.pool.ok) reasons[s.pool.reason] = (reasons[s.pool.reason] || 0) + 1;
  console.log(`             理由: ${Object.entries(reasons).map(([k, v]) => `${k}×${v}`).join(', ')}`);
}
console.log('');
console.log('--- プール圧（8192 MiB の枠） ---');
// 「読めた」と「新しく読めた」は別。cache state 行はイベント時にしか出ないので、
// 起動時に拾った1つの値を92秒間そのまま表示し続ける、ということが起きる。
// それを黙って通すと、圧力が動いていないのか、見えていないだけなのかが区別できない。
const freshCount = poolOk.filter((s) => s.pool.fresh).length;
const staleCount = poolOk.filter((s) => s.pool.stale).length;
const distinct = new Set(poolOk.map((s) => s.pool.usedMiB)).size;
console.log(`  新しく読めた: ${freshCount}標本 / 古い値のまま: ${staleCount}標本 / 異なる値: ${distinct}種類`);
if (freshCount === 0 && poolOk.length > 0) {
  console.log('  ※ この記録の間、cache state 行は一度も出ていません。');
  console.log('     下の数字は監視を始めた時点で拾った1つの値です。**期間中の圧力は測れていません。**');
}
if (poolRatios) {
  console.log(`  最小 ${pct(poolRatios.min)} / 中央 ${pct(poolRatios.med)} / 最大 ${pct(poolRatios.max)}`);
  const over75 = poolOk.filter((s) => s.pool.ratio > 0.75).length;
  const over90 = poolOk.filter((s) => s.pool.ratio > 0.90).length;
  console.log(`  75%超: ${over75}標本 (${((over75 / poolOk.length) * 100).toFixed(0)}%) / 90%超: ${over90}標本`);
} else console.log('  取得できていません');
console.log('');
console.log('--- プロンプトキャッシュの命中率 ---');
if (hitRates) console.log(`  最小 ${pct(hitRates.min)} / 中央 ${pct(hitRates.med)} / 最大 ${pct(hitRates.max)}`);
else console.log('  取得できていません');
console.log('');
console.log('--- 生成速度 ---');
console.log(`  フェーズ内訳: idle ${samples.filter((s) => s.phase === 'idle').length} / prefill ${prefill.length} / decode ${decode.length} / 不明 ${samples.filter((s) => !s.phase).length}`);
if (decodeTps) {
  console.log(`  decode tok/s : 最小 ${decodeTps.min.toFixed(1)} / 中央 ${decodeTps.med.toFixed(1)} / 最大 ${decodeTps.max.toFixed(1)}`);
  const base = last.baseline_tps;
  console.log(`  基準 tok/s   : ${base === null ? '決まらなかった' : base.toFixed(2)}`);
  if (base) {
    const below = decode.filter((s) => s.tps !== null && s.tps < base * 0.6).length;
    console.log(`  基準の60%未満: ${below}標本 (${((below / decode.length) * 100).toFixed(0)}%)`);
  }
} else console.log('  decode が観測されていません（この記録では生成が走っていない）');
console.log('');
console.log('--- 前処理のやり直し（forcing full prompt re-processing） ---');
const events = samples.filter((s) => s.pool.ok && s.pool.forcingDelta > 0);
console.log(`  発生回数: ${events.length}`);
for (const e of events) {
  console.log(`    ${e.t.slice(11, 19)} プール圧 ${pct(e.pool.ratio)} / 命中率 ${e.slots.ok ? pct(e.slots.cache_hit_rate) : 'NG'} / 直前の decode 平均 ${e.decode_tps_avg32 ? e.decode_tps_avg32.toFixed(1) : '—'} tok/s`);
}
console.log('');
console.log('--- 手順4 の判定 ---');
if (!decodeTps) {
  console.log('  判定できません。この記録には生成が入っていないので、長時間タスクを流し直してください。');
} else if (events.length === 0) {
  console.log('  前処理のやり直しは起きていません。');
  console.log('  この記録の範囲では、圧縮機構が要る証拠は出ていません（より長いタスクが要る）。');
} else {
  console.log(`  やり直しが ${events.length} 回。上の行で、そのときのプール圧と速度が対応しているかを見てください。`);
  console.log('  対応していれば閾値を決める段（手順5）へ。していなければ、原因は別にあります。');
}
