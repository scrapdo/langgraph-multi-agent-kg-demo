import Plot from 'react-plotly.js';
import { useEffect, useMemo, useState } from 'react';
import { getGraph } from '../api/client';
import type { GraphResponse } from '../types';

export function GraphPanel() {
  const [graph, setGraph] = useState<GraphResponse>({ nodes: [], edges: [] });

  useEffect(() => {
    const load = async () => {
      const data = await getGraph();
      setGraph(data);
    };
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);

  const positions = useMemo(() => {
    const n = Math.max(graph.nodes.length, 1);
    return graph.nodes.map((node, i) => {
      const angle = (2 * Math.PI * i) / n;
      const radius = 1 + (i % 5) * 0.35;
      return {
        ...node,
        x: radius * Math.cos(angle),
        y: radius * Math.sin(angle),
        z: (i % 7) - 3,
      };
    });
  }, [graph.nodes]);

  return (
    <section className="panel">
      <h2>Knowledge Graph (3D)</h2>
      <Plot
        data={[
          {
            type: 'scatter3d',
            mode: 'markers+text',
            x: positions.map((n) => n.x),
            y: positions.map((n) => n.y),
            z: positions.map((n) => n.z),
            text: positions.map((n) => `${n.labels.join(',') || 'Node'}:${n.id}`),
            marker: { size: 5, color: '#ff8a00' },
          },
        ]}
        layout={{
          paper_bgcolor: '#0f172a',
          plot_bgcolor: '#0f172a',
          font: { color: '#e2e8f0' },
          margin: { l: 0, r: 0, b: 0, t: 10 },
          scene: {
            xaxis: { visible: false },
            yaxis: { visible: false },
            zaxis: { visible: false },
          },
        }}
        style={{ width: '100%', height: 360 }}
        config={{ responsive: true }}
      />
      <p className="muted">Nodes: {graph.nodes.length} | Edges: {graph.edges.length}</p>
    </section>
  );
}
