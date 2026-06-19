#!/usr/bin/env python3
"""
QLoRA fine-tune for QodeX — NVIDIA path (true 4-bit bitsandbytes via Unsloth).

For Apple Silicon use mlx-lora.yaml instead (bitsandbytes 4-bit doesn't run on Metal).

Reads finetune/data/{train,valid}.jsonl (from export-dataset.mjs) — chat format
{"messages":[...]} — and trains a high-capacity QLoRA adapter.

  pip install -r requirements-qlora.txt
  python qlora.py

Env overrides: BASE_MODEL, MAX_SEQ_LEN, EPOCHS, BATCH, GRAD_ACCUM, LR, OUTPUT.
"""

import os
from unsloth import FastLanguageModel
from unsloth.chat_templates import train_on_responses_only
from datasets import load_dataset
from trl import SFTTrainer, SFTConfig

BASE_MODEL = os.environ.get("BASE_MODEL", "unsloth/Qwen3-Coder-30B-A3B-Instruct")
MAX_SEQ_LEN = int(os.environ.get("MAX_SEQ_LEN", 8192))
EPOCHS = float(os.environ.get("EPOCHS", 3))
BATCH = int(os.environ.get("BATCH", 2))
GRAD_ACCUM = int(os.environ.get("GRAD_ACCUM", 8))   # effective batch = BATCH * GRAD_ACCUM
LR = float(os.environ.get("LR", 1e-4))              # QLoRA tolerates a higher LR than full FT
OUTPUT = os.environ.get("OUTPUT", "qodex-qlora-adapters")
DATA_DIR = os.path.join(os.path.dirname(__file__), "data")

# 1. Load base in 4-bit (NF4) — this is the "Q" in QLoRA.
model, tokenizer = FastLanguageModel.from_pretrained(
    model_name=BASE_MODEL,
    max_seq_length=MAX_SEQ_LEN,
    load_in_4bit=True,
    dtype=None,  # auto (bf16 on Ampere+)
)

# 2. Attach a HIGH-capacity LoRA over ALL linear projections.
model = FastLanguageModel.get_peft_model(
    model,
    r=64,
    lora_alpha=128,            # alpha = 2*r — strong adapter
    lora_dropout=0.05,
    bias="none",
    target_modules=[
        "q_proj", "k_proj", "v_proj", "o_proj",
        "gate_proj", "up_proj", "down_proj",
    ],
    use_gradient_checkpointing="unsloth",  # long context + all-layer headroom
    use_rslora=True,           # rank-stabilized LoRA — better at high rank
    random_state=3407,
)

# 3. Dataset — apply the model's chat template to {"messages":[...]} rows.
ds = load_dataset(
    "json",
    data_files={
        "train": os.path.join(DATA_DIR, "train.jsonl"),
        "valid": os.path.join(DATA_DIR, "valid.jsonl"),
    },
)

def format_chat(batch):
    return {
        "text": [
            tokenizer.apply_chat_template(m, tokenize=False, add_generation_prompt=False)
            for m in batch["messages"]
        ]
    }

ds = ds.map(format_chat, batched=True, remove_columns=ds["train"].column_names)

# 4. Train. SFTConfig with cosine schedule + warmup.
trainer = SFTTrainer(
    model=model,
    tokenizer=tokenizer,
    train_dataset=ds["train"],
    eval_dataset=ds["valid"],
    args=SFTConfig(
        dataset_text_field="text",
        max_seq_length=MAX_SEQ_LEN,
        packing=False,                  # keep agent traces intact (don't pack across sessions)
        per_device_train_batch_size=BATCH,
        gradient_accumulation_steps=GRAD_ACCUM,
        num_train_epochs=EPOCHS,
        learning_rate=LR,
        lr_scheduler_type="cosine",
        warmup_ratio=0.05,
        bf16=True,
        optim="adamw_8bit",
        weight_decay=0.01,
        logging_steps=5,
        eval_strategy="steps",
        eval_steps=50,
        save_steps=100,
        output_dir=OUTPUT,
        seed=3407,
        report_to="none",
    ),
)

# Train ONLY on assistant responses (mask the prompt) — sharper, less overfit to inputs.
# The markers below match Qwen/ChatML; adjust for a different base's chat template.
try:
    trainer = train_on_responses_only(
        trainer,
        instruction_part="<|im_start|>user\n",
        response_part="<|im_start|>assistant\n",
    )
except Exception as e:  # noqa: BLE001 — non-ChatML templates: fall back to full-sequence loss
    print(f"[qlora] train_on_responses_only skipped ({e}); training on full sequences.")

trainer.train()

# 5. Save the adapter. (Optionally export merged + GGUF for Ollama — uncomment.)
model.save_pretrained(OUTPUT)
tokenizer.save_pretrained(OUTPUT)
print(f"\nSaved QLoRA adapter → {OUTPUT}")

# model.save_pretrained_merged("qodex-merged", tokenizer, save_method="merged_16bit")
# model.save_pretrained_gguf("qodex-gguf", tokenizer, quantization_method="q4_k_m")
print("To run in Ollama: export GGUF (see commented lines), then `ollama create`. ")
print("To run in LM Studio: merge to 16-bit and convert to MLX, or use the GGUF.")
