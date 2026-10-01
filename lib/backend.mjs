// 推論サーバの居場所を見つけて、状態を尋ねる — 仕様 §6.2 ／ 訂正1
//
// 前提の訂正（2026-09-05 実測）：
//   CLAUDE.md には「/slots も /props も 404。キャッシュ枠を触る口は無い」と書いてあるが、
//   それは ollama の窓口（11434）に限った話だった。
//   ollama は内部で llama-server を素で起動していて、そちらのポートを直接叩けば
//   /slots も /props も /health も 200 で返る。
//
//   ただしポートは起動のたびに変わる。だから固定値で持ってはいけない。
//   毎回 ps から引き直す。引けなかったら「取得失敗」であって「圧力ゼロ」ではない（§7.5）。
//
// /slots から取れて、仕様が想定していなかったもの：
//   n_prompt_tokens_cache / n_prompt_tokens = プロンプトキャッシュの命中率。
//   §9 手順4 は「tok/s の低下とKV使用率の上昇が時間軸で一致するか」という間接測定だが、
//   命中率は直接測れる。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_DISCOVER_TTL_MS = 15_000;

let _cache = { at: 0, value: null };

/**
 * 動いている llama-server を ps から探す。
 * @returns {Promise<{ok:true, pid:number, host:string, port:number, ctx:number|null, model:string|null}
 *                  | {ok:false, reason:string, detail?:string}>}
 */
export async function discoverBackend({ ttlMs = DEFAULT_DISCOVER_TTL_MS, force = false } = {}) {
  const now = Date.now();
  if (!force && _cache.value && now - _cache.at < ttlMs) return _cache.value;

  let stdout;
  try {
    ({ stdout } = await execFileAsync('ps', ['-axo', 'pid=,command='], {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 5000,
    }));
  } catch (err) {
    const res = { ok: false, reason: 'ps_failed', detail: String(err && err.message) };
    _cache = { at: now, value: res };
    return res;
  }

  for (const line of stdout.split('\n')) {
    if (!line.includes('llama-server')) continue;
    if (line.includes('grep')) continue;
    const pidM = /^\s*(\d+)\s/.exec(line);
    const portM = /--port\s+(\d+)/.exec(line);
    if (!pidM || !portM) continue;
    const hostM = /--host\s+(\S+)/.exec(line);
    const ctxM = /\s-c\s+(\d+)/.exec(line);
    const modelM = /--model\s+(\S+)/.exec(line);
    const res = {
      ok: true,
      pid: Number(pidM[1]),
      host: hostM ? hostM[1] : '127.0.0.1',
      port: Number(portM[1]),
      ctx: ctxM ? Number(ctxM[1]) : null,
      model: modelM ? modelM[1] : null,
      foundAt: now,
    };
    _cache = { at: now, value: res };
    return res;
  }

  const res = { ok: false, reason: 'not_running', detail: 'llama-server が見つかりません' };
  _cache = { at: now, value: res };
  return res;
}

export function _resetBackendCache() { _cache = { at: 0, value: null }; }

function pickNextToken(slot) {
  // llama.cpp のバージョンによって next_token は配列だったりオブジェクトだったりする。
  const nt = slot.next_token;
  if (Array.isArray(nt)) return nt[0] || null;
  if (nt && typeof nt === 'object') return nt;
  return null;
}

/**
 * /slots を1回叩く。
 *
 * §7.5 の要件：取れなかったものを 0 として返さない。
 * 想定したフィールドが無い場合も「値が0」ではなく「取得失敗」として返す。
 * ここを 0 で埋めると、エンドポイントが死んでいても「圧力なし」に見える。
 */
export async function fetchSlots({ backend = null, timeoutMs = 1500 } = {}) {
  const at = Date.now();
  const be = backend || (await discoverBackend());
  if (!be.ok) return { ok: false, at, reason: be.reason, detail: be.detail };

  let json;
  try {
    const res = await fetch(`http://${be.host}:${be.port}/slots`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return { ok: false, at, reason: 'http_status', detail: String(res.status), backend: be };
    }
    json = await res.json();
  } catch (err) {
    // ポートは起動のたびに変わる。次回は探し直す。
    _resetBackendCache();
    const reason = err && err.name === 'TimeoutError' ? 'timeout' : 'fetch_failed';
    return { ok: false, at, reason, detail: String(err && err.message), backend: be };
  }

  if (!Array.isArray(json) || json.length === 0) {
    return { ok: false, at, reason: 'bad_shape', detail: 'slots が配列ではありません', backend: be };
  }
  const slot = json[0];
  // 参照するフィールドが無い場合も取得失敗（§7.5 の最後の段落）
  const required = ['n_ctx', 'n_prompt_tokens', 'n_prompt_tokens_cache', 'n_prompt_tokens_processed'];
  const missing = required.filter((k) => typeof slot[k] !== 'number');
  if (missing.length) {
    return { ok: false, at, reason: 'field_missing', detail: missing.join(','), backend: be };
  }

  const nt = pickNextToken(slot);
  const nPrompt = slot.n_prompt_tokens;
  return {
    ok: true,
    at,
    backend: be,
    n_ctx: slot.n_ctx,
    n_prompt_tokens: nPrompt,
    n_prompt_tokens_cache: slot.n_prompt_tokens_cache,
    n_prompt_tokens_processed: slot.n_prompt_tokens_processed,
    is_processing: Boolean(slot.is_processing),
    id_task: slot.id_task ?? null,
    n_decoded: nt && typeof nt.n_decoded === 'number' ? nt.n_decoded : null,
    // 命中率。
    //
    // 実測で分かったこと（2026-09-05）：処理していないあいだ、n_prompt_tokens_cache は
    // 0 に戻るが n_prompt_tokens は前の値のまま残る。そのまま割ると「命中率 0%」になり、
    // 「本当に1つも当たらなかった」と見分けが付かない。
    // 処理中でないときは数字を出さない（§7.5：持っていない値を数字にしない）。
    cache_hit_rate:
      slot.is_processing && nPrompt > 0 ? slot.n_prompt_tokens_cache / nPrompt : null,
    ctx_use_rate: slot.n_ctx > 0 ? nPrompt / slot.n_ctx : null,
  };
}

export async function fetchProps({ backend = null, timeoutMs = 1500 } = {}) {
  const be = backend || (await discoverBackend());
  if (!be.ok) return { ok: false, reason: be.reason };
  try {
    const res = await fetch(`http://${be.host}:${be.port}/props`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, reason: 'http_status', detail: String(res.status) };
    return { ok: true, props: await res.json(), backend: be };
  } catch (err) {
    return { ok: false, reason: 'fetch_failed', detail: String(err && err.message) };
  }
}
