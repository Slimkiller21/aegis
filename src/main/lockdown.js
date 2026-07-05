// Lockdown tier: a per-user Windows Scheduled Task ("AegisGuard") that fires
// every minute and resurrects Aegis if it was killed. Complements the watchdog
// process: the watchdog respawns in seconds but can itself be killed; Task
// Scheduler is a SYSTEM service and survives.
//
// Mutual guard: the app re-creates the task every minute while alive, and the
// task restarts the app within a minute of it dying. Defeating both requires
// killing the app + watchdog AND deleting the task inside the same one-minute
// window — real friction instead of two clicks in Task Manager.
//
// Per-user task = created/removed silently, no UAC. The task's script stands
// down when it sees a fresh shutdown.flag (authorized quit / update install)
// or an uninstall-allowed flag, so legitimate stops are respected — and an
// authorized quit removes the task entirely anyway.
//
// The task runs a .vbs wrapper so no console window flashes every minute.

const { app } = require('electron');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const TASK = 'AegisGuard';
let timer = null;
let logFn = console.log;

function userData() {
  return app.getPath('userData');
}

function writeScripts(exe) {
  const ps1 = path.join(userData(), 'guard-task.ps1');
  const vbs = path.join(userData(), 'guard-task.vbs');
  fs.writeFileSync(
    ps1,
    `# AegisGuard: restart Aegis if it is not running (see lockdown.js)
$ud = "$env:APPDATA\\nsfw-guard"
if (Test-Path "$ud\\uninstall-allowed") { exit }
$sf = "$ud\\shutdown.flag"
if (Test-Path $sf) {
  if (((Get-Date) - (Get-Item $sf).LastWriteTime).TotalMinutes -lt 10) { exit }
}
$hb = "$ud\\heartbeat.txt"
if ((Test-Path $hb) -and (((Get-Date) - (Get-Item $hb).LastWriteTime).TotalSeconds -lt 90)) { exit }
Start-Process -FilePath "${exe.replace(/"/g, '')}"
`
  );
  fs.writeFileSync(
    vbs,
    `CreateObject("Wscript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""${ps1}""", 0, False\r\n`
  );
  return vbs;
}

function createTask(vbs, quiet) {
  const tr = `wscript.exe \\"${vbs}\\"`;
  const user = process.env.USERNAME || '';
  // /IT + /RU <user> = run in the user's INTERACTIVE session. Without /IT the
  // task runs non-interactively (session 0) and a GUI app it launches can't
  // attach to the desktop and never appears. /RL LIMITED = normal privileges.
  const cmd =
    `schtasks /Create /F /TN "${TASK}" /SC MINUTE /MO 1 ` +
    `/RL LIMITED /RU "${user}" /IT /TR "${tr}"`;
  exec(cmd, (e, _o, se) => {
    if (e) logFn('[lockdown] task create failed: ' + (se || e.message).trim());
    else if (!quiet) logFn('[lockdown] task created');
  });
}

function ensure(exe, force) {
  let vbs;
  try {
    vbs = writeScripts(exe); // refreshes the exe path in the script each time
  } catch (e) {
    logFn('[lockdown] script write failed: ' + e.message);
    return;
  }
  if (force) return createTask(vbs, true); // overwrite even if present
  exec(`schtasks /Query /TN "${TASK}"`, (err) => {
    if (err) createTask(vbs); // deleted behind our back — mutual guard
  });
}

// arm the mutual guard: force-refresh the task now (heals stale definitions
// from older versions), then re-ensure every minute
function start(log) {
  if (log) logFn = log;
  if (!app.isPackaged) {
    logFn('[lockdown] dev mode — skipped');
    return;
  }
  const exe = process.execPath;
  ensure(exe, true);
  if (timer) clearInterval(timer);
  timer = setInterval(() => ensure(exe), 60 * 1000);
  logFn('[lockdown] armed (task: ' + TASK + ')');
}

// authorized stop (quit with password / uninstall): stand down completely
function remove(cb) {
  if (timer) clearInterval(timer);
  timer = null;
  exec(`schtasks /Delete /F /TN "${TASK}"`, () => {
    logFn('[lockdown] task removed');
    if (cb) cb();
  });
}

module.exports = { start, remove };
