// Aegis — main process.
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
  Notification,
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
  const quotes = require('./quotes');
  const updater = require('./updater');
  const lockdown = require('./lockdown');
  const report = require('./report');

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
      // a normal launch means we're NOT mid-uninstall — clear any stale grant
      try { fs.unlinkSync(flagPath('uninstall-allowed')); } catch {}
      cfg = config.load();
      app.setLoginItemSettings({ openAtLogin: !!cfg.autoStart });
      store.beginProtection();

      createUI();
      log('[init] UI created; building capture...');
      await createCapture(); // overlays + detectors for every display
      log(`[init] capture built (${detectors.length} detector(s))`);
      createTray();
      startHeartbeat();
      checkMilestones(); // catch any crossed while the app was closed
      setInterval(checkMilestones, 60 * 1000);
      checkReport(); // weekly partner email if due
      setInterval(checkReport, 60 * 60 * 1000);
      if (cfg.watchdog) ensureWatchdog();
      if (cfg.lockdown !== false) lockdown.start(log);
      updater.start({
        log,
        prepareShutdown: () => {
          app.isQuitting = true;
          try { fs.writeFileSync(flagPath('shutdown.flag'), String(Date.now())); } catch {}
        },
      });
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
      title: 'Aegis',
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

  // Show a reflection popup on the given display: a random quote (70% scripture
  // / 30% historical) that auto-dismisses after cfg.quotePopupMs.
  const overlayTimers = new Map();
  function showQuoteOverlay(displayId) {
    const key = String(displayId);
    const win = overlays.get(key) || overlays.values().next().value;
    if (!win || win.isDestroyed()) return;
    const ms = cfg.quotePopupMs || 5000;
    win.webContents.send('overlay-quote', { ...quotes.pick(), durationMs: ms });
    win.showInactive();
    win.setAlwaysOnTop(true, 'screen-saver');
    if (overlayTimers.has(key)) clearTimeout(overlayTimers.get(key));
    overlayTimers.set(key, setTimeout(() => hideOverlay(key), ms));
  }
  function hideOverlay(displayId) {
    const key = String(displayId);
    if (overlayTimers.has(key)) { clearTimeout(overlayTimers.get(key)); overlayTimers.delete(key); }
    const win = overlays.get(key);
    if (win && !win.isDestroyed()) win.hide();
  }
  function hideAllOverlays() {
    for (const t of overlayTimers.values()) clearTimeout(t);
    overlayTimers.clear();
    for (const win of overlays.values()) if (win && !win.isDestroyed()) win.hide();
    for (const fsm of fsmByDisplay.values()) {
      fsm.state = 'CLEAN';
      fsm.escalated = false;
      fsm.cleanStreak = 0;
      fsm.lastActionAt = 0;
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
    detectorError = null; // a rebuild may recover a failed detector
    await createCapture();
  }

  // ---- detection result -> FSM + accountability --------------------------
  ipcMain.on('nsfw-result', (_e, payload) => {
    if (paused) return;
    if (payload.flagged) {
      const s = payload.scores || {};
      log('[flagged]', `${payload.engine || '?'}:${payload.category}`,
        `full=${(s.full ?? 0).toFixed(2)} tile=${(s.tile ?? 0).toFixed(2)} nsfw=${(s.nsfw ?? 0).toFixed(2)}`);
    }
    const id = String(payload.displayId ?? 'primary');
    const fsm = fsmFor(id);
    const now = Date.now();
    if (payload.flagged) {
      fsm.cleanStreak = 0;
      // Temporal confirmation: require several CONSECUTIVE flagged frames before
      // acting. Real NSFW sits on screen and scores high frame after frame; a
      // fast video cut (e.g. an anime trailer) may spike one frame near the
      // threshold but won't sustain it. This kills the dominant false-positive
      // mode without slowing down on genuinely explicit content.
      fsm.flagStreak = (fsm.flagStreak || 0) + 1;
      if (
        fsm.flagStreak >= (cfg.flagConfirmFrames || 3) &&
        now - (fsm.lastActionAt || 0) >= (cfg.actionCooldownMs || 6000)
      ) {
        fsm.lastActionAt = now;
        fsm.state = 'WARNING';
        enforce(id);
        showQuoteOverlay(id);
        if (store.recordIncident(payload.category, payload.score)) pushUpdate();
      }
    } else {
      fsm.flagStreak = 0; // one clean frame breaks the confirmation run
      if (fsm.state === 'WARNING') {
        fsm.cleanStreak += 1;
        if (fsm.cleanStreak >= cfg.clearFrames) fsm.state = 'CLEAN';
      }
    }
  });

  // Close the offending foreground window (browser tab or app window), falling
  // back to minimize if closing is disabled or the window can't be identified.
  function enforce(displayId) {
    if (cfg.enforceClose === false) {
      if (cfg.enforceMinimize) enforcement.minimizeForegroundWindow();
      return;
    }
    enforcement.closeForeground((kind, name) => {
      log(`[enforce] ${kind} ${name} (display ${displayId})`);
      if ((kind === 'skip' || kind === 'none') && cfg.enforceMinimize) {
        enforcement.minimizeForegroundWindow();
      }
    });
  }

  ipcMain.on('detector-status', (_e, msg) => log('[detector]', msg));

  // Fail loud: if a detector can't load its model or capture the screen, the
  // user must know they are NOT protected — never fail silently.
  let detectorError = null;
  ipcMain.on('detector-failed', (_e, { displayId, message }) => {
    detectorError = message;
    log(`[detector] FAILED on display ${displayId}: ${message}`);
    pushUpdate();
    showUI();
  });

  // ---- UI IPC ------------------------------------------------------------
  function status() {
    if (detectorError) return 'failed';
    if (cooldown) return 'cooling';
    return paused ? 'paused' : 'active';
  }
  function fullState() {
    return {
      ...store.snapshot(),
      status: status(),
      detectorError,
      cooldownRemainingMs: cooldown ? Math.max(0, cooldown.endsAt - Date.now()) : 0,
      settings: {
        fps: cfg.fps,
        thresholds: cfg.thresholds,
        flagSexy: cfg.flagSexy,
        message: cfg.message,
        disableCooldownMs: cfg.disableCooldownMs,
        lockdown: cfg.lockdown !== false,
        email: {
          enabled: !!(cfg.email && cfg.email.enabled),
          partnerEmail: (cfg.email && cfg.email.partnerEmail) || '',
          senderEmail: (cfg.email && cfg.email.senderEmail) || '',
          smtpHost: (cfg.email && cfg.email.smtpHost) || 'smtp.gmail.com',
          smtpPort: (cfg.email && cfg.email.smtpPort) || 465,
          hasPassword: !!(cfg.email && cfg.email.passEnc),
          lastReportAt: (cfg.email && cfg.email.lastReportAt) || 0,
        },
      },
    };
  }
  function pushUpdate() {
    if (uiWin && !uiWin.isDestroyed()) uiWin.webContents.send('ui:update', fullState());
    updateTray();
  }

  // Milestones grow with the passage of time, not from an event, so we poll.
  // Each reached threshold fires once per streak: a desktop notification + an
  // in-app celebration the next time the dashboard is open.
  const MILESTONE_LABEL = {
    1: 'One day clean', 3: '3 days clean', 7: 'One week clean',
    14: 'Two weeks clean', 30: '30 days clean', 60: '60 days clean',
    90: '90 days clean', 180: 'Half a year clean', 365: 'One year clean',
  };
  function checkMilestones() {
    let reached;
    try { reached = store.claimReachedMilestones(); } catch { return; }
    if (!reached || !reached.length) return;
    const day = Math.max(...reached);
    const title = MILESTONE_LABEL[day] || `${day} days clean`;
    log(`[milestone] reached ${day} days`);
    if (Notification.isSupported()) {
      new Notification({
        title: `Aegis — ${title} 🛡️`,
        body: 'Another marker behind you. Keep going.',
        silent: false,
      }).show();
    }
    pushUpdate();
    if (uiWin && !uiWin.isDestroyed()) {
      uiWin.webContents.send('ui:milestone', { day, title });
    }
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
    if ('lockdown' in patch) {
      if (patch.lockdown) lockdown.start(log);
      else lockdown.remove();
    }
    pushUpdate();
    return { ok: true };
  });

  // Partner email settings are accountability settings -> password-gated so the
  // user can't quietly turn off their own reporting. `password` (the SMTP app
  // password) is encrypted before it touches disk.
  ipcMain.handle('ui:saveEmailSettings', (_e, { pw, patch }) => {
    if (security.hasPassword() && !security.verifyPassword(pw)) {
      return { ok: false, reason: 'bad-password' };
    }
    cfg = config.load();
    const e = { ...cfg.email };
    for (const k of ['enabled', 'partnerEmail', 'senderEmail', 'smtpHost', 'smtpPort', 'smtpSecure']) {
      if (k in patch) e[k] = patch[k];
    }
    if (patch.password) e.passEnc = report.encryptSecret(patch.password);
    cfg.email = e;
    config.save(cfg);
    pushUpdate();
    return { ok: true };
  });

  ipcMain.handle('ui:sendTestReport', async () => {
    cfg = config.load();
    try {
      await report.send(cfg.email, store.snapshot());
      cfg.email.lastReportAt = Date.now();
      config.save(cfg);
      log('[report] test email sent to ' + cfg.email.partnerEmail);
      return { ok: true };
    } catch (err) {
      log('[report] test send failed: ' + err.message);
      return { ok: false, reason: err.message };
    }
  });

  // Weekly cadence: send if enabled and a week has elapsed. Checked on startup
  // and hourly.
  async function checkReport() {
    cfg = config.load();
    const e = cfg.email || {};
    if (!e.enabled) return;
    if (Date.now() - (e.lastReportAt || 0) < (e.everyMs || 604800000)) return;
    try {
      await report.send(e, store.snapshot());
      e.lastReportAt = Date.now();
      config.save(cfg);
      log('[report] weekly email sent to ' + e.partnerEmail);
    } catch (err) {
      log('[report] weekly send failed: ' + err.message);
    }
  }

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
      { label: `Aegis — ${status()}`, enabled: false },
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
    tray.setToolTip(`Aegis — ${status()}`);
  }

  // quit must pass the same locked + cooldown gate as disabling
  ipcMain.handle('ui:requestQuit', (_e, pw) => {
    if (security.hasPassword() && !security.verifyPassword(pw)) {
      return { ok: false, reason: 'bad-password' };
    }
    // authorized stop: the lockdown task must stand down too, or it would
    // resurrect the app a few minutes after a legitimate quit
    lockdown.remove(() => doQuit());
    return { ok: true };
  });

  // Guarded uninstall: the installer's uninstaller refuses to run unless this
  // flag exists. We only write it after the partner password is verified, then
  // fully stop Aegis (and its watchdog) so the uninstaller isn't blocked. The
  // flag is deleted on the next normal launch, so it's valid only while the app
  // is intentionally stopped for removal.
  ipcMain.handle('ui:authorizeUninstall', (_e, pw) => {
    if (security.hasPassword() && !security.verifyPassword(pw)) {
      return { ok: false, reason: 'bad-password' };
    }
    try {
      fs.writeFileSync(flagPath('uninstall-allowed'), String(Date.now()));
    } catch (e) {
      log('[uninstall] could not write flag: ' + e.message);
      return { ok: false, reason: 'io' };
    }
    log('[uninstall] authorized — stopping Aegis for removal');
    lockdown.remove(() => doQuit());
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
