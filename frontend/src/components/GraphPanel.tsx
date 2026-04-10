import { useEffect, useMemo, useRef, useState } from 'react';
import { getGraph } from '../api/client';
import type { GraphNode, GraphResponse } from '../types';

const LABEL_COLORS: Record<string, string> = {
  Agent: '#22d3ee',
  Run: '#f59e0b',
  Schedule: '#f97316',
  Thread: '#fb7185',
  Episode: '#34d399',
  Claim: '#a78bfa',
  Source: '#10b981',
  ToolExecution: '#f472b6',
  DesktopArtifact: '#facc15',
  Task: '#f97316',
  Entity: '#60a5fa',
};

interface PositionedNode {
  x: number;
  y: number;
  z: number;
  label: string;
  node: GraphNode;
}

function pointForNode(node: GraphNode, i: number, n: number): PositionedNode {
  const angle = (2 * Math.PI * i) / n;
  const band = i % 11;
  const radius = 1.6 + band * 0.27;
  return {
    x: radius * Math.cos(angle),
    y: radius * Math.sin(angle),
    z: Math.sin(angle * 1.7) * 2.1 + (band - 5) * 0.08,
    label: node.labels[0] ?? 'Node',
    node,
  };
}

function rotatePoint(node: PositionedNode, rotation: number) {
  const sin = Math.sin(rotation);
  const cos = Math.cos(rotation);
  return {
    ...node,
    rx: node.x * cos - node.z * sin,
    rz: node.x * sin + node.z * cos,
  };
}

function projectPoint(point: ReturnType<typeof rotatePoint>, width: number, height: number, scale = 115) {
  const depth = 4.8 / (4.8 + point.rz + 4);
  return {
    ...point,
    px: width / 2 + point.rx * scale * depth,
    py: height / 2 + point.y * scale * depth,
    depth,
  };
}

interface Props {
  runId?: string | null;
  threadId?: string | null;
}

export function GraphPanel({ runId, threadId }: Props) {
  const [graph, setGraph] = useState<GraphResponse>({ nodes: [], edges: [] });
  const [query, setQuery] = useState('');
  const [activeLabels, setActiveLabels] = useState<string[]>([]);
  const [activeShortcut, setActiveShortcut] = useState('all');
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const load = async () => {
      const data = await getGraph(320, { runId, threadId });
      setGraph(data);
    };
    void load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [runId, threadId]);

  const availableLabels = useMemo(() => {
    const labels = new Set<string>();
    for (const node of graph.nodes) {
      for (const label of node.labels) labels.add(label);
    }
    return Array.from(labels).sort();
  }, [graph.nodes]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const useLabelFilter = activeLabels.length > 0;
    const pendingScheduleIds = new Set(
      graph.nodes
        .filter((node) => node.labels.includes('Schedule') && String(node.properties.last_run_status || '') === 'awaiting_approval')
        .map((node) => node.id),
    );
    const rejectedScheduleIds = new Set(
      graph.nodes
        .filter((node) => node.labels.includes('Schedule') && String(node.properties.last_run_status || '') === 'rejected')
        .map((node) => node.id),
    );
    const completedScheduleIds = new Set(
      graph.nodes
        .filter((node) => node.labels.includes('Schedule') && String(node.properties.last_run_status || '') === 'completed')
        .map((node) => node.id),
    );
    const failedScheduleIds = new Set(
      graph.nodes
        .filter((node) => node.labels.includes('Schedule') && String(node.properties.last_run_status || '') === 'failed')
        .map((node) => node.id),
    );
    const liveScheduleIds = new Set(
      graph.nodes
        .filter((node) => node.labels.includes('Schedule') && String(node.properties.mode || '') === 'live')
        .map((node) => node.id),
    );
    const simulationScheduleIds = new Set(
      graph.nodes
        .filter((node) => node.labels.includes('Schedule') && String(node.properties.mode || '') === 'simulation')
        .map((node) => node.id),
    );
    const pendingRunIds = new Set(
      graph.edges
        .filter((edge) => edge.type === 'DISPATCHED_RUN' && pendingScheduleIds.has(edge.source))
        .map((edge) => edge.target),
    );
    const rejectedRunIds = new Set(
      graph.edges
        .filter((edge) => edge.type === 'DISPATCHED_RUN' && rejectedScheduleIds.has(edge.source))
        .map((edge) => edge.target),
    );
    const completedRunIds = new Set(
      graph.edges
        .filter((edge) => edge.type === 'DISPATCHED_RUN' && completedScheduleIds.has(edge.source))
        .map((edge) => edge.target),
    );
    const failedRunIds = new Set(
      graph.edges
        .filter((edge) => edge.type === 'DISPATCHED_RUN' && failedScheduleIds.has(edge.source))
        .map((edge) => edge.target),
    );

    const nodes = graph.nodes.filter((node) => {
      const labelText = node.labels.join(' ').toLowerCase();
      const propText = Object.values(node.properties).join(' ').toLowerCase();
      const matchesQuery = !q || labelText.includes(q) || propText.includes(q) || node.id.toLowerCase().includes(q);
      const matchesLabel = !useLabelFilter || node.labels.some((label) => activeLabels.includes(label));
      let matchesShortcut = true;
      if (activeShortcut === 'pending_approvals') {
        matchesShortcut =
          (node.labels.includes('Schedule') && pendingScheduleIds.has(node.id)) ||
          (node.labels.includes('Run') && pendingRunIds.has(node.id));
      } else if (activeShortcut === 'rejected_schedules') {
        matchesShortcut =
          (node.labels.includes('Schedule') && rejectedScheduleIds.has(node.id)) ||
          (node.labels.includes('Run') && rejectedRunIds.has(node.id));
      } else if (activeShortcut === 'completed_schedule_runs') {
        matchesShortcut =
          (node.labels.includes('Schedule') && completedScheduleIds.has(node.id)) ||
          (node.labels.includes('Run') && completedRunIds.has(node.id));
      } else if (activeShortcut === 'failed_schedule_runs') {
        matchesShortcut =
          (node.labels.includes('Schedule') && failedScheduleIds.has(node.id)) ||
          (node.labels.includes('Run') && failedRunIds.has(node.id));
      } else if (activeShortcut === 'live_schedules') {
        matchesShortcut = node.labels.includes('Schedule') && liveScheduleIds.has(node.id);
      } else if (activeShortcut === 'simulation_schedules') {
        matchesShortcut = node.labels.includes('Schedule') && simulationScheduleIds.has(node.id);
      }
      return matchesQuery && matchesLabel && matchesShortcut;
    });

    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges = graph.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
    return { nodes, edges };
  }, [graph, query, activeLabels, activeShortcut]);

  const layout = useMemo(() => {
    const n = Math.max(visible.nodes.length, 1);
    const points = visible.nodes.map((node, index) => pointForNode(node, index, n));
    return { points };
  }, [visible.nodes]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let frame = 0;
    let rotation = 0;
    const pointer = { x: -9999, y: -9999 };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.floor(rect.width * devicePixelRatio);
      canvas.height = Math.floor(rect.height * devicePixelRatio);
      ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const onMove = (event: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer.x = event.clientX - rect.left;
      pointer.y = event.clientY - rect.top;
    };

    const onLeave = () => {
      pointer.x = -9999;
      pointer.y = -9999;
      setHoveredNode(null);
    };

    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseleave', onLeave);

    const draw = () => {
      rotation += 0.004;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      ctx.clearRect(0, 0, width, height);

      const projected = layout.points
        .map((point) => projectPoint(rotatePoint(point, rotation), width, height))
        .sort((a, b) => a.depth - b.depth);
      const projectedIndex = new Map(projected.map((point) => [point.node.id, point] as const));

      ctx.strokeStyle = 'rgba(74, 222, 255, 0.18)';
      ctx.lineWidth = 1;
      for (const edge of visible.edges) {
        const start = projectedIndex.get(edge.source);
        const end = projectedIndex.get(edge.target);
        if (!start || !end) continue;
        ctx.globalAlpha = Math.min(start.depth, end.depth) * 0.8;
        ctx.beginPath();
        ctx.moveTo(start.px, start.py);
        ctx.lineTo(end.px, end.py);
        ctx.stroke();
      }

      let nextHovered: GraphNode | null = null;
      let closest = 16;

      for (const point of projected) {
        const radius = (point.label === 'Agent' ? 7 : point.label === 'Run' ? 6 : point.label === 'Episode' ? 5.2 : 4.6) * (0.65 + point.depth);
        const dx = pointer.x - point.px;
        const dy = pointer.y - point.py;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance < closest) {
          closest = distance;
          nextHovered = point.node;
        }

        ctx.beginPath();
        ctx.fillStyle = LABEL_COLORS[point.label] ?? '#60a5fa';
        ctx.globalAlpha = 0.35 + point.depth * 0.65;
        ctx.arc(point.px, point.py, radius, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.globalAlpha = 1;
      setHoveredNode((current) => ((current?.id || null) === (nextHovered?.id || null) ? current : nextHovered));
      frame = requestAnimationFrame(draw);
    };

    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mouseleave', onLeave);
    };
  }, [layout, visible.edges]);

  const toggleLabel = (label: string) => {
    setActiveShortcut('custom');
    setActiveLabels((prev) => (prev.includes(label) ? prev.filter((value) => value !== label) : [...prev, label]));
  };

  const applyShortcut = (shortcut: string, labels: string[]) => {
    setActiveShortcut(shortcut);
    setActiveLabels(labels);
  };

  const tooltip = hoveredNode
    ? `${hoveredNode.labels.join(', ') || 'Node'}: ${String(hoveredNode.properties.name ?? hoveredNode.properties.id ?? hoveredNode.id)}`
    : 'Hover a node to inspect it';

  return (
    <section className="panel graph-panel">
      <div className="graph-head">
        <div>
          <h2>Knowledge Graph</h2>
          <p className="muted">{runId ? 'Scoped to the current run and thread lineage.' : 'Global graph view across all stored lineage.'}</p>
        </div>
        <input placeholder="Search entities..." value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>

      <div className="filter-chips">
        <button
          type="button"
          className={activeShortcut === 'all' && activeLabels.length === 0 ? 'chip active' : 'chip'}
          onClick={() => {
            setActiveShortcut('all');
            setActiveLabels([]);
          }}
        >
          All
        </button>
        <button
          type="button"
          className={activeShortcut === 'artifacts' ? 'chip active' : 'chip'}
          onClick={() => applyShortcut('artifacts', ['DesktopArtifact'])}
        >
          Artifacts
        </button>
        <button
          type="button"
          className={activeShortcut === 'artifact_lineage' ? 'chip active' : 'chip'}
          onClick={() => applyShortcut('artifact_lineage', ['DesktopArtifact', 'Episode'])}
        >
          Artifact Lineage
        </button>
        <button
          type="button"
          className={activeShortcut === 'run_outputs' ? 'chip active' : 'chip'}
          onClick={() => applyShortcut('run_outputs', ['Run', 'DesktopArtifact'])}
        >
          Run Outputs
        </button>
        <button
          type="button"
          className={activeShortcut === 'claims' ? 'chip active' : 'chip'}
          onClick={() => applyShortcut('claims', ['Claim'])}
        >
          Claims
        </button>
        <button
          type="button"
          className={activeShortcut === 'tools' ? 'chip active' : 'chip'}
          onClick={() => applyShortcut('tools', ['ToolExecution'])}
        >
          Tools
        </button>
        <button
          type="button"
          className={activeShortcut === 'episodes' ? 'chip active' : 'chip'}
          onClick={() => applyShortcut('episodes', ['Episode'])}
        >
          Memory Episodes
        </button>
        <button
          type="button"
          className={activeShortcut === 'schedules' ? 'chip active' : 'chip'}
          onClick={() => applyShortcut('schedules', ['Schedule'])}
        >
          Schedules
        </button>
        <button
          type="button"
          className={activeShortcut === 'schedule_runs' ? 'chip active' : 'chip'}
          onClick={() => applyShortcut('schedule_runs', ['Schedule', 'Run'])}
        >
          Schedule Runs
        </button>
        <button
          type="button"
          className={activeShortcut === 'pending_approvals' ? 'chip active' : 'chip'}
          onClick={() => applyShortcut('pending_approvals', [])}
        >
          Pending Approvals
        </button>
        <button
          type="button"
          className={activeShortcut === 'rejected_schedules' ? 'chip active' : 'chip'}
          onClick={() => applyShortcut('rejected_schedules', [])}
        >
          Rejected Schedules
        </button>
        <button
          type="button"
          className={activeShortcut === 'completed_schedule_runs' ? 'chip active' : 'chip'}
          onClick={() => applyShortcut('completed_schedule_runs', [])}
        >
          Completed Schedule Runs
        </button>
        <button
          type="button"
          className={activeShortcut === 'failed_schedule_runs' ? 'chip active' : 'chip'}
          onClick={() => applyShortcut('failed_schedule_runs', [])}
        >
          Failed Schedule Runs
        </button>
        <button
          type="button"
          className={activeShortcut === 'live_schedules' ? 'chip active' : 'chip'}
          onClick={() => applyShortcut('live_schedules', [])}
        >
          Live Schedules
        </button>
        <button
          type="button"
          className={activeShortcut === 'simulation_schedules' ? 'chip active' : 'chip'}
          onClick={() => applyShortcut('simulation_schedules', [])}
        >
          Simulation Schedules
        </button>
        {availableLabels.map((label) => {
          const active = activeLabels.includes(label);
          return (
            <button key={label} type="button" className={active ? 'chip active' : 'chip'} onClick={() => toggleLabel(label)}>
              {label}
            </button>
          );
        })}
      </div>

      <div className="graph-stage">
        <canvas ref={canvasRef} className="graph-canvas" aria-label="Knowledge graph visualization" />
        <div className="graph-tooltip">{tooltip}</div>
      </div>

      <p className="muted">{visible.nodes.length} entities visible • {visible.edges.length} relationships visible</p>
    </section>
  );
}
