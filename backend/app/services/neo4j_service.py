from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime
from typing import Any

from app.core.config import settings

logger = logging.getLogger("app.neo4j")

# Neo4j is optional. The native-app bundle ships without the driver to keep
# binary size down; the Docker stack keeps it installed. If the package is
# missing, we skip graph storage entirely (no-op driver below).
try:
    from neo4j import GraphDatabase  # type: ignore[import-not-found]
    _NEO4J_AVAILABLE = True
except Exception:
    GraphDatabase = None  # type: ignore[assignment]
    _NEO4J_AVAILABLE = False


class _NoOpResult:
    """Sink that mimics the shape of a neo4j Result but holds no data. Used
    when Neo4j is unconfigured or unreachable in native-app builds."""

    def single(self) -> None:
        return None

    def data(self) -> list:
        return []

    def values(self, *_: Any) -> list:
        return []

    def __iter__(self):
        return iter([])


class _NoOpSession:
    def __enter__(self) -> "_NoOpSession":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None

    def run(self, *_: Any, **__: Any) -> _NoOpResult:
        return _NoOpResult()


class _NoOpDriver:
    """Drop-in replacement for a neo4j Driver when Neo4j is disabled.

    Every .session() produces a no-op context manager; every .run() returns
    an empty result. That lets the rest of the codebase stay identical while
    graph storage silently becomes a no-op.
    """

    def session(self, *_: Any, **__: Any) -> _NoOpSession:
        return _NoOpSession()

    def close(self) -> None:
        return None


def _build_driver() -> Any:
    """Return a real neo4j Driver when configured and reachable, otherwise a
    no-op driver. Native-app builds leave ``neo4j_uri`` blank so graph storage
    is skipped entirely without crashing anything upstream."""
    if not _NEO4J_AVAILABLE:
        logger.info("neo4j package not installed — graph storage is a no-op")
        return _NoOpDriver()
    uri = (settings.neo4j_uri or "").strip()
    if not uri:
        logger.info("Neo4j disabled (no URI configured) — graph storage is a no-op")
        return _NoOpDriver()
    try:
        driver = GraphDatabase.driver(uri, auth=(settings.neo4j_user, settings.neo4j_password))
        # Probe the connection so we fail fast if the server isn't there.
        driver.verify_connectivity()
        return driver
    except Exception as exc:
        logger.warning("Neo4j connection failed (%s) — falling back to no-op driver", exc)
        return _NoOpDriver()


class Neo4jService:
    def __init__(self) -> None:
        self._driver = _build_driver()
        self._constraints_ready = isinstance(self._driver, _NoOpDriver)

    @property
    def enabled(self) -> bool:
        return not isinstance(self._driver, _NoOpDriver)

    def close(self) -> None:
        self._driver.close()

    def _normalize_value(self, value: Any) -> Any:
        if value is None or isinstance(value, (str, int, float, bool)):
            return value
        if isinstance(value, datetime):
            return value.isoformat()
        isoformat = getattr(value, "isoformat", None)
        if callable(isoformat):
            try:
                return isoformat()
            except Exception:
                pass
        if isinstance(value, dict):
            return {str(k): self._normalize_value(v) for k, v in value.items()}
        if isinstance(value, (list, tuple, set)):
            return [self._normalize_value(v) for v in value]
        return str(value)

    def _normalize_node_properties(self, node: Any) -> dict[str, Any]:
        return {str(key): self._normalize_value(value) for key, value in dict(node).items()}

    def _ensure_constraints(self) -> None:
        if self._constraints_ready:
            return
        statements = [
            "CREATE CONSTRAINT run_id IF NOT EXISTS FOR (r:Run) REQUIRE r.id IS UNIQUE",
            "CREATE CONSTRAINT thread_id IF NOT EXISTS FOR (t:Thread) REQUIRE t.id IS UNIQUE",
            "CREATE CONSTRAINT episode_id IF NOT EXISTS FOR (e:Episode) REQUIRE e.id IS UNIQUE",
            "CREATE CONSTRAINT claim_id IF NOT EXISTS FOR (c:Claim) REQUIRE c.id IS UNIQUE",
            "CREATE CONSTRAINT tool_execution_id IF NOT EXISTS FOR (te:ToolExecution) REQUIRE te.id IS UNIQUE",
            "CREATE CONSTRAINT desktop_artifact_id IF NOT EXISTS FOR (da:DesktopArtifact) REQUIRE da.id IS UNIQUE",
            "CREATE CONSTRAINT schedule_id IF NOT EXISTS FOR (sc:Schedule) REQUIRE sc.id IS UNIQUE",
            "CREATE CONSTRAINT source_url IF NOT EXISTS FOR (s:Source) REQUIRE s.url IS UNIQUE",
            "CREATE CONSTRAINT entity_canonical_name IF NOT EXISTS FOR (e:Entity) REQUIRE e.canonical_name IS UNIQUE",
        ]
        with self._driver.session() as session:
            for statement in statements:
                session.run(statement)
        self._constraints_ready = True

    def upsert_run(
        self,
        run_id: str,
        task: str,
        status: str,
        *,
        user_id: str | None = None,
        thread_id: str | None = None,
        mode: str | None = None,
        task_type: str | None = None,
    ) -> None:
        self._ensure_constraints()
        query = """
        MERGE (r:Run {id: $run_id})
        ON CREATE SET r.created_at = datetime()
        SET r.task = $task,
            r.status = $status,
            r.user_id = coalesce($user_id, r.user_id),
            r.thread_id = coalesce($thread_id, r.thread_id),
            r.mode = coalesce($mode, r.mode),
            r.task_type = coalesce($task_type, r.task_type),
            r.updated_at = datetime()
        WITH r
        FOREACH (_ IN CASE WHEN $thread_id IS NULL THEN [] ELSE [1] END |
            MERGE (t:Thread {id: $thread_id})
            ON CREATE SET t.created_at = datetime(), t.user_id = $user_id, t.session_id = $thread_id
            SET t.updated_at = datetime(), t.user_id = coalesce($user_id, t.user_id)
            MERGE (r)-[:USES_THREAD]->(t)
        )
        """
        with self._driver.session() as session:
            session.run(
                query,
                run_id=run_id,
                task=task,
                status=status,
                user_id=user_id,
                thread_id=thread_id,
                mode=mode,
                task_type=task_type,
            )

    def upsert_thread(self, thread_id: str, user_id: str, session_id: str | None = None) -> None:
        self._ensure_constraints()
        query = """
        MERGE (t:Thread {id: $thread_id})
        ON CREATE SET t.created_at = datetime()
        SET t.user_id = $user_id,
            t.session_id = coalesce($session_id, t.session_id),
            t.updated_at = datetime()
        """
        with self._driver.session() as session:
            session.run(query, thread_id=thread_id, user_id=user_id, session_id=session_id or thread_id)

    def create_episode(
        self,
        run_id: str,
        thread_id: str,
        agent_id: str,
        episode_type: str,
        content: str,
        *,
        metadata: dict[str, Any] | None = None,
        previous_episode_id: str | None = None,
    ) -> str:
        self._ensure_constraints()
        episode_id = str(uuid.uuid4())
        metadata = metadata or {}
        query = """
        MERGE (r:Run {id: $run_id})
        MERGE (t:Thread {id: $thread_id})
        MERGE (a:Agent {name: $agent_id})
        WITH r, t, a
        OPTIONAL MATCH (prev:Episode {id: $previous_episode_id})
        CREATE (e:Episode {
            id: $episode_id,
            run_id: $run_id,
            thread_id: $thread_id,
            agent_id: $agent_id,
            episode_type: $episode_type,
            content: $content,
            metadata_json: $metadata_json,
            created_at: datetime()
        })
        MERGE (r)-[:HAS_EPISODE]->(e)
        MERGE (t)-[:CONTAINS]->(e)
        MERGE (a)-[:AUTHORED]->(e)
        WITH e, prev
        FOREACH (_ IN CASE WHEN prev IS NULL THEN [] ELSE [1] END |
            MERGE (prev)-[:PRECEDES]->(e)
        )
        RETURN e.id AS episode_id
        """
        with self._driver.session() as session:
            record = session.run(
                query,
                run_id=run_id,
                thread_id=thread_id,
                agent_id=agent_id,
                episode_id=episode_id,
                episode_type=episode_type,
                content=content,
                metadata_json=json.dumps(metadata),
                previous_episode_id=previous_episode_id,
            ).single()
        return str(record["episode_id"]) if record else episode_id

    def record_tool_execution(
        self,
        run_id: str,
        thread_id: str,
        agent_id: str,
        tool_name: str,
        *,
        detail: str,
        ok: bool,
        payload: dict[str, Any] | None = None,
        error: str | None = None,
        episode_id: str | None = None,
    ) -> str:
        self._ensure_constraints()
        execution_id = str(uuid.uuid4())
        query = """
        MERGE (r:Run {id: $run_id})
        MERGE (t:Thread {id: $thread_id})
        MERGE (a:Agent {name: $agent_id})
        WITH r, t, a
        OPTIONAL MATCH (ep:Episode {id: $episode_id})
        CREATE (te:ToolExecution {
            id: $execution_id,
            tool: $tool_name,
            detail: $detail,
            ok: $ok,
            payload_json: $payload_json,
            error: $error,
            created_at: datetime()
        })
        MERGE (a)-[:USED_TOOL]->(te)
        MERGE (r)-[:USED_TOOL]->(te)
        MERGE (t)-[:CONTAINS]->(te)
        WITH te, ep
        FOREACH (_ IN CASE WHEN ep IS NULL THEN [] ELSE [1] END |
            MERGE (ep)-[:USED_TOOL]->(te)
        )
        RETURN te.id AS execution_id
        """
        with self._driver.session() as session:
            record = session.run(
                query,
                run_id=run_id,
                thread_id=thread_id,
                agent_id=agent_id,
                execution_id=execution_id,
                tool_name=tool_name,
                detail=detail,
                ok=ok,
                payload_json=json.dumps(payload or {}),
                error=error,
                episode_id=episode_id,
            ).single()
        return str(record["execution_id"]) if record else execution_id

    def upsert_entity(self, name: str, entity_type: str = "concept") -> str:
        self._ensure_constraints()
        canonical_name = name.strip().lower()
        if not canonical_name:
            return ""
        query = """
        MERGE (e:Entity {canonical_name: $canonical_name})
        ON CREATE SET e.id = randomUUID(), e.created_at = datetime()
        SET e.name = $name,
            e.entity_type = $entity_type,
            e.updated_at = datetime()
        RETURN e.id AS entity_id
        """
        with self._driver.session() as session:
            record = session.run(query, canonical_name=canonical_name, name=name.strip(), entity_type=entity_type).single()
        return str(record["entity_id"]) if record else ""

    def create_claim(
        self,
        run_id: str,
        thread_id: str,
        claim: str,
        *,
        source: str,
        confidence: float = 0.72,
        status: str = "active",
        episode_id: str | None = None,
        entity_names: list[str] | None = None,
    ) -> str:
        self._ensure_constraints()
        claim_id = str(uuid.uuid4())
        entity_names = entity_names or []
        query = """
        MERGE (r:Run {id: $run_id})
        MERGE (t:Thread {id: $thread_id})
        WITH r, t
        OPTIONAL MATCH (ep:Episode {id: $episode_id})
        CREATE (c:Claim {
            id: $claim_id,
            text: $claim,
            confidence: $confidence,
            status: $status,
            valid_from: datetime(),
            created_at: datetime()
        })
        MERGE (s:Source {url: $source})
        ON CREATE SET s.created_at = datetime()
        SET s.updated_at = datetime()
        MERGE (r)-[:PRODUCED]->(c)
        MERGE (t)-[:CONTAINS]->(c)
        MERGE (c)-[:SUPPORTED_BY]->(s)
        WITH c, ep
        FOREACH (_ IN CASE WHEN ep IS NULL THEN [] ELSE [1] END |
            MERGE (ep)-[:PRODUCED]->(c)
        )
        RETURN c.id AS claim_id
        """
        with self._driver.session() as session:
            record = session.run(
                query,
                run_id=run_id,
                thread_id=thread_id,
                claim_id=claim_id,
                claim=claim,
                confidence=confidence,
                status=status,
                source=source,
                episode_id=episode_id,
            ).single()
        created_claim_id = str(record["claim_id"]) if record else claim_id
        for entity_name in entity_names:
            entity_id = self.upsert_entity(entity_name)
            if entity_id:
                self.link_claim_to_entity(created_claim_id, entity_name)
        return created_claim_id

    def link_claim_to_entity(self, claim_id: str, entity_name: str) -> None:
        canonical_name = entity_name.strip().lower()
        if not canonical_name:
            return
        query = """
        MATCH (c:Claim {id: $claim_id})
        MATCH (e:Entity {canonical_name: $canonical_name})
        MERGE (c)-[:ABOUT]->(e)
        """
        with self._driver.session() as session:
            session.run(query, claim_id=claim_id, canonical_name=canonical_name)

    def link_episode_to_entity(self, episode_id: str, entity_name: str, entity_type: str = "concept") -> None:
        entity_id = self.upsert_entity(entity_name, entity_type=entity_type)
        if not entity_id:
            return
        query = """
        MATCH (ep:Episode {id: $episode_id})
        MATCH (e:Entity {canonical_name: $canonical_name})
        MERGE (ep)-[:MENTIONS]->(e)
        """
        with self._driver.session() as session:
            session.run(query, episode_id=episode_id, canonical_name=entity_name.strip().lower())

    def record_failure(self, run_id: str, thread_id: str, agent_id: str, detail: str, *, episode_id: str | None = None) -> None:
        self._ensure_constraints()
        query = """
        MERGE (r:Run {id: $run_id})
        MERGE (t:Thread {id: $thread_id})
        MERGE (a:Agent {name: $agent_id})
        MERGE (r)-[:FAILED_AT]->(a)
        WITH r, t, a
        OPTIONAL MATCH (src:Episode {id: $episode_id})
        CREATE (ep:Episode {
            id: randomUUID(),
            run_id: $run_id,
            thread_id: $thread_id,
            agent_id: $agent_id,
            episode_type: 'failure',
            content: $detail,
            created_at: datetime()
        })
        MERGE (r)-[:HAS_EPISODE]->(ep)
        MERGE (t)-[:CONTAINS]->(ep)
        MERGE (a)-[:AUTHORED]->(ep)
        WITH ep, src
        FOREACH (_ IN CASE WHEN src IS NULL THEN [] ELSE [1] END |
            MERGE (src)-[:CHALLENGES]->(ep)
        )
        """
        with self._driver.session() as session:
            session.run(query, run_id=run_id, thread_id=thread_id, agent_id=agent_id, detail=detail, episode_id=episode_id)

    def create_desktop_artifact(
        self,
        run_id: str,
        thread_id: str,
        agent_id: str,
        *,
        action_id: str,
        kind: str,
        title: str,
        output_path: str,
        action_type: str | None = None,
        episode_id: str | None = None,
    ) -> str:
        self._ensure_constraints()
        artifact_id = str(uuid.uuid4())
        query = """
        MERGE (r:Run {id: $run_id})
        MERGE (t:Thread {id: $thread_id})
        MERGE (a:Agent {name: $agent_id})
        WITH r, t, a
        OPTIONAL MATCH (ep:Episode {id: $episode_id})
        CREATE (da:DesktopArtifact {
            id: $artifact_id,
            action_id: $action_id,
            kind: $kind,
            action_type: $action_type,
            title: $title,
            output_path: $output_path,
            created_at: datetime()
        })
        MERGE (r)-[:GENERATED]->(da)
        MERGE (t)-[:CONTAINS]->(da)
        MERGE (a)-[:GENERATED]->(da)
        WITH da, ep
        FOREACH (_ IN CASE WHEN ep IS NULL THEN [] ELSE [1] END |
            MERGE (ep)-[:PRODUCED]->(da)
        )
        RETURN da.id AS artifact_id
        """
        with self._driver.session() as session:
            record = session.run(
                query,
                run_id=run_id,
                thread_id=thread_id,
                agent_id=agent_id,
                artifact_id=artifact_id,
                action_id=action_id,
                kind=kind,
                action_type=action_type,
                title=title,
                output_path=output_path,
                episode_id=episode_id,
            ).single()
        return str(record["artifact_id"]) if record else artifact_id

    def upsert_schedule(
        self,
        schedule_id: str,
        *,
        name: str,
        workflow_kind: str,
        agent_id: str,
        enabled: bool,
        mode: str,
        approval_required: bool,
        cadence_label: str,
        output_preset: str = "custom",
        output_subdir: str = "",
        template_preset: str = "none",
        prompt_template: str = "",
        content_template: str = "",
        last_run_status: str = "",
        next_run_at: str = "",
    ) -> None:
        self._ensure_constraints()
        query = """
        MERGE (sc:Schedule {id: $schedule_id})
        ON CREATE SET sc.created_at = datetime()
        SET sc.name = $name,
            sc.workflow_kind = $workflow_kind,
            sc.agent_id = $agent_id,
            sc.enabled = $enabled,
            sc.mode = $mode,
            sc.approval_required = $approval_required,
            sc.cadence_label = $cadence_label,
            sc.output_preset = $output_preset,
            sc.output_subdir = $output_subdir,
            sc.template_preset = $template_preset,
            sc.prompt_template = $prompt_template,
            sc.content_template = $content_template,
            sc.last_run_status = $last_run_status,
            sc.next_run_at = $next_run_at,
            sc.updated_at = datetime()
        WITH sc
        MERGE (a:Agent {name: $agent_id})
        MERGE (sc)-[:OWNED_BY]->(a)
        """
        with self._driver.session() as session:
            session.run(
                query,
                schedule_id=schedule_id,
                name=name,
                workflow_kind=workflow_kind,
                agent_id=agent_id,
                enabled=enabled,
                mode=mode,
                approval_required=approval_required,
                cadence_label=cadence_label,
                output_preset=output_preset,
                output_subdir=output_subdir,
                template_preset=template_preset,
                prompt_template=prompt_template,
                content_template=content_template,
                last_run_status=last_run_status,
                next_run_at=next_run_at,
            )

    def link_schedule_to_run(self, schedule_id: str, run_id: str) -> None:
        self._ensure_constraints()
        query = """
        MATCH (sc:Schedule {id: $schedule_id})
        MATCH (r:Run {id: $run_id})
        MERGE (sc)-[:DISPATCHED_RUN]->(r)
        """
        with self._driver.session() as session:
            session.run(query, schedule_id=schedule_id, run_id=run_id)

    def delete_schedule(self, schedule_id: str) -> None:
        self._ensure_constraints()
        query = """
        MATCH (sc:Schedule {id: $schedule_id})
        DETACH DELETE sc
        """
        with self._driver.session() as session:
            session.run(query, schedule_id=schedule_id)

    def fetch_graph(self, limit: int = 100, run_id: str | None = None, thread_id: str | None = None, labels: list[str] | None = None) -> dict[str, Any]:
        self._ensure_constraints()
        labels = labels or []
        with self._driver.session() as session:
            if run_id:
                node_query = """
                MATCH (r:Run {id: $run_id})
                OPTIONAL MATCH (r)-[:USES_THREAD]->(t:Thread)
                OPTIONAL MATCH (r)-[:HAS_EPISODE]->(ep:Episode)
                OPTIONAL MATCH (r)-[:PRODUCED]->(c:Claim)
                OPTIONAL MATCH (r)-[:USED_TOOL]->(te:ToolExecution)
                OPTIONAL MATCH (r)-[:GENERATED]->(da:DesktopArtifact)
                OPTIONAL MATCH (sc:Schedule)-[:DISPATCHED_RUN]->(r)
                OPTIONAL MATCH (ep)<-[:AUTHORED]-(author:Agent)
                OPTIONAL MATCH (ep)-[:MENTIONS]->(entity_from_episode:Entity)
                OPTIONAL MATCH (ep)-[:USED_TOOL]->(tool_from_episode:ToolExecution)
                OPTIONAL MATCH (ep)-[:PRODUCED]->(claim_from_episode:Claim)
                OPTIONAL MATCH (ep)-[:PRODUCED]->(artifact_from_episode:DesktopArtifact)
                OPTIONAL MATCH (claim_from_episode)-[:ABOUT]->(entity_from_claim:Entity)
                OPTIONAL MATCH (claim_from_episode)-[:SUPPORTED_BY]->(source_from_claim:Source)
                OPTIONAL MATCH (c)-[:ABOUT]->(claim_entity:Entity)
                OPTIONAL MATCH (c)-[:SUPPORTED_BY]->(claim_source:Source)
                WITH [
                    r, t, ep, c, te, da, sc, author, entity_from_episode, tool_from_episode,
                    claim_from_episode, artifact_from_episode, entity_from_claim, source_from_claim, claim_entity, claim_source
                ] AS grouped
                UNWIND grouped AS candidate
                WITH DISTINCT candidate
                WHERE candidate IS NOT NULL
                  AND (size($labels) = 0 OR any(label IN labels(candidate) WHERE label IN $labels))
                RETURN candidate, elementId(candidate) AS element_id
                LIMIT $limit
                """
                node_records = session.run(node_query, run_id=run_id, labels=labels, limit=limit)
                selected_nodes = [(record["candidate"], str(record["element_id"])) for record in node_records]
                node_element_ids = [element_id for _, element_id in selected_nodes]
                nodes = {
                    element_id: {
                        "id": element_id,
                        "labels": list(node.labels),
                        "properties": self._normalize_node_properties(node),
                    }
                    for node, element_id in selected_nodes
                }
                edges: list[dict[str, Any]] = []
                if node_element_ids:
                    edge_query = """
                    MATCH (n)-[r]->(m)
                    WHERE elementId(n) IN $node_element_ids AND elementId(m) IN $node_element_ids
                    RETURN n, r, m
                    LIMIT $limit
                    """
                    for record in session.run(edge_query, node_element_ids=node_element_ids, limit=limit * 4):
                        n = record["n"]
                        m = record["m"]
                        r = record["r"]
                        edges.append(
                            {
                                "id": str(r.element_id),
                                "type": r.type,
                                "source": str(n.element_id),
                                "target": str(m.element_id),
                                "properties": self._normalize_value(dict(r)),
                            }
                        )
                return {"nodes": list(nodes.values()), "edges": edges}

            if thread_id:
                root_query = """
                MATCH (root)
                WHERE root:Thread AND root.id = $thread_id
                MATCH p=(root)-[*0..3]-(n)
                UNWIND nodes(p) AS candidate
                WITH DISTINCT candidate
                WHERE size($labels) = 0 OR any(label IN labels(candidate) WHERE label IN $labels)
                RETURN candidate, elementId(candidate) AS element_id
                LIMIT $limit
                """
                node_records = session.run(root_query, thread_id=thread_id, labels=labels, limit=limit)
                selected_nodes = [(record["candidate"], str(record["element_id"])) for record in node_records]
                node_element_ids = [element_id for _, element_id in selected_nodes]
                nodes = {
                    element_id: {
                        "id": element_id,
                        "labels": list(node.labels),
                        "properties": self._normalize_node_properties(node),
                    }
                    for node, element_id in selected_nodes
                }
                edges: list[dict[str, Any]] = []
                if node_element_ids:
                    edge_query = """
                    MATCH (n)-[r]->(m)
                    WHERE elementId(n) IN $node_element_ids AND elementId(m) IN $node_element_ids
                    RETURN n, r, m
                    LIMIT $limit
                    """
                    for record in session.run(edge_query, node_element_ids=node_element_ids, limit=limit * 3):
                        n = record["n"]
                        m = record["m"]
                        r = record["r"]
                        edges.append(
                            {
                                "id": str(r.element_id),
                                "type": r.type,
                                "source": str(n.element_id),
                                "target": str(m.element_id),
                                "properties": self._normalize_value(dict(r)),
                            }
                        )
                return {"nodes": list(nodes.values()), "edges": edges}

            query = """
            MATCH (n)
            WHERE size($labels) = 0 OR any(label IN labels(n) WHERE label IN $labels)
            OPTIONAL MATCH (n)-[r]->(m)
            RETURN n, r, m
            LIMIT $limit
            """
            nodes: dict[str, dict[str, Any]] = {}
            edges: list[dict[str, Any]] = []
            for record in session.run(query, labels=labels, limit=limit):
                n = record.get("n")
                r = record.get("r")
                m = record.get("m")
                if n is not None:
                    nodes[str(n.element_id)] = {
                        "id": str(n.element_id),
                        "labels": list(n.labels),
                        "properties": self._normalize_node_properties(n),
                    }
                if m is not None:
                    nodes[str(m.element_id)] = {
                        "id": str(m.element_id),
                        "labels": list(m.labels),
                        "properties": self._normalize_node_properties(m),
                    }
                if r is not None and n is not None and m is not None:
                    edges.append(
                        {
                            "id": str(r.element_id),
                            "type": r.type,
                            "source": str(n.element_id),
                            "target": str(m.element_id),
                            "properties": self._normalize_value(dict(r)),
                        }
                    )
            return {"nodes": list(nodes.values()), "edges": edges}

    def fetch_run_memory(self, run_id: str, limit: int = 24) -> dict[str, Any]:
        self._ensure_constraints()
        query = """
        MATCH (r:Run {id: $run_id})
        OPTIONAL MATCH (r)-[:USES_THREAD]->(t:Thread)
        OPTIONAL MATCH (r)-[:HAS_EPISODE]->(ep:Episode)
        OPTIONAL MATCH (r)-[:PRODUCED]->(c:Claim)
        OPTIONAL MATCH (r)-[:GENERATED]->(da:DesktopArtifact)
        OPTIONAL MATCH (ep)-[:MENTIONS]->(entity:Entity)
        RETURN r, t,
               collect(DISTINCT ep)[0..$limit] AS episodes,
               collect(DISTINCT c)[0..$limit] AS claims,
               collect(DISTINCT entity)[0..$limit] AS entities,
               collect(DISTINCT da)[0..$limit] AS desktop_artifacts
        """
        with self._driver.session() as session:
            record = session.run(query, run_id=run_id, limit=limit).single()
        if not record:
            return {"run_id": run_id, "thread_id": None, "episodes": [], "claims": [], "entities": [], "desktop_artifacts": []}

        thread = record.get("t")
        episodes = []
        for ep in record.get("episodes", []) or []:
            if ep is None:
                continue
            metadata = {}
            raw_meta = dict(ep).get("metadata_json")
            if raw_meta:
                try:
                    metadata = json.loads(raw_meta)
                except Exception:
                    metadata = {}
            episodes.append(
                {
                    "episode_id": dict(ep).get("id", ""),
                    "thread_id": dict(ep).get("thread_id"),
                    "run_id": dict(ep).get("run_id"),
                    "agent_id": dict(ep).get("agent_id"),
                    "episode_type": dict(ep).get("episode_type", "episode"),
                    "content": dict(ep).get("content", ""),
                    "created_at": self._normalize_value(dict(ep).get("created_at")),
                    "metadata": metadata,
                }
            )
        claims = []
        for claim in record.get("claims", []) or []:
            if claim is None:
                continue
            claims.append(
                {
                    "claim_id": dict(claim).get("id", ""),
                    "text": dict(claim).get("text", ""),
                    "source": None,
                    "confidence": dict(claim).get("confidence"),
                    "status": dict(claim).get("status"),
                    "entity_names": [],
                    "created_at": self._normalize_value(dict(claim).get("created_at")),
                }
            )
        entities = []
        for entity in record.get("entities", []) or []:
            if entity is None:
                continue
            entities.append(
                {
                    "entity_id": dict(entity).get("id", ""),
                    "name": dict(entity).get("name", ""),
                    "entity_type": dict(entity).get("entity_type", "concept"),
                }
            )
        desktop_artifacts = []
        for artifact in record.get("desktop_artifacts", []) or []:
            if artifact is None:
                continue
            desktop_artifacts.append(
                {
                    "artifact_id": dict(artifact).get("id", ""),
                    "action_id": dict(artifact).get("action_id", ""),
                    "kind": dict(artifact).get("kind", ""),
                    "agent_id": None,
                    "action_type": dict(artifact).get("action_type"),
                    "title": dict(artifact).get("title"),
                    "output_path": dict(artifact).get("output_path"),
                    "created_at": self._normalize_value(dict(artifact).get("created_at")),
                }
            )
        episodes.sort(key=lambda item: item.get("created_at") or "")
        claims.sort(key=lambda item: item.get("created_at") or "")
        return {
            "run_id": run_id,
            "thread_id": dict(thread).get("id") if thread is not None else None,
            "episodes": episodes,
            "claims": claims,
            "entities": entities,
            "desktop_artifacts": desktop_artifacts,
        }

    def fetch_run_claims(self, run_id: str, limit: int = 24) -> dict[str, Any]:
        self._ensure_constraints()
        query = """
        MATCH (r:Run {id: $run_id})-[:PRODUCED]->(c:Claim)
        OPTIONAL MATCH (c)-[:SUPPORTED_BY]->(s:Source)
        OPTIONAL MATCH (c)-[:ABOUT]->(e:Entity)
        RETURN c, collect(DISTINCT s.url) AS sources, collect(DISTINCT e.name) AS entity_names
        LIMIT $limit
        """
        claims = []
        with self._driver.session() as session:
            for record in session.run(query, run_id=run_id, limit=limit):
                claim = record["c"]
                claims.append(
                    {
                        "claim_id": dict(claim).get("id", ""),
                        "text": dict(claim).get("text", ""),
                        "source": ", ".join([s for s in record.get("sources", []) if s]),
                        "confidence": dict(claim).get("confidence"),
                        "status": dict(claim).get("status"),
                        "entity_names": [name for name in record.get("entity_names", []) if name],
                        "created_at": self._normalize_value(dict(claim).get("created_at")),
                    }
                )
        claims.sort(key=lambda item: item.get("created_at") or "")
        return {"run_id": run_id, "claims": claims}

    def fetch_thread_lineage(self, thread_id: str, limit: int = 24) -> dict[str, Any]:
        self._ensure_constraints()
        query = """
        MATCH (t:Thread {id: $thread_id})
        OPTIONAL MATCH (t)-[:CONTAINS]->(ep:Episode)
        RETURN t, collect(DISTINCT ep)[0..$limit] AS episodes
        """
        with self._driver.session() as session:
            record = session.run(query, thread_id=thread_id, limit=limit).single()
        if not record:
            return {"thread_id": thread_id, "user_id": None, "episodes": []}
        thread = record.get("t")
        episodes = []
        for ep in record.get("episodes", []) or []:
            if ep is None:
                continue
            metadata = {}
            raw_meta = dict(ep).get("metadata_json")
            if raw_meta:
                try:
                    metadata = json.loads(raw_meta)
                except Exception:
                    metadata = {}
            episodes.append(
                {
                    "episode_id": dict(ep).get("id", ""),
                    "thread_id": dict(ep).get("thread_id"),
                    "run_id": dict(ep).get("run_id"),
                    "agent_id": dict(ep).get("agent_id"),
                    "episode_type": dict(ep).get("episode_type", "episode"),
                    "content": dict(ep).get("content", ""),
                    "created_at": self._normalize_value(dict(ep).get("created_at")),
                    "metadata": metadata,
                }
            )
        episodes.sort(key=lambda item: item.get("created_at") or "")
        return {
            "thread_id": thread_id,
            "user_id": dict(thread).get("user_id") if thread is not None else None,
            "episodes": episodes,
        }


neo4j_service = Neo4jService()
