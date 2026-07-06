// Diagnostic: run the Marqo NSFW model over an image the exact way the detector
// does — full frame + a 2x2 tile grid, worst region wins — and print every
// region's NSFW probability. Reveals whether false positives come from the
// threshold, the tiling, or the model itself.
//
//   node scripts/diag_scores.js <image1> [image2 ...]

const fs = require('fs');
const path = require('path');
const ort = require('onnxruntime-node');
const sharp = require('sharp');

const MODEL = path.join(__dirname, '..', 'assets', 'models', 'marqo-nsfw-384.onnx');
const META = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'assets', 'models', 'marqo-nsfw-384.json'), 'utf8')
);
const S = META.size;
const [m0, m1, m2] = META.mean;
const [d0, d1, d2] = META.std;
const nsfwIdx = META.labels.findIndex((l) => /nsfw/i.test(l));

function tensorFromRGB(raw) {
  const n = S * S;
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    out[i] = (raw[i * 3] / 255 - m0) / d0;
    out[n + i] = (raw[i * 3 + 1] / 255 - m1) / d1;
    out[2 * n + i] = (raw[i * 3 + 2] / 255 - m2) / d2;
  }
  return new ort.Tensor('float32', out, [1, 3, S, S]);
}

function nsfwProb(logits) {
  let max = -Infinity;
  for (const v of logits) if (v > max) max = v;
  let sum = 0;
  const exps = [];
  for (const v of logits) { const e = Math.exp(v - max); exps.push(e); sum += e; }
  return exps[nsfwIdx] / sum;
}

async function main() {
  const session = await ort.InferenceSession.create(MODEL, { executionProviders: ['cpu'] });
  const files = process.argv.slice(2);

  for (const file of files) {
    const meta = await sharp(file).metadata();
    const W = meta.width, H = meta.height;
    // regions: full frame + 2x2 tiles (same as detector.js defaults)
    const regions = [{ name: 'full ', left: 0, top: 0, w: W, h: H }];
    const tw = Math.floor(W / 2), th = Math.floor(H / 2);
    for (let r = 0; r < 2; r++)
      for (let c = 0; c < 2; c++)
        regions.push({ name: `tile${r}${c}`, left: c * tw, top: r * th, w: tw, h: th });

    let full = 0, tile = 0;
    const line = [];
    for (const rg of regions) {
      const raw = await sharp(file)
        .extract({ left: rg.left, top: rg.top, width: rg.w, height: rg.h })
        .resize(S, S, { fit: 'fill' })
        .removeAlpha()
        .raw()
        .toBuffer();
      const res = await session.run({ input: tensorFromRGB(raw) });
      const p = nsfwProb(res.logits.data);
      if (rg.name === 'full ') full = p;
      else if (p > tile) tile = p;
      line.push(`${rg.name}=${p.toFixed(3)}`);
    }
    // new rule (mirrors detector.js): full-frame primary + high-bar tile backstop
    const decide = (fullThr) =>
      (full >= fullThr || (tile >= 0.95 && full >= 0.35)) ? 'FLAG' : 'ok';
    console.log(`\n${path.basename(file)}  (${W}x${H})`);
    console.log('  ' + line.join('  '));
    console.log(`  full=${full.toFixed(3)} tile=${tile.toFixed(3)}  ->  Balanced(0.82): ${decide(0.82)}   Strict(0.72): ${decide(0.72)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
