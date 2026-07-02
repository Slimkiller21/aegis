// NSFW Guard — main process.
// Orchestrates: the dashboard/onboarding UI, screen-source handoff, the hidden
// detector, the blocking overlay, the detection state machine, accountability
// (streaks + incident log), tamper-resistance (locked + cooldown-gated disable
// and a guardian watchdog), the tray, and autostart.

const {
  app,
  BrowserWindow,
  desktopCapturer,
  screen,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  dialog,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// ---- guardian watchdog mode ----------------------------------------------
// Launched as a detached child with --watchdog. Restarts the app if its
// heartbeat goes stale (i.e. it was killed), unless a clean-quit flag is set.
if (process.argv.includes('--watchdog')) {
  runWatchdog();
} else {
  runApp();
}

// =========================================================================
//  APP
// =========================================================================
function runApp() {
  const config = require('./config');
  const store = require('./store');
  const security = require('./security');
  const enforcement = require('./enforcement');

  // Persistent log so a packaged build (no console) is still debuggable.
  function log(...args) {
    const line = `${new Date().toISOString()} ${args.join(' ')}`;
    console.log(line);
    try {
      fs.appendFileSync(path.join(app.getPath('userData'), 'log.txt'), line + '\n');
    } catch {}
  }
  process.on('uncaughtException', (e) =>
    log('[uncaught] ' + (e && e.stack ? e.stack : e)));
  process.on('unhandledRejection', (e) =>
    log('[unhandledRejection] ' + (e && e.stack ? e.stack : e)));

  let detectors = []; // [{ win, displayId }] — one hidden capturer per display
  let overlays = new Map(); // displayId -> overlay BrowserWindow (covers that display)
  let uiWin = null;
  let tray = null;
  let cfg = null;
  let heartbeatTimer = null;

  // protection + disable-cooldown state machine
  let paused = false;
  let cooldown = null; // { endsAt, timer }

  // per-display detection FSM: displayId -> { state, warnStart, cleanStreak, escalated }
  const fsmByDisplay = new Map();
  function fsmFor(id) {
    if (!fsmByDisplay.has(id))
      fsmByDisplay.set(id, { state: 'CLEAN', warnStart: 0, cleanStreak: 0, escalated: false });
    return fsmByDisplay.get(id);
  }

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', () => showUI());

  app.whenReady().then(init);

  async function init() {
    try {
      log(`[init] start packaged=${app.isPackaged} userData=${app.getPath('userData')}`);
      cfg = config.load();
      app.setLoginItemSettings({ openAtLogin: !!cfg.autoStart });
      store.beginProtection();

      createUI();
      log('[init] UI created; building capture...');
      await createCapture(); // overlays + detectors for every display
      log(`[init] capture built (${detectors.length} detector(s))`);
      createTray();
      startHeartbeat();
      if (cfg.watchdog) ensureWatchdog();
      log('[init] complete');

      // displays come and go (docking, unplugging) -> rebuild coverage
      screen.on('display-metrics-changed', rebuildCapture);
      screen.on('display-added', rebuildCapture);
      screen.on('display-removed', rebuildCapture);
    } catch (e) {
      log('[init] FATAL ' + (e && e.stack ? e.stack : e));
    }
  }

  // ---- main UI window (onboarding or dashboard) --------------------------
  function createUI() {
    uiWin = new BrowserWindow({
      width: 1060,
      height: 740,
      minWidth: 920,
      minHeight: 660,
      show: true,
      backgroundColor: '#0b0d12',
      title: 'NSFW Guard',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'ui-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    uiWin.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
    uiWin.on('close', (e) => {
      // closing the window just hides it; protection keeps running in tray
      if (!app.isQuitting) {
        e.preventDefault();
        uiWin.hide();
      }
    });
  }

  function showUI() {
    if (!uiWin || uiWin.isDestroyed()) createUI();
    if (uiWin.isMinimized()) uiWin.restore();
    uiWin.show();
    uiWin.focus();
  }

  // ---- capture + overlays: one of each per display -----------------------
  async function createCapture() {
    const displays = screen.getAllDisplays();
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 },
    });
    for (const display of displays) {
      const id = String(display.id);
      // match by display_id; fall back to positional if the platform omits it
      const source =
        sources.find((s) => String(s.display_id) === id) ||
        sources[displays.indexOf(display)];
      if (!source) continue;
      createOverlayFor(display);
      await createDetectorFor(display, source.id);
    }
    if (!detectors.length) console.error('[main] no screen sources to capture');
  }

  // Bundled model files live under assets/models. Inside a packaged app they
  // are asar-unpacked (onnxruntime needs a real file path on disk).
  function modelAsset(name) {
    return path
      .join(app.getAppPath(), 'assets', 'models', name)
      .replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
  }

  function detectorParams() {
    return {
      engine: cfg.engine,
      marqoModelPath: modelAsset('marqo-nsfw-384.onnx'),
      marqoMetaPath: modelAsset('marqo-nsfw-384.json'),
      fps: cfg.fps,
      thresholds: cfg.thresholds,
      flagSexy: cfg.flagSexy,
      tiling: cfg.tiling,
    };
  }

  async function createDetectorFor(display, sourceId) {
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        backgroundThrottling: false,
      },
    });
    await win.loadFile(path.join(__dirname, '..', 'detector', 'detector.html'));
    win.webContents.send('start-capture', {
      displayId: String(display.id),
      sourceId,
      ...detectorParams(),
    });
    detectors.push({ win, displayId: String(display.id) });
  }

  function createOverlayFor(display) {
    const { x, y, width, height } = display.bounds;
    const win = new BrowserWindow({
      x, y, width, height,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: true,
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true);
    win.loadFile(path.join(__dirname, '..', 'overlay', 'overlay.html'));
    overlays.set(String(display.id), win);
  }

  function showOverlay(displayId) {
    const win = overlays.get(String(displayId)) || overlays.values().next().value;
    if (!win || win.isDestroyed()) return;
    win.webContents.send('overlay-message', cfg.message);
    win.showInactive();
    win.setAlwaysOnTop(true, 'screen-saver');
  }
  function hideOverlay(displayId) {
    const win = overlays.get(String(displayId));
    if (win && !win.isDestroyed()) win.hide();
  }
  function hideAllOverlays() {
    for (const win of overlays.values()) if (win && !win.isDestroyed()) win.hide();
    for (const fsm of fsmByDisplay.values()) {
      fsm.state = 'CLEAN';
      fsm.escalated = false;
      fsm.cleanStreak = 0;
    }
  }

  // settings change -> push new params to existing detectors (no re-capture)
  function restartDetector() {
    for (const d of detectors) {
      if (d.win && !d.win.isDestroyed())
        d.win.webContents.send('update-config', detectorParams());
    }
  }

  // display added/removed/resized -> tear down and rebuild full coverage
  async function rebuildCapture() {
    for (const d of detectors) try { d.win.destroy(); } catch {}
    for (const win of overlays.values()) try { win.destroy(); } catch {}
    detectors = [];
    overlays = new Map();
    fsmByDisplay.clear();
    await createCapture();
  }

  // ---- detection result -> FSM + accountability --------------------------
  ipcMain.on('nsfw-result', (_e, payload) => {
    if (paused) return;
    if (payload.flagged) {
      const s = payload.scores || {};
      log('[flagged]', `${payload.engine || '?'}:${payload.category}`,
        `nsfw=${(s.nsfw ?? 0).toFixed(2)} porn=${(s.porn ?? 0).toFixed(2)} sexy=${(s.sexy ?? 0).toFixed(2)} hentai=${(s.hentai ?? 0).toFixed(2)}`);
    }
    const id = String(payload.displayId ?? 'primary');
    const fsm = fsmFor(id);
    const now = Date.now();
    if (payload.flagged) {
      fsm.cleanStreak = 0;
      if (fsm.state === 'CLEAN') {
        fsm.state = 'WARNING';
        fsm.warnStart = now;
        fsm.escalated = false;
        showOverlay(id);
        // log the incident (resets the clean streak) — dedup within episode
        if (store.recordIncident(payload.category, payload.score)) pushUpdate();
      } else if (
        fsm.state === 'WARNING' &&
        !fsm.escalated &&
        now - fsm.warnStart >= cfg.graceMs
      ) {
        fsm.escalated = true;
        if (cfg.enforceMinimize) enforcement.minimizeForegroundWindow();
      }
    } else if (fsm.state === 'WARNING') {
      fsm.cleanStreak += 1;
      if (fsm.cleanStreak >= cfg.clearFrames) {
        fsm.state = 'CLEAN';
        fsm.escalated = false;
        hideOverlay(id);
      }
    }
  });

  ipcMain.on('detector-status', (_e, msg) => log('[detector]', msg));

  // ---- UI IPC ------------------------------------------------------------
  function status() {
    if (cooldown) return 'cooling';
    return paused ? 'paused' : 'active';
  }
  function fullState() {
    return {
      ...store.snapshot(),
      status: status(),
      cooldownRemainingMs: cooldown ? Math.max(0, cooldown.endsAt - Date.now()) : 0,
      settings: {
        fps: cfg.fps,
        thresholds: cfg.thresholds,
        flagSexy: cfg.flagSexy,
        message: cfg.message,
        disableCooldownMs: cfg.disableCooldownMs,
      },
    };
  }
  function pushUpdate() {
    if (uiWin && !uiWin.isDestroyed()) uiWin.webContents.send('ui:update', fullState());
    updateTray();
  }

  ipcMain.handle('ui:getState', () => fullState());

  ipcMain.handle('ui:completeOnboarding', (_e, data) => {
    const s = store.load();
    s.profile = { ...s.profile, ...data.profile };
    s.onboarded = true;
    store.save();
    if (data.password) security.setPassword(data.password);
    pushUpdate();
    return { ok: true };
  });

  ipcMain.handle('ui:verifyPassword', (_e, pw) => security.verifyPassword(pw));

  // request to turn protection OFF: needs the (partner) password, then a
  // mandatory cooldown before it actually disables.
  ipcMain.handle('ui:requestDisable', (_e, pw) => {
    if (security.hasPassword() && !security.verifyPassword(pw)) {
      return { ok: false, reason: 'bad-password' };
    }
    if (cooldown) return { ok: true, status: 'cooling' };
    const ms = cfg.disableCooldownMs || 0;
    if (ms <= 0) {
      paused = true;
      hideAllOverlays();
      pushUpdate();
      return { ok: true, status: 'paused' };
    }
    cooldown = { endsAt: Date.now() + ms, timer: null };
    cooldown.timer = setInterval(() => {
      if (Date.now() >= cooldown.endsAt) {
        clearInterval(cooldown.timer);
        cooldown = null;
        paused = true;
        hideAllOverlays();
      }
      pushUpdate();
    }, 1000);
    pushUpdate();
    return { ok: true, status: 'cooling' };
  });

  ipcMain.handle('ui:cancelDisable', () => {
    if (cooldown) {
      clearInterval(cooldown.timer);
      cooldown = null;
    }
    pushUpdate();
    return { ok: true };
  });

  ipcMain.handle('ui:resume', () => {
    paused = false;
    if (cooldown) {
      clearInterval(cooldown.timer);
      cooldown = null;
    }
    pushUpdate();
    return { ok: true };
  });

  ipcMain.handle('ui:updateSettings', (_e, { pw, patch }) => {
    if (security.hasPassword() && !security.verifyPassword(pw)) {
      return { ok: false, reason: 'bad-password' };
    }
    cfg = config.load();
    Object.assign(cfg, patch);
    config.save(cfg);
    restartDetector();
    pushUpdate();
    return { ok: true };
  });

  ipcMain.handle('ui:exportLog', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(uiWin, {
      title: 'Export accountability log',
      defaultPath: `nsfw-guard-log-${new Date().toISOString().slice(0, 10)}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (canceled || !filePath) return { ok: false };
    const s = store.load();
    const rows = [['timestamp', 'category', 'confidence_pct']].concat(
      s.incidents.map((i) => [new Date(i.t).toISOString(), i.category, i.score])
    );
    fs.writeFileSync(filePath, rows.map((r) => r.join(',')).join('\n'));
    return { ok: true, filePath };
  });

  // ---- tray --------------------------------------------------------------
  function createTray() {
    let img = nativeImage.createFromPath(
      path.join(__dirname, '..', '..', 'assets', 'icon.png')
    );
    if (img.isEmpty()) img = nativeImage.createEmpty();
    tray = new Tray(img);
    tray.on('click', showUI);
    updateTray();
  }

  function updateTray() {
    if (!tray) return;
    const menu = Menu.buildFromTemplate([
      { label: `NSFW Guard — ${status()}`, enabled: false },
      { type: 'separator' },
      { label: 'Open dashboard', click: showUI },
      {
        label: 'Quit',
        click: () => {
          // quitting = turning off protection -> route through the locked UI
          if (security.hasPassword()) {
            showUI();
            if (uiWin && !uiWin.isDestroyed())
              uiWin.webContents.send('ui:request-quit');
          } else {
            doQuit();
          }
        },
      },
    ]);
    tray.setContextMenu(menu);
    tray.setToolTip(`NSFW Guard — ${status()}`);
  }

  // quit must pass the same locked + cooldown gate as disabling
  ipcMain.handle('ui:requestQuit', (_e, pw) => {
    if (security.hasPassword() && !security.verifyPassword(pw)) {
      return { ok: false, reason: 'bad-password' };
    }
    doQuit();
    return { ok: true };
  });

  function doQuit() {
    app.isQuitting = true;
    // tell the watchdog this is a legitimate shutdown
    try {
      fs.writeFileSync(flagPath('shutdown.flag'), String(Date.now()));
    } catch {}
    app.quit();
  }

  // ---- heartbeat + watchdog ----------------------------------------------
  function startHeartbeat() {
    const hb = flagPath('heartbeat.txt');
    const tick = () => {
      try {
        fs.writeFileSync(hb, String(Date.now()));
      } catch {}
    };
    tick();
    heartbeatTimer = setInterval(tick, 1000);
  }

  function ensureWatchdog() {
    const lock = flagPath('watchdog.lock');
    // if a live watchdog already owns the lock, don't spawn another
    try {
      const pid = parseInt(fs.readFileSync(lock, 'utf8'), 10);
      if (pid && isAlive(pid)) return;
    } catch {}
    // dev: `electron <appPath> --watchdog`. packaged: `<App>.exe --watchdog`.
    const wdArgs = app.isPackaged ? ['--watchdog'] : [app.getAppPath(), '--watchdog'];
    const relaunchArgs = app.isPackaged ? [] : [app.getAppPath()];
    const child = spawn(process.execPath, wdArgs, {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        NSFW_GUARD_USERDATA: app.getPath('userData'),
        NSFW_GUARD_RELAUNCH_EXEC: process.execPath,
        NSFW_GUARD_RELAUNCH_ARGS: JSON.stringify(relaunchArgs),
      },
    });
    try {
      fs.writeFileSync(lock, String(child.pid));
    } catch {}
    child.unref();
  }

  function flagPath(name) {
    return path.join(app.getPath('userData'), name);
  }

  app.on('window-all-closed', (e) => {
    if (!app.isQuitting) e.preventDefault?.();
  });
  app.on('before-quit', () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  });
}

// =========================================================================
//  WATCHDOG  (runs in a separate, headless process)
// =========================================================================
function runWatchdog() {
  // we don't need the full Electron app lifecycle here; keep it minimal.
  const userData =
    process.env.NSFW_GUARD_USERDATA ||
    path.join(process.env.APPDATA || process.env.HOME || '.', 'nsfw-guard');
  const hbFile = path.join(userData, 'heartbeat.txt');
  const shutdownFlag = path.join(userData, 'shutdown.flag');
  const STALE_MS = 8000;

  // how to bring the app back, handed down from the parent (dev vs packaged)
  const relExec = process.env.NSFW_GUARD_RELAUNCH_EXEC || process.execPath;
  let relArgs = [];
  try {
    relArgs = JSON.parse(process.env.NSFW_GUARD_RELAUNCH_ARGS || '[]');
  } catch {}

  setInterval(() => {
    // legitimate shutdown -> stand down. Only honor a FRESH flag, so a
    // leftover flag from a crash can't silently disable future protection.
    if (fs.existsSync(shutdownFlag)) {
      let ts = 0;
      try {
        ts = parseInt(fs.readFileSync(shutdownFlag, 'utf8'), 10) || 0;
      } catch {}
      try {
        fs.unlinkSync(shutdownFlag);
      } catch {}
      if (Date.now() - ts < 30000) process.exit(0);
      // stale flag -> ignore and keep guarding
    }
    let hb = 0;
    try {
      hb = parseInt(fs.readFileSync(hbFile, 'utf8'), 10) || 0;
    } catch {}
    if (Date.now() - hb > STALE_MS) {
      // app appears dead (killed) -> relaunch it, then exit; the fresh app
      // spawns its own watchdog.
      try {
        const child = spawn(relExec, relArgs, { detached: true, stdio: 'ignore' });
        child.unref();
      } catch {}
      process.exit(0);
    }
  }, 3000);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
