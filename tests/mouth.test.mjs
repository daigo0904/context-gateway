import test from 'node:test';
import assert from 'node:assert/strict';
import { filterOutput, createMouth } from '../lib/mouth.mjs';

const f = (s, o) => filterOutput(s, o).text;

test('独り言のブロックを消す', () => {
  assert.equal(f('<think>あれこれ</think>答えです。'), '答えです。');
  assert.equal(f('<think>\n複数行\nの考え\n</think>\n答えです。\n'), '答えです。\n');
});

test('閉じ忘れた独り言も消す（§3.3）', () => {
  const r = filterOutput('答えます。\n<think>\n途中で切れた');
  assert.equal(r.text, '答えます。\n');
  assert.equal(r.stats.unterminatedThink, true);
});

test('コードブロックの中は一切いじらない', () => {
  const src = '```js\nconst a = 1;   \n\n\n<think>これはコード</think>\n```\n';
  assert.equal(f(src), src);
});

test('先頭と末尾の定型あいさつだけ落とす', () => {
  assert.equal(f('承知しました。\n本文。\n'), '本文。\n');
  assert.equal(f('本文。\n何かご不明な点があればお知らせください。\n'), '本文。\n');
  // 文中の同じ文字列には触らない
  assert.ok(f('前。\n承知しました。\n後。\n').includes('承知しました'));
});

test('あいさつしか無いときは消さない（空にしない）', () => {
  assert.equal(f('承知しました。'), '承知しました。');
});

test('空行をまとめ、行末の空白を落とす', () => {
  assert.equal(f('a   \n\n\n\nb\n'), 'a\n\nb\n');
  assert.equal(f('\n\n\na\n'), 'a\n');
  assert.equal(f('a\n\n\n'), 'a\n');
});

test('1文字ずつ流しても一括と同じ結果になる', () => {
  const cases = [
    '承知しました。\n\n<think>x\ny</think>\n本文。   \n\n\n続き。\n```\ncode\n\n\n```\n以上です。\n',
    'ふつうの文章。\n2行目。',
    '<think>全部独り言</think>',
    '```\n<think>コード内</think>\n```',
  ];
  for (const src of cases) {
    const once = filterOutput(src).text;
    const m = createMouth();
    let out = '';
    for (const ch of src) out += m.push(ch);
    out += m.end();
    assert.equal(out, once, `不一致: ${JSON.stringify(src)}`);
  }
});

test('文字を増やさない', () => {
  const src = 'a'.repeat(500) + '\n<think>b</think>\n' + 'c'.repeat(500);
  const r = filterOutput(src);
  assert.ok(r.text.length <= src.length);
});

test('壊れたら原文をそのまま返す（§1.5 安全側への縮退）', () => {
  let notified = null;
  // 正規表現の生成で必ず落ちる設定を渡す
  const r = filterOutput('大事な本文です。', {
    thinkTags: ['('],           // 不正なパターン
    onError: (e) => { notified = e; },
  });
  assert.equal(r.text, '大事な本文です。');
  assert.ok(notified, '壊れたことが通知される');
});

test('途中で壊れても、それ以降は素通しになる', () => {
  const m = createMouth();
  let out = m.push('前半。\n');
  m.openRe = null; // 内部を壊す
  out += m.push('後半は素通し。\n');
  out += m.end();
  assert.ok(out.includes('後半は素通し。'), '壊れた後の入力が失われない');
  assert.equal(m.stats.errors, 1);
});

test('日本語と英語の両方のあいさつを落とす', () => {
  assert.equal(f('Sure!\nThe answer is 42.\nLet me know if you need anything else.\n'), 'The answer is 42.\n');
});
