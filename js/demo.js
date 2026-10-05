// Simulated range: renders a target as a phone at the firing line would see it,
// with perspective squash, uneven light, blur, sensor noise and slight sway.
// Used by the Demo source in the app and by the automated tests.

function gauss() {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export class DemoRange {
  constructor(profile, o = {}) {
    this.p = profile;
    this.o = {
      w: 1920, h: 1080, pxPerMm: 2.6, squash: 0.9, tilt: 0.35, spin: 0.08,
      hole: 70, noise: 3, sway: 1.2, aim: [3, 5], spread: 9, pelletD: 4.5, ...o,
    };
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.o.w; this.canvas.height = this.o.h;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.holes = [];
    this.centre = [this.o.w * 0.52, this.o.h * 0.5];
    this.offset = [0, 0];
    this.light = 1;
    this.render();
  }

  // mm -> frame for the current pose (rotation, squash along a tilted axis, spin).
  pose() {
    const { pxPerMm: k, squash, tilt, spin } = this.o;
    const c = Math.cos(tilt), s = Math.sin(tilt), c2 = Math.cos(tilt + spin), s2 = Math.sin(tilt + spin);
    // k * R(tilt) * diag(1, squash) * R(-(tilt+spin))
    const m00 = k * (c * c2 + s * squash * s2);
    const m01 = k * (c * s2 - s * squash * c2);
    const m10 = k * (s * c2 - c * squash * s2);
    const m11 = k * (s * s2 + c * squash * c2);
    return { m: [m00, m01, m10, m11], t: [this.centre[0] + this.offset[0], this.centre[1] + this.offset[1]] };
  }

  toFrame(x, y) {
    const { m, t } = this.pose();
    return [t[0] + m[0] * x + m[1] * y, t[1] + m[2] * x + m[3] * y];
  }

  fire(at) {
    const [ax, ay] = this.o.aim, sp = this.o.spread / 2.5;
    const h = at ? { x: at[0], y: at[1] } : { x: ax + gauss() * sp, y: ay + gauss() * sp };
    this.holes.push(h);
    this.wobble();
    this.render();
    return h;
  }

  wobble() {
    const s = this.o.sway;
    this.offset = [gauss() * s, gauss() * s];
    this.light = 1 + gauss() * 0.02;
  }

  render() {
    const { ctx } = this, { w, h, pelletD } = this.o, p = this.p;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = 'none';
    const bg = ctx.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, '#3a3c3e'); bg.addColorStop(1, '#202224');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    const { m, t } = this.pose();
    ctx.setTransform(m[0], m[2], m[1], m[3], t[0], t[1]);
    ctx.filter = 'blur(0.6px)';
    const card = p.card || 170;
    ctx.fillStyle = '#ece9df';
    ctx.fillRect(-card / 2, -card / 2, card, card);
    if (p.black) {
      ctx.fillStyle = '#1b1b1d';
      ctx.beginPath(); ctx.arc(0, 0, p.black / 2, 0, 7); ctx.fill();
    }
    ctx.lineWidth = 0.25;
    for (const d of p.rings) {
      ctx.strokeStyle = p.black && d < p.black ? '#e8e6de' : '#1b1b1d';
      ctx.beginPath(); ctx.arc(0, 0, d / 2, 0, 7); ctx.stroke();
    }
    if (!p.rings.length) { // a picture-style mark
      ctx.strokeStyle = '#1b1b1d'; ctx.lineWidth = 1.5;
      ctx.strokeRect(-25, -25, 50, 50);
      ctx.beginPath(); ctx.moveTo(-10, 0); ctx.lineTo(10, 0); ctx.moveTo(0, -10); ctx.lineTo(0, 10); ctx.stroke();
    }
    const hv = this.o.hole;
    ctx.fillStyle = `rgb(${hv},${hv},${hv + 4})`;
    for (const hl of this.holes) { ctx.beginPath(); ctx.arc(hl.x, hl.y, pelletD / 2, 0, 7); ctx.fill(); }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = 'none';
    const img = ctx.getImageData(0, 0, w, h), d = img.data, nz = this.o.noise, L = this.light;
    for (let y = 0; y < h; y++) {
      const shade = L * (0.86 + 0.14 * (1 - y / h));
      for (let x = 0, i = y * w * 4; x < w; x++, i += 4) {
        const k = shade * (0.93 + 0.07 * (x / w)), n = gauss() * nz;
        d[i] = d[i] * k + n; d[i + 1] = d[i + 1] * k + n; d[i + 2] = d[i + 2] * k + n;
      }
    }
    ctx.putImageData(img, 0, 0);
  }
}
