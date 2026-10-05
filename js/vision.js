// On-device image processing. No dependencies, no network.
// A "gray" is { w, h, d: Float32Array, ox, oy, s } where frame = o + pixel * s.

export function toGray(img, ox = 0, oy = 0, s = 1) {
  const { width: w, height: h, data } = img;
  const d = new Float32Array(w * h);
  for (let i = 0, j = 0; i < d.length; i++, j += 4) d[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
  return { w, h, d, ox, oy, s };
}

export function averageGrays(gs) {
  if (gs.length === 1) return gs[0];
  const d = new Float32Array(gs[0].d.length);
  for (const g of gs) for (let i = 0; i < d.length; i++) d[i] += g.d[i];
  for (let i = 0; i < d.length; i++) d[i] /= gs.length;
  return { ...gs[0], d };
}

function sample(g, x, y) {
  if (x < 0 || y < 0 || x >= g.w - 1 || y >= g.h - 1) return -1;
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * g.w + x0, d = g.d;
  return (d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) + (d[i + g.w] * (1 - fx) + d[i + g.w + 1] * fx) * fy;
}

function otsuHist(hist, n) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = -1, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF, v = wB * wF * (mB - mF) ** 2;
    if (v > best) { best = v; thr = t + 0.5; }
  }
  return thr;
}

export function otsu(g, x0 = 0, y0 = 0, x1 = g.w, y1 = g.h, step = 1) {
  const hist = new Float64Array(256);
  let n = 0;
  x0 = Math.max(0, x0 | 0); y0 = Math.max(0, y0 | 0); x1 = Math.min(g.w, x1 | 0); y1 = Math.min(g.h, y1 | 0);
  for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) {
    hist[Math.max(0, Math.min(255, g.d[y * g.w + x] | 0))]++; n++;
  }
  return otsuHist(hist, n);
}

function dilate(m, w, h) {
  const o = new Uint8Array(m.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 0;
    for (let dy = -1; dy <= 1 && !v; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (xx >= 0 && xx < w && m[yy * w + xx]) { v = 1; break; }
      }
    }
    o[y * w + x] = v;
  }
  return o;
}

function erode(m, w, h) {
  const o = new Uint8Array(m.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 1;
    for (let dy = -1; dy <= 1 && v; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (xx >= 0 && xx < w && !m[yy * w + xx]) { v = 0; break; }
      }
    }
    o[y * w + x] = v;
  }
  return o;
}

// 3x3 min and max filters (separable).
function minMax3(d, w, h) {
  const tmin = new Float32Array(d.length), tmax = new Float32Array(d.length);
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) {
      const a = d[r + Math.max(0, x - 1)], b = d[r + x], c = d[r + Math.min(w - 1, x + 1)];
      tmin[r + x] = Math.min(a, b, c);
      tmax[r + x] = Math.max(a, b, c);
    }
  }
  const mn = new Float32Array(d.length), mx = new Float32Array(d.length);
  for (let y = 0; y < h; y++) {
    const u = Math.max(0, y - 1) * w, r = y * w, dn = Math.min(h - 1, y + 1) * w;
    for (let x = 0; x < w; x++) {
      mn[r + x] = Math.min(tmin[u + x], tmin[r + x], tmin[dn + x]);
      mx[r + x] = Math.max(tmax[u + x], tmax[r + x], tmax[dn + x]);
    }
  }
  return [mn, mx];
}

function blur3(d, w, h) {
  const t = new Float32Array(d.length), o = new Float32Array(d.length);
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) t[r + x] = (d[r + Math.max(0, x - 1)] + d[r + x] + d[r + Math.min(w - 1, x + 1)]) / 3;
  }
  for (let y = 0; y < h; y++) {
    const u = Math.max(0, y - 1) * w, r = y * w, dn = Math.min(h - 1, y + 1) * w;
    for (let x = 0; x < w; x++) o[r + x] = (t[u + x] + t[r + x] + t[dn + x]) / 3;
  }
  return o;
}

function meanStd(d) {
  let s = 0, s2 = 0;
  const step = 3;
  let n = 0;
  for (let i = 0; i < d.length; i += step) { s += d[i]; s2 += d[i] * d[i]; n++; }
  const m = s / n;
  return [m, Math.sqrt(Math.max(0, s2 / n - m * m))];
}

function median(a) {
  const b = Float64Array.from(a).sort();
  return b.length ? b[b.length >> 1] : 0;
}

// ---------- Finding the aiming mark ----------

// Dark connected regions after a small closing (bridges thin white ring lines).
export function darkComponents(g) {
  const { w, h, d } = g;
  const thr = otsu(g);
  let m = new Uint8Array(w * h);
  for (let i = 0; i < m.length; i++) m[i] = d[i] < thr ? 1 : 0;
  m = erode(dilate(m, w, h), w, h);
  const lab = new Int32Array(w * h).fill(-1);
  const comps = [], stack = [];
  const rowMin = new Int32Array(h), rowMax = new Int32Array(h);
  for (let i = 0; i < m.length; i++) {
    if (!m[i] || lab[i] >= 0) continue;
    const id = comps.length;
    let area = 0, x0 = w, y0 = h, x1 = 0, y1 = 0, border = false;
    rowMin.fill(w); rowMax.fill(-1);
    stack.push(i); lab[i] = id;
    while (stack.length) {
      const p = stack.pop(), x = p % w, y = (p - x) / w;
      area++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
      if (x < rowMin[y]) rowMin[y] = x; if (x > rowMax[y]) rowMax[y] = x;
      if (x > 0 && m[p - 1] && lab[p - 1] < 0) { lab[p - 1] = id; stack.push(p - 1); }
      if (x < w - 1 && m[p + 1] && lab[p + 1] < 0) { lab[p + 1] = id; stack.push(p + 1); }
      if (y > 0 && m[p - w] && lab[p - w] < 0) { lab[p - w] = id; stack.push(p - w); }
      if (y < h - 1 && m[p + w] && lab[p + w] < 0) { lab[p + w] = id; stack.push(p + w); }
    }
    let filled = 0;
    for (let y = y0; y <= y1; y++) if (rowMax[y] >= 0) filled += rowMax[y] - rowMin[y] + 1;
    comps.push({ id, area, filled, x0, y0, x1, y1, border });
  }
  return { lab, comps, thr };
}

function blobScore(c) {
  const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1;
  if (c.border || bw < 8 || bh < 8) return 0;
  const asp = bw / bh;
  if (asp < 0.5 || asp > 2) return 0;
  const fill = c.filled / (bw * bh), sol = c.area / c.filled;
  if (sol < 0.5) return 0;
  return c.filled * Math.exp(-(((fill - 0.785) / 0.12) ** 2)) * sol;
}

function compToFrame(g, c) {
  const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1;
  return { x: g.ox + ((c.x0 + c.x1 + 1) / 2) * g.s, y: g.oy + ((c.y0 + c.y1 + 1) / 2) * g.s, r: ((bw + bh) / 4) * g.s };
}

// Best n round dark blobs of similar size (n > 1 for multi-bull cards).
export function findDarkBlobs(g, n = 1) {
  const { comps } = darkComponents(g);
  const ranked = comps.map(c => ({ c, sc: blobScore(c) })).filter(o => o.sc > 0).sort((a, b) => b.sc - a.sc);
  if (!ranked.length) return [];
  const top = ranked[0].c;
  const out = [top];
  for (const o of ranked.slice(1)) {
    if (out.length >= n) break;
    const k = o.c.filled / top.filled;
    if (k > 0.5 && k < 2) out.push(o.c);
  }
  return out.map(c => compToFrame(g, c));
}

// The dark blob under (or nearest to) a tapped frame point.
export function darkBlobAt(g, fx, fy) {
  const { lab, comps } = darkComponents(g);
  const px = Math.round((fx - g.ox) / g.s), py = Math.round((fy - g.oy) / g.s);
  let best = null, bestD = 1e9;
  for (let dy = -12; dy <= 12; dy++) for (let dx = -12; dx <= 12; dx++) {
    const x = px + dx, y = py + dy;
    if (x < 0 || y < 0 || x >= g.w || y >= g.h) continue;
    const id = lab[y * g.w + x];
    if (id < 0) continue;
    const c = comps[id], dd = dx * dx + dy * dy;
    if (c.x1 - c.x0 < 5 || c.y1 - c.y0 < 5) continue;
    if (dd < bestD) { bestD = dd; best = c; }
  }
  return best ? compToFrame(g, best) : null;
}

// Cast rays from inside the aiming mark to its outer edge, then fit an ellipse.
// Short light runs (white ring lines, numbers, pellet holes) are skipped.
export function refineBull(g, seedX, seedY, approxR) {
  // Pixel i spans [i, i+1) in frame coords, so its sample point is i + 0.5. (g.s must be 1.)
  const sx = seedX - g.ox - 0.5, sy = seedY - g.oy - 0.5;
  const win = approxR * 1.7;
  const thr = otsu(g, sx - win, sy - win, sx + win, sy + win, Math.max(1, Math.round(approxR / 60)));
  const N = 120, L = Math.max(3, approxR * 0.08), maxT = approxR * 1.9, st = 0.5;
  const pts = [];
  for (let k = 0; k < N; k++) {
    const ang = (2 * Math.PI * k) / N, c = Math.cos(ang), s = Math.sin(ang);
    let seen = false, run = 0, lastDark = -1;
    for (let t = 0; t < maxT; t += st) {
      const v = sample(g, sx + t * c, sy + t * s);
      if (v < 0) break;
      if (v < thr) { seen = true; run = 0; lastDark = t; }
      else if (seen) {
        run += st;
        if (run >= L) {
          const v0 = sample(g, sx + lastDark * c, sy + lastDark * s);
          const v1 = sample(g, sx + (lastDark + st) * c, sy + (lastDark + st) * s);
          const f = v1 !== v0 ? Math.max(0, Math.min(1, (thr - v0) / (v1 - v0))) : 0.5;
          const e = lastDark + st * f;
          pts.push([seedX + e * c, seedY + e * s]);
          break;
        }
      }
    }
  }
  if (pts.length < N * 0.4) return null;
  const e = robustEllipse(pts);
  if (!e || e.inliers < N * 0.4) return null;
  const ratio = e.a / e.b;
  if (ratio < 0.5 || ratio > 2 || e.a < 4 || e.b < 4) return null;
  return e;
}

function solve(A) {
  const n = A.length;
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    if (Math.abs(A[p][i]) < 1e-12) return null;
    [A[i], A[p]] = [A[p], A[i]];
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = A[r][i] / A[i][i];
      for (let c = i; c <= n; c++) A[r][c] -= f * A[i][c];
    }
  }
  return A.map((row, i) => row[n] / row[i]);
}

// Algebraic least-squares conic fit: A x² + B xy + C y² + D x + E y = 1.
export function fitEllipse(pts) {
  const n = pts.length;
  if (n < 6) return null;
  let mx = 0, my = 0;
  for (const [x, y] of pts) { mx += x; my += y; }
  mx /= n; my /= n;
  let sc = 0;
  for (const [x, y] of pts) sc += Math.hypot(x - mx, y - my);
  sc /= n;
  if (!sc) return null;
  const A = Array.from({ length: 5 }, () => new Float64Array(6));
  for (const [px, py] of pts) {
    const x = (px - mx) / sc, y = (py - my) / sc, r = [x * x, x * y, y * y, x, y];
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 5; j++) A[i][j] += r[i] * r[j];
      A[i][5] += r[i];
    }
  }
  const s = solve(A);
  if (!s) return null;
  const [a, b, c, d, e] = s;
  const den = 4 * a * c - b * b;
  if (den <= 0) return null;
  const x0 = (b * e - 2 * c * d) / den, y0 = (b * d - 2 * a * e) / den;
  const f0 = -1 + (d * x0 + e * y0) / 2;
  const th = 0.5 * Math.atan2(b, a - c), ct = Math.cos(th), st = Math.sin(th);
  const l1 = a * ct * ct + b * ct * st + c * st * st, l2 = a + c - l1;
  if (l1 * f0 >= 0 || l2 * f0 >= 0) return null;
  return { cx: mx + x0 * sc, cy: my + y0 * sc, a: Math.sqrt(-f0 / l1) * sc, b: Math.sqrt(-f0 / l2) * sc, theta: th };
}

function ellipseResid(e, x, y) {
  const u = x - e.cx, v = y - e.cy, ct = Math.cos(e.theta), st = Math.sin(e.theta);
  const xr = u * ct + v * st, yr = -u * st + v * ct;
  return (Math.hypot(xr / e.a, yr / e.b) - 1) * ((e.a + e.b) / 2);
}

function robustEllipse(pts) {
  let e = fitEllipse(pts), cur = pts;
  for (let it = 0; it < 4 && e; it++) {
    const r = pts.map(p => Math.abs(ellipseResid(e, p[0], p[1])));
    const lim = Math.max(0.75, 3 * 1.4826 * median(r));
    const next = pts.filter((p, i) => r[i] <= lim);
    if (next.length < 10) break;
    const e2 = fitEllipse(next);
    if (!e2) break;
    e = e2; cur = next;
  }
  if (!e) return null;
  const rms = Math.sqrt(cur.reduce((s, p) => s + ellipseResid(e, p[0], p[1]) ** 2, 0) / cur.length);
  return { ...e, inliers: cur.length, rms };
}

// ---------- Target geometry ----------
// A bull is an ellipse in frame px plus rMm, the real radius it corresponds to.
// mm -> frame is the symmetric affine R(θ)·diag(a,b)·R(θ)ᵀ / rMm.

export function bullMatrix(b) {
  const c = Math.cos(b.theta), s = Math.sin(b.theta), ka = b.a / b.rMm, kb = b.b / b.rMm;
  return [c * c * ka + s * s * kb, c * s * (ka - kb), c * s * (ka - kb), s * s * ka + c * c * kb];
}

export function mmToFrame(b, x, y) {
  const m = bullMatrix(b);
  return [b.cx + m[0] * x + m[1] * y, b.cy + m[2] * x + m[3] * y];
}

export function frameToMm(b, X, Y) {
  const m = bullMatrix(b), det = m[0] * m[3] - m[1] * m[2], u = X - b.cx, v = Y - b.cy;
  return [(m[3] * u - m[1] * v) / det, (-m[2] * u + m[0] * v) / det];
}

export function pxPerMm(b) {
  return (b.a + b.b) / 2 / b.rMm;
}

// ---------- New-hole detection ----------
// Compare the current frame with the reference. Each current pixel is compared
// with the min/max of its 3x3 reference neighbourhood, so sub-pixel wobble on
// printed edges cancels out and only genuinely new marks remain.
// `known` lists existing holes in frame coords (helps with overlapping shots).
export function detectNewHoles(ref, cur, { pelletPx, minThr = 14, maxShift = 5, known = [] }) {
  const { w, h } = ref, n = w * h;
  const kn = known.map(([x, y]) => [(x - cur.ox) / cur.s - 0.5, (y - cur.oy) / cur.s - 0.5]);
  const [mr, sr] = meanStd(ref.d), [mc, sc] = meanStd(cur.d);
  const gain = sc > 1e-3 ? sr / sc : 1;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = (cur.d[i] - mc) * gain + mr;
  // Align: integer search on SAD, then a parabolic sub-pixel fit.
  const R = maxShift, m = R + 3;
  const sad = (dx, dy, step) => {
    let e = 0;
    for (let y = m; y < h - m; y += step) for (let x = m; x < w - m; x += step) e += Math.abs(c[y * w + x] - ref.d[(y + dy) * w + x + dx]);
    return e;
  };
  let bx = 0, by = 0, be = Infinity;
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    const e = sad(dx, dy, 4);
    if (e < be) { be = e; bx = dx; by = dy; }
  }
  const e0 = sad(bx, by, 2);
  const para = (em, ep) => { const den = em - 2 * e0 + ep; return den > 0 ? Math.max(-0.5, Math.min(0.5, (em - ep) / (2 * den))) : 0; };
  const fx = Math.abs(bx) < R ? para(sad(bx - 1, by, 2), sad(bx + 1, by, 2)) : 0;
  const fy = Math.abs(by) < R ? para(sad(bx, by - 1, 2), sad(bx, by + 1, 2)) : 0;
  const sx = bx + fx, sy = by + fy;
  const refS = new Float32Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = sample(ref, x + sx, y + sy);
    refS[y * w + x] = v < 0 ? ref.d[y * w + x] : v;
  }
  const [rmin, rmax] = minMax3(refS, w, h);
  const D = new Float32Array(n);
  for (let y = m; y < h - m; y++) for (let x = m; x < w - m; x++) {
    const i = y * w + x, v = c[i];
    D[i] = Math.max(0, v - rmax[i], rmin[i] - v);
  }
  const Ds = blur3(D, w, h);
  // Pixels on strong printed edges: change there is hidden by the tolerant comparison.
  const amb = new Uint8Array(n);
  for (let i = 0; i < n; i++) amb[i] = rmax[i] - rmin[i] > 45 ? 1 : 0;
  const smp = [];
  for (let i = 0; i < n; i += 7) smp.push(Ds[i]);
  smp.sort((a, b) => a - b);
  const p99 = smp[Math.floor(smp.length * 0.99)] || 0;
  const thr = Math.max(minThr, p99 * 2 + 3), lo = thr * 0.5;

  const pA = Math.PI * (pelletPx / 2) ** 2;
  const lab = new Uint8Array(n), stack = [];
  let changed = 0, large = false;
  for (let i = 0; i < n; i++) if (Ds[i] > thr) changed++;
  let comps = [];
  for (let i = 0; i < n; i++) {
    if (lab[i] || Ds[i] <= thr) continue;
    const pix = [];
    stack.push(i); lab[i] = 1;
    while (stack.length) {
      const p = stack.pop(), x = p % w, y = (p - x) / w;
      pix.push(p);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const q = yy * w + xx;
        if (!lab[q] && Ds[q] > lo) { lab[q] = 1; stack.push(q); }
      }
    }
    if (pix.length > 12 * pA) { large = true; continue; }
    comps.push({ pix, ...centroid(pix, Ds, w, lo) });
  }
  // A printed line crossing a hole can cut it in two: merge nearby fragments.
  for (let merged = true; merged;) {
    merged = false;
    outer: for (let i = 0; i < comps.length; i++) for (let j = i + 1; j < comps.length; j++) {
      const a = comps[i], b = comps[j];
      if (Math.hypot(a.cx - b.cx, a.cy - b.cy) < 0.8 * pelletPx && a.pix.length + b.pix.length < 1.5 * pA) {
        const pix = a.pix.concat(b.pix);
        comps[i] = { pix, ...centroid(pix, Ds, w, lo) };
        comps.splice(j, 1);
        merged = true;
        break outer;
      }
    }
  }
  const blobs = [], rejects = [];
  for (const cp of comps) {
    const area = cp.pix.length;
    if (area < Math.max(3, 0.12 * pA)) { rejects.push({ cx: cp.cx, cy: cp.cy, area, why: 'small' }); continue; }
    let x0 = w, x1 = 0, y0 = h, y1 = 0, peak = 0;
    for (const p of cp.pix) {
      const x = p % w, y = (p - x) / w;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (Ds[p] > peak) peak = Ds[p];
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    if (Math.min(bw, bh) < 0.35 * pelletPx && Math.max(bw, bh) > 1.5 * pelletPx) { rejects.push({ cx: cp.cx, cy: cp.cy, area, peak, why: 'streak' }); continue; }
    // A new shot overlapping an old hole only removes a crescent of paper.
    const nearOld = kn.some(([x, y]) => Math.hypot(x - cp.cx, y - cp.cy) < 1.3 * pelletPx);
    // Shimmer on fine printed lines is faint and small; a hole is compact and clearly stronger.
    const minArea = nearOld ? 0.12 : 0.3;
    const strong = Math.max(1.6 * minThr, 1.25 * thr);
    if (!(peak >= 2 * strong || (peak >= strong && area >= minArea * pA))) { rejects.push({ cx: cp.cx, cy: cp.cy, area, peak, why: 'weak' }); continue; }
    // Touching holes: split when the blob is clearly bigger or longer than one pellet.
    let k = area > 1.55 * pA ? Math.round(area / (1.05 * pA)) : 1;
    if (k < 2 && area > 1.15 * pA && cp.elong > 1.4) k = 2;
    k = Math.max(1, Math.min(6, k));
    let centres = clusterCentres(cp.pix, Ds, w, lo, k);
    if (k === 1) centres = [fitDisc(cp.pix, w, h, centres[0], pelletPx / 2, kn, amb, nearOld && area < 0.8 * pA)];
    for (const ctr of centres) {
      blobs.push({ x: cur.ox + (ctr[0] + 0.5) * cur.s, y: cur.oy + (ctr[1] + 0.5) * cur.s, area: area / k, peak });
    }
  }
  return { blobs, rejects, changedFrac: changed / n, large, thr, shift: [sx, sy] };
}

// Place a pellet-sized disc so it covers the new pixels. Parts of the disc that
// aren't new must be explained: inside an existing hole, or on a printed line
// (where the edge-tolerant comparison can't see change).
function fitDisc(pix, w, h, start, r, kn, amb, crescent) {
  const isNew = new Set(pix);
  const inOld = (x, y) => kn.some(([kx, ky]) => (x - kx) ** 2 + (y - ky) ** 2 < (r + 0.5) ** 2);
  const ri = r - 0.7;
  let best = start, bestCost = Infinity;
  for (let oy = -r; oy <= r; oy += 0.5) for (let ox = -r; ox <= r; ox += 0.5) {
    const cx = start[0] + ox, cy = start[1] + oy;
    let cost = 0;
    for (const p of pix) { const x = p % w, y = (p - x) / w; if (Math.hypot(x - cx, y - cy) > r + 0.7) cost++; }
    for (let y = Math.ceil(cy - ri); y <= cy + ri; y++) for (let x = Math.ceil(cx - ri); x <= cx + ri; x++) {
      if (x < 0 || y < 0 || x >= w || y >= h || (x - cx) ** 2 + (y - cy) ** 2 > ri * ri) continue;
      const i = y * w + x;
      if (!isNew.has(i) && !amb[i] && !inOld(x, y)) cost++;
    }
    if (cost < bestCost - 1e-9 || (cost === bestCost && ox * ox + oy * oy < (best[0] - start[0]) ** 2 + (best[1] - start[1]) ** 2)) { bestCost = cost; best = [cx, cy]; }
  }
  if (crescent) return best;
  // Sub-pixel finish: centroid of new + line pixels inside the fitted disc.
  let sx = 0, sy = 0, n = 0;
  for (let y = Math.ceil(best[1] - r); y <= best[1] + r; y++) for (let x = Math.ceil(best[0] - r); x <= best[0] + r; x++) {
    if (x < 0 || y < 0 || x >= w || y >= h || (x - best[0]) ** 2 + (y - best[1]) ** 2 > r * r) continue;
    const i = y * w + x;
    if (isNew.has(i) || amb[i]) { sx += x; sy += y; n++; }
  }
  return n ? [sx / n, sy / n] : best;
}

function centroid(pix, W, w, lo) {
  let sx = 0, sy = 0, sw = 0;
  for (const p of pix) { const x = p % w, y = (p - x) / w, wt = W[p] - lo; sx += x * wt; sy += y * wt; sw += wt; }
  const cx = sx / sw, cy = sy / sw;
  let xx = 0, xy = 0, yy = 0;
  for (const p of pix) { const x = p % w - cx, y = (p - (p % w)) / w - cy; xx += x * x; xy += x * y; yy += y * y; }
  const tr = xx + yy, det = xx * yy - xy * xy, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
  const l1 = tr / 2 + disc, l2 = Math.max(1e-6, tr / 2 - disc);
  return { cx, cy, elong: Math.sqrt(l1 / l2) };
}

// Weighted k-means over blob pixels, to split touching holes.
function clusterCentres(pix, W, w, lo, k) {
  const P = pix.map(p => { const x = p % w; return [x, (p - x) / w, W[p] - lo]; });
  let sx = 0, sy = 0, sw = 0;
  for (const [x, y, wt] of P) { sx += x * wt; sy += y * wt; sw += wt; }
  const mean = [sx / sw, sy / sw];
  if (k === 1) return [mean];
  let cxx = 0, cxy = 0, cyy = 0;
  for (const [x, y, wt] of P) { const u = x - mean[0], v = y - mean[1]; cxx += u * u * wt; cxy += u * v * wt; cyy += v * v * wt; }
  const ang = 0.5 * Math.atan2(2 * cxy, cxx - cyy), ax = [Math.cos(ang), Math.sin(ang)];
  let lo2 = Infinity, hi2 = -Infinity;
  for (const [x, y] of P) { const t = (x - mean[0]) * ax[0] + (y - mean[1]) * ax[1]; lo2 = Math.min(lo2, t); hi2 = Math.max(hi2, t); }
  let C = Array.from({ length: k }, (_, i) => {
    const t = lo2 + ((i + 0.5) / k) * (hi2 - lo2);
    return [mean[0] + t * ax[0], mean[1] + t * ax[1]];
  });
  for (let it = 0; it < 12; it++) {
    const acc = C.map(() => [0, 0, 0]);
    for (const [x, y, wt] of P) {
      let bi = 0, bd = Infinity;
      C.forEach((c, i) => { const d = (x - c[0]) ** 2 + (y - c[1]) ** 2; if (d < bd) { bd = d; bi = i; } });
      acc[bi][0] += x * wt; acc[bi][1] += y * wt; acc[bi][2] += wt;
    }
    C = C.map((c, i) => (acc[i][2] ? [acc[i][0] / acc[i][2], acc[i][1] / acc[i][2]] : c));
  }
  return C;
}
