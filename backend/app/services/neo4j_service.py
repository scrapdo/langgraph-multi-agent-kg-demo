from __future__ import annotations

from typing import Any

from neo4j import GraphDatabase

from app.core.config import settings


class Neo4jService:
    def __init__(self) -> None:
        self._driver = GraphDatabase.driver(
            settings.neo4j_uri,
            auth=(settings.neo4j_user, settings.neo4j_password),
        )

    def close(self) -> None:
        self._driver.close()

    def upsert_run(self, run_id: str, task: str, status: str) -> None:
        query = """
        MERGE (r:Run {id: $run_id})
        SET r.task = $task, r.status = $status, r.updated_at = datetime()
        """
        with self._driver.session() as session:
            session.run(query, run_id=run_id, task=task, status=status)

    def log_node_execution(self, run_id: str, node: str, detail: str) -> None:
        query = """
        MERGE (r:Run {id: $run_id})
        MERGE (a:Agent {name: $node})
        MERGE (r)-[:ASSIGNED_TO]->(a)
        MERGE (te:ToolExecution {id: randomUUID()})
        SET te.detail = $detail, te.created_at = datetime()
        MERGE (a)-[:USED_TOOL]->(te)
        """
        with self._driver.session() as session:
            session.run(query, run_id=run_id, node=node, detail=detail)

    def create_claim_and_source(self, run_id: str, claim: str, source: str) -> None:
        query = """
        MERGE (r:Run {id: $run_id})
        MERGE (c:Claim {text: $claim})
        MERGE (s:Source {url: $source})
        MERGE (c)-[:SUPPORTS]->(s)
        MERGE (r)-[:PRODUCED]->(c)
        """
        with self._driver.session() as session:
            session.run(query, run_id=run_id, claim=claim, source=source)

    def fetch_graph(self, limit: int = 100) -> dict[str, Any]:
        query = """
        MATCH (n)
        OPTIONAL MATCH (n)-[r]->(m)
        RETURN n, r, m
        LIMIT $limit
        """
        nodes: dict[str, dict[str, Any]] = {}
        edges: list[dict[str, Any]] = []
        with self._driver.session() as session:
            result = session.run(query, limit=limit)
            for record in result:
                n = record.get("n")
                r = record.get("r")
                m = record.get("m")
                if n is not None:
                    nodes[str(n.id)] = {
                        "id": str(n.id),
                        "labels": list(n.labels),
                        "properties": dict(n),
                    }
                if m is not None:
                    nodes[str(m.id)] = {
                        "id": str(m.id),
                        "labels": list(m.labels),
                        "properties": dict(m),
                    }
                if r is not None and n is not None and m is not None:
                    edges.append(
                        {
                            "id": str(r.id),
                            "type": r.type,
                            "source": str(n.id),
                            "target": str(m.id),
                            "properties": dict(r),
                        }
                    )
        return {"nodes": list(nodes.values()), "edges": edges}


neo4j_service = Neo4jService()
