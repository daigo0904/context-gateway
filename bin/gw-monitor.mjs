#!/usr/bin/env node
// 監視を回して記録する — §9 手順3
//
//   node bin/gw-monitor.mjs [--out 記録先.jsonl] [--interval 1000] [--quiet] [--judge]
//
// 既定では何も止めないし何も消さない。1秒ごとに数字を並べるだけ。
// --judge を付けると §6.3 の判定も一緒に表示するが、それでも介入はしない。

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Monitor, PHASE } from '../lib/monitor.mjs';
import { PressureJudge, STATE } from '../lib/judge.mjs';
import { discoverBackend } from '../lib/backend.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const quiet = Boolean(arg('quiet', false));
const withJudge = Boolean(arg('judge', false));
const interval = Number(arg('interval', 1000));
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outPath = arg('out', path.join(ROOT, '計測の記録', '監視', `${stamp}.jsonl`));

const be = await discoverBackend({ force: true });
if (!be.ok) {
  console.error(`推論サーバが見つかりません（${be.reason}）。ollama が動いていない可能性があります。`);
  console.error('監視は続けます。取得できないことも記録として残ります。');
} else {
  console.error(`推論サーバ: pid=${be.pid} ${be.host}:${be.port} 文脈=${be.ctx}`);
}
console.error(`記録先: ${outPath}`);
console.error('止めるには Ctrl-C。\n');

const judge = withJudge ? new PressureJudge({ enabled: false }) : null;
let lastForcing = 0;

const monitor = new Monitor({
  intervalMs: interval,
  outPath,
  onWarn: (w) => console.error(`\n[警告] ${w.message}`),
  onSample: (s) => {
    if (judge) {
      const r = judge.update({
        at: s.at,
        poolRatio: s.pool.ok ? s.pool.ratio : null,
        tpsRatio: s.tps_vs_baseline,
        unknown: s.unknown,
        assumeHigh: s.assume_high,
      });
      if (r.changed) console.error(`\n[判定] ${r.state} — ${r.reason}`);
    }
    if (s.pool.ok && s.pool.forcingTotal > lastForcing) {
      const d = s.pool.forcingTotal - lastForcing;
      lastForcing = s.pool.forcingTotal;
      console.error(`\n[事象] 前処理のやり直しが ${d} 回発生（累計 ${s.pool.forcingTotal}）`);
    }
    if (quiet) return;

    const pool = s.pool.ok
      ? `${(s.pool.ratio * 100).toFixed(1)}% (${s.pool.prompts}件${s.pool.stale ? '/古' : ''})`
      : `取得失敗:${s.pool.reason}`;
    const hit = s.slots.ok && s.slots.cache_hit_rate !== null
      ? `${(s.slots.cache_hit_rate * 100).toFixed(0)}%`
      : (s.slots.ok ? '—' : 'NG');
    const ctx = s.slots.ok ? `${(s.slots.ctx_use_rate * 100).toFixed(1)}%` : 'NG';
    const tps = s.tps !== null ? `${s.tps.toFixed(1)}` : '—';
    const base = s.baseline_tps !== null ? `${s.baseline_tps.toFixed(1)}` : '未定';
    const st = judge ? ` 判定=${judge.state}` : '';
    process.stderr.write(
      `\r${s.t.slice(11, 19)} ${String(s.phase ?? '不明').padEnd(7)} プール圧=${pool.padEnd(20)} 命中=${hit.padEnd(4)} 文脈=${ctx.padEnd(6)} tok/s=${tps.padEnd(6)} 基準=${base}${st}   `,
    );
  },
});

monitor.start();

function finish() {
  monitor.stop();
  const snap = monitor.snapshot();
  console.error('\n\n--- まとめ ---');
  console.error(`標本数: ${snap.samples}（${Math.round(snap.uptimeMs / 1000)}秒）`);
  console.error(`基準 tok/s: ${snap.baseline_tps === null ? '決まらなかった（生成が観測されていない）' : snap.baseline_tps.toFixed(2)}`);
  console.error(`decode 平均 tok/s: ${snap.decode_tps_avg32 === null ? '—' : snap.decode_tps_avg32.toFixed(2)}`);
  console.error(`prefill 平均 tok/s: ${snap.prefill_tps_avg32 === null ? '—' : snap.prefill_tps_avg32.toFixed(2)}`);
  console.error(`取得失敗: /slots ${snap.slots.failures}回 / ログ ${snap.pool.failures}回`);
  if (judge) console.error(`判定の遷移: ${judge.snapshot().transitions}回`);
  console.error(`記録: ${outPath}`);
  process.exit(0);
}

process.on('SIGINT', finish);
process.on('SIGTERM', finish);
