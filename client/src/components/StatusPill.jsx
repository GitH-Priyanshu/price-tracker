import React from 'react';

/**
 * Status indicator pill enforcing fixed design brief colors:
 * green = success, amber = retried, red = failed.
 */
export default function StatusPill({ status }) {
  if (!status) {
    return <span className="pill pill-neutral">N/A</span>;
  }

  const normalized = String(status).toLowerCase();
  let modifier = 'pill-neutral';

  if (normalized === 'success' || normalized === 'in_stock' || normalized === 'tracking') {
    modifier = 'pill-success';
  } else if (normalized === 'retried' || normalized === 'low_stock') {
    modifier = 'pill-retried';
  } else if (normalized === 'failed' || normalized === 'out_of_stock') {
    modifier = 'pill-failed';
  }

  return (
    <span className={`pill ${modifier}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}
