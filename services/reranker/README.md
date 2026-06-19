# QodeX Local Reranker Service

A tiny local service that gives QodeX's stage-2 cross-encoder reranker a real
`/v1/rerank` endpoint — running `BAAI/bge-reranker-v2-m3` directly on your Mac's
GPU (Apple Silicon MPS) via `sentence-transformers`.

## Why this is separate from the QodeX CLI

QodeX's retrieval already knows how to *call* a `/v1/rerank` endpoint
(`src/context/reranker.ts`). The problem is that **neither Ollama nor LM Studio
serves one** for cross-encoder models:

- Ollama has no native `/api/rerank` — community reranker models there only
  expose `/api/embed`, which returns embeddings, not joint relevance scores.
- LM Studio's MLX engine can't even load a BERT reranker — it errors with
  `'Model' object has no attribute 'layers'` because that engine targets
  generative *decoder* models, not encoder + classification-head rerankers.

So this service loads the model the correct way (`CrossEncoder`) and speaks the
exact contract QodeX expects. **Zero changes to QodeX's code** — you only point
config at it.

## Setup

```bash
cd services/reranker
./start.sh            # creates venv, installs deps, downloads model (~2.2GB), serves on :11435
```

First run downloads the model from HuggingFace. Behind an Iran ISP:

```bash
HTTPS_PROXY=http://127.0.0.1:8889 ./start.sh          # via your proxy
# or
HF_ENDPOINT=https://hf-mirror.com ./start.sh          # via the mirror
```

## Point QodeX at it

In `~/.qodex/config.yaml`:

```yaml
context:
  rerank: true
  rerankModel: bge-reranker-v2-m3
  rerankBaseUrl: http://127.0.0.1:11435
```

Then `qodex` retrieval will cast a wide net with hybrid search and re-score the
top candidates through the cross-encoder. If this service isn't running, QodeX
degrades cleanly to bi-encoder order — nothing breaks.

## Verify

```bash
curl http://127.0.0.1:11435/health
curl http://127.0.0.1:11435/v1/rerank -H 'Content-Type: application/json' -d '{
  "query": "database tradeoff for sessions",
  "documents": ["PostgreSQL stores session state", "the sky is blue", "higher write latency accepted for consistency"]
}'
```

The relevant documents should come back with the highest `relevance_score`.

## Notes

- Runs on GPU automatically (MPS). Force CPU with `QODEX_RERANK_DEVICE=cpu`.
- Use a smaller/faster model by setting `QODEX_RERANK_MODEL` (e.g. an Ettin or
  MiniLM cross-encoder) — anything `sentence-transformers` `CrossEncoder` loads.
- Reranking 40 candidates takes well under a second on an M3 Ultra; it's only
  invoked during the retrieval pre-pass, not on every token.
```

---

## MLX models (Apple Silicon) — recon first

If you downloaded the MLX-format bge-reranker-v2-m3 (e.g. the 8-bit MXFP8 ~576MB or the
full ~2.1GB MLX build), note that `server.py` above uses the PyTorch/sentence-transformers
path and loads the **HF-format** model — it does NOT load MLX files. To run the MLX files
natively we first need to discover the exact loader on your machine:

```bash
python3 probe_mlx.py --model /path/to/your/mlx-bge-reranker-v2-m3
```

Paste the output back and the MLX `/v1/rerank` server (`server_mlx.py`) gets written around
the call that actually works — drop-in, same contract, no QodeX-side change.

**Before any of that, decide if reranking even helps** (it varies by model + codebase):
1. `./start.sh` (runs the proven PyTorch path on MPS).
2. In `~/.qodex/config.yaml`: `context: { rerank: true, rerankBaseUrl: "http://127.0.0.1:11435" }`.
3. Use QodeX on a real task; then set `rerank: false` and compare retrieval quality. Keep
   whichever is better. No point optimizing to MLX for a feature that isn't earning its place.
