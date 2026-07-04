// Enforcement actions, done WITHOUT native modules (tiny PowerShell user32
// calls) so the app runs anywhere with no build step.
//
//   closeForeground() — the primary action. Looks at the foreground window and:
//     * browser  -> sends Ctrl+W, closing the active (offending) tab
//     * other app -> posts WM_CLOSE, closing that window (e.g. a media player
//                    or image viewer showing illicit content)
//     * system / our own windows -> skipped, never touched
//   minimizeForegroundWindow() — softer fallback (minimize, no data loss).
//
// The overlay window is non-focusable, so the OS foreground window stays on the
// offending app while we act on it.

const { spawn } = require('child_process');

let busy = false;

function runPs(script, onLine) {
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { windowsHide: true }
  );
  let out = '';
  child.stdout.on('data', (d) => (out += d.toString()));
  child.on('error', (e) => console.error('[enforce] error:', e.message));
  child.on('close', () => {
    busy = false;
    if (onLine) onLine(out.trim());
  });
}

// Close the offending foreground window. `onResult(kind, name)` is called with
// kind in {tab, window, skip, none}. Browsers = active-tab close; else = window
// close. A denylist protects the shell and our own app.
function closeForeground(onResult) {
  if (process.platform !== 'win32') return;
  if (busy) return;
  busy = true;

  const ps = `
$sig = @'
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr PostMessage(IntPtr h, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
'@
Add-Type -TypeDefinition $sig
$h = [Win]::GetForegroundWindow()
if ($h -eq [IntPtr]::Zero) { Write-Output 'none:'; exit }
$procId = 0
[Win]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
$name = ''
try { $name = (Get-Process -Id $procId -ErrorAction Stop).ProcessName.ToLower() } catch {}

$browsers  = @('chrome','msedge','firefox','brave','opera','vivaldi','arc','chromium','thorium','waterfox','librewolf','iexplore','maxthon','yandex')
$protected = @('nsfw guard','nsfwguard','explorer','dwm','searchhost','searchapp','startmenuexperiencehost','shellexperiencehost','textinputhost','applicationframehost','sihost','lockapp','systemsettings')

foreach ($p in $protected) { if ($name -like "*$p*") { Write-Output "skip:$name"; exit } }

$isBrowser = $false
foreach ($b in $browsers) { if ($name -like "*$b*") { $isBrowser = $true; break } }

if ($isBrowser) {
  [Win]::SetForegroundWindow($h) | Out-Null
  Start-Sleep -Milliseconds 70
  [Win]::keybd_event(0x11,0,0,[UIntPtr]::Zero)   # Ctrl down
  [Win]::keybd_event(0x57,0,0,[UIntPtr]::Zero)   # W down
  [Win]::keybd_event(0x57,0,2,[UIntPtr]::Zero)   # W up
  [Win]::keybd_event(0x11,0,2,[UIntPtr]::Zero)   # Ctrl up
  Write-Output "tab:$name"
} else {
  [Win]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null   # WM_CLOSE
  Write-Output "window:$name"
}
`.trim();

  runPs(ps, (line) => {
    const i = line.lastIndexOf(':');
    const kind = i >= 0 ? line.slice(0, i).split('\n').pop() : 'none';
    const name = i >= 0 ? line.slice(i + 1) : '';
    if (onResult) onResult(kind, name);
  });
}

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
[Win]::ShowWindow($h, 6) | Out-Null   # SW_MINIMIZE
`.trim();
  runPs(ps, null);
}

module.exports = { closeForeground, minimizeForegroundWindow };
