import { useEffect, useState } from 'react';
import {
  getHuggingFaceStatus,
  searchHuggingFaceDatasets,
  searchHuggingFaceModels,
  searchHuggingFaceSpaces,
} from '../api/client';
import type { HuggingFaceRepoResult, HuggingFaceSearchResponse, HuggingFaceStatus } from '../types';

type SearchKind = 'models' | 'datasets' | 'spaces';

function formatCompactNumber(value?: number | null) {
  if (!value) return '--';
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function ResultCard({ item, kind }: { item: HuggingFaceRepoResult; kind: SearchKind }) {
  return (
    <article className="hf-result-card">
      <div>
        <strong>{item.id}</strong>
        <p className="muted small">
          {kind === 'models' ? item.pipeline_tag || item.library_name || 'model' : kind === 'datasets' ? 'dataset' : item.sdk || 'space'}
        </p>
      </div>
      <div className="hf-result-meta">
        <span>Downloads: {formatCompactNumber(item.downloads)}</span>
        <span>Likes: {formatCompactNumber(item.likes)}</span>
      </div>
      {item.tags && item.tags.length > 0 && <p className="muted small">Tags: {item.tags.slice(0, 4).join(' • ')}</p>}
      <p><a href={item.link} target="_blank" rel="noreferrer">Open on Hugging Face</a></p>
    </article>
  );
}

export function HuggingFacePanel() {
  const [status, setStatus] = useState<HuggingFaceStatus | null>(null);
  const [kind, setKind] = useState<SearchKind>('models');
  const [query, setQuery] = useState('parler tts');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<HuggingFaceRepoResult[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    void getHuggingFaceStatus()
      .then(setStatus)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load Hugging Face status'));
  }, []);

  const search = async () => {
    setLoading(true);
    setError('');
    try {
      let payload: HuggingFaceSearchResponse;
      if (kind === 'datasets') payload = await searchHuggingFaceDatasets(query, 8);
      else if (kind === 'spaces') payload = await searchHuggingFaceSpaces(query, 8);
      else payload = await searchHuggingFaceModels(query, 8);
      setResults(payload.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void search();
  }, [kind]);

  return (
    <section className="panel">
      <h2>Hugging Face</h2>
      <p className="muted">Open-model discovery, dataset lookup, Spaces search, and local inference capability status.</p>

      <div className="metric-grid compact">
        <article>
          <h4>Hub</h4>
          <p>{status?.hub ?? '--'}</p>
        </article>
        <article>
          <h4>Parler TTS</h4>
          <p>{status?.parler_tts ?? '--'}</p>
        </article>
        <article>
          <h4>Transformers</h4>
          <p>{status?.transformers_local ?? '--'}</p>
        </article>
        <article>
          <h4>Optimum</h4>
          <p>{status?.optimum ?? '--'}</p>
        </article>
      </div>

      <div className="status-card">
        <p><strong>Local model:</strong> {status?.local_model ?? '--'}</p>
        <p><strong>Parler model:</strong> {status?.parler_model ?? '--'}</p>
        <p><strong>Optimum acceleration:</strong> {status?.optimum_acceleration ? 'on' : 'off'}</p>
      </div>

      <div className="voice-profile-row">
        <label>
          Search Type
          <select value={kind} onChange={(e) => setKind(e.target.value as SearchKind)}>
            <option value="models">Models</option>
            <option value="datasets">Datasets</option>
            <option value="spaces">Spaces</option>
          </select>
        </label>
      </div>

      <label>
        Search
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="search the hub" />
      </label>
      <div className="template-save-bar">
        <button type="button" onClick={() => void search()} disabled={loading}>
          {loading ? 'Searching…' : 'Search Hugging Face'}
        </button>
      </div>

      {error && <p className="muted">{error}</p>}

      <div className="preset-list">
        {results.map((item) => (
          <ResultCard key={item.id} item={item} kind={kind} />
        ))}
        {!results.length && !loading && <p className="muted small">No results yet.</p>}
      </div>
    </section>
  );
}
