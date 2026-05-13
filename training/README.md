# Fine-tune a small model on your brain's conversations

This folder turns your run history into a LoRA adapter that sounds like you
and knows what you care about. Training happens on your hardware (single
consumer GPU ≈ enough for 3B base models).

## 1. Export your data

With the brain running:

```bash
curl -o data.jsonl "http://127.0.0.1:8000/training/export?min_tokens=40"
wc -l data.jsonl   # how many conversations you have
```

Each line is OpenAI chat format:

```json
{
  "messages": [
    {"role": "system",    "content": "You are a personal AI assistant..."},
    {"role": "user",      "content": "..."},
    {"role": "assistant", "content": "..."}
  ]
}
```

Tweak `min_tokens` to filter out trivial answers. The system prompt embeds
your operator profile so the trained model inherits your preferences.

## 2. Set up a training environment

This is intentionally a separate virtualenv — training deps are heavy and
you don't want them polluting the backend runtime.

```bash
python3 -m venv .venv-train
source .venv-train/bin/activate
pip install -r training/requirements.txt
```

If you're on Apple Silicon, `bitsandbytes` won't install — the training
script falls back to `--quant none` which uses full-precision bf16. Recommend
running actual training on a CUDA machine (Linux / Windows WSL). On an M-series
Mac it will run but be slow.

## 3. Train

```bash
python training/finetune.py \
  --jsonl data.jsonl \
  --model meta-llama/Llama-3.2-3B-Instruct \
  --output training/out \
  --epochs 3 \
  --max-seq-len 2048
```

Key flags worth knowing:

- `--model` — try `Qwen/Qwen2.5-3B-Instruct`, `mistralai/Mistral-7B-Instruct-v0.3`,
  `meta-llama/Llama-3.1-8B-Instruct` for larger VRAM budgets. 7B needs ~16 GB
  VRAM with 4-bit QLoRA.
- `--quant 4bit|8bit|none` — 4-bit keeps memory tiny; `none` if you have the
  VRAM or no bitsandbytes support.
- `--epochs 2–4` depending on dataset size. Less for > 2k examples.
- `--val-split 0.05` — auto-splits 5% for validation loss. Set `0` to skip.

Outputs go to `training/out/` as an adapter (checkpoints per epoch + final).

## 4. Load the adapter

```python
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer

base = "meta-llama/Llama-3.2-3B-Instruct"
model = AutoModelForCausalLM.from_pretrained(base, device_map="auto")
model = PeftModel.from_pretrained(model, "training/out")
tokenizer = AutoTokenizer.from_pretrained(base)
```

Or merge + save a single model for simpler serving:

```python
merged = model.merge_and_unload()
merged.save_pretrained("training/merged")
tokenizer.save_pretrained("training/merged")
```

## 5. Use it from the brain

Once you have a merged model dir:

1. Serve it locally via `text-generation-inference`, `vLLM`, `llama.cpp`, or
   an OpenAI-compatible proxy like `litellm`.
2. Point the brain at it by setting these in `~/.config/the-brain/secrets.env`:

   ```
   OPENAI_BASE_URL=http://127.0.0.1:8080/v1     # or wherever your local server listens
   OPENAI_API_KEY=local                          # anything non-empty
   OPENAI_MODEL=your-merged-model
   ```

3. Restart the backend. The model router picks up the OpenAI-compatible
   provider and routes calls to your local inference.

## Honest caveats

- 100–500 conversations isn't a lot of data. You'll see voice / style drift
  toward you, but factual grounding still comes from Zep + Neo4j + tool calls
  at runtime.
- Fine-tuning doesn't replace memory. Keep your profile, Zep, and the memory
  library in use — the model learns *how you like things*, not *what's
  happening today*.
- Don't commit the JSONL export to git. It's the full transcript of your
  personal conversations.
