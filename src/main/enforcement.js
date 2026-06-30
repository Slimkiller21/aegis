// Enforcement actions. Overlay is handled in main.js; here = the "minimize
// the offending window" escalation, done WITHOUT native modules so the app
// runs anywhere with no build step.
//
// Strategy: the overlay window is non-focusable, so the OS foreground window
// stays on the offending app. We minimize the current foreground window via
// a tiny PowerShell user32 call. Minimize (not close) = no unsaved-work loss.

const { spawn } = require('child_process');

let busy = false;

function minimizeForegroundWindow() {
  if (process.platform !== 'win32') return;
  if (busy) return;
  busy = true;

  const ps = `
$sig = @'
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
}
'@
Add-Type -TypeDefinition $sig
$h = [Win]::GetForegroundWindow()
# 6 = SW_MINIMIZE
[Win]::ShowWindow($h, 6) | Out-Null
`.trim();

  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
    { windowsHide: true }
  );
  child.on('error', (e) => console.error('[enforce] minimize error:', e.message));
  child.on('close', () => {
    busy = false;
  });
}

module.exports = { minimizeForegroundWindow };
