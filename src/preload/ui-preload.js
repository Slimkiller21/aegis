// Secure bridge for the dashboard/onboarding window. The UI runs with context
// isolation + no node access; it talks to the main process only through this
// minimal, audited surface.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('guard', {
  getState: () => ipcRenderer.invoke('ui:getState'),
  completeOnboarding: (data) => ipcRenderer.invoke('ui:completeOnboarding', data),
  verifyPassword: (pw) => ipcRenderer.invoke('ui:verifyPassword', pw),
  requestDisable: (pw) => ipcRenderer.invoke('ui:requestDisable', pw),
  cancelDisable: () => ipcRenderer.invoke('ui:cancelDisable'),
  resume: () => ipcRenderer.invoke('ui:resume'),
  requestQuit: (pw) => ipcRenderer.invoke('ui:requestQuit', pw),
  updateSettings: (pw, patch) => ipcRenderer.invoke('ui:updateSettings', { pw, patch }),
  exportLog: () => ipcRenderer.invoke('ui:exportLog'),
  // live push of state changes (status, new incidents, cooldown ticks)
  onUpdate: (cb) => {
    const fn = (_e, payload) => cb(payload);
    ipcRenderer.on('ui:update', fn);
    return () => ipcRenderer.removeListener('ui:update', fn);
  },
  // tray "Quit" routes here so the locked quit modal can open
  onRequestQuit: (cb) => {
    const fn = () => cb();
    ipcRenderer.on('ui:request-quit', fn);
    return () => ipcRenderer.removeListener('ui:request-quit', fn);
  },
});
