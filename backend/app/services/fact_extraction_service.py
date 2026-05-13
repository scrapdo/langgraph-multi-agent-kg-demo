"""Lightweight post-run fact extractor.

After a conversation turn, ask a fast LLM whether there's anything worth
remembering about the operator. Returns a structured proposal the UI can
accept or dismiss with one click.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from app.services.model_router_service import build_llm
from app.services.user_profile_service import user_profile_service

logger = logging.getLogger("app.fact_extraction")

_SYSTEM_PROMPT = (
    "You are a memory extractor helping a personal AI assistant remember facts about its "
    "operator across conversations. Read the user's latest message and the assistant's reply, "
    "then decide whether there is anything durably worth remembering about the operator — "
    "their identity, role, location, preferences, goals, relationships, projects, or other "
    "context that would improve future responses. "
    "Do NOT remember transient task details, one-off research topics, or the assistant's opinions. "
    "Do NOT duplicate anything already present in the current profile."
)

_USER_TEMPLATE = """Current operator profile (what we already know):
```json
{profile}
```

User said:
\"\"\"
{user_task}
\"\"\"

Assistant replied:
\"\"\"
{assistant_output}
\"\"\"

Reply with strict JSON matching this schema. No prose, no markdown fences.

{{
  "has_new_facts": true | false,
  "proposals": {{
    "name"?: "string",
    "role"?: "string",
    "location"?: "string",
    "timezone"?: "string",
    "current_focus"?: "string",
    "preferences"?: "string (append-style)",
    "goals_add"?: ["..."],
    "notes_add"?: "single-line fact worth remembering"
  }},
  "reason": "one short sentence about why these should be remembered"
}}

If there is nothing worth remembering, return {{"has_new_facts": false, "proposals": {{}}, "reason": ""}}.
"""


def _strip_fences(text: str) -> str:
    t = text.strip()
    if t.startswith("```"):
        t = re.sub(r"^```[a-zA-Z0-9_-]*\n?", "", t)
        t = re.sub(r"\n?```\s*$", "", t)
    return t.strip()


async def extract_facts(user_task: str, assistant_output: str) -> dict[str, Any]:
    """Return a proposal dict. Always safe to fail — returns empty on any error."""
    user_task = (user_task or "").strip()
    assistant_output = (assistant_output or "").strip()
    if not user_task or not assistant_output:
        return {"has_new_facts": False, "proposals": {}, "reason": ""}

    # Strip the operator-profile framing before we send it back to the extractor.
    if user_task.startswith("[Operator profile"):
        end = user_task.find("[/Operator profile]")
        if end != -1:
            user_task = user_task[end + len("[/Operator profile]"):].strip()

    profile = user_profile_service.get()
    # Trim to keep the prompt small.
    profile_for_prompt = {k: v for k, v in profile.items() if k != "updated_at" and v}
    prompt = _USER_TEMPLATE.format(
        profile=json.dumps(profile_for_prompt, ensure_ascii=False),
        user_task=user_task[:2000],
        assistant_output=assistant_output[:3000],
    )

    try:
        llm = build_llm(temperature=0.1)
        response = await llm.ainvoke([
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ])
        raw = getattr(response, "content", None) or str(response)
        parsed = json.loads(_strip_fences(str(raw)))
        if not isinstance(parsed, dict):
            return {"has_new_facts": False, "proposals": {}, "reason": ""}
        parsed.setdefault("has_new_facts", False)
        parsed.setdefault("proposals", {})
        parsed.setdefault("reason", "")
        if not isinstance(parsed["proposals"], dict):
            parsed["proposals"] = {}
        return parsed
    except Exception as exc:
        logger.debug("fact_extraction_failed", extra={"error": str(exc)})
        return {"has_new_facts": False, "proposals": {}, "reason": ""}


def apply_proposals(proposals: dict[str, Any]) -> dict[str, Any]:
    """Merge proposals into the persisted profile. Returns the new profile."""
    profile = user_profile_service.get()
    updates: dict[str, Any] = {}

    scalar_fields = ("name", "role", "location", "timezone", "current_focus")
    for key in scalar_fields:
        value = proposals.get(key)
        if isinstance(value, str) and value.strip() and not profile.get(key):
            updates[key] = value.strip()

    pref = proposals.get("preferences")
    if isinstance(pref, str) and pref.strip():
        existing = str(profile.get("preferences") or "").strip()
        updates["preferences"] = f"{existing}\n{pref.strip()}".strip() if existing else pref.strip()

    goals_add = proposals.get("goals_add") or []
    if isinstance(goals_add, list) and goals_add:
        existing = [str(g).strip() for g in (profile.get("goals") or []) if str(g).strip()]
        for g in goals_add:
            if isinstance(g, str) and g.strip() and g.strip() not in existing:
                existing.append(g.strip())
        updates["goals"] = existing

    notes_add = proposals.get("notes_add")
    if isinstance(notes_add, str) and notes_add.strip():
        existing = str(profile.get("notes") or "").strip()
        bullet = f"- {notes_add.strip()}"
        updates["notes"] = f"{existing}\n{bullet}".strip() if existing else bullet

    if not updates:
        return profile
    return user_profile_service.save(updates)
