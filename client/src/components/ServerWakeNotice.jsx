import React, { useState, useEffect } from 'react';
import { subscribeServerWake } from '../api/client.js';

/**
 * Friendly notification shown when Render free tier instance is spinning up.
 * Prevents false "error" reports on initial cold starts.
 */
export default function ServerWakeNotice() {
  const [isWaking, setIsWaking] = useState(false);

  useEffect(() => {
    return subscribeServerWake(setIsWaking);
  }, []);

  if (!isWaking) return null;

  return (
    <div className="server-notice" role="status" aria-live="polite">
      <strong>Connecting to backend:</strong> Waking up the server (Render free instance sleeps when idle and may take up to 60 seconds on the first request)...
    </div>
  );
}
