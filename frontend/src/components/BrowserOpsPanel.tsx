import { useEffect, useState } from 'react';
import {
  getBrowserWorkflows,
  getPlaywrightPresets,
  installPlaywrightPresets,
  approvePlaywrightScript,
  deletePlaywrightScript,
  getPlaywrightScripts,
  getPlaywrightStatus,
  inspectBrowserUrl,
  runBrowserWorkflow,
  runPlaywrightScript,
  saveBrowserWorkflow,
  savePlaywrightScript,
} from '../api/client';
import type { BrowserInspectionResult, BrowserStepDraft, BrowserWorkflow, PlaywrightScript, PlaywrightScriptPreset, RunMode } from '../types';

const DEFAULT_AGENT = 'researcher';
const AGENT_OPTIONS = ['researcher', 'shopper', 'social', 'secretary'];

export function BrowserOpsPanel() {
  const [url, setUrl] = useState('https://example.com');
  const [inspection, setInspection] = useState<BrowserInspectionResult | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [workflows, setWorkflows] = useState<BrowserWorkflow[]>([]);
  const [workflowAgent, setWorkflowAgent] = useState(DEFAULT_AGENT);
  const [name, setName] = useState('Research Sweep');
  const [goal, setGoal] = useState('Inspect key pages and summarize the main signal on each.');
  const [seedUrls, setSeedUrls] = useState('https://example.com');
  const [mode, setMode] = useState<RunMode>('simulation');
  const [runResults, setRunResults] = useState<BrowserInspectionResult[]>([]);
  const [playwrightStatus, setPlaywrightStatus] = useState<Record<string, unknown> | null>(null);
  const [scripts, setScripts] = useState<PlaywrightScript[]>([]);
  const [presets, setPresets] = useState<PlaywrightScriptPreset[]>([]);
  const [scriptName, setScriptName] = useState('Login Flow');
  const [scriptStartUrl, setScriptStartUrl] = useState('https://example.com');
  const [scriptSteps, setScriptSteps] = useState(
    JSON.stringify(
      [
        { action: 'wait', timeout_ms: 1200, label: 'settle' },
        { action: 'extract_text', selector: 'h1', label: 'headline' },
      ],
      null,
      2,
    ),
  );
  const [scriptResults, setScriptResults] = useState<Array<Record<string, unknown>>>([]);
  const [scriptMode, setScriptMode] = useState<RunMode>('simulation');
  const [scriptApprovalRequired, setScriptApprovalRequired] = useState(false);
  const [scriptAgent, setScriptAgent] = useState(DEFAULT_AGENT);
  const [draftAction, setDraftAction] = useState<BrowserStepDraft['action']>('wait');
  const [draftLabel, setDraftLabel] = useState('settle');
  const [draftSelector, setDraftSelector] = useState('');
  const [draftValue, setDraftValue] = useState('');
  const [draftTimeout, setDraftTimeout] = useState('1200');

  const loadWorkflows = async () => {
    const [workflowData, statusData, scriptData, presetData] = await Promise.all([
      getBrowserWorkflows(),
      getPlaywrightStatus(),
      getPlaywrightScripts(),
      getPlaywrightPresets(),
    ]);
    setWorkflows(workflowData.workflows);
    setPlaywrightStatus(statusData);
    setScripts(scriptData.scripts);
    setPresets(presetData.presets);
  };

  useEffect(() => {
    void loadWorkflows();
  }, []);

  const inspect = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await inspectBrowserUrl(url);
      setInspection(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Inspection failed');
    } finally {
      setLoading(false);
    }
  };

  const saveWorkflow = async () => {
    setError('');
    try {
      await saveBrowserWorkflow({
        name,
        agent_id: workflowAgent,
        mode,
        start_url: seedUrls.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)[0] ?? '',
        urls: seedUrls.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).slice(1),
        goal,
      });
      await loadWorkflows();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save workflow');
    }
  };

  const runWorkflow = async (workflowId: string) => {
    setError('');
    try {
      const result = await runBrowserWorkflow(workflowId);
      setRunResults(result.results);
      await loadWorkflows();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to run workflow');
    }
  };

  const saveScript = async () => {
    setError('');
    try {
      const steps = JSON.parse(scriptSteps);
      await savePlaywrightScript({
        name: scriptName,
        agent_id: scriptAgent,
        start_url: scriptStartUrl,
        steps: Array.isArray(steps) ? steps : [],
        mode: scriptMode,
        approval_required: scriptApprovalRequired,
      });
      await loadWorkflows();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save script');
    }
  };

  const runScript = async (scriptId: string) => {
    setError('');
    try {
      const result = await runPlaywrightScript(scriptId);
      setScriptResults(result.results);
      await loadWorkflows();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to run script');
    }
  };

  const approveScript = async (scriptId: string) => {
    setError('');
    try {
      const result = await approvePlaywrightScript(scriptId);
      setScriptResults(result.results);
      await loadWorkflows();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to approve script');
    }
  };

  const removeScript = async (scriptId: string) => {
    setError('');
    try {
      await deletePlaywrightScript(scriptId);
      await loadWorkflows();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete script');
    }
  };

  const applyPreset = (preset: PlaywrightScriptPreset) => {
    setScriptName(preset.name);
    setScriptAgent(preset.agent_id);
    setScriptStartUrl(preset.start_url);
    setScriptMode(preset.mode);
    setScriptApprovalRequired(preset.approval_required);
    setScriptSteps(JSON.stringify(preset.steps, null, 2));
  };

  const installPresetPack = async (agentId: string) => {
    setError('');
    try {
      await installPlaywrightPresets(agentId);
      await loadWorkflows();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to install preset pack');
    }
  };

  const appendDraftStep = () => {
    try {
      const existing = JSON.parse(scriptSteps);
      const steps = Array.isArray(existing) ? existing : [];
      const next: Record<string, unknown> = { action: draftAction, label: draftLabel || draftAction };
      if (draftAction === 'wait') next.timeout_ms = Number(draftTimeout || 1200);
      if (draftAction !== 'wait') next.selector = draftSelector;
      if (draftAction === 'fill') next.value = draftValue;
      const merged = [...steps, next];
      setScriptSteps(JSON.stringify(merged, null, 2));
    } catch {
      setError('Steps JSON must be valid before appending new steps');
    }
  };

  return (
    <section className="panel specialist-panel">
      <div className="specialist-head">
        <div>
          <h2>Browser Ops</h2>
          <p className="muted">Inspect pages, save repeatable research sweeps, and rerun browser workflows from the dashboard.</p>
        </div>
      </div>

      <div className="specialist-callout">
        <strong>Current scope</strong>
        <p className="muted small">
          This is a real browser research surface built on live HTTP inspection and saved workflows. It is not yet a full Playwright recorder.
        </p>
      </div>

      <div className="shopping-grid">
        <div className="shopping-card">
          <h3>Page Inspect</h3>
          <label>
            URL
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" />
          </label>
          <div className="action-row">
            <button type="button" onClick={() => void inspect()} disabled={loading}>
              {loading ? 'Inspecting...' : 'Inspect URL'}
            </button>
          </div>
          {inspection && (
            <div className="document-result">
              <div className="shopping-meta">
                <span>{inspection.status_code}</span>
                <span>{inspection.content_type}</span>
                <span>{inspection.link_count} links</span>
              </div>
              <p><strong>{inspection.title || inspection.h1 || inspection.url}</strong></p>
              <p className="muted">{inspection.description || inspection.h1 || 'No page summary available.'}</p>
            </div>
          )}
        </div>

        <div className="shopping-card">
          <h3>Saved Workflow</h3>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            Goal
            <textarea rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} />
          </label>
          <label>
            URLs
            <textarea
              rows={5}
              value={seedUrls}
              onChange={(e) => setSeedUrls(e.target.value)}
              placeholder={'https://example.com\nhttps://example.com/about'}
            />
          </label>
          <label>
            Mode
            <select value={mode} onChange={(e) => setMode(e.target.value as RunMode)}>
              <option value="simulation">simulation</option>
              <option value="live">live</option>
            </select>
          </label>
          <label>
            Agent
            <select value={workflowAgent} onChange={(e) => setWorkflowAgent(e.target.value)}>
              {AGENT_OPTIONS.map((agent) => (
                <option key={agent} value={agent}>{agent}</option>
              ))}
            </select>
          </label>
          <div className="action-row">
            <button type="button" onClick={() => void saveWorkflow()}>
              Save Workflow
            </button>
          </div>
        </div>
      </div>

      {error && <p className="error-text">{error}</p>}

      <div className="preset-panel">
        <div className="preset-panel-head">
          <div>
            <h3>Browser Workflows</h3>
            <p className="muted small">Reusable page sweeps for research, sourcing, and quick operator checks.</p>
          </div>
        </div>
        <div className="preset-list">
          {workflows.length === 0 && <p className="muted small">No browser workflows saved yet.</p>}
          {workflows.map((workflow) => (
            <article key={workflow.workflow_id} className="preset-card">
              <div>
                <strong>{workflow.name}</strong>
                <p className="muted small">
                  {workflow.agent_id} · {workflow.mode} · {workflow.last_status || 'never run'}
                </p>
                <p className="muted small">{workflow.start_url}</p>
              </div>
              <div className="preset-actions">
                <button type="button" onClick={() => void runWorkflow(workflow.workflow_id)}>Run</button>
              </div>
            </article>
          ))}
        </div>
      </div>

      <div className="preset-panel">
        <div className="preset-panel-head">
          <div>
            <h3>Playwright Scripts</h3>
            <p className="muted small">
              Runtime status: {playwrightStatus?.playwright_available ? 'available' : 'not installed'} ·{' '}
              {playwrightStatus?.headless ? 'headless' : 'headed'}
            </p>
          </div>
        </div>
        <div className="preset-list">
          {presets.map((preset) => (
            <article key={preset.preset_id} className="preset-card">
              <div>
                <strong>{preset.name}</strong>
                <p className="muted small">{preset.agent_id} · {preset.mode} · {preset.approval_required ? 'approval-gated' : 'direct'}</p>
                <p className="muted small">{preset.description}</p>
              </div>
              <div className="preset-actions">
                <button type="button" className="ghost-button" onClick={() => applyPreset(preset)}>
                  Use Preset
                </button>
              </div>
            </article>
          ))}
        </div>
        <div className="action-row">
          {AGENT_OPTIONS.map((agent) => (
            <button key={agent} type="button" className="ghost-button" onClick={() => void installPresetPack(agent)}>
              Install {agent} pack
            </button>
          ))}
        </div>
        <div className="shopping-grid">
          <div className="shopping-card">
            <label>
              Script Name
              <input value={scriptName} onChange={(e) => setScriptName(e.target.value)} />
            </label>
            <label>
              Agent
              <select value={scriptAgent} onChange={(e) => setScriptAgent(e.target.value)}>
                {AGENT_OPTIONS.map((agent) => (
                  <option key={agent} value={agent}>{agent}</option>
                ))}
              </select>
            </label>
            <label>
              Start URL
              <input value={scriptStartUrl} onChange={(e) => setScriptStartUrl(e.target.value)} />
            </label>
            <label>
              Mode
              <select value={scriptMode} onChange={(e) => setScriptMode(e.target.value as RunMode)}>
                <option value="simulation">simulation</option>
                <option value="live">live</option>
              </select>
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={scriptApprovalRequired}
                onChange={(e) => setScriptApprovalRequired(e.target.checked)}
              />
              Require approval before live execution
            </label>
            <label>
              Steps JSON
              <textarea rows={7} value={scriptSteps} onChange={(e) => setScriptSteps(e.target.value)} />
            </label>
            <div className="action-row">
              <button type="button" onClick={() => void saveScript()}>
                Save Script
              </button>
            </div>
          </div>
          <div className="shopping-card">
            <h3>Guided Step Capture</h3>
            <p className="muted small">This builds Playwright steps interactively so you do not have to hand-write JSON.</p>
            <label>
              Action
              <select value={draftAction} onChange={(e) => setDraftAction(e.target.value as BrowserStepDraft['action'])}>
                <option value="wait">wait</option>
                <option value="click">click</option>
                <option value="fill">fill</option>
                <option value="extract_text">extract_text</option>
              </select>
            </label>
            <label>
              Label
              <input value={draftLabel} onChange={(e) => setDraftLabel(e.target.value)} />
            </label>
            {draftAction === 'wait' ? (
              <label>
                Timeout (ms)
                <input value={draftTimeout} onChange={(e) => setDraftTimeout(e.target.value)} />
              </label>
            ) : (
              <label>
                Selector
                <input value={draftSelector} onChange={(e) => setDraftSelector(e.target.value)} placeholder="input[name='email']" />
              </label>
            )}
            {draftAction === 'fill' && (
              <label>
                Value
                <input value={draftValue} onChange={(e) => setDraftValue(e.target.value)} />
              </label>
            )}
            <div className="action-row">
              <button type="button" className="ghost-button" onClick={appendDraftStep}>
                Add Step
              </button>
              <button type="button" className="ghost-button" onClick={() => setScriptSteps('[]')}>
                Clear Steps
              </button>
            </div>
          </div>
          <div className="shopping-card">
            <h3>Saved Scripts</h3>
            <div className="preset-list">
              {scripts.length === 0 && <p className="muted small">No Playwright scripts saved yet.</p>}
              {scripts.map((script) => (
                <article key={script.script_id} className="preset-card">
                  <div>
                    <strong>{script.name}</strong>
                    <p className="muted small">{script.start_url}</p>
                    <p className="muted small">
                      {(script.mode || 'simulation')} · {script.approval_required ? 'approval-gated' : 'direct'} · {script.last_status || 'never run'}
                    </p>
                  </div>
                  <div className="preset-actions">
                    <button type="button" onClick={() => void runScript(script.script_id)}>
                      Run
                    </button>
                    {script.last_status === 'awaiting_approval' && (
                      <button type="button" className="ghost-button" onClick={() => void approveScript(script.script_id)}>
                        Approve
                      </button>
                    )}
                    <button type="button" className="ghost-button" onClick={() => void removeScript(script.script_id)}>
                      Delete
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </div>
        {scriptResults.length > 0 && (
          <div className="document-result">
            <pre className="document-preview">{JSON.stringify(scriptResults, null, 2)}</pre>
          </div>
        )}
      </div>

      {runResults.length > 0 && (
        <div className="preset-panel">
          <div className="preset-panel-head">
            <div>
              <h3>Latest Workflow Results</h3>
              <p className="muted small">Recent live page inspection results from the selected workflow.</p>
            </div>
          </div>
          <div className="preset-list">
            {runResults.map((result) => (
              <article key={`${result.url}-${result.title ?? result.error ?? 'result'}`} className="preset-card">
                <div>
                  <strong>{result.title || result.url}</strong>
                  <p className="muted small">{result.url}</p>
                  <p className="muted small">{result.description || result.h1 || result.error || 'No summary available.'}</p>
                </div>
              </article>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
