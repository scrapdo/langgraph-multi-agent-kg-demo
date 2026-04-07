from __future__ import annotations

import asyncio
from functools import lru_cache
from types import SimpleNamespace
from typing import Any

from app.core.config import settings

try:
    from huggingface_hub import HfApi, InferenceClient
except Exception:  # pragma: no cover
    HfApi = None  # type: ignore
    InferenceClient = None  # type: ignore

try:
    import torch
except Exception:  # pragma: no cover
    torch = None  # type: ignore

try:
    from transformers import AutoModelForCausalLM, AutoTokenizer, pipeline
except Exception:  # pragma: no cover
    AutoModelForCausalLM = None  # type: ignore
    AutoTokenizer = None  # type: ignore
    pipeline = None  # type: ignore

try:
    from optimum.onnxruntime import ORTModelForCausalLM
except Exception:  # pragma: no cover
    ORTModelForCausalLM = None  # type: ignore


class TransformersLocalAdapter:
    def __init__(self, model_id: str, temperature: float = 0.2) -> None:
        self.model_id = model_id
        self.temperature = temperature

    async def ainvoke(self, prompt: str):
        text = await asyncio.to_thread(
            huggingface_service.generate_text_local,
            prompt,
            self.model_id,
            self.temperature,
        )
        return SimpleNamespace(content=text)


class HuggingFaceService:
    def hub_enabled(self) -> bool:
        return HfApi is not None

    def inference_enabled(self) -> bool:
        return InferenceClient is not None

    def transformers_enabled(self) -> bool:
        return bool(pipeline and AutoTokenizer and AutoModelForCausalLM and torch)

    def optimum_enabled(self) -> bool:
        return ORTModelForCausalLM is not None

    def status(self) -> dict[str, Any]:
        return {
            "hub": "enabled" if self.hub_enabled() else "disabled",
            "inference": "enabled" if self.inference_enabled() else "disabled",
            "transformers_local": "enabled" if self.transformers_enabled() else "disabled",
            "optimum": "enabled" if self.optimum_enabled() else "disabled",
            "parler_tts": "enabled" if self.inference_enabled() else "disabled",
            "local_model": settings.transformers_local_model,
            "parler_model": settings.parler_tts_model,
            "optimum_acceleration": settings.transformers_use_optimum and self.optimum_enabled(),
        }

    @lru_cache(maxsize=1)
    def _api(self):
        if HfApi is None:
            raise RuntimeError("huggingface_hub is not installed")
        token = settings.huggingface_api_key or None
        return HfApi(token=token)

    def _client(self):
        if InferenceClient is None:
            raise RuntimeError("huggingface_hub inference client is not installed")
        return InferenceClient(token=settings.huggingface_api_key or None, timeout=120)

    async def search_models(self, query: str = "", limit: int = 8, task: str | None = None) -> dict[str, Any]:
        api = self._api()
        raw_results = await asyncio.to_thread(
            lambda: list(api.list_models(search=query or None, limit=max(limit * 3, limit), sort="downloads")),
        )
        normalized_task = (task or "").strip().lower()
        results = []
        for item in raw_results:
            if normalized_task:
                pipeline_tag = str(getattr(item, "pipeline_tag", "") or "").lower()
                tags = [str(tag).lower() for tag in getattr(item, "tags", [])]
                if normalized_task != pipeline_tag and normalized_task not in tags:
                    continue
            results.append(item)
            if len(results) >= limit:
                break
        items = [
            {
                "id": item.id,
                "downloads": getattr(item, "downloads", None),
                "likes": getattr(item, "likes", None),
                "pipeline_tag": getattr(item, "pipeline_tag", None),
                "library_name": getattr(item, "library_name", None),
                "tags": list(getattr(item, "tags", [])[:8]),
                "link": f"https://huggingface.co/{item.id}",
            }
            for item in results
        ]
        return {"items": items}

    async def search_datasets(self, query: str = "", limit: int = 8) -> dict[str, Any]:
        api = self._api()
        results = await asyncio.to_thread(
            lambda: list(api.list_datasets(search=query or None, limit=limit, sort="downloads")),
        )
        items = [
            {
                "id": item.id,
                "downloads": getattr(item, "downloads", None),
                "likes": getattr(item, "likes", None),
                "tags": list(getattr(item, "tags", [])[:8]),
                "link": f"https://huggingface.co/datasets/{item.id}",
            }
            for item in results
        ]
        return {"items": items}

    async def search_spaces(self, query: str = "", limit: int = 8) -> dict[str, Any]:
        api = self._api()
        results = await asyncio.to_thread(
            lambda: list(api.list_spaces(search=query or None, limit=limit, sort="likes")),
        )
        items = [
            {
                "id": item.id,
                "likes": getattr(item, "likes", None),
                "sdk": getattr(item, "sdk", None),
                "link": f"https://huggingface.co/spaces/{item.id}",
            }
            for item in results
        ]
        return {"items": items}

    async def synthesize_parler(self, text: str, persona: str) -> bytes:
        client = self._client()
        description = persona.strip() or settings.parler_tts_voice_description
        try:
            return await asyncio.wait_for(
                asyncio.to_thread(
                    client.text_to_speech,
                    text,
                    model=settings.parler_tts_model,
                    extra_body={"description": description},
                ),
                timeout=20,
            )
        except TimeoutError as exc:
            raise RuntimeError("Parler TTS timed out while waiting for Hugging Face inference") from exc

    @lru_cache(maxsize=2)
    def _load_local_pipeline(self, model_id: str):
        if not self.transformers_enabled():
            raise RuntimeError("Local Transformers provider requires transformers and torch in the backend environment")

        tokenizer = AutoTokenizer.from_pretrained(model_id)
        if tokenizer.pad_token_id is None and tokenizer.eos_token_id is not None:
            tokenizer.pad_token_id = tokenizer.eos_token_id

        if settings.transformers_use_optimum and self.optimum_enabled():
            model = ORTModelForCausalLM.from_pretrained(model_id, export=True)
            return pipeline("text-generation", model=model, tokenizer=tokenizer)

        model_kwargs: dict[str, Any] = {}
        if settings.transformers_device == "cpu":
            model_kwargs["torch_dtype"] = getattr(torch, "float32", None)
        model = AutoModelForCausalLM.from_pretrained(model_id, **{k: v for k, v in model_kwargs.items() if v is not None})
        pipe_kwargs: dict[str, Any] = {"model": model, "tokenizer": tokenizer}
        if settings.transformers_device == "auto":
            pipe_kwargs["device_map"] = "auto"
        elif settings.transformers_device == "cpu":
            pipe_kwargs["device"] = -1
        return pipeline("text-generation", **pipe_kwargs)

    def generate_text_local(self, prompt: str, model_id: str | None = None, temperature: float = 0.2) -> str:
        resolved_model = (model_id or settings.transformers_local_model).strip()
        pipe = self._load_local_pipeline(resolved_model)
        outputs = pipe(
            prompt,
            max_new_tokens=settings.transformers_max_new_tokens,
            do_sample=temperature > 0.01,
            temperature=max(0.01, temperature),
            return_full_text=False,
            pad_token_id=getattr(pipe.tokenizer, "pad_token_id", None) or getattr(pipe.tokenizer, "eos_token_id", None),
        )
        first = outputs[0] if isinstance(outputs, list) and outputs else {}
        text = str(first.get("generated_text") or "").strip()
        return text or "No response generated."


huggingface_service = HuggingFaceService()
