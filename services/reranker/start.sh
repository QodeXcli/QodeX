#!/usr/bin/env bash
# QodeX reranker service launcher.
# Creates a venv on first run, installs deps, then starts the service.
#
# Behind an Iran ISP / proxy? Either export HTTPS_PROXY before running, e.g.
#   HTTPS_PROXY=http://127.0.0.1:8889 ./start.sh
# or use the HuggingFace mirror for the one-time model download:
#   HF_ENDPOINT=https://hf-mirror.com ./start.sh
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  echo "[qodex-reranker] creating venv …"
  python3 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate

if ! python -c "import sentence_transformers, fastapi" 2>/dev/null; then
  echo "[qodex-reranker] installing deps (first run) …"
  pip install --quiet --upgrade pip
  pip install --quiet -r requirements.txt
fi

# Speeds up the one-time model download when the mirror/proxy is reachable.
export HF_HUB_ENABLE_HF_TRANSFER="${HF_HUB_ENABLE_HF_TRANSFER:-1}"

echo "[qodex-reranker] starting on http://127.0.0.1:${QODEX_RERANK_PORT:-11435}"
exec python server.py
