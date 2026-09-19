import { execSync } from 'child_process';
import { getBrowserInstance, closeBrowser } from '../src/services/browserScraper.js';

export function getProcessTreeMemoryBytes(rootPid = process.pid) {
  try {
    // Get all process ids and parent process ids on Windows
    const psCmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, WorkingSetSize | ConvertTo-Json -Compress"`;
    const stdout = execSync(psCmd, { encoding: 'utf8', timeout: 5000 });
    const procs = JSON.parse(stdout);
    
    // Build tree map
    const pids = new Set([rootPid]);
    let added = true;
    while (added) {
      added = false;
      for (const p of procs) {
        if (pids.has(p.ParentProcessId) && !pids.has(p.ProcessId)) {
          pids.add(p.ProcessId);
          added = true;
        }
      }
    }

    let totalWorkingSet = 0;
    const matched = [];
    for (const p of procs) {
      if (pids.has(p.ProcessId)) {
        totalWorkingSet += Number(p.WorkingSetSize) || 0;
        matched.push({ pid: p.ProcessId, wsMb: ((Number(p.WorkingSetSize) || 0) / (1024 * 1024)).toFixed(1) });
      }
    }

    return { totalBytes: totalWorkingSet, totalMb: (totalWorkingSet / (1024 * 1024)).toFixed(1), processes: matched };
  } catch (e) {
    return { totalBytes: process.memoryUsage().rss, totalMb: (process.memoryUsage().rss / (1024 * 1024)).toFixed(1), error: e.message };
  }
}

async function test() {
  const mem1 = getProcessTreeMemoryBytes();
  console.log('Before Chromium launch:', mem1);

  const browser = await getBrowserInstance({ headed: false });
  const mem2 = getProcessTreeMemoryBytes();
  console.log('After Chromium launch (Process Tree):', mem2);

  await closeBrowser();
}

test().catch(console.error);
