// Hidden detector: grabs one display's stream and classifies it.
// Everything stays in-process — frames are never written to disk or uploaded.
//
// Engines:
//   marqo  (default) — Marqo/nsfw-image-detection-384 (ViT-tiny, Apache-2.0)
//                      exported to ONNX, run via onnxruntime-node. One
//                      probability out: NSFW. ~98.6% accuracy, 384px input.
//   nsfwjs (fallback) — MobileNetV2 5-class model. Used if the ONNX model is
//                      missing or fails to load.
//
// Tiling: besides the whole frame, we score a grid of sub-regions so small
// on-screen images aren't lost when the full screen is shrunk to the model's
// input size. The worst region across the grid drives the decision.

const { ipcRenderer } = require('electron');
const fs = require('fs');

const vid = document.getElementById('vid');
const cv = document.getElementById('cv');
const ctx = cv.getContext('2d', { willReadFrequently: true });

let engine = null; // 'marqo' | 'nsfwjs' — resolved at load time
let ortSession = null;
let marqoMeta = null; // { size, mean, std, labels }
let nsfwjsModel = null;

let cfg = {
  engine: 'marqo',
  marqoModelPath: null,
  marqoMetaPath: null,
  fps: 2,
  thresholds: { porn: 0.6, hentai: 0.6, sexy: 0.85, nsfw: 0.8, nsfwStrict: 0.6 },
  flagSexy: false,
  tiling: { enabled: true, cols: 2, rows: 2 },
  displayId: 'primary',
};
let timer = null;
let classifying = false;

function status(msg) {
  ipcRenderer.send('detector-status', `[${cfg.displayId}] ${msg}`);
}

// ---- engine loading --------------------------------------------------------

async function loadMarqo() {
  const ort = require('onnxruntime-node');
  marqoMeta = JSON.parse(fs.readFileSync(cfg.marqoMetaPath, 'utf8'));
  ortSession = await ort.InferenceSession.create(cfg.marqoModelPath, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
  });
  cv.width = marqoMeta.size;
  cv.height = marqoMeta.size;
  engine = 'marqo';
  status(`engine loaded: marqo (onnx, ${marqoMeta.size}px, labels=${marqoMeta.labels.join(',')})`);
}

async function loadNsfwjs() {
  const nsfwjs = require('nsfwjs');
  const tf = require('@tensorflow/tfjs');
  await tf.ready();
  status('tfjs backend: ' + tf.getBackend());
  nsfwjsModel = cfg.modelUrl ? await nsfwjs.load(cfg.modelUrl) : await nsfwjs.load();
  cv.width = 224;
  cv.height = 224;
  engine = 'nsfwjs';
  status('engine loaded: nsfwjs (MobileNetV2 fallback)');
}

async function loadEngine() {
  status('loading engine: ' + cfg.engine);
  if (cfg.engine === 'marqo') {
    try {
      await loadMarqo();
      return;
    } catch (e) {
      status('MARQO LOAD FAILED: ' + e.message + ' — falling back to nsfwjs');
    }
  }
  try {
    await loadNsfwjs();
  } catch (e) {
    status('MODEL LOAD FAILED: ' + e.message);
    throw e;
  }
}

// ---- classification --------------------------------------------------------

// canvas RGBA -> normalized CHW float32 tensor for the ONNX model
function marqoTensor() {
  const ort = require('onnxruntime-node');
  const s = marqoMeta.size;
  const { data } = ctx.getImageData(0, 0, s, s);
  const n = s * s;
  const out = new Float32Array(3 * n);
  const [m0, m1, m2] = marqoMeta.mean;
  const [d0, d1, d2] = marqoMeta.std;
  for (let i = 0; i < n; i++) {
    out[i] = (data[i * 4] / 255 - m0) / d0;
    out[n + i] = (data[i * 4 + 1] / 255 - m1) / d1;
    out[2 * n + i] = (data[i * 4 + 2] / 255 - m2) / d2;
  }
  return new ort.Tensor('float32', out, [1, 3, s, s]);
}

// classify current canvas -> { nsfw } or per-class map, engine-dependent
async function classifyCanvas() {
  if (engine === 'marqo') {
    const res = await ortSession.run({ input: marqoTensor() });
    const logits = res.logits.data;
    // softmax over the label set; return p(NSFW)
    let max = -Infinity;
    for (const v of logits) if (v > max) max = v;
    let sum = 0;
    const exps = [];
    for (const v of logits) {
      const e = Math.exp(v - max);
      exps.push(e);
      sum += e;
    }
    const idx = marqoMeta.labels.findIndex((l) => /nsfw/i.test(l));
    return { nsfw: exps[idx] / sum };
  }
  // nsfwjs
  const preds = await nsfwjsModel.classify(cv);
  const out = {};
  for (const p of preds) out[p.className.toLowerCase()] = p.probability;
  return out;
}

// ---- capture + loop --------------------------------------------------------

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
  if (!engine || classifying || !vid.videoWidth) return;
  classifying = true;
  try {
    // aggregate the max probability per category across all regions
    const agg = {};
    for (const rg of regions(vid.videoWidth, vid.videoHeight)) {
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.drawImage(vid, rg.sx, rg.sy, rg.sw, rg.sh, 0, 0, cv.width, cv.height);
      const scores = await classifyCanvas();
      for (const k of Object.keys(scores)) {
        if (!(k in agg) || scores[k] > agg[k]) agg[k] = scores[k];
      }
    }

    const t = cfg.thresholds;
    const violations = [];
    if (engine === 'marqo') {
      // one calibrated probability; flagSexy = the UI's "stricter" toggle
      const thr = cfg.flagSexy ? (t.nsfwStrict ?? 0.6) : (t.nsfw ?? 0.8);
      if ((agg.nsfw ?? 0) >= thr) violations.push(['nsfw', agg.nsfw]);
    } else {
      if ((agg.porn ?? 0) >= t.porn) violations.push(['porn', agg.porn]);
      if ((agg.hentai ?? 0) >= t.hentai) violations.push(['hentai', agg.hentai]);
      if (cfg.flagSexy && (agg.sexy ?? 0) >= t.sexy) violations.push(['sexy', agg.sexy]);
    }
    violations.sort((a, b) => b[1] - a[1]);
    const flagged = violations.length > 0;

    ipcRenderer.send('nsfw-result', {
      displayId: cfg.displayId,
      engine,
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
  if (!engine) await loadEngine();
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
