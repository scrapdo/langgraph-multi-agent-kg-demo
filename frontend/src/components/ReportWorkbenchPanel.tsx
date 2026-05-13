import { getRunReportUrl } from '../api/client';

export function ReportWorkbenchPanel({ runId }: { runId: string | null }) {
  return (
    <section className="panel report-workbench">
      <div className="specialist-head">
        <div>
          <h2>Visual Reports</h2>
          <p className="muted">Open the active run as a clean HTML report and print it to PDF from the browser.</p>
        </div>
      </div>
      {!runId ? (
        <p className="muted">Run a mission first. The report workbench is scoped to the active run.</p>
      ) : (
        <div className="report-workbench-actions">
          <a className="ghost-button" href={getRunReportUrl(runId)} target="_blank" rel="noreferrer">
            Open Report
          </a>
          <p className="muted small">This uses a dedicated report layout instead of printing the live dashboard directly.</p>
        </div>
      )}
    </section>
  );
}
