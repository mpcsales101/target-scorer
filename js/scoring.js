// Scoring follows the gauge rule: a shot takes the higher ring if the pellet's
// edge touches the ring line, i.e. distance from centre <= ring radius + pellet radius.

export function scoreAt(profile, x, y, pelletD) {
  if (!profile.rings.length) return { score: null, dec: null, inner: false };
  const dist = Math.hypot(x, y), rp = pelletD / 2;
  const B = profile.rings.map(d => d / 2 + rp);
  const i = B.findIndex(b => dist <= b);
  if (i < 0) return { score: 0, dec: 0, inner: false };
  const score = profile.top - i;
  const width = i === 0 ? (B.length > 1 ? B[1] - B[0] : B[0]) : B[i] - B[i - 1];
  const dec = +(score + Math.min(0.9, Math.floor(((B[i] - dist) / width) * 10 + 1e-9) / 10)).toFixed(1);
  const inner = profile.innerTen ? dist <= profile.innerTen / 2 + rp : false;
  return { score, dec, inner };
}

export function cardStats(shots) {
  const n = shots.length;
  const out = { n, total: 0, dec: 0, inners: 0, mpi: null, es: 0, mr: 0, scored: false };
  if (!n) return out;
  let sx = 0, sy = 0;
  for (const s of shots) {
    if (s.score != null) { out.scored = true; out.total += s.score; out.dec += s.dec; }
    if (s.inner) out.inners++;
    sx += s.x; sy += s.y;
  }
  out.dec = +out.dec.toFixed(1);
  out.mpi = [sx / n, sy / n];
  for (let i = 0; i < n; i++) {
    out.mr += Math.hypot(shots[i].x - out.mpi[0], shots[i].y - out.mpi[1]) / n;
    for (let j = i + 1; j < n; j++) out.es = Math.max(out.es, Math.hypot(shots[i].x - shots[j].x, shots[i].y - shots[j].y));
  }
  return out;
}

export function series(shots, len) {
  const out = [];
  for (let i = 0; i < shots.length; i += len) {
    const s = shots.slice(i, i + len);
    out.push({ shots: s, total: s.reduce((a, b) => a + (b.score || 0), 0), dec: +s.reduce((a, b) => a + (b.dec || 0), 0).toFixed(1) });
  }
  return out;
}

// Sight advice: move the rear sight in the direction you want the group to go.
export function sightAdvice(mpi, clickMm) {
  if (!mpi) return '';
  const [x, y] = mpi, parts = [];
  const fmt = (mm, dir) => {
    if (Math.abs(mm) < 1) return null;
    const clicks = clickMm > 0 ? ` (≈${Math.round(Math.abs(mm) / clickMm)} clicks)` : '';
    return `${dir} ${Math.abs(mm).toFixed(1)} mm${clicks}`;
  };
  const v = fmt(y, y > 0 ? 'UP' : 'DOWN'), h = fmt(x, x > 0 ? 'LEFT' : 'RIGHT');
  if (v) parts.push(v);
  if (h) parts.push(h);
  return parts.length ? `Move rear sight ${parts.join(', ')}` : 'Group is centred';
}

export function describeOffset(mpi) {
  if (!mpi) return '–';
  const [x, y] = mpi;
  const v = Math.abs(y) < 0.5 ? '' : `${Math.abs(y).toFixed(1)} ${y > 0 ? 'low' : 'high'}`;
  const h = Math.abs(x) < 0.5 ? '' : `${Math.abs(x).toFixed(1)} ${x > 0 ? 'right' : 'left'}`;
  return [v, h].filter(Boolean).join(', ') || 'centre';
}
