// 3アーム対照計測。アームは第1引数（none / every / new）、手数は第2引数。
//
// 条件（外すと測定が無効になる）:
//   ・同一タスク・同一ファイル・temperature 0
//   ・アームの前に ollama を再起動して prompt cache を空にする（呼び出し側の責任）
//   ・maxToolChars は3アーム共通（4000）。ここを変えると shrink の効果と混ざる
import { Agent } from '/Users/USER/コーディングCLI/src/agent.mjs';
import { PermissionManager } from '/Users/USER/コーディングCLI/src/permissions.mjs';
import { DEFAULT_CONFIG } from '/Users/USER/コーディングCLI/src/config.mjs';

const root = '/Users/USER/コーディングCLI';
const arm = process.argv[2];
const steps = Number(process.argv[3] || 40);
if (!['none', 'every', 'new'].includes(arm)) { console.error('arm は none/every/new'); process.exit(2); }

const config = {
  ...DEFAULT_CONFIG,
  autoApprove: true, keepAlive: -1, numCtx: 65536,
  showThinking: 'off', showTiming: false,
  temperature: 0,
  maxToolChars: 4000,                     // 3アーム共通
  shrinkOldToolOutput: arm !== 'none'     // none は圧縮そのものを止める
};

// every = 旧挙動の再現。毎ターン、確定印を無視して古い出力を書き換える。
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
  rows.push({
    step: rows.length + 1, toolOut, totalChars: total,
    promptTokens: res.stats?.promptTokens ?? 0,
    promptMs: res.stats?.promptMs ?? 0,
    evalMs: res.stats?.evalMs ?? 0,
    outTokens: res.stats?.outputTokens ?? 0,
    wallMs: Date.now() - t0,
    tool: res.toolCalls?.[0]?.name ?? '(end)'
  });
  return res;
};

// 手順を固定する。同じ順で同じファイルを読ませる。
const files = ['agent.mjs','tools.mjs','ollama.mjs','config.mjs','ui.mjs','web.mjs',
               'prompt.mjs','permissions.mjs','session.mjs','tools.mjs','agent.mjs','edits.mjs'];
const t0 = Date.now();
for (let i = 0; i < steps; i++) {
  const f = files[i % files.length];
  await agent.runTurn(`src/${f} を読んで、何をしているファイルか2行で説明して`);
  if (rows.length && rows[rows.length - 1].promptTokens > 60000) break;   // 文脈が尽きる前で止める
}
console.log('\n@@RESULT@@');
console.log(JSON.stringify({
  arm, steps: rows.length, wallMs: Date.now() - t0,
  compactedEvents: agent.compactedEvents || 0,
  finalTokens: rows.length ? rows[rows.length - 1].promptTokens : 0,
  rows
}, null, 0));
