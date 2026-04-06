import Plot from 'react-plotly.js';
import { useEffect, useMemo, useState } from 'react';
import { getGraph } from '../api/client';
import type { GraphNode, GraphResponse } from '../types';

const LABEL_COLORS: Record<string, string> = {
  Agent: '#22d3ee',
  Run: '#f59e0b',
  Claim: '#a78bfa',
  Source: '#10b981',
  ToolExecution: '#f472b6',
  Task: '#f97316',
  Entity: '#60a5fa',
};

function pointForNode(node: GraphNode, i: number, n: number) {
  const angle = (2 * Math.PI * i) / n;
  const band = i % 11;
  const radius = 1.6 + (band * 0.27);
  return {
    x: radius * Math.cos(angle),
    y: radius * Math.sin(angle),
    z: Math.sin(angle * 1.7) * 2.1 + (band - 5) * 0.08,
    label: node.labels[0] ?? 'Node',
  };
}

export function GraphPanel() {
  const [graph, setGraph] = useState<GraphResponse>({ nodes: [], edges: [] });
  const [query, setQuery] = useState('');
  const [activeLabels, setActiveLabels] = useState<string[]>([]);

  useEffect(() => {
    const load = async () => {
      const data = await getGraph(300);
      setGraph(data);
    };
    void load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);

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
      const matchesQuery = !q || labelText.includes(q) || node.id.toLowerCase().includes(q);
      const matchesLabel = !useLabelFilter || node.labels.some((l) => activeLabels.includes(l));
      return matchesQuery && matchesLabel;
    });

    const nodeIds = new Set(nodes.map((n) => n.id));
    const edges = graph.edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));

    return { nodes, edges };
  }, [graph, query, activeLabels]);

  const render = useMemo(() => {
    const n = Math.max(visible.nodes.length, 1);
    const nodeIndex = new Map<string, { x: number; y: number; z: number; node: GraphNode; label: string }>();

    visible.nodes.forEach((node, i) => {
      const p = pointForNode(node, i, n);
      nodeIndex.set(node.id, { ...p, node, label: p.label });
    });

    const edgeX: number[] = [];
    const edgeY: number[] = [];
    const edgeZ: number[] = [];

    for (const edge of visible.edges) {
      const a = nodeIndex.get(edge.source);
      const b = nodeIndex.get(edge.target);
      if (!a || !b) continue;
      edgeX.push(a.x, b.x, Number.NaN);
      edgeY.push(a.y, b.y, Number.NaN);
      edgeZ.push(a.z, b.z, Number.NaN);
    }

    const points = Array.from(nodeIndex.values());

    return {
      points,
      edgeX,
      edgeY,
      edgeZ,
    };
  }, [visible.nodes, visible.edges]);

  const toggleLabel = (label: string) => {
    setActiveLabels((prev) => (prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label]));
  };

  return (
    <section className="panel graph-panel">
      <div className="graph-head">
        <h2>Cognitive Graph</h2>
        <input
          placeholder="Search entities..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
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

      <Plot
        data={[
          {
            type: 'scatter3d',
            mode: 'lines',
            x: render.edgeX,
            y: render.edgeY,
            z: render.edgeZ,
            hoverinfo: 'none',
            line: {
              color: 'rgba(74, 222, 255, 0.22)',
              width: 1.2,
            },
          },
          {
            type: 'scatter3d',
            mode: 'markers',
            x: render.points.map((n) => n.x),
            y: render.points.map((n) => n.y),
            z: render.points.map((n) => n.z),
            text: render.points.map((n) => `${n.node.labels.join(',') || 'Node'}: ${n.node.id}`),
            hovertemplate: '%{text}<extra></extra>',
            marker: {
              size: render.points.map((n) => (n.label === 'Agent' ? 8 : n.label === 'Run' ? 6 : 5)),
              color: render.points.map((n) => LABEL_COLORS[n.label] ?? '#60a5fa'),
              opacity: 0.93,
              line: {
                color: 'rgba(255,255,255,0.3)',
                width: 0.5,
              },
            },
          },
        ]}
        layout={{
          paper_bgcolor: '#02060d',
          plot_bgcolor: '#02060d',
          font: { color: '#cde5f6' },
          margin: { l: 0, r: 0, b: 0, t: 8 },
          scene: {
            xaxis: { visible: false },
            yaxis: { visible: false },
            zaxis: { visible: false },
            camera: {
              eye: { x: 1.25, y: 1.18, z: 0.7 },
            },
          },
        }}
        style={{ width: '100%', height: 520 }}
        config={{ responsive: true, displayModeBar: false }}
      />

      <p className="muted">{visible.nodes.length} entities visible • {visible.edges.length} relationships visible</p>
    </section>
  );
}
