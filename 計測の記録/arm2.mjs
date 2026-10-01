// 本計測アーム（Step C 用）。arm.mjs との違いは3つ。
//
//  1. 汚染を**その場で**検知して中断する（事後に全部捨てるのを避ける）
//     GIN 行は完了時に書かれるので、自分の呼び出しが返った直後は
//     「ログの推論リクエスト件数 == 自分の件数」でなければならない。
//     超えていれば外から誰かが叩いている＝このアームは無効。
//  2. 読ませるファイルを25本の実在ファイルに広げる（同じ12本を巡ると
//     モデルが履歴から答えてしまい、道具を呼ばなくなって文脈が伸びない）
//  3. 圧縮の閾値（compactAtRatio）を引数で受ける
import { Agent } from '/Users/USER/コーディングCLI/src/agent.mjs';
import { PermissionManager } from '/Users/USER/コーディングCLI/src/permissions.mjs';
import { DEFAULT_CONFIG } from '/Users/USER/コーディングCLI/src/config.mjs';
import { inferenceCalls } from './oll.mjs';

const root = '/Users/USER/コーディングCLI';
const arm = process.argv[2];
const turns = Number(process.argv[3] || 40);
const offset = Number(process.argv[4] || 0);          // 計測開始時のログ位置
const ratio = Number(process.argv[5] || 0.7);
if (!['none', 'every', 'new'].includes(arm)) { console.error('arm は none/every/new'); process.exit(2); }

const config = {
  ...DEFAULT_CONFIG,
  autoApprove: true, keepAlive: -1, numCtx: 65536,
  showThinking: 'off', showTiming: false,
  temperature: 0,
  maxToolChars: 4000,                     // 3アーム共通
  compactAtRatio: ratio,                  // 3アーム共通
  shrinkOldToolOutput: arm !== 'none'
};

class EveryTurn extends Agent {
  async runTurn(input, images) {
    for (const m of this.messages) if (m.frozen) delete m.frozen;
    this.compactToolOutputOnce();
    return super.runTurn(input, images);
  }
}
const Klass = arm === 'every' ? EveryTurn : Agent;
const agent = new Klass({ config, root, permissions: new PermissionManager(config, async () => 'y') });

const rows = [];
let ownCalls = 0;
let contaminated = null;

const orig = agent.streamAssistant.bind(agent);
agent.streamAssistant = async (progress) => {
  let toolOut = 0, total = 0;
  for (const m of agent.messages) {
    const n = (m.content || '').length + (m.thinking || '').length;
    total += n;
    if (m.role === 'tool') toolOut += n;
  }
  const t0 = Date.now();
  const res = await orig(progress);
  ownCalls++;
  rows.push({
    step: rows.length + 1, toolOut, totalChars: total,
    promptTokens: res.stats?.promptTokens ?? 0,
    promptMs: res.stats?.promptMs ?? 0,
    evalMs: res.stats?.evalMs ?? 0,
    outTokens: res.stats?.outputTokens ?? 0,
    wallMs: Date.now() - t0,
    tool: res.toolCalls?.[0]?.name ?? '(end)'
  });

  // ── 汚染の即時判定 ───────────────────────────────
  // ログの書き込みは自分の応答完了よりわずかに遅れることがあるので、
  // 件数が足りない側は少し待って読み直す。多い側は待っても減らない。
  let seen = inferenceCalls(offset);
  for (let i = 0; i < 10 && seen.count < ownCalls; i++) {
    await new Promise((r) => setTimeout(r, 200));
    seen = inferenceCalls(offset);
  }
  if (seen.count > ownCalls) {
    const ownSec = rows.reduce((a, r) => a + r.wallMs, 0) / 1000;
    contaminated = {
      atStep: rows.length,
      logCalls: seen.count, ownCalls,
      foreignCalls: seen.count - ownCalls,
      logSeconds: +seen.seconds.toFixed(1),
      ownSeconds: +ownSec.toFixed(1),
      overheadPct: +(((seen.seconds - ownSec) / ownSec) * 100).toFixed(1)
    };
    const e = new Error('CONTAMINATED');
    e.contaminated = contaminated;
    throw e;
  }
  return res;
};

const files = ['agent.mjs','tools.mjs','ollama.mjs','prompt.mjs','lsp.mjs','web.mjs',
               'ui.mjs','config.mjs','browser.mjs','mcp.mjs','harness.mjs','edits.mjs',
               'smalltalk.mjs','permissions.mjs','embed.mjs','rules.mjs','mentions.mjs',
               'effort.mjs','skills.mjs','complete.mjs','subagent.mjs','commands.mjs',
               'session.mjs','paste.mjs','paths.mjs'];

const t0 = Date.now();
let stopped = null;
try {
  for (let i = 0; i < turns; i++) {
    const f = files[i % files.length];
    await agent.runTurn(`src/${f} を read_file で読んで、何をしているファイルか2行で説明して`);
    if (rows.length && rows[rows.length - 1].promptTokens > 60000) { stopped = 'ctx'; break; }
  }
} catch (err) {
  if (!err.contaminated) throw err;
  stopped = 'contaminated';
}

console.log('\n@@RESULT@@');
console.log(JSON.stringify({
  arm, ratio, turnsAsked: turns, steps: rows.length,
  valid: !contaminated,
  contaminated, stopped,
  wallMs: Date.now() - t0,
  compactedEvents: agent.compactedEvents || 0,
  finalTokens: rows.length ? rows[rows.length - 1].promptTokens : 0,
  rows
}, null, 0));
if (contaminated) process.exit(3);
