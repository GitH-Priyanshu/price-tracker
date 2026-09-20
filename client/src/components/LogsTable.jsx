import React from 'react';
import StatusPill from './StatusPill.jsx';

/**
 * Plain table listing scrape audit logs and execution telemetry (Level F3).
 */
export default function LogsTable({ logs = [], total = 0, limit = 20, offset = 0, onPageChange }) {
  if (!logs || logs.length === 0) {
    return (
      <p style={{ color: 'var(--text-muted)', fontSize: 'var(--font-sm)', margin: 'var(--space-3) 0' }}>
        No scrape execution logs recorded yet.
      </p>
    );
  }

  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages = Math.ceil(total / limit) || 1;

  return (
    <div>
      <table>
        <thead>
          <tr>
            <th>Timestamp</th>
            <th>Status</th>
            <th>Attempts</th>
            <th>Duration</th>
            <th>HTTP</th>
            <th>Error / Diagnostics</th>
          </tr>
        </thead>
        <tbody>
          {logs.map((log) => {
            const ts = log.started_at || log.created_at || log.finished_at;
            const time = ts ? new Date(ts).toLocaleString() : '—';
            const isFailed = log.status === 'failed';

            let attempts = [];
            if (Array.isArray(log.attempt_details)) {
              attempts = log.attempt_details;
            } else if (typeof log.attempt_details === 'string') {
              try {
                attempts = JSON.parse(log.attempt_details);
              } catch {}
            }

            return (
              <tr key={log.id} className={isFailed ? 'row-failed' : ''}>
                <td style={{ fontSize: 'var(--font-xs)', color: isFailed ? 'var(--status-failed)' : 'var(--text-muted)' }}>
                  {time}
                </td>
                <td><StatusPill status={log.status} /></td>
                <td className="mono">{log.attempts ?? 1}</td>
                <td className="mono">{log.duration_ms != null ? `${log.duration_ms}ms` : '—'}</td>
                <td className="mono">{log.http_status || '200'}</td>
                <td style={{ fontSize: 'var(--font-xs)' }}>
                  {log.error_message ? (
                    <div style={{ color: 'var(--status-failed)', fontWeight: 500 }}>
                      {log.error_message}
                    </div>
                  ) : (
                    <span style={{ color: 'var(--text-muted)' }}>None</span>
                  )}
                  {attempts.length > 0 ? (
                    <details style={{ marginTop: 'var(--space-1)', cursor: 'pointer' }}>
                      <summary style={{ color: 'var(--accent)', fontSize: 'var(--font-xs)' }}>
                        {attempts.length} attempt detail(s)
                      </summary>
                      <ul style={{ margin: 'var(--space-1) 0 0', paddingLeft: 'var(--space-3)', fontSize: '11px', color: 'var(--text)' }}>
                        {attempts.map((att, idx) => (
                          <li key={idx}>
                            Attempt #{att.attempt || idx + 1}: {att.error_type || att.status || 'failed'}
                            {att.duration_ms != null ? ` (${att.duration_ms}ms)` : ''}
                            {att.error_message ? ` — ${att.error_message}` : ''}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : (isFailed && log.error_message && (
                    <details style={{ marginTop: 'var(--space-1)', cursor: 'pointer' }}>
                      <summary style={{ color: 'var(--accent)', fontSize: 'var(--font-xs)' }}>
                        Diagnostic details
                      </summary>
                      <div className="mono" style={{ fontSize: '11px', color: 'var(--status-failed)', marginTop: '2px' }}>
                        {log.error_type || 'SCRAPE_FAILURE'}: {log.error_message}
                      </div>
                    </details>
                  ))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {totalPages > 1 && (
        <div className="pagination-bar">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => onPageChange(Math.max(0, offset - limit))}
            disabled={offset === 0}
          >
            &larr; Previous
          </button>
          <span>
            Page {currentPage} of {totalPages} ({total} total logs)
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => onPageChange(offset + limit)}
            disabled={offset + limit >= total}
          >
            Next &rarr;
          </button>
        </div>
      )}
    </div>
  );
}
