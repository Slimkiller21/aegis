// Hidden detector: grabs one display's stream and classifies it with the
// Marqo/nsfw-image-detection-384 model (ViT-tiny, Apache-2.0) exported to ONNX
// and run via onnxruntime-node. One probability out: NSFW. 384px input.
// Everything stays in-process — frames are never written to disk or uploaded.
//
// Tiling: besides the whole frame, we score a grid of sub-regions so small
// on-screen images aren't lost when the full screen is shrunk to 384px. The
// worst region across the grid drives the decision.
//
// If the model can't load, we tell main so the dashboard can show a loud
// "NOT PROTECTED" state instead of silently doing nothing.

const { ipcRenderer } = require('electron');
const fs = require('fs');

const vid = document.getElementById('vid');
const cv = document.getElementById('cv');
const ctx = cv.getContext('2d', { willReadFrequently: true });

let ready = false;
let ortSession = null;
let meta = null; // { size, mean, std, labels }

let cfg = {
  marqoModelPath: null,
  marqoMetaPath: null,
  fps: 2,
  thresholds: { nsfw: 0.8, nsfwStrict: 0.6 },
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

async function loadEngine() {
  status('loading model (marqo onnx)...');
  const ort = require('onnxruntime-node');
  meta = JSON.parse(fs.readFileSync(cfg.marqoMetaPath, 'utf8'));
  ortSession = await ort.InferenceSession.create(cfg.marqoModelPath, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
  });
  cv.width = meta.size;
  cv.height = meta.size;
  ready = true;
  status(`model loaded (${meta.size}px, labels=${meta.labels.join(',')})`);
}

// ---- classification --------------------------------------------------------

// canvas RGBA -> normalized CHW float32 tensor for the ONNX model
function toTensor() {
  const ort = require('onnxruntime-node');
  const s = meta.size;
  const { data } = ctx.getImageData(0, 0, s, s);
  const n = s * s;
  const out = new Float32Array(3 * n);
  const [m0, m1, m2] = meta.mean;
  const [d0, d1, d2] = meta.std;
  for (let i = 0; i < n; i++) {
    out[i] = (data[i * 4] / 255 - m0) / d0;
    out[n + i] = (data[i * 4 + 1] / 255 - m1) / d1;
    out[2 * n + i] = (data[i * 4 + 2] / 255 - m2) / d2;
  }
  return new ort.Tensor('float32', out, [1, 3, s, s]);
}

// classify current canvas -> p(NSFW)
async function classifyCanvas() {
  const res = await ortSession.run({ input: toTensor() });
  const logits = res.logits.data;
  let max = -Infinity;
  for (const v of logits) if (v > max) max = v;
  let sum = 0;
  const exps = [];
  for (const v of logits) {
    const e = Math.exp(v - max);
    exps.push(e);
    sum += e;
  }
  const idx = meta.labels.findIndex((l) => /nsfw/i.test(l));
  return exps[idx] / sum;
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
  if (!ready || classifying || !vid.videoWidth) return;
  classifying = true;
  try {
    // The FULL-FRAME score is the trustworthy signal. Tiles (crops) are only a
    // high-confidence backstop for small on-screen NSFW, because cropping a
    // clothed anime character makes this model score it like hentai (real data:
    // Naruto/Jujutsu posters hit 0.84-0.91 on a tile but ~0.16/0.65 full-frame).
    const rs = regions(vid.videoWidth, vid.videoHeight);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(vid, rs[0].sx, rs[0].sy, rs[0].sw, rs[0].sh, 0, 0, cv.width, cv.height);
    const full = await classifyCanvas();

    let tile = 0;
    for (let i = 1; i < rs.length; i++) {
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.drawImage(vid, rs[i].sx, rs[i].sy, rs[i].sw, rs[i].sh, 0, 0, cv.width, cv.height);
      const p = await classifyCanvas();
      if (p > tile) tile = p;
    }

    const t = cfg.thresholds;
    const fullThr = cfg.flagSexy ? (t.nsfwStrict ?? 0.72) : (t.nsfw ?? 0.82);
    const tileThr = t.tile ?? 0.95; // above the ~0.91 clothed-anime tile ceiling
    const tileMinFull = t.tileMinFull ?? 0.35; // frame must be broadly suspicious

    // full-screen NSFW OR a very confident tile on an already-suspicious frame
    const flagged = full >= fullThr || (tile >= tileThr && full >= tileMinFull);
    const nsfw = Math.max(full, flagged ? tile : 0);

    ipcRenderer.send('nsfw-result', {
      displayId: cfg.displayId,
      engine: 'marqo',
      flagged,
      category: flagged ? 'nsfw' : null,
      score: flagged ? nsfw : 0,
      scores: { nsfw, full, tile },
    });
  } catch (e) {
    status('classify error: ' + e.message);
  } finally {
    classifying = false;
  }
}

ipcRenderer.on('start-capture', async (_e, opts) => {
  cfg = { ...cfg, ...opts };
  if (!ready) {
    try {
      await loadEngine();
    } catch (e) {
      // fail loud: main surfaces a NOT PROTECTED state to the user
      status('MODEL LOAD FAILED: ' + e.message);
      ipcRenderer.send('detector-failed', {
        displayId: cfg.displayId,
        message: e.message,
      });
      return;
    }
  }
  loop();
  try {
    await startCapture(opts.sourceId);
  } catch (e) {
    status('capture failed: ' + e.message);
    ipcRenderer.send('detector-failed', {
      displayId: cfg.displayId,
      message: 'screen capture failed: ' + e.message,
    });
  }
});

// settings changed in the dashboard — update params without re-capturing
ipcRenderer.on('update-config', (_e, opts) => {
  cfg = { ...cfg, ...opts };
  loop();
});
