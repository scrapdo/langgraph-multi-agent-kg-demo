import { useEffect, useMemo, useRef, useState } from 'react';
import { getGraph } from '../api/client';
import type { GraphNode, GraphResponse } from '../types';

const LABEL_COLORS: Record<string, string> = {
  Agent: '#22d3ee',
  Run: '#f59e0b',
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

    const nodes = graph.nodes.filter((node) => {
      const labelText = node.labels.join(' ').toLowerCase();
      const propText = Object.values(node.properties).join(' ').toLowerCase();
      const matchesQuery = !q || labelText.includes(q) || propText.includes(q) || node.id.toLowerCase().includes(q);
      const matchesLabel = !useLabelFilter || node.labels.some((label) => activeLabels.includes(label));
      return matchesQuery && matchesLabel;
    });

    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges = graph.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
    return { nodes, edges };
  }, [graph, query, activeLabels]);

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
    setActiveLabels((prev) => (prev.includes(label) ? prev.filter((value) => value !== label) : [...prev, label]));
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
