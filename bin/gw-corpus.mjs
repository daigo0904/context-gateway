#!/usr/bin/env node
// 原文ストアを手で触る道具 — §2
//
//   node bin/gw-corpus.mjs add --kind user_turn --sender daigo --content "本文"
//   node bin/gw-corpus.mjs add --kind fetched_data --sender web --file ./page.html
//   node bin/gw-corpus.mjs get <record_id>
//   node bin/gw-corpus.mjs tail [件数]
//   node bin/gw-corpus.mjs lineage <record_id>
//   node bin/gw-corpus.mjs stats

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Corpus, KINDS } from '../lib/corpus.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return process.argv[i + 1] ?? fallback;
}

const dir = arg('dir', process.env.GW_CORPUS_DIR || path.join(ROOT, 'corpus'));
const corpus = new Corpus({ dir });
const cmd = process.argv[2];

switch (cmd) {
  case 'add': {
    const kind = arg('kind');
    const sender = arg('sender', 'cli');
    const file = arg('file');
    let content = arg('content');
    if (file) content = fs.readFileSync(file, 'utf8');
    if (content === null && !process.stdin.isTTY) {
      content = fs.readFileSync(0, 'utf8');
    }
    if (!kind || content === null) {
      console.error(`使い方: add --kind <${KINDS.join('|')}> --sender <名前> (--content <文> | --file <パス> | 標準入力)`);
      process.exit(2);
    }
    const rec = corpus.append({ kind, sender, content, parent_id: arg('parent') });
    console.log(rec.record_id);
    break;
  }
  case 'get': {
    const id = process.argv[3];
    const rec = corpus.get(id);
    if (!rec) { console.error('見つかりません'); process.exit(1); }
    console.log(JSON.stringify(rec, null, 2));
    break;
  }
  case 'tail': {
    const n = Number(process.argv[3] || 20);
    for (const rec of corpus.tail(n)) {
      const head = rec.content.replace(/\n/g, ' ').slice(0, 70);
      console.log(`${rec.record_id} ${rec.ts.slice(11, 19)} ${rec.kind.padEnd(15)} ${String(rec.sender).padEnd(10)} ${head}`);
    }
    break;
  }
  case 'lineage': {
    const chain = corpus.lineage(process.argv[3]);
    if (!chain.length) { console.error('見つかりません'); process.exit(1); }
    chain.forEach((rec, i) => {
      console.log(`${'  '.repeat(i)}${i === 0 ? '' : '└ '}${rec.record_id} ${rec.kind} (${rec.byte_len}バイト)`);
    });
    break;
  }
  case 'stats': {
    const s = corpus.stats();
    console.log(`置き場所 : ${s.dir}`);
    console.log(`日数     : ${s.segments}`);
    console.log(`レコード : ${s.records}件`);
    console.log(`原文     : ${(s.bytes / 1024).toFixed(1)} KiB`);
    for (const [k, v] of Object.entries(s.byKind)) console.log(`  ${k.padEnd(16)} ${v}件`);
    break;
  }
  default:
    console.error('add / get / tail / lineage / stats のどれかを指定してください');
    process.exit(2);
}
