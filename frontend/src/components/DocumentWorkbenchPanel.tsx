import { useState } from 'react';
import { processDocument } from '../api/client';
import type { DocumentProcessResponse } from '../types';

export function DocumentWorkbenchPanel() {
  const [result, setResult] = useState<DocumentProcessResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const onFile = async (file: File | null) => {
    if (!file) return;
    setLoading(true);
    setError('');
    try {
      const next = await processDocument(file);
      setResult(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Document processing failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="panel document-workbench">
      <div className="specialist-head">
        <div>
          <h2>Document Processing</h2>
          <p className="muted">Upload a file to extract readable text, surface likely sections, and prepare it for agent workflows.</p>
        </div>
      </div>
      <label className="upload-dropzone">
        <input
          type="file"
          onChange={(e) => {
            void onFile(e.target.files?.[0] ?? null);
            e.currentTarget.value = '';
          }}
        />
        <strong>{loading ? 'Processing document...' : 'Choose document'}</strong>
        <span>Supports TXT, MD, CSV, JSON, HTML, and code files in the local demo.</span>
      </label>
      {error && <p className="error-text">{error}</p>}
      {result && (
        <div className="document-result">
          <div className="shopping-meta">
            <span>{result.name}</span>
            <span>{result.content_type}</span>
            <span>{result.size_bytes} bytes</span>
          </div>
          <p>{result.summary}</p>
          {result.sections.length > 0 && (
            <div className="document-sections">
              {result.sections.map((section) => (
                <span key={section} className="trust-pill">
                  {section}
                </span>
              ))}
            </div>
          )}
          {result.warnings.length > 0 && (
            <ul className="bullet-list muted small">
              {result.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
          <pre className="document-preview">{result.extracted_text || 'No text extracted.'}</pre>
        </div>
      )}
    </section>
  );
}
