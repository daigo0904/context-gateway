// ollama のログから「誰かが割り込んだか」を判定する共通部品。
// GIN の行は**完了時に**書かれるので、自分の呼び出しが返った直後に数えれば、
// 自分の件数とログの件数は一致するはず。一致しなければ外から誰かが叩いている。
import fs from 'fs';
import { execSync } from 'node:child_process';

export const OLLAMA_LOG = '/opt/homebrew/var/log/ollama.log';

// "1m8s" "31.32s" "1.63ms" "122µs" "2m7s" "1h2m3s" を秒に直す
export function ginDuration(s) {
  let m = /^([\d.]+)(µs|ms|s)$/.exec(s);
  if (m) return parseFloat(m[1]) * { 'µs': 1e-6, ms: 1e-3, s: 1 }[m[2]];
  m = /^(?:(\d+)h)?(?:(\d+)m)?([\d.]+)s$/.exec(s);
  if (m) return (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + parseFloat(m[3]);
  return null;
}

const GIN = /\[GIN\][^|]*\|\s*\d+\s*\|\s*([0-9a-zµ.]+)\s*\|[^|]*\|\s*(\w+)\s+"([^"]+)"/;

// offset バイト目以降の推論リクエスト（POST の chat/generate）を拾う
export function inferenceCalls(offset) {
  let buf;
  try {
    const fd = fs.openSync(OLLAMA_LOG, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.max(0, size - offset);
    buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, offset);
    fs.closeSync(fd);
  } catch { return { count: 0, seconds: 0 }; }

  let count = 0, seconds = 0;
  for (const line of buf.toString('utf8').split('\n')) {
    const m = GIN.exec(line);
    if (!m) continue;
    if (m[2] !== 'POST') continue;
    if (!/\/api\/(chat|generate)|\/v1\/chat\/completions/.test(m[3])) continue;
    const d = ginDuration(m[1]);
    if (d === null) continue;
    count++; seconds += d;
  }
  return { count, seconds };
}

export function logSize() {
  try { return fs.statSync(OLLAMA_LOG).size; } catch { return 0; }
}

// 開始前の独占チェック。ollama 自身の側のソケットを除いた接続が1つでもあれば、
// 他のクライアントが繋がっている＝いつ叩かれるか分からない、とみなす。
export function foreignClients() {
  try {
    const out = execSync(
      "lsof -nP -iTCP:11434 -sTCP:ESTABLISHED 2>/dev/null || true",
      { encoding: 'utf8' });
    return out.split('\n').slice(1)
      .filter((l) => l.trim() && !/^ollama\s/.test(l))
      .map((l) => l.split(/\s+/).slice(0, 2).join(' '));
  } catch { return []; }
}
