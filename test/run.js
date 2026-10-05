import * as V from '../js/vision.js';
import { BUILTIN } from '../js/targets.js';
import { scoreAt } from '../js/scoring.js';
import { DemoRange } from '../js/demo.js';

const out = document.getElementById('out');
const log = s => { out.textContent += s + '\n'; };

function grab(canvas, r, s = 1) {
  const c = document.createElement('canvas');
  c.width = Math.round(r.w / s); c.height = Math.round(r.h / s);
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(canvas, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
  return V.toGray(x.getImageData(0, 0, c.width, c.height), r.x, r.y, s);
}

function refineAt(cv, x, y, r) {
  const rect = { x: Math.max(0, Math.round(x - 2.2 * r)), y: Math.max(0, Math.round(y - 2.2 * r)) };
  rect.w = Math.min(cv.width - rect.x, Math.round(4.4 * r)); rect.h = Math.min(cv.height - rect.y, Math.round(4.4 * r));
  const g = grab(cv, rect);
  const b = V.refineBull(g, x, y, r);
  return b && (V.refineBull(g, b.cx, b.cy, (b.a + b.b) / 2) || b);
}

function trial(profile, opts, shots = 20, pairs = false) {
  const sim = new DemoRange(profile, opts);
  const cv = sim.canvas, s = Math.max(1, cv.width / 640);
  const cand = V.findDarkBlobs(grab(cv, { x: 0, y: 0, w: cv.width, h: cv.height }, s), 1)[0];
  if (!cand) return { fail: 'no blob' };
  let b = refineAt(cv, cand.x, cand.y, cand.r);
  if (!b) return { fail: 'refine' };
  b.rMm = profile.black / 2;
  const [tx, ty] = sim.toFrame(0, 0);
  const centreErr = Math.hypot(b.cx - tx, b.cy - ty) / V.pxPerMm(b);
  const half = profile.card / 2;
  const corners = [[-half, -half], [half, -half], [-half, half], [half, half]].map(([x, y]) => V.mmToFrame(b, x, y));
  const xs = corners.map(c => c[0]), ys = corners.map(c => c[1]);
  const roi = { x: Math.round(Math.min(...xs)), y: Math.round(Math.min(...ys)) };
  roi.w = Math.round(Math.max(...xs)) - roi.x; roi.h = Math.round(Math.max(...ys)) - roi.y;
  const off = [roi.x - b.cx, roi.y - b.cy];
  const roiAt = bb => ({ x: Math.round(bb.cx + off[0]), y: Math.round(bb.cy + off[1]), w: roi.w, h: roi.h });
  let ref = grab(cv, roiAt(b));
  let ok = 0, miss = 0, extra = 0, errSum = 0, n = 0;
  const pellet = 4.5;
  const seen = [];
  for (let i = 0; i < shots; i++) {
    const truths = [sim.fire()];
    if (pairs) truths.push(sim.fire([truths[0].x + 3, truths[0].y + 1.5]));
    const nb = refineAt(cv, b.cx, b.cy, (b.a + b.b) / 2);
    if (nb) b = { ...nb, rMm: b.rMm };
    const cur = grab(cv, roiAt(b));
    const res = V.detectNewHoles(ref, cur, { pelletPx: pellet * V.pxPerMm(b), minThr: 14, known: seen.map(([x, y]) => V.mmToFrame(b, x, y)) });
    ref = cur;
    const found = res.blobs.map(bl => V.frameToMm(b, bl.x, bl.y));
    seen.push(...found);
    for (const t of truths) {
      let bi = -1, bd = 1e9;
      found.forEach((f, j) => { const d = Math.hypot(f[0] - t.x, f[1] - t.y); if (d < bd) { bd = d; bi = j; } });
      if (bi < 0 || bd > 3) { miss++; continue; }
      const f = found.splice(bi, 1)[0];
      n++; errSum += Math.abs(Math.hypot(f[0], f[1]) - Math.hypot(t.x, t.y));
      if (scoreAt(profile, f[0], f[1], pellet).score === scoreAt(profile, t.x, t.y, pellet).score) ok++;
    }
    extra += found.length;
  }
  const total = shots * (pairs ? 2 : 1);
  const k = opts.pxPerMm || 2.6, sq = opts.squash || 0.9;
  return { centreErr: centreErr.toFixed(2) + 'mm', scaleErr: ((V.pxPerMm(b) / (k * (1 + sq) / 2) - 1) * 100).toFixed(1) + '%', found: `${n}/${total}`, scoreOk: `${ok}/${n}`, meanErr: (errSum / Math.max(1, n)).toFixed(2) + 'mm', miss, extra };
}

const AP = BUILTIN[0], AR = BUILTIN[1];
const W = { spread: 28 };
const cases = [
  ['AP 2.6px/mm (≈12px hole)', AP, { ...W }],
  ['AP 1.6px/mm (≈7px hole)', AP, { ...W, pxPerMm: 1.6 }],
  ['AP 1.1px/mm (≈5px hole)', AP, { ...W, pxPerMm: 1.1 }],
  ['AP no backlight (hole≈black)', AP, { ...W, hole: 40 }],
  ['AP heavy noise + sway', AP, { ...W, noise: 7, sway: 3 }],
  ['AP strong angle (squash .7)', AP, { ...W, squash: 0.7, tilt: 1.1 }],
  ['AP tight group (overlaps)', AP, { spread: 9 }],
  ['AR 4px/mm', AR, { pxPerMm: 4, aim: [1, 1], spread: 14 }],
];
window.results = [];
for (const [name, p, o] of cases) {
  const t0 = performance.now();
  const r = trial(p, o);
  r.ms = Math.round(performance.now() - t0);
  window.results.push([name, r]);
  log(name.padEnd(32) + JSON.stringify(r));
}
const pr = trial(AP, { spread: 28 }, 10, true);
window.results.push(['AP touching pairs', pr]);
log('AP touching pairs'.padEnd(32) + JSON.stringify(pr));
log('DONE');
