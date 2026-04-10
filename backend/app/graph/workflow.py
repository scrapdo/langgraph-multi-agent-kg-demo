from __future__ import annotations

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


def _dsn_for_langgraph() -> str:
    # langgraph postgres saver expects psycopg URI scheme.
    return settings.postgres_dsn.replace("postgresql+psycopg://", "postgresql://")


def build_checkpointer():
    try:
        from langgraph.checkpoint.postgres import PostgresSaver

        saver = PostgresSaver.from_conn_string(_dsn_for_langgraph())
        saver.setup()
        return saver
    except Exception:
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
