"""LoRA fine-tune a small base model on your brain's conversation history.

Intended to run locally against a JSONL you export with:

    curl -o data.jsonl "http://127.0.0.1:8000/training/export"

Defaults to Llama 3.2 3B Instruct + 4-bit QLoRA so it trains on a single
consumer GPU (8–12 GB VRAM). Override via CLI flags for anything bigger.

Quick start (from the repo root):

    python -m venv .venv-train
    source .venv-train/bin/activate
    pip install -r training/requirements.txt
    python training/finetune.py \
        --jsonl data.jsonl \
        --model meta-llama/Llama-3.2-3B-Instruct \
        --output ./training/out \
        --epochs 3 --max-seq-len 2048

After it finishes, load it with PEFT:

    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer
    base = AutoModelForCausalLM.from_pretrained("meta-llama/Llama-3.2-3B-Instruct")
    model = PeftModel.from_pretrained(base, "./training/out")
    tokenizer = AutoTokenizer.from_pretrained("meta-llama/Llama-3.2-3B-Instruct")

Or merge the adapter into the base for simpler serving:

    merged = model.merge_and_unload()
    merged.save_pretrained("./training/merged")
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--jsonl", required=True, type=Path, help="Path to the conversations JSONL")
    p.add_argument(
        "--model",
        default="meta-llama/Llama-3.2-3B-Instruct",
        help="Base model id from Hugging Face",
    )
    p.add_argument("--output", default=Path("./training/out"), type=Path, help="Adapter output directory")
    p.add_argument("--epochs", type=float, default=3.0)
    p.add_argument("--batch-size", type=int, default=1)
    p.add_argument("--grad-accum", type=int, default=8)
    p.add_argument("--lr", type=float, default=2e-4)
    p.add_argument("--max-seq-len", type=int, default=2048)
    p.add_argument("--lora-r", type=int, default=16)
    p.add_argument("--lora-alpha", type=int, default=32)
    p.add_argument("--lora-dropout", type=float, default=0.05)
    p.add_argument("--quant", choices=["4bit", "8bit", "none"], default="4bit")
    p.add_argument("--val-split", type=float, default=0.05)
    return p.parse_args()


def load_dataset(path: Path):
    from datasets import Dataset

    rows: list[dict] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            if not isinstance(obj, dict) or "messages" not in obj:
                continue
            msgs = obj["messages"]
            if not isinstance(msgs, list) or len(msgs) < 2:
                continue
            rows.append({"messages": msgs})
    if not rows:
        raise RuntimeError(f"No rows found in {path}. Did the export run find any conversations?")
    return Dataset.from_list(rows)


def main() -> int:
    args = parse_args()

    # Imports are lazy so `--help` works without installing the heavy deps.
    import torch
    from datasets import DatasetDict
    from peft import LoraConfig
    from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
    from trl import SFTConfig, SFTTrainer

    dataset = load_dataset(args.jsonl)
    val_count = max(1, int(len(dataset) * args.val_split)) if args.val_split else 0
    if val_count and val_count < len(dataset):
        split = dataset.train_test_split(test_size=val_count, seed=42)
        dataset = DatasetDict({"train": split["train"], "validation": split["test"]})
    else:
        dataset = DatasetDict({"train": dataset})

    print(
        f"Loaded {sum(len(v) for v in dataset.values())} examples "
        f"({', '.join(f'{k}={len(v)}' for k, v in dataset.items())})",
        file=sys.stderr,
    )

    tokenizer = AutoTokenizer.from_pretrained(args.model, use_fast=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32
    quant_config = None
    if args.quant != "none" and torch.cuda.is_available():
        quant_config = BitsAndBytesConfig(
            load_in_4bit=args.quant == "4bit",
            load_in_8bit=args.quant == "8bit",
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=dtype,
            bnb_4bit_use_double_quant=True,
        )

    model = AutoModelForCausalLM.from_pretrained(
        args.model,
        torch_dtype=dtype,
        quantization_config=quant_config,
        device_map="auto",
        trust_remote_code=True,
    )
    model.config.use_cache = False

    peft_config = LoraConfig(
        r=args.lora_r,
        lora_alpha=args.lora_alpha,
        lora_dropout=args.lora_dropout,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=[
            "q_proj",
            "k_proj",
            "v_proj",
            "o_proj",
            "gate_proj",
            "up_proj",
            "down_proj",
        ],
    )

    training_args = SFTConfig(
        output_dir=str(args.output),
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch_size,
        gradient_accumulation_steps=args.grad_accum,
        learning_rate=args.lr,
        lr_scheduler_type="cosine",
        warmup_ratio=0.05,
        logging_steps=10,
        save_strategy="epoch",
        eval_strategy="epoch" if "validation" in dataset else "no",
        max_length=args.max_seq_len,
        report_to="none",
        bf16=dtype == torch.bfloat16,
        gradient_checkpointing=True,
        packing=False,
    )

    trainer = SFTTrainer(
        model=model,
        processing_class=tokenizer,
        args=training_args,
        train_dataset=dataset["train"],
        eval_dataset=dataset.get("validation"),
        peft_config=peft_config,
    )
    trainer.train()
    trainer.save_model(str(args.output))
    tokenizer.save_pretrained(str(args.output))
    print(f"\nSaved adapter to {args.output.resolve()}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
