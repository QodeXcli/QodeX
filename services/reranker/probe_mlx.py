#!/usr/bin/env python3
"""
QodeX reranker — MLX recon probe.

Purpose: the downloaded models ("BAAI bge-reranker-v2-m3" MLX, and its 8-bit MXFP8
variant) are MLX-format cross-encoders (XLM-RoBERTa encoder + a relevance head).
The current server (server.py) runs the *PyTorch/sentence-transformers* path on MPS
and CANNOT load these MLX files. Before writing an MLX server, we need to know — on
YOUR machine — exactly which library + call actually loads and SCORES these models.

This script DISCOVERS that instead of guessing: it inspects your environment and the
model folder, then TRIES the likely MLX APIs and prints what worked (or the precise
error). It does not need to know the API in advance — it reveals it.

Run on the Mac:
    python3 probe_mlx.py --model /path/to/bge-reranker-v2-m3-mlx
    # or an HF repo id, e.g.:
    python3 probe_mlx.py --model flaglow/bge-reranker-v2-m3   # adjust to the real id

Then paste the WHOLE output back so the exact MLX server can be written around the
call that actually works. Nothing here writes files or changes anything — read-only recon.
"""

import argparse
import json
import os
import platform
import sys
import traceback

QUERY = "How do I configure the database connection pool?"
DOC_GOOD = "Set DATABASE_POOL_SIZE in settings.py to tune the connection pool."
DOC_BAD = "The cafeteria menu rotates every two weeks."


def section(title: str) -> None:
    print("\n" + "=" * 64)
    print(title)
    print("=" * 64)


def try_import(name: str):
    try:
        mod = __import__(name)
        ver = getattr(mod, "__version__", "?")
        print(f"  OK   {name}  (version {ver})")
        return mod
    except Exception as e:  # noqa: BLE001
        print(f"  MISS {name}  ({e.__class__.__name__}: {e})")
        return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True,
                    help="Local path to the MLX model dir, or an HF repo id.")
    args = ap.parse_args()
    model = args.model

    section("1. Environment")
    print(f"  python:   {sys.version.split()[0]}")
    print(f"  platform: {platform.platform()}")
    print(f"  machine:  {platform.machine()} "
          f"(Apple Silicon = {'yes' if platform.machine() == 'arm64' else 'NO — MLX needs arm64'})")

    section("2. Libraries available")
    mlx = try_import("mlx")
    try_import("mlx.core")
    mlx_emb = try_import("mlx_embeddings")
    try_import("mlx_lm")
    st = try_import("sentence_transformers")
    torch = try_import("torch")
    if torch is not None:
        try:
            print(f"       torch MPS available: {torch.backends.mps.is_available()}")
        except Exception:  # noqa: BLE001
            pass

    section("3. Model folder inspection")
    if os.path.isdir(model):
        files = sorted(os.listdir(model))
        print(f"  dir: {model}")
        print(f"  files: {files}")
        cfg_path = os.path.join(model, "config.json")
        if os.path.isfile(cfg_path):
            try:
                cfg = json.load(open(cfg_path))
                print(f"  model_type:   {cfg.get('model_type')}")
                print(f"  architectures:{cfg.get('architectures')}")
                print(f"  quantization: {cfg.get('quantization') or cfg.get('quantization_config')}")
            except Exception as e:  # noqa: BLE001
                print(f"  (could not read config.json: {e})")
    else:
        print(f"  '{model}' is not a local dir — treating it as an HF repo id.")

    # ── 4. Discover the mlx_embeddings API surface (so we see the real method names) ──
    if mlx_emb is not None:
        section("4. mlx_embeddings API surface")
        print("  top-level symbols:")
        print("   ", [s for s in dir(mlx_emb) if not s.startswith("_")])
        for sub in ("utils", "models"):
            try:
                m = __import__(f"mlx_embeddings.{sub}", fromlist=["x"])
                print(f"  mlx_embeddings.{sub}:")
                print("   ", [s for s in dir(m) if not s.startswith("_")])
            except Exception:  # noqa: BLE001
                pass

    # ── 5. Try candidate load+score paths; report which one actually works ──
    section("5. Candidate load + score attempts")

    # Candidate A: mlx_embeddings.load(...) then inspect the returned object for a
    # rerank/score/__call__ path. We DON'T assume the method name — we print it.
    if mlx_emb is not None and hasattr(mlx_emb, "load"):
        print("\n  [A] mlx_embeddings.load(model)")
        try:
            loaded = mlx_emb.load(model)
            print(f"      load() returned: {type(loaded)}")
            if isinstance(loaded, tuple):
                for i, part in enumerate(loaded):
                    print(f"        [{i}] {type(part)} -> "
                          f"{[s for s in dir(part) if not s.startswith('_')][:25]}")
            else:
                print(f"        methods: {[s for s in dir(loaded) if not s.startswith('_')][:25]}")
            print("      ↑ tell me which of these looks like rerank/score/encode "
                  "and I'll wire the server to it.")
        except Exception as e:  # noqa: BLE001
            print(f"      FAILED: {e.__class__.__name__}: {e}")
            traceback.print_exc()

    # Candidate B: sentence-transformers CrossEncoder (works for HF-format dirs; for an
    # MLX-only folder it will likely fail — that failure is itself informative).
    if st is not None:
        print("\n  [B] sentence_transformers.CrossEncoder(model).predict([(q, doc)])")
        try:
            from sentence_transformers import CrossEncoder
            ce = CrossEncoder(model, max_length=512)
            scores = ce.predict([(QUERY, DOC_GOOD), (QUERY, DOC_BAD)])
            print(f"      OK scores: good={float(scores[0]):.3f}  bad={float(scores[1]):.3f}")
            print("      (good should be >> bad — confirms reranking signal works on this model)")
        except Exception as e:  # noqa: BLE001
            print(f"      FAILED: {e.__class__.__name__}: {e}")

    section("Done")
    print("Paste this entire output back. From the working path above, I'll write a drop-in")
    print("MLX /v1/rerank server (server_mlx.py) — zero changes needed on the QodeX side.")


if __name__ == "__main__":
    main()
