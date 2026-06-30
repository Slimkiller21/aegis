// App data store: user profile (onboarding answers), stats, and the incident
// log that powers streaks + accountability. JSON in userData. No deps.
// All local — nothing here ever leaves the device.

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const EMPTY = {
  onboarded: false,
  profile: {
    name: '',
    why: '',
    triggers: [],
    baseline: '',
    strugglingFor: '',
    goalDays: 90,
    partner: { name: '', email: '' },
    unlockMode: 'partner', // 'partner' | 'self'
  },
  security: { salt: '', hash: '' }, // partner-set lock password
  stats: {
    startedAt: 0, // when protection first began
    cleanSince: 0, // start of current streak
    longestStreakMs: 0,
    totalBlocks: 0,
  },
  incidents: [], // { t, category, score }
};

let cached = null;

function storePath() {
  return path.join(app.getPath('userData'), 'store.json');
}

function load() {
  if (cached) return cached;
  try {
    cached = merge(structuredClone(EMPTY), JSON.parse(fs.readFileSync(storePath(), 'utf8')));
  } catch {
    cached = structuredClone(EMPTY);
  }
  return cached;
}

function save() {
  try {
    fs.writeFileSync(storePath(), JSON.stringify(cached, null, 2));
  } catch (e) {
    console.error('[store] save failed:', e.message);
  }
}

function merge(base, over) {
  for (const k of Object.keys(over)) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k])) {
      base[k] = merge(base[k] || {}, over[k]);
    } else {
      base[k] = over[k];
    }
  }
  return base;
}

// ---- lifecycle -----------------------------------------------------------
function beginProtection() {
  const s = load();
  const now = Date.now();
  if (!s.stats.startedAt) s.stats.startedAt = now;
  if (!s.stats.cleanSince) s.stats.cleanSince = now;
  save();
}

// ---- incidents + streaks -------------------------------------------------
// Records a blocked-content event and resets the current clean streak.
// Returns true the first time per "episode" so we don't spam the log while a
// single page sits open (caller passes a dedupe window).
function recordIncident(category, score, dedupeMs = 60000) {
  const s = load();
  const now = Date.now();
  const last = s.incidents[s.incidents.length - 1];
  if (last && now - last.t < dedupeMs) return false;

  // bank the streak that just ended
  const streak = now - (s.stats.cleanSince || now);
  if (streak > s.stats.longestStreakMs) s.stats.longestStreakMs = streak;
  s.stats.cleanSince = now;
  s.stats.totalBlocks += 1;
  s.incidents.push({ t: now, category, score: Math.round((score || 0) * 100) });
  if (s.incidents.length > 1000) s.incidents = s.incidents.slice(-1000);
  save();
  return true;
}

function currentStreakMs() {
  const s = load();
  if (!s.stats.cleanSince) return 0;
  return Date.now() - s.stats.cleanSince;
}

function blocksThisWeek() {
  const s = load();
  const weekAgo = Date.now() - 7 * 864e5;
  return s.incidents.filter((i) => i.t >= weekAgo).length;
}

function snapshot() {
  const s = load();
  return {
    onboarded: s.onboarded,
    profile: s.profile,
    hasLock: !!s.security.hash,
    stats: {
      ...s.stats,
      currentStreakMs: currentStreakMs(),
      blocksThisWeek: blocksThisWeek(),
      daysProtected: s.stats.startedAt
        ? Math.floor((Date.now() - s.stats.startedAt) / 864e5)
        : 0,
    },
    incidents: s.incidents.slice(-50).reverse(),
  };
}

module.exports = {
  load,
  save,
  beginProtection,
  recordIncident,
  currentStreakMs,
  snapshot,
  raw: () => cached,
};
