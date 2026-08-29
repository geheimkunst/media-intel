#!/usr/bin/env bash
# Sync fixtures and bench code to hermes-vps, prepare caches (models, tessdata), run the suite, fetch results.
# Usage: bash bench/run-vps.sh [--only a,b] [--skip-sync]
set -euo pipefail
HOST=hermes-vps
REMOTE=/home/yunus/dev/media-intel
ONLY=""
SYNC=1
while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY="$2"; shift 2 ;;
    --skip-sync) SYNC=0; shift ;;
    *) echo "unknown arg $1"; exit 1 ;;
  esac
done
cd "$(dirname "$0")/.."
if [ "$SYNC" = 1 ]; then
  rsync -az --delete --exclude node_modules --exclude dist --exclude .git --exclude .scratch --exclude .claude --exclude coverage --exclude bench/.cache --exclude bench/results ./ "$HOST:$REMOTE/"
fi
ssh -o BatchMode=yes "$HOST" bash -s "$ONLY" <<'EOF'
set -euo pipefail
ONLY="$1"
export PATH=$HOME/.local/opt/node24/bin:$HOME/.local/bin:$PATH
BENCH=/home/yunus/bench
REMOTE=/home/yunus/dev/media-intel
mkdir -p $BENCH/cache $BENCH/results $BENCH/ref
rm -rf $BENCH/fixtures && cp -r $REMOTE/bench/fixtures $BENCH/fixtures && chmod -R a+rX $BENCH/fixtures
# media-intel variants: whisper models + VAD inside their cache
for c in media-intel media-intel-base; do
  mkdir -p $BENCH/cache/$c/models
  cp -n $HOME/.cache/media-intel/models/ggml-large-v3-turbo-q5_0.bin $BENCH/cache/$c/models/ 2>/dev/null || true
  cp -n $HOME/.cache/media-intel/models/ggml-silero-v5.1.2.bin $BENCH/cache/$c/models/ 2>/dev/null || true
  cp -n $HOME/.cache/media-understanding/models/ggml-base-q5_1.bin $BENCH/cache/$c/models/ 2>/dev/null || true
done
# media-understanding: XDG_CACHE_HOME=/cache -> /cache/media-understanding/models/ggml-base-q5_1.bin
mkdir -p $BENCH/cache/media-understanding/media-understanding/models
cp -n $HOME/.cache/media-understanding/models/ggml-base-q5_1.bin $BENCH/cache/media-understanding/media-understanding/models/ 2>/dev/null || true
# mcp-video-analyzer: tesseract.js language data must be present offline
TD=$BENCH/cache/mcp-video-analyzer/mcp-video-analyzer/tessdata
mkdir -p $TD
for l in eng deu; do
  [ -f $TD/$l.traineddata ] || curl -fsSL -o $TD/$l.traineddata https://raw.githubusercontent.com/tesseract-ocr/tessdata/main/$l.traineddata
done
mkdir -p $BENCH/cache/claude-video-script
chmod -R a+rwX $BENCH/cache
cd $REMOTE
ARGS=(--fixtures $BENCH/fixtures --cache $BENCH/cache --ref $BENCH/ref --docker "sudo docker" --out $BENCH/results/run-$(date +%Y%m%d-%H%M%S).json)
[ -n "$ONLY" ] && ARGS+=(--only "$ONLY")
node bench/run.mjs "${ARGS[@]}"
ls -t $BENCH/results | head -1
EOF
mkdir -p bench/results
rsync -az "$HOST:/home/yunus/bench/results/" bench/results/
ls -t bench/results | head -1
