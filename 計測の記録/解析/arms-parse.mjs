// 9/3 のアームログ（llama-server の生ログ）から、実際に送られたトークンと時間を取り出す。
//
// なぜこのログなのか：
//   qwc のセッション記録（~/.qwythos-code/sessions/*.json）は**圧縮後の履歴**を保存する。
//   道具出力は既に短くされていて（`…[古い出力のため省略]`）、実際に送った量ではない。
//   「何トークン送ったか」を知りたいなら、推論サーバ側のログしかない。
//
// 1リクエストから取れるもの：
//   task.n_tokens        送った総トークン
//   cached n_tokens      キャッシュから再利用できた分
//   prompt eval time     実際に処理し直したトークン数と、その時間
//   eval time            生成したトークン数と、その時間
//
// 使い方: node arms-parse.mjs ../arms/r1-none.log
import fs from 'node:fs';

const RE = {
  newPrompt: /task (\d+) \| new prompt, n_ctx_slot = \d+, n_keep = \d+, task\.n_tokens = (\d+)/,
  forcing:   /task (\d+) \| forcing full prompt re-processing/,
  peval:     /task (\d+) \| prompt eval time =\s+([\d.]+) ms \/\s+(\d+) tokens/,
  eval:      /task (\d+) \|\s+eval time =\s+([\d.]+) ms \/\s+(\d+) tokens/,
};

export function parseArmLog(path) {
  const reqs = new Map();
  const order = [];
  for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
    let m = RE.newPrompt.exec(line);
    if (m) {
      reqs.set(m[1], { task: m[1], promptTokens: +m[2], forcing: false, pevalMs: 0, pevalTok: 0, evalMs: 0, evalTok: 0 });
      order.push(m[1]);
      continue;
    }
    m = RE.forcing.exec(line);
    if (m && reqs.has(m[1])) { reqs.get(m[1]).forcing = true; continue; }
    m = RE.peval.exec(line);
    if (m && reqs.has(m[1])) { const r = reqs.get(m[1]); r.pevalMs = +m[2]; r.pevalTok = +m[3]; continue; }
    m = RE.eval.exec(line);
    if (m && reqs.has(m[1])) { const r = reqs.get(m[1]); r.evalMs = +m[2]; r.evalTok = +m[3]; }
  }
  return order.map((t) => reqs.get(t));
}

if (process.argv[2]) {
  const reqs = parseArmLog(process.argv[2]);
  const sum = (f) => reqs.reduce((a, r) => a + f(r), 0);
  const sent = sum((r) => r.promptTokens), proc = sum((r) => r.pevalTok);
  console.log(`手数 ${reqs.length} / 送信 ${sent.toLocaleString()}tok / 再処理 ${proc.toLocaleString()}tok ` +
    `(再利用 ${((1 - proc / sent) * 100).toFixed(1)}%)`);
  console.log(`前処理 ${(sum((r) => r.pevalMs) / 1000).toFixed(1)}秒 / 生成 ${(sum((r) => r.evalMs) / 1000).toFixed(1)}秒 ` +
    `/ やり直し ${reqs.filter((r) => r.forcing).length}回`);
}
