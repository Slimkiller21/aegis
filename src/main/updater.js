// Auto-update via GitHub releases (electron-updater).
//
// - Differential downloads: electron-builder publishes a .blockmap next to the
//   installer, so most updates fetch only changed blocks (a few MB), not the
//   full 158MB.
// - Install is silent (per-user NSIS = no UAC) and relaunches Aegis right
//   away, so the protection gap is seconds.
// - The caller's prepareShutdown() writes shutdown.flag + sets app.isQuitting
//   so the watchdog stands down and the window-close guards don't block the
//   quit. The Lockdown scheduled task is left in place on purpose: its fresh
//   shutdown.flag check keeps it quiet during the install, and it guarantees
//   Aegis comes back even if the relaunch fails.

const { app } = require('electron');

function start({ log, prepareShutdown }) {
  if (!app.isPackaged) {
    log('[updater] dev mode — skipped');
    return;
  }
  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (e) {
    log('[updater] unavailable: ' + e.message);
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.logger = null; // we log ourselves

  autoUpdater.on('update-available', (i) =>
    log(`[updater] v${i.version} available — downloading`));
  autoUpdater.on('update-not-available', () => log('[updater] up to date'));
  autoUpdater.on('error', (e) => log('[updater] error: ' + (e.message || e)));
  autoUpdater.on('update-downloaded', (i) => {
    log(`[updater] v${i.version} downloaded — installing silently + relaunching`);
    prepareShutdown();
    // isSilent=true, isForceRunAfter=true
    setTimeout(() => autoUpdater.quitAndInstall(true, true), 1500);
  });

  const check = () =>
    autoUpdater
      .checkForUpdates()
      .catch((e) => log('[updater] check failed: ' + (e.message || e)));

  setTimeout(check, 30 * 1000); // let the model load first
  setInterval(check, 4 * 60 * 60 * 1000); // then every 4h

  log('[updater] armed (github: Slimkiller21/aegis)');
}

module.exports = { start };
