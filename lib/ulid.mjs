// ULID — 時刻順に並ぶ26文字のID。
//
// 仕様 §2.2 が record_id に ULID を要求している理由は「時系列順にソート可能」だから。
// 前半10文字がミリ秒の時刻、後半16文字が乱数。文字列として並べ替えるだけで
// 発生順に並ぶので、原文ストアは追記するだけで時系列が保たれる。
//
// もう一つの利点をこの実装は積極的に使っている。IDから発生時刻を取り出せるので、
// 「このIDはどのファイルに入っているか」を索引なしで決められる（corpus.mjs を見よ）。

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford Base32（紛らわしいI L O U を除いてある）
const ENCODING_LEN = 32;
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const TIME_MAX = 281474976710655; // 2^48 - 1

export const ULID_LEN = TIME_LEN + RANDOM_LEN;

function encodeTime(ms, len) {
  if (!Number.isInteger(ms) || ms < 0 || ms > TIME_MAX) {
    throw new TypeError(`ULID: 時刻が範囲外です: ${ms}`);
  }
  let out = '';
  let rest = ms;
  for (let i = len - 1; i >= 0; i--) {
    const mod = rest % ENCODING_LEN;
    out = ENCODING[mod] + out;
    rest = (rest - mod) / ENCODING_LEN;
  }
  return out;
}

function randomChars(len, rng) {
  let out = '';
  for (let i = 0; i < len; i++) {
    out += ENCODING[Math.floor(rng() * ENCODING_LEN)];
  }
  return out;
}

function defaultRng() {
  // crypto があれば使う。無い環境でも動くように Math.random へ落とす。
  // ここは安全性ではなく衝突回避のための乱数なので、落ちても情報は失われない。
  try {
    const buf = new Uint32Array(1);
    globalThis.crypto.getRandomValues(buf);
    return buf[0] / 0x100000000;
  } catch {
    return Math.random();
  }
}

// 同じミリ秒に複数回呼ばれても順序が保たれるようにする。
// 後半の乱数部分を1つ繰り上げることで、同一ミリ秒内でも単調増加になる。
export function monotonicFactory({ now = Date.now, rng = defaultRng } = {}) {
  let lastTime = -1;
  let lastRandom = null; // 文字ではなく数値の配列で持つ（繰り上げを計算するため）

  function incrementRandom(chars) {
    const next = chars.slice();
    for (let i = next.length - 1; i >= 0; i--) {
      if (next[i] < ENCODING_LEN - 1) {
        next[i]++;
        return next;
      }
      next[i] = 0; // 桁上がり
    }
    // 16桁すべてが上限。同一ミリ秒に 32^16 回呼ばれたときだけ起きる。
    // 起きたら順序を壊すより失敗させたほうが安全。
    throw new Error('ULID: 同一ミリ秒内で乱数部分が上限に達しました');
  }

  return function ulid(seedTime) {
    const t = seedTime === undefined ? now() : seedTime;
    let randomChars_;
    if (t === lastTime && lastRandom) {
      lastRandom = incrementRandom(lastRandom);
      randomChars_ = lastRandom.map((i) => ENCODING[i]).join('');
    } else if (t < lastTime && lastRandom) {
      // 時計が巻き戻った（NTP補正など）。順序が壊れるより、直前のIDの次を出す。
      lastRandom = incrementRandom(lastRandom);
      randomChars_ = lastRandom.map((i) => ENCODING[i]).join('');
      return encodeTime(lastTime, TIME_LEN) + randomChars_;
    } else {
      randomChars_ = randomChars(RANDOM_LEN, rng);
      lastRandom = randomChars_.split('').map((c) => ENCODING.indexOf(c));
      lastTime = t;
    }
    return encodeTime(lastTime === -1 ? t : Math.max(t, lastTime), TIME_LEN) + randomChars_;
  };
}

export const ulid = monotonicFactory();

// IDから発生時刻（ミリ秒）を取り出す。
export function decodeTime(id) {
  if (typeof id !== 'string' || id.length !== ULID_LEN) {
    throw new TypeError(`ULID: 形式が違います: ${id}`);
  }
  let ms = 0;
  for (let i = 0; i < TIME_LEN; i++) {
    const v = ENCODING.indexOf(id[i].toUpperCase());
    if (v === -1) throw new TypeError(`ULID: 使えない文字が入っています: ${id[i]}`);
    ms = ms * ENCODING_LEN + v;
  }
  return ms;
}

export function isUlid(id) {
  if (typeof id !== 'string' || id.length !== ULID_LEN) return false;
  for (const ch of id) {
    if (ENCODING.indexOf(ch.toUpperCase()) === -1) return false;
  }
  return true;
}
