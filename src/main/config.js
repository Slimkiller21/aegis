// Persistent config. Stored as JSON in userData. No deps.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  // capture cadence (frames per second to classify). Low = light on CPU.
  fps: 2,

  // tiling: also classify a grid of sub-regions so small on-screen images
  // (thumbnails, partial windows) aren't lost when the whole frame is shrunk
  // to 224px. cols*rows tiles + the full frame are scored each tick; the app
  // flags on the worst region.
  tiling: { enabled: true, cols: 2, rows: 2 },

  // detection engine: 'marqo' (ViT-tiny ONNX, one NSFW probability, default)
  // or 'nsfwjs' (MobileNetV2 5-class legacy). marqo falls back to nsfwjs if
  // its model file is missing.
  engine: 'marqo',

  // classification thresholds per category (0..1). Above = flagged.
  // porn/hentai/sexy apply to the nsfwjs engine; nsfw/nsfwStrict to marqo
  // (nsfwStrict is used when the "flag suggestive" setting is on).
  thresholds: { porn: 0.6, hentai: 0.6, sexy: 0.85, nsfw: 0.8, nsfwStrict: 0.6 },

  // whether "sexy" (suggestive but clothed) counts as a violation.
  // off by default to cut false positives on normal browsing/ads.
  flagSexy: false,

  // overlay (blur scrim + warning) is shown instantly on first detection.
  // if content is STILL flagged after graceMs, escalate to minimize.
  graceMs: 4000,

  // consecutive clean frames required before clearing the overlay (debounce).
  clearFrames: 3,

  // escalation: minimize the offending foreground window when grace expires.
  enforceMinimize: true,

  // start automatically on login (recovery tool should always be on).
  autoStart: true,

  // tamper-resistance level: 'strict' = watchdog restart + locked disable +
  // cooldown. (Heavier 'lockdown' service mode is a separate future build.)
  tamperLevel: 'strict',

  // deliberate delay before protection can actually be turned off, even with
  // the right password. Defeats impulsive "just this once" disabling.
  disableCooldownMs: 60000,

  // run the guardian watchdog process that restarts the app if it's killed.
  watchdog: true,

  // optional explicit model URL. null = use bundled/local then nsfwjs default.
  modelUrl: null,

  // message shown on the blocking overlay.
  message:
    "Take a breath.\n\nThis content was blocked to protect your focus and well-being.\n\nUrges pass. You are stronger than this moment — step away and do something that future-you will thank you for.",
};

let cached = null;

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function load() {
  if (cached) return cached;
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    cached = deepMerge(structuredClone(DEFAULTS), JSON.parse(raw));
  } catch {
    cached = structuredClone(DEFAULTS);
    save(cached);
  }
  return cached;
}

function save(cfg) {
  cached = cfg;
  // Atomic write (temp + rename) so an interrupted write can't corrupt config.
  try {
    const p = configPath();
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    fs.renameSync(tmp, p);
  } catch (e) {
    console.error('[config] save failed:', e.message);
  }
}

function deepMerge(base, override) {
  for (const k of Object.keys(override)) {
    if (
      override[k] &&
      typeof override[k] === 'object' &&
      !Array.isArray(override[k])
    ) {
      base[k] = deepMerge(base[k] || {}, override[k]);
    } else {
      base[k] = override[k];
    }
  }
  return base;
}

module.exports = { load, save, DEFAULTS };
