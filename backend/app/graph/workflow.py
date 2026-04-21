from __future__ import annotations

import logging
from pathlib import Path

from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, StateGraph

from app.agents.nodes import (
    coordinator_node,
    critic_node,
    degraded_handler_node,
    researcher_node,
    should_coordinator_route,
    should_critic_route,
    should_research_continue,
    writer_node,
)
from app.core.config import settings
from app.graph.state import AgentState

logger = logging.getLogger("app.workflow")


def _postgres_dsn_for_langgraph() -> str:
    # langgraph postgres saver expects psycopg URI scheme.
    return settings.postgres_dsn.replace("postgresql+psycopg://", "postgresql://")


def _build_sqlite_checkpointer():
    """Local-file checkpointer for native-app deployments (no Docker).

    The workflow is invoked via ``ainvoke``, so we need the async variant.
    AsyncSqliteSaver wraps aiosqlite and is drop-in compatible with the
    checkpointer interface langgraph expects.
    """
    from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

    path = Path(settings.sqlite_checkpoint_path).expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    # AsyncSqliteSaver.from_conn_string returns an async context manager. We
    # enter it manually so the saver stays alive for the process lifetime.
    cm = AsyncSqliteSaver.from_conn_string(str(path))
    # __aenter__ returns a coroutine; we need to run it. Use a tiny one-shot
    # event loop since this happens once at graph-build time.
    import asyncio as _asyncio

    loop = _asyncio.new_event_loop()
    try:
        saver = loop.run_until_complete(cm.__aenter__())
    finally:
        loop.close()
    # setup() on AsyncSqliteSaver is async too — same pattern.
    loop2 = _asyncio.new_event_loop()
    try:
        loop2.run_until_complete(saver.setup())
    finally:
        loop2.close()
    logger.info("langgraph async-sqlite checkpointer ready at %s", path)
    return saver


def build_checkpointer():
    """Pick the durable checkpointer that matches the current deployment.

    Priority:
      1. Postgres, if ``postgres_dsn`` is set (legacy Docker stack).
      2. SQLite file at ``sqlite_checkpoint_path`` (native-app default).
      3. In-memory fallback (last resort, state lost on restart).
    """
    if settings.postgres_dsn:
        try:
            from langgraph.checkpoint.postgres import PostgresSaver

            cm = PostgresSaver.from_conn_string(_postgres_dsn_for_langgraph())
            # Newer langgraph versions return a context manager from from_conn_string.
            # Support both shapes without branching on the library version.
            saver = cm.__enter__() if hasattr(cm, "__enter__") else cm
            saver.setup()
            logger.info("langgraph postgres checkpointer ready")
            return saver
        except Exception as exc:
            logger.warning("postgres checkpointer failed (%s); falling back to sqlite", exc)

    try:
        return _build_sqlite_checkpointer()
    except Exception as exc:
        logger.warning("sqlite checkpointer failed (%s); falling back to in-memory", exc)
        return MemorySaver()


def build_graph():
    graph = StateGraph(AgentState)

    graph.add_node("coordinator", coordinator_node)
    graph.add_node("researcher", researcher_node)
    graph.add_node("critic", critic_node)
    graph.add_node("writer", writer_node)
    graph.add_node("degraded", degraded_handler_node)

    graph.set_entry_point("coordinator")
    graph.add_conditional_edges(
        "coordinator",
        should_coordinator_route,
        {
            "researcher": "researcher",
            "writer": "writer",
            "degraded": "degraded",
        },
    )

    graph.add_conditional_edges(
        "researcher",
        should_research_continue,
        {
            "critic": "critic",
            "degraded": "degraded",
        },
    )

    graph.add_conditional_edges(
        "critic",
        should_critic_route,
        {
            "researcher": "researcher",
            "writer": "writer",
            "degraded": "degraded",
        },
    )

    graph.add_edge("writer", END)
    graph.add_edge("degraded", END)

    return graph.compile(checkpointer=build_checkpointer())
