from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.repositories.run_store import run_store
from app.services.memory_service import memory_service
from app.services.neo4j_service import neo4j_service


def _utc_now() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def _action_content(action: dict[str, Any]) -> tuple[str, str]:
    kind = str(action.get("kind") or "")
    output_path = str(action.get("output_path") or "").strip()
    if not output_path:
        return "", output_path
    path = Path(output_path)
    file_path = path
    if kind == "gmail_calendar":
        file_path = path if path.suffix == ".md" else path / "snapshot.md"
    elif kind == "writer_doc":
        file_path = path if path.suffix == ".md" else Path(f"{output_path}.md")
    elif kind in {"social_package", "ai_influencer"}:
        file_path = path / "brief.md"
    try:
        return file_path.read_text(encoding="utf-8").strip(), output_path
    except Exception:
        return "", output_path


async def ingest_desktop_action(action: dict[str, Any]) -> None:
    if str(action.get("status")) != "completed":
        return

    payload = dict(action.get("payload") or {})
    run_id = str(payload.get("run_id") or "").strip()
    if not run_id:
        return
    rec = run_store.get(run_id)
    if not rec:
        return

    content, output_path = _action_content(action)
    if not content:
        return

    state = dict(rec.get("state") or {})
    thread_id = str(state.get("thread_id") or rec.get("run_id") or "").strip()
    user_id = str(state.get("user_id") or "demo-user")
    agent_id = str(action.get("agent_id") or payload.get("owner_agent") or "coordinator")
    kind = str(action.get("kind") or "desktop_action")
    action_type = str(payload.get("action_type") or kind)
    episode_type = f"desktop_{action_type}"
    previous_episode_id = state.get("last_episode_id")
    metadata = {
        "desktop_action_id": str(action.get("action_id") or ""),
        "desktop_kind": kind,
        "action_type": action_type,
        "output_path": output_path,
    }

    episode_id = neo4j_service.create_episode(
        run_id,
        thread_id,
        agent_id,
        episode_type,
        content,
        metadata=metadata,
        previous_episode_id=previous_episode_id,
    )
    artifact_id = neo4j_service.create_desktop_artifact(
        run_id,
        thread_id,
        agent_id,
        action_id=str(action.get("action_id") or ""),
        kind=kind,
        title=str(action.get("title") or kind),
        output_path=output_path,
        action_type=action_type,
        episode_id=episode_id,
    )
    memory_ref = await memory_service.add_episode(
        user_id,
        thread_id,
        content,
        source_description=f"{agent_id}:desktop",
        episode_type=episode_type,
    )
    await memory_service.add_message(
        user_id,
        thread_id,
        role="assistant",
        content=content,
        metadata={"run_id": run_id, "agent_id": agent_id, "episode_id": episode_id, **metadata},
        return_context=False,
    )

    def transform(current: dict) -> dict:
        artifacts = list(current.get("desktop_artifacts") or [])
        if not any(item.get("action_id") == action.get("action_id") for item in artifacts):
            artifacts.append(
                {
                    "artifact_id": artifact_id,
                    "action_id": action.get("action_id"),
                    "kind": kind,
                    "agent_id": agent_id,
                    "action_type": action_type,
                    "title": action.get("title"),
                    "output_path": output_path,
                    "created_at": _utc_now(),
                }
            )
        current["desktop_artifacts"] = artifacts[-24:]
        current["last_episode_id"] = episode_id
        episodes = list(current.get("episodes") or [])
        episodes.append(
            {
                "episode_id": episode_id,
                "thread_id": thread_id,
                "run_id": run_id,
                "agent_id": agent_id,
                "episode_type": episode_type,
                "content": content,
                "created_at": _utc_now(),
                "metadata": metadata,
            }
        )
        current["episodes"] = episodes[-24:]
        if memory_ref:
            refs = list(current.get("memory_refs") or [])
            seen = {str(item.get("memory_id") or "") for item in refs}
            if str(memory_ref.get("memory_id") or "") not in seen:
                refs.append(memory_ref)
            current["memory_refs"] = refs[-16:]
        return current

    run_store.update_state(run_id, transform)
