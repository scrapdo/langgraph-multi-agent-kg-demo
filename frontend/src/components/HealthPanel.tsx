import { useEffect, useState } from 'react';
import { getHealth } from '../api/client';

interface HealthData {
  status?: string;
  app?: string;
  dependencies?: Record<string, string>;
}

function formatDependency(value?: string) {
  if (!value) return 'unknown';
  if (value.startsWith('postgresql')) return 'connected';
  if (value.startsWith('redis://')) return 'connected';
  return value;
}

export function HealthPanel() {
  const [health, setHealth] = useState<HealthData | null>(null);

  useEffect(() => {
    const load = async () => {
      setHealth((await getHealth()) as HealthData);
    };
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);

  const deps = health?.dependencies ?? {};

  return (
    <section className="panel">
      <h2>Health</h2>
      {!health && <p>Loading...</p>}
      {health && (
        <div className="status-card">
          <p><strong>App:</strong> {health.app ?? 'unknown'}</p>
          <p><strong>Status:</strong> {health.status ?? 'unknown'}</p>
          <h3>Dependencies</h3>
          <ul className="health-list">
            {Object.entries(deps).map(([name, status]) => (
              <li key={name}>
                <span>{name}</span>
                <strong>{formatDependency(status)}</strong>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
