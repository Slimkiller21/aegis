// Hidden detector: grabs one display's stream, classifies it with NSFWJS
// (the JS port of the same GantMan model the repo forks), and reports to main.
// Everything stays in-process — frames are never written to disk or uploaded.
//
// Tiling: besides the whole frame, we score a grid of sub-regions so small
// on-screen images aren't lost when the full screen is shrunk to 224px. The
// worst region across the grid drives the decision.

const { ipcRenderer } = require('electron');
const tf = require('@tensorflow/tfjs');
const nsfwjs = require('nsfwjs');

const vid = document.getElementById('vid');
const cv = document.getElementById('cv');
const ctx = cv.getContext('2d', { willReadFrequently: true });

let model = null;
let cfg = {
  fps: 2,
  thresholds: { porn: 0.6, hentai: 0.6, sexy: 0.85 },
  flagSexy: false,
  tiling: { enabled: true, cols: 2, rows: 2 },
  displayId: 'primary',
};
let timer = null;
let classifying = false;

function status(msg) {
  ipcRenderer.send('detector-status', `[${cfg.displayId}] ${msg}`);
}

async function loadModel() {
  status('loading model...');
  await tf.ready();
  status('tfjs backend: ' + tf.getBackend());
  try {
    model = cfg.modelUrl ? await nsfwjs.load(cfg.modelUrl) : await nsfwjs.load();
    status('model loaded');
  } catch (e) {
    status('MODEL LOAD FAILED: ' + e.message);
    throw e;
  }
}

async function startCapture(sourceId) {
  status('requesting screen stream for ' + sourceId);
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        maxWidth: 1920,
        maxHeight: 1080,
        maxFrameRate: 5,
      },
    },
  });
  vid.srcObject = stream;
  await vid.play();
  status('capture started (' + vid.videoWidth + 'x' + vid.videoHeight + ')');
  loop();
}

function loop() {
  if (timer) clearInterval(timer);
  const interval = Math.max(200, Math.round(1000 / (cfg.fps || 2)));
  timer = setInterval(tick, interval);
}

// build the list of source-rects to classify: whole frame + tile grid
function regions(vw, vh) {
  const list = [{ sx: 0, sy: 0, sw: vw, sh: vh }];
  const t = cfg.tiling || {};
  if (t.enabled) {
    const cols = Math.max(1, t.cols || 1);
    const rows = Math.max(1, t.rows || 1);
    const tw = vw / cols;
    const th = vh / rows;
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++)
        list.push({ sx: c * tw, sy: r * th, sw: tw, sh: th });
  }
  return list;
}

async function tick() {
  if (!model || classifying || !vid.videoWidth) return;
  classifying = true;
  try {
    // aggregate the max probability per category across all regions
    const agg = {};
    for (const rg of regions(vid.videoWidth, vid.videoHeight)) {
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.drawImage(vid, rg.sx, rg.sy, rg.sw, rg.sh, 0, 0, cv.width, cv.height);
      const preds = await model.classify(cv);
      for (const p of preds) {
        const k = p.className.toLowerCase();
        if (!(k in agg) || p.probability > agg[k]) agg[k] = p.probability;
      }
    }

    const t = cfg.thresholds;
    const violations = [];
    if ((agg.porn ?? 0) >= t.porn) violations.push(['porn', agg.porn]);
    if ((agg.hentai ?? 0) >= t.hentai) violations.push(['hentai', agg.hentai]);
    if (cfg.flagSexy && (agg.sexy ?? 0) >= t.sexy) violations.push(['sexy', agg.sexy]);
    violations.sort((a, b) => b[1] - a[1]);
    const flagged = violations.length > 0;

    ipcRenderer.send('nsfw-result', {
      displayId: cfg.displayId,
      flagged,
      category: flagged ? violations[0][0] : null,
      score: flagged ? violations[0][1] : 0,
      scores: agg,
    });
  } catch (e) {
    status('classify error: ' + e.message);
  } finally {
    classifying = false;
  }
}

ipcRenderer.on('start-capture', async (_e, opts) => {
  cfg = { ...cfg, ...opts };
  if (!model) await loadModel();
  loop();
  try {
    await startCapture(opts.sourceId);
  } catch (e) {
    status('capture failed: ' + e.message);
  }
});

// settings changed in the dashboard — update params without re-capturing
ipcRenderer.on('update-config', (_e, opts) => {
  cfg = { ...cfg, ...opts };
  loop();
});
