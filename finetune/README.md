# QodeX fine-tuning (LoRA / QLoRA)

Make QodeX's local model sharper at *agentic coding the way you actually work*: tool
use, edit→verify loops, your conventions, your language. We do this by distilling
QodeX's own session history into a training set, then LoRA/QLoRA fine-tuning the base
model and loading the result back into LM Studio / Ollama.

> **Why this beats a generic instruct tune:** the signal comes from real QodeX traces —
> `read_file → edit_symbol → shell(test) → fix` loops, your `remember`-ed preferences,
> your stack. The adapter learns *your* loop, not the internet's.

---

## 0. Which path?

| Your machine | Path | Quantized? | Notes |
|---|---|---|---|
| **Apple Silicon (your M3 Ultra / 256 GB)** | **MLX-LM LoRA** (`mlx-lora.yaml`) | base loaded 4–8 bit | Native, fast, no CUDA. This is your path. |
| NVIDIA GPU (≥24 GB) | **QLoRA via Unsloth** (`qlora.py`) | base loaded 4-bit (NF4) | True bitsandbytes QLoRA. For a cloud box. |

bitsandbytes 4-bit QLoRA does **not** run on Metal — on the Mac, MLX-LM's LoRA over a
quantized MLX base is the equivalent and the right tool.

---

## 1. Build the dataset from your QodeX sessions

```bash
cd finetune
node export-dataset.mjs            # reads ~/.qodex/sessions.db
# → data/train.jsonl, data/valid.jsonl  (chat format: {"messages":[...]})
```

Options (env vars):

- `QODEX_DB=/path/to/sessions.db`  — alternate DB
- `MIN_TURNS=2`                    — drop trivial sessions (default 2)
- `VALID_FRACTION=0.1`            — train/valid split (default 0.1)
- `MAX_TOOL_CHARS=4000`          — truncate giant tool outputs (default 4000)
- `INCLUDE_TOOLS=1`              — keep `tool`/tool_call structure (default on; set 0 for plain chat)

The more you use QodeX, the better this set gets. Re-run anytime to refresh.

---

## 2a. Train on Apple Silicon (MLX-LM) — recommended for you

```bash
pip install -U mlx-lm
# Edit mlx-lora.yaml: set `model:` to your base (HF repo or local MLX path).
python -m mlx_lm lora --config mlx-lora.yaml

# Try it:
python -m mlx_lm generate --model <BASE> --adapter-path adapters \
  --prompt "Refactor this function to remove the N+1 query."

# Fuse the adapter into a standalone model you can run in LM Studio:
python -m mlx_lm fuse --model <BASE> --adapter-path adapters \
  --save-path ./qodex-qwen3-coder-tuned
```

Drop `qodex-qwen3-coder-tuned/` into `~/.cache/lm-studio/models/...` (or point LM Studio
at it) and select it as QodeX's primary in `qx setup`.

## 2b. Train QLoRA on NVIDIA (Unsloth)

```bash
pip install -r requirements-qlora.txt   # see README bottom
python qlora.py                          # reads data/{train,valid}.jsonl
# → ./qodex-qlora-adapters  (+ optional GGUF export for Ollama)
```

---

## 3. Load the tuned model back into QodeX

- **LM Studio (MLX, fused):** place the fused folder in LM Studio's models dir, load it,
  then `qx setup` → pick it as primary (or set `defaults.model` in `~/.qodex/config.yaml`).
- **Ollama (GGUF):** `ollama create qodex-tuned -f Modelfile` then set it as a role/primary.

---

## Tuning for "highest capability" (already baked into the configs)

- **Rank 64 / alpha 128** — high-capacity adapter; your 256 GB easily affords it.
- **All linear projections** targeted (q,k,v,o,gate,up,down), not just q,v.
- **Many / all transformer layers** fine-tuned, not just the top 16.
- **Longer context** (`max_seq_length: 8192`) so multi-file agent traces fit.
- **Cosine LR schedule + warmup**, grad checkpointing for memory headroom.
- Keep `valid.jsonl` honest (held-out sessions) and watch val loss for overfit — with a
  personal dataset, prefer **more epochs only if val loss keeps dropping**.

## requirements-qlora.txt (NVIDIA path)

```
unsloth
trl>=0.9
peft>=0.11
transformers>=4.44
accelerate
bitsandbytes
datasets
```
