from __future__ import annotations

from app.core.config import settings


def live_tools() -> set[str]:
    return {x.strip() for x in settings.side_effect_live_tools_csv.split(',') if x.strip()}


def can_execute_live(tool_name: str, mode: str) -> bool:
    if mode != 'live':
        return False
    return tool_name in live_tools()
