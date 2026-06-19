#!/usr/bin/env python3
"""
QodeX local cross-encoder reranker service.

Why this exists
---------------
QodeX's retrieval has a stage-2 cross-encoder reranker (src/context/reranker.ts)
that POSTs to a local `/v1/rerank` endpoint. Neither Ollama nor LM Studio exposes
that endpoint for cross-encoder models today — and LM Studio's MLX engine can't
even load a BERT-architecture reranker (it errors with
"'Model' object has no attribute 'layers'" because that engine is built for
generative decoder models, not encoder+classification-head rerankers).

This tiny service fills the gap: it loads BAAI/bge-reranker-v2-m3 directly with
sentence-transformers (running on Apple-Silicon GPU via MPS) and exposes exactly
the `/v1/rerank` contract QodeX already speaks. No change to QodeX's TS code —
just point `context.rerankBaseUrl` at this service.

Request  (what QodeX sends):
    POST /v1/rerank
    { "model": "...", "query": "...", "documents": ["...", ...], "top_n": N }

Response (what QodeX expects):
    { "results": [ { "index": <int>, "relevance_score": <float> }, ... ] }

The cross-encoder reads (query, document) jointly so attention runs directly
between query terms and code lines — the precision win a bi-encoder can't give.

Run it
------
    cd services/reranker
    python3 -m venv .venv && source .venv/bin/activate
    pip install -r requirements.txt
    python server.py                       # serves on http://127.0.0.1:11435

First run downloads the model (~2.2GB) from HuggingFace to the HF cache. If you
are behind a proxy (Iran ISP), export HTTPS_PROXY / HTTP_PROXY first, or set
HF_ENDPOINT=https://hf-mirror.com to use the mirror.

Then in ~/.qodex/config.yaml:
    context:
      rerank: true
      rerankModel: bge-reranker-v2-m3
      rerankBaseUrl: http://127.0.0.1:11435
"""

import os
import sys
import time
from typing import List, Optional

try:
    from fastapi import FastAPI
    from pydantic import BaseModel
    import uvicorn
except ImportError:
    sys.stderr.write(
        "[qodex-reranker] Missing deps. Run:\n"
        "  pip install -r requirements.txt\n"
    )
    sys.exit(1)


# ── Config via env (all optional) ──────────────────────────────────────────
MODEL_NAME = os.environ.get("QODEX_RERANK_MODEL", "BAAI/bge-reranker-v2-m3")
HOST = os.environ.get("QODEX_RERANK_HOST", "127.0.0.1")
PORT = int(os.environ.get("QODEX_RERANK_PORT", "11435"))
# Device: prefer Apple-Silicon GPU (MPS), fall back to CPU. Override with
# QODEX_RERANK_DEVICE=cpu to force CPU.
DEVICE = os.environ.get("QODEX_RERANK_DEVICE", "")


def _pick_device() -> str:
    if DEVICE:
        return DEVICE
    try:
        import torch
        if torch.backends.mps.is_available():
            return "mps"          # Apple Silicon GPU
        if torch.cuda.is_available():
            return "cuda"
    except Exception:
        pass
    return "cpu"


# ── Lazy model load (so the server starts fast and reports readiness) ──────
_model = None
_device = _pick_device()


def _get_model():
    global _model
    if _model is None:
        from sentence_transformers import CrossEncoder
        sys.stderr.write(f"[qodex-reranker] loading {MODEL_NAME} on {_device} …\n")
        t0 = time.time()
        # max_length 512 is plenty for a query + a code chunk; bump if you feed
        # very large chunks. activation handled by CrossEncoder.predict.
        _model = CrossEncoder(MODEL_NAME, max_length=512, device=_device)
        sys.stderr.write(f"[qodex-reranker] ready in {time.time() - t0:.1f}s\n")
    return _model


app = FastAPI(title="QodeX Reranker", version="1.0.0")


class RerankRequest(BaseModel):
    query: str
    documents: List[str]
    model: Optional[str] = None
    top_n: Optional[int] = None


class RerankResultItem(BaseModel):
    index: int
    relevance_score: float


class RerankResponse(BaseModel):
    results: List[RerankResultItem]


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_NAME, "device": _device}


@app.post("/v1/rerank", response_model=RerankResponse)
def rerank(req: RerankRequest):
    if not req.documents:
        return {"results": []}
    model = _get_model()
    # CrossEncoder.predict scores each (query, document) pair jointly.
    pairs = [(req.query, doc) for doc in req.documents]
    scores = model.predict(pairs)  # numpy array of floats
    results = [
        {"index": i, "relevance_score": float(score)}
        for i, score in enumerate(scores)
    ]
    # Sort best-first; QodeX re-sorts too, but this keeps top_n meaningful.
    results.sort(key=lambda r: r["relevance_score"], reverse=True)
    if req.top_n is not None:
        results = results[: req.top_n]
    return {"results": results}


# Also accept the Ollama-style path so QodeX's first attempt (/api/rerank) works
# too — same handler, so either base URL shape succeeds.
@app.post("/api/rerank", response_model=RerankResponse)
def rerank_ollama(req: RerankRequest):
    return rerank(req)


def main():
    # Warm the model at boot so the first real request isn't slow. Comment out
    # to load lazily on first request instead.
    try:
        _get_model()
    except Exception as e:
        sys.stderr.write(f"[qodex-reranker] WARNING model preload failed: {e}\n")
        sys.stderr.write("[qodex-reranker] will retry on first request.\n")
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")


if __name__ == "__main__":
    main()
