// Step A: 圧縮(compactToolOutputOnce)の発火動作確認。**計測ではない。**
//
// 目的は3つだけ:
//   1. compactedEvents > 0 になるか
//   2. 発火の前後で prompt token がどう動くか
//   3. 発火した次の呼び出しで full re-prefill（前処理の跳ね上がり）が起きるか
//
// 汚染は許容する（他のセッションが ollama を使っていてよい）。
// そのかわり本計測では使わない数値であることを、出力に明記する。
import { Agent } from '/Users/USER/コーディングCLI/src/agent.mjs';
import { PermissionManager } from '/Users/USER/コーディングCLI/src/permissions.mjs';
import { DEFAULT_CONFIG } from '/Users/USER/コーディングCLI/src/config.mjs';

const root = '/Users/USER/コーディングCLI';
const ratio = Number(process.argv[2] || 0.11);
const turns = Number(process.argv[3] || 12);

const config = {
  ...DEFAULT_CONFIG,
  autoApprove: true, keepAlive: -1, numCtx: 65536,
  showThinking: 'off', showTiming: false,
  temperature: 0,
  maxToolChars: 4000,
  shrinkOldToolOutput: true,
  compactAtRatio: ratio            // ← ここだけ下げて、短い手数で閾値に触れさせる
};
const limit = Math.floor(config.numCtx * config.compactAtRatio);

// agent.mjs の estimateTokens と同じ数え方（文字数÷3、メッセージのみ）。
// system プロンプトと道具定義は含まれない。閾値判定はこの数で行われる。
const est = (messages) => {
  let chars = 0;
  for (const m of messages) {
    chars += (m.content || '').length + (m.thinking || '').length;
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
  }
  return Math.ceil(chars / 3);
};

const agent = new Agent({ config, root, permissions: new PermissionManager(config, async () => 'y') });

const rows = [];
const events = [];

// 発火を捕まえる
const origCompact = agent.maybeCompact.bind(agent);
agent.maybeCompact = async () => {
  const before = est(agent.messages);
  const beforeEvents = agent.compactedEvents || 0;
  await origCompact();
  const after = est(agent.messages);
  if ((agent.compactedEvents || 0) > beforeEvents || after !== before) {
    events.push({ atStep: rows.length + 1, before, after, limit,
                  events: agent.compactedEvents || 0 });
  }
};

const origStream = agent.streamAssistant.bind(agent);
agent.streamAssistant = async (progress) => {
  const e = est(agent.messages);
  const t0 = Date.now();
  const res = await origStream(progress);
  rows.push({
    step: rows.length + 1,
    est: e,
    promptTokens: res.stats?.promptTokens ?? 0,
    promptMs: res.stats?.promptMs ?? 0,
    evalMs: res.stats?.evalMs ?? 0,
    wallMs: Date.now() - t0,
    tool: res.toolCalls?.[0]?.name ?? '(end)'
  });
  return res;
};

const files = ['agent.mjs','tools.mjs','ollama.mjs','prompt.mjs','lsp.mjs','web.mjs',
               'ui.mjs','config.mjs','browser.mjs','mcp.mjs','harness.mjs','edits.mjs',
               'smalltalk.mjs','permissions.mjs','embed.mjs','rules.mjs','mentions.mjs',
               'effort.mjs','skills.mjs','complete.mjs','subagent.mjs','commands.mjs',
               'session.mjs','paste.mjs','paths.mjs'];

const t0 = Date.now();
for (let i = 0; i < turns; i++) {
  const f = files[i % files.length];
  await agent.runTurn(`src/${f} を read_file で読んで、何をしているファイルか2行で説明して`);
}
console.log('\n@@PROBE@@');
console.log(JSON.stringify({
  ratio, limit, turns,
  compactedEvents: agent.compactedEvents || 0,
  events, wallMs: Date.now() - t0, rows
}, null, 0));
