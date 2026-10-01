#!/bin/bash
# 本計測。arm.mjs 版との違いは「独占の担保」。
#   ・開始前: ollama に他のクライアントが繋がっていないことを確認。繋がっていれば中止。
#   ・実行中: arm2.mjs が毎手ログと突き合わせ、割り込みを見つけた時点でそのアームを中断。
#   ・終了後: ログ上の全推論時間と自分の呼び出し時間を比べ、差が5%を超えたら無効と記録。
set -u
S=/private/tmp/claude-501/-Users-daigo/d2ee986b-2ad5-492b-8357-1d5e740e57af/scratchpad
L=/opt/homebrew/var/log/ollama.log
LOCK=/tmp/ollama-measure.lock
TURNS=${TURNS:-40}
RATIO=${RATIO:-0.7}
ORDER=${ORDER:-"none every new"}
TAG=${TAG:-r3}
OUT=$S/arms2
mkdir -p $OUT

if [ -e "$LOCK" ]; then
  echo "中止: 別の計測が走っています → $(cat $LOCK)"; exit 1
fi
echo "pid=$$ tag=$TAG 開始=$(date '+%F %T')" > $LOCK
trap 'rm -f $LOCK' EXIT

foreign() {  # ollama 自身の側を除いた接続＝他のクライアント
  lsof -nP -iTCP:11434 -sTCP:ESTABLISHED 2>/dev/null | tail -n +2 | grep -v '^ollama ' | awk '{print $1" "$2}'
}

for ARM in $ORDER; do
  echo "=== [$TAG] arm=$ARM 開始 $(date '+%F %T') ==="

  # 1) ollama を再起動 → prompt cache を空にする
  launchctl kickstart -k gui/$(id -u)/homebrew.mxcl.ollama
  for i in $(seq 1 60); do
    curl -s -m 2 http://127.0.0.1:11434/api/version >/dev/null 2>&1 && break
    sleep 1
  done

  # 2) モデルを載せ直す（積み直しの時間を計測に混ぜない）
  curl -s http://127.0.0.1:11434/api/chat -d "{\"model\":\"gemma4:26b\",\"stream\":false,
    \"keep_alive\":-1,\"options\":{\"num_ctx\":65536,\"temperature\":0},
    \"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" >/dev/null
  sleep 2

  # 3) 事前チェック: 他のクライアントが繋がっていないこと
  F=$(foreign)
  if [ -n "$F" ]; then
    echo "!! [$TAG/$ARM] 中止: 他のクライアントが ollama に接続中 →"; echo "$F"
    printf '%s\t%s\t%s\tABORT_PRECHECK\n' "$TAG" "$ARM" "$(date '+%F %T')" >> $OUT/times.tsv
    continue
  fi

  # 4) ログの印を取ってから走らせる
  OFF=$(wc -c < $L | tr -d ' ')
  START=$(date '+%F %T')
  node $S/arm2.mjs $ARM $TURNS $OFF $RATIO > $OUT/$TAG-$ARM.txt 2>&1
  RC=$?
  END=$(date '+%F %T')
  tail -c +$((OFF+1)) $L > $OUT/$TAG-$ARM.log

  # 5) 事後判定: ログ上の推論時間 vs 自分の呼び出し時間
  VERDICT=$(node -e "
    import('$S/oll.mjs').then(async (m) => {
      const fs = await import('fs');
      const t = fs.readFileSync('$OUT/$TAG-$ARM.txt','utf8');
      const i = t.indexOf('@@RESULT@@');
      if (i < 0) { console.log('INVALID\t結果なし'); return; }
      const j = JSON.parse(t.slice(i+10).trim());
      const own = j.rows.reduce((a,r)=>a+r.wallMs,0)/1000;
      const seen = m.inferenceCalls($OFF);
      const pct = ((seen.seconds - own) / own) * 100;
      const bad = (seen.count !== j.steps) || (pct > 5);
      console.log((bad?'INVALID':'VALID') +
        '\t呼出 自分=' + j.steps + '/ログ=' + seen.count +
        '  時間 自分=' + own.toFixed(0) + 's/ログ=' + seen.seconds.toFixed(0) + 's' +
        '  超過=' + pct.toFixed(1) + '%');
    });
  ")
  printf '%s\t%s\t%s\t%s\trc=%s\t%s\n' "$TAG" "$ARM" "$START" "$END" "$RC" "$VERDICT" >> $OUT/times.tsv
  echo "=== [$TAG] arm=$ARM 終了 $END  rc=$RC  $VERDICT ==="
done
echo "ALLDONE"
