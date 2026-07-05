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
    celebratedMilestones: [], // day-thresholds already celebrated THIS streak
  },
  incidents: [], // { t, category, score }
};

// Clean-streak milestones, in days. Crossing one fires a celebration + a
// desktop notification. Reset when the streak breaks.
const MILESTONE_DAYS = [1, 3, 7, 14, 30, 60, 90, 180, 365];

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
  // Atomic write: a crash/kill mid-write must never truncate store.json, or
  // load() would fall back to EMPTY and silently wipe onboarding + the lock
  // password (disabling tamper-resistance). Write a temp file, then rename.
  try {
    const p = storePath();
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cached, null, 2));
    fs.renameSync(tmp, p);
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
  s.stats.celebratedMilestones = []; // new streak can re-earn milestones
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

const streakDays = () => Math.floor(currentStreakMs() / 864e5);

// The next milestone the user is working toward, and how far off it is.
function nextMilestone() {
  const d = streakDays();
  const day = MILESTONE_DAYS.find((m) => m > d);
  return day ? { day, daysToGo: day - d } : null;
}

// Return any milestones newly reached since last check and mark them claimed,
// so each fires its celebration exactly once per streak. Idempotent.
function claimReachedMilestones() {
  const s = load();
  const d = streakDays();
  if (!Array.isArray(s.stats.celebratedMilestones)) s.stats.celebratedMilestones = [];
  const reached = MILESTONE_DAYS.filter(
    (m) => d >= m && !s.stats.celebratedMilestones.includes(m)
  );
  if (reached.length) {
    s.stats.celebratedMilestones.push(...reached);
    save();
  }
  return reached; // e.g. [7] — usually 0 or 1 entries
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
      nextMilestone: nextMilestone(),
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
  claimReachedMilestones,
  nextMilestone,
  snapshot,
  raw: () => cached,
  MILESTONE_DAYS,
};
