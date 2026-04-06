import { useEffect, useState } from 'react';
import { getHealth } from '../api/client';

export function HealthPanel() {
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    const load = async () => {
      setHealth(await getHealth());
    };
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);

  return (
    <section className="panel">
      <h2>Health</h2>
      {health ? <pre className="output">{JSON.stringify(health, null, 2)}</pre> : <p>Loading...</p>}
    </section>
  );
}
