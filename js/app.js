import { BUILTIN, makeProfile, calibrationRings } from './targets.js';
import * as V from './vision.js';
import { scoreAt, cardStats, series, sightAdvice, describeOffset } from './scoring.js';
import { sessions, loadJSON, saveJSON } from './store.js';
import { DemoRange } from './demo.js';

const $ = s => document.querySelector(s);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- Settings & profiles ----------
const settings = {
  profileId: 'issf-ap10', pellet: 4.5, seriesLen: 10, minThr: 14, showRings: true,
  clickMm: 0, beep: true, speak: false, camId: '', camZoom: null,
  ...loadJSON('settings', {}),
};
let custom = loadJSON('profiles', []);
const saveSettings = () => saveJSON('settings', settings);
const allProfiles = () => [...BUILTIN, ...custom];
const profileById = id => allProfiles().find(p => p.id === id) || BUILTIN[0];
const profile = () => profileById(settings.profileId);

const newCard = () => ({ id: uid(), started: Date.now(), profileId: profile().id, pellet: settings.pellet, shots: [], image: null });

const S = {
  src: null, stream: null, track: null, photos: [], photoIdx: 0, demo: null,
  bulls: [], roiOff: [0, 0], roiSize: [0, 0], ref: null,
  card: newCard(), session: null, sel: null, lastId: null,
  mode: 'idle', calib: null, auto: false, pending: [], quiet: 0, busy: false,
  zoom: 1, center: null, vf: null, drag: null, pan: null, dirty: true,
  camZ: 1, hwMin: 1, hwMax: 1, dz: 1, pinch: null, tap: null,
  aiming: false, aimSel: [], aimPrev: null,
};
const pointers = new Map();
const cardProfile = () => profileById(S.card.profileId);

// ---------- Small UI helpers ----------
function status(msg, kind = '') { const el = $('#status'); el.textContent = msg; el.dataset.kind = kind; }
let toastT;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => { el.hidden = true; }, 3500);
}
const requestRender = () => { S.dirty = true; };

// ---------- Frames ----------
const work = document.createElement('canvas');
const wctx = work.getContext('2d', { willReadFrequently: true });

function clampRect(r) {
  const x = clamp(Math.round(r.x), 0, S.src.w - 1), y = clamp(Math.round(r.y), 0, S.src.h - 1);
  return { x, y, w: clamp(Math.round(r.w), 1, S.src.w - x), h: clamp(Math.round(r.h), 1, S.src.h - y) };
}

function grabGray(rect, s = 1) {
  const r = clampRect(rect);
  const w = Math.max(1, Math.round(r.w / s)), h = Math.max(1, Math.round(r.h / s));
  if (work.width !== w) work.width = w;
  if (work.height !== h) work.height = h;
  wctx.drawImage(S.src.el, r.x, r.y, r.w, r.h, 0, 0, w, h);
  return V.toGray(wctx.getImageData(0, 0, w, h), r.x, r.y, r.w / w);
}

const nextFrame = () => new Promise(res => {
  const v = S.src && S.src.kind === 'camera' ? S.src.el : null;
  if (v && v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => res());
  else setTimeout(res, 60);
});

// Averaging a few video frames cuts sensor noise before comparing.
async function grabAvg(rect, k) {
  if (S.src.kind !== 'camera') k = 1;
  const gs = [];
  for (let i = 0; i < k; i++) {
    if (i) await nextFrame();
    gs.push(grabGray(rect));
  }
  return V.averageGrays(gs);
}

function frameReady() {
  if (!S.src) return false;
  if (S.src.kind === 'camera') return S.src.el.readyState >= 2 && S.src.el.videoWidth > 0;
  return true;
}

// ---------- Target geometry ----------
function roiNow() {
  if (!S.bulls.length) return { x: 0, y: 0, w: S.src.w, h: S.src.h };
  const b = S.bulls[0], [w, h] = S.roiSize;
  return {
    x: clamp(Math.round(b.cx + S.roiOff[0]), 0, S.src.w - w),
    y: clamp(Math.round(b.cy + S.roiOff[1]), 0, S.src.h - h), w, h,
  };
}

function computeRoi() {
  const p = profile();
  const half = (p.rings.length ? p.rings[p.rings.length - 1] / 2 : p.card / 2) + 6;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of S.bulls) for (const [x, y] of [[-half, -half], [half, -half], [-half, half], [half, half]]) {
    const [fx, fy] = V.mmToFrame(b, x, y);
    x0 = Math.min(x0, fx); y0 = Math.min(y0, fy); x1 = Math.max(x1, fx); y1 = Math.max(y1, fy);
  }
  x0 = clamp(Math.floor(x0), 0, S.src.w - 1); y0 = clamp(Math.floor(y0), 0, S.src.h - 1);
  x1 = clamp(Math.ceil(x1), x0 + 1, S.src.w); y1 = clamp(Math.ceil(y1), y0 + 1, S.src.h);
  S.roiSize = [x1 - x0, y1 - y0];
  S.roiOff = [x0 - S.bulls[0].cx, y0 - S.bulls[0].cy];
}

const pelletPx = () => (S.bulls.length ? S.card.pellet * V.pxPerMm(S.bulls[0]) : 10);

function knownHoles() {
  return S.card.shots.filter(s => S.bulls[s.bull]).map(s => V.mmToFrame(S.bulls[s.bull], s.x, s.y));
}

function refineAt(x, y, r, rMm) {
  const g = grabGray({ x: x - 2.2 * r, y: y - 2.2 * r, w: 4.4 * r, h: 4.4 * r });
  let b = V.refineBull(g, x, y, r);
  if (b) b = V.refineBull(g, b.cx, b.cy, (b.a + b.b) / 2) || b;
  return b && { cx: b.cx, cy: b.cy, a: b.a, b: b.b, theta: b.theta, rMm };
}

function sortBulls(bs) {
  const r = (bs[0].a + bs[0].b) / 2;
  return bs.sort((p, q) => Math.round(p.cy / (2 * r)) - Math.round(q.cy / (2 * r)) || p.cx - q.cx);
}

// ---------- Calibration ----------
// ---------- Full-screen aiming ----------
// Find target opens the camera full screen. Zoom in, tap the target (or centre it),
// then Enter locks on and returns to the main screen.
function enterAim() {
  if (!S.src) return toast('Start the camera, load photos or try the demo first');
  if (S.aiming) return;
  S.aimPrev = S.bulls.length ? { bulls: S.bulls, ref: S.ref, roiOff: S.roiOff, roiSize: S.roiSize } : null;
  S.bulls = []; S.ref = null; S.auto = false; S.pending = []; S.zoom = 1;
  S.aimSel = []; S.aiming = true; S.mode = 'aim'; S.calib = null;
  hideBanner();
  document.body.classList.add('aiming');
  document.documentElement.requestFullscreen?.().catch(() => {});
  history.pushState({ aim: true }, '');
  aimMessage();
  updatePill(); updateButtons(); sizeView(); requestRender();
}

function exitAim(cancelled) {
  if (!S.aiming) return;
  if (cancelled && S.aimPrev) Object.assign(S, S.aimPrev);
  S.aiming = false; S.aimPrev = null; S.aimSel = [];
  S.mode = 'idle'; S.calib = null;
  hideBanner();
  document.body.classList.remove('aiming');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (history.state?.aim) history.back();
  if (cancelled && !S.bulls.length) status('Not locked on. Tap Find target to aim.');
  updatePill(); updateButtons(); sizeView(); updatePanels(); requestRender();
  window.scrollTo(0, 0);
}

function aimMessage(msg) {
  const p = profile(), n = S.aimSel.length;
  $('#aimMsg').textContent = msg || (!p.black
    ? 'Zoom in on the target, then press Enter'
    : n >= p.bulls ? 'Target selected. Press Enter'
    : p.bulls > 1 ? `Zoom in and tap each bull (${n} of ${p.bulls}), then Enter`
    : 'Zoom in, tap the target (or centre it), then Enter');
}

async function aimTap(fx, fy) {
  const p = profile();
  if (!p.black) return aimMessage('This target is calibrated by hand: press Enter first');
  const hit = S.aimSel.findIndex(b => Math.hypot(b.cx - fx, b.cy - fy) < (b.a + b.b) / 2);
  if (hit >= 0) { S.aimSel.splice(hit, 1); aimMessage(); requestRender(); return; }
  const span = Math.min(S.src.w, S.src.h) * 0.35;
  const g = grabGray({ x: fx - span, y: fy - span, w: 2 * span, h: 2 * span }, Math.max(1, (2 * span) / 500));
  const blob = V.darkBlobAt(g, fx, fy);
  const b = blob && refineAt(blob.x, blob.y, blob.r, p.black / 2);
  if (!b) return aimMessage("Couldn't find a black aiming mark there. Zoom in more and tap right on it.");
  if (p.bulls === 1) S.aimSel = [b];
  else if (S.aimSel.length < p.bulls) S.aimSel.push(b);
  aimMessage(); requestRender();
}

async function aimEnter() {
  const p = profile();
  if (!p.black) { startCalib(); return; } // tap centre + ring, still full screen
  let bulls = S.aimSel;
  if (bulls.length < p.bulls) {
    // Nothing tapped: look for the target in what's on screen, favouring the centre.
    const area = aimRegion();
    const cands = V.findDarkBlobs(grabGray(area, Math.max(1, area.w / 640)), p.bulls);
    bulls = cands.map(c => refineAt(c.x, c.y, c.r, p.black / 2)).filter(Boolean);
  }
  if (bulls.length < p.bulls) {
    aimMessage("Couldn't find the target. Zoom in and tap on the black aiming mark, then Enter.");
    return;
  }
  await setCalibration(sortBulls(bulls));
}

function startCalib() {
  const p = profile();
  S.mode = 'calib';
  if (S.aiming) aimMessage('Tap the centre, then the ring line');
  S.calib = { kind: p.black ? 'black' : 'manual', bulls: [], centres: [] };
  S.bulls = []; S.ref = null; S.zoom = 1; S.auto = false;
  updatePill(); showBanner(); updateButtons(); sizeView(); requestRender();
}

function cancelCalib() {
  S.mode = S.aiming ? 'aim' : 'idle'; S.calib = null; hideBanner();
  if (S.aiming) aimMessage();
  updateButtons(); requestRender();
}

function calibRadiusMm() {
  const sel = $('#calRing'), inp = $('#calMm');
  return sel ? +sel.value : inp ? +inp.value : 0;
}

function showBanner() {
  const p = profile(), c = S.calib, el = $('#banner');
  const n = p.bulls > 1 ? ` (${(c.kind === 'black' ? c.bulls.length : c.centres.length) + 1} of ${p.bulls})` : '';
  let html;
  if (c.kind === 'black') html = `<span class="msg">Tap the black aiming mark${n}</span>`;
  else if (c.centres.length < p.bulls) html = `<span class="msg">Tap the exact centre of the target${n}</span>`;
  else if (p.rings.length) {
    const opts = calibrationRings(p).map((o, i) => `<option value="${o.r}" ${i === p.rings.length - 1 ? 'selected' : ''}>${esc(o.label)}</option>`).join('');
    html = `<span class="msg">Now tap on this ring line:</span><select id="calRing">${opts}</select>`;
  } else html = `<span class="msg">Tap a point this far from the centre (mm):</span><input id="calMm" type="number" value="50" min="1">`;
  el.innerHTML = html + '<button id="calCancel">Cancel</button>';
  el.hidden = false;
  $('#calCancel').onclick = cancelCalib;
}
const hideBanner = () => { $('#banner').hidden = true; };

async function onCalibTap(fx, fy) {
  const p = profile(), c = S.calib;
  if (c.kind === 'black') {
    const span = Math.min(S.src.w, S.src.h) * 0.35;
    const g = grabGray({ x: fx - span, y: fy - span, w: 2 * span, h: 2 * span }, Math.max(1, (2 * span) / 500));
    const blob = V.darkBlobAt(g, fx, fy);
    const b = blob && refineAt(blob.x, blob.y, blob.r, p.black / 2);
    if (!b) return toast("Couldn't find a dark aiming mark there. Tap right on it.");
    c.bulls.push(b);
    if (c.bulls.length >= p.bulls) return setCalibration(sortBulls(c.bulls));
  } else if (c.centres.length < p.bulls) {
    c.centres.push([fx, fy]);
  } else {
    const [cx, cy] = c.centres[0], rpx = Math.hypot(fx - cx, fy - cy), rMm = calibRadiusMm();
    if (rpx < 5 || !(rMm > 0)) return toast('Tap further from the centre');
    return setCalibration(c.centres.map(([x, y]) => ({ cx: x, cy: y, a: rpx, b: rpx, theta: 0, rMm, manual: true })));
  }
  showBanner(); requestRender();
}

async function setCalibration(bulls) {
  S.bulls = bulls; S.mode = 'idle'; S.calib = null; S.zoom = 1; S.pending = [];
  hideBanner();
  computeRoi();
  await setReference();
  const hp = pelletPx();
  if (hp < 7) status(`Locked on, but holes are only ~${hp.toFixed(0)} px wide. Zoom in for reliable detection.`, 'warn');
  else status(`Locked on · holes ≈ ${hp.toFixed(0)} px wide. Shoot, then tap Score shot (or turn on Auto).`, 'ok');
  updatePill(); updateButtons(); sizeView(); requestRender();
  if (settings.lock) applyLock(true);
  if (S.aiming) exitAim(false);
}

async function setReference() {
  if (!S.bulls.length) return;
  S.ref = await grabAvg(roiNow(), 3);
  S.pending = []; S.quiet = 0;
}

// Follow the card as it sways. Small jitter is smoothed so the overlay doesn't shimmer.
function track(precise = false) {
  if (!S.src || !S.bulls.length) return true;
  let ok = true;
  S.bulls = S.bulls.map(b => {
    if (b.manual) return b;
    const r0 = (b.a + b.b) / 2, nb = refineAt(b.cx, b.cy, r0, b.rMm);
    if (!nb || Math.abs((nb.a + nb.b) / 2 - r0) > 0.08 * r0 || Math.hypot(nb.cx - b.cx, nb.cy - b.cy) > 0.5 * r0) { ok = false; return b; }
    const k = precise || Math.hypot(nb.cx - b.cx, nb.cy - b.cy) > 1.5 ? 1 : 0.3;
    return { ...b, cx: b.cx + (nb.cx - b.cx) * k, cy: b.cy + (nb.cy - b.cy) * k, a: b.a + (nb.a - b.a) * k, b: b.b + (nb.b - b.b) * k, theta: k === 1 ? nb.theta : b.theta };
  });
  return ok;
}

// ---------- Scoring ----------
function rescore(s) { Object.assign(s, scoreAt(cardProfile(), s.x, s.y, S.card.pellet)); }

function addShotAtFrame(fx, fy, auto = false) {
  let best = -1, bd = Infinity, pos = null;
  S.bulls.forEach((b, i) => {
    const [x, y] = V.frameToMm(b, fx, fy), d = Math.hypot(x, y);
    if (d < bd) { bd = d; best = i; pos = [x, y]; }
  });
  if (best < 0) return null;
  const shot = { id: uid(), bull: best, x: +pos[0].toFixed(2), y: +pos[1].toFixed(2), auto, t: Date.now() };
  rescore(shot);
  S.card.shots.push(shot);
  S.lastId = shot.id;
  ensureSession();
  persist();
  return shot;
}

async function scoreNow(auto = false) {
  if (!S.src) return toast('Start the camera, load photos or try the demo first');
  if (!S.bulls.length) return toast('Lock on to the target first (Find target)');
  if (S.busy) return;
  S.busy = true;
  try {
    if (S.src.kind === 'photo') {
      if (S.photoIdx >= S.photos.length - 1) return toast('No more photos. Add the next one under Camera & source.');
      showPhoto(S.photoIdx + 1);
    }
    track(true);
    const cur = await grabAvg(roiNow(), 4);
    if (!S.ref) { S.ref = cur; return toast('Reference saved'); }
    const res = V.detectNewHoles(S.ref, cur, { pelletPx: pelletPx(), minThr: settings.minThr, known: knownHoles() });
    S.ref = cur; S.pending = [];
    if (!res.blobs.length) {
      if (res.large) toast('A lot changed (movement or light?). Reference reset.');
      else if (!auto) toast('No new holes found. Use ＋ Add to mark one by hand.');
      return;
    }
    const added = res.blobs.map(b => addShotAtFrame(b.x, b.y, true)).filter(Boolean);
    announce(added);
    if (S.auto) status('Auto: watching for new holes…', 'ok');
  } finally {
    S.busy = false;
    updatePanels(); requestRender();
  }
}

// Auto mode: a candidate must persist across 3 checks before it is scored,
// so a passing hand or a flicker isn't counted.
async function autoTick() {
  if (!S.src || S.busy || !S.bulls.length || S.mode !== 'idle' || document.hidden) return;
  if (S.src.kind === 'photo') return;
  S.busy = true;
  let confirm = false;
  try {
    if (S.src.kind === 'demo') S.demo.render();
    track();
    requestRender();
    if (!S.auto || !S.ref) return;
    const cur = grabGray(roiNow());
    const res = V.detectNewHoles(S.ref, cur, { pelletPx: pelletPx(), minThr: settings.minThr, known: knownHoles() });
    if (res.large || res.changedFrac > 0.01) { S.pending = []; S.quiet = 0; status('Auto: movement in view, waiting…', 'warn'); return; }
    const tol = Math.max(3, pelletPx());
    S.pending = res.blobs.map(b => {
      const m = S.pending.find(q => Math.hypot(q.x - b.x, q.y - b.y) < tol);
      return { x: b.x, y: b.y, hits: m ? m.hits + 1 : 1 };
    });
    if (S.pending.some(q => q.hits >= 3)) confirm = true;
    else if (!S.pending.length) {
      status('Auto: watching for new holes…', 'ok');
      if (++S.quiet > 40) { S.quiet = 0; S.ref = await grabAvg(roiNow(), 3); } // follow slow light changes
    } else status('Auto: possible hole, confirming…', 'ok');
  } catch (e) {
    console.error(e);
  } finally {
    S.busy = false;
  }
  if (confirm) await scoreNow(true);
}

let audioCtx;
function announce(shots) {
  if (!shots.length) return;
  if (settings.beep) {
    try {
      audioCtx = audioCtx || new AudioContext();
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = 880; g.gain.value = 0.08;
      o.connect(g).connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + 0.09);
    } catch { /* audio unavailable */ }
    navigator.vibrate?.(60);
  }
  if (settings.speak && 'speechSynthesis' in window) {
    const p = cardProfile();
    const text = shots.map(s => (p.rings.length ? (p.decimals ? s.dec.toFixed(1) : String(s.score)) : 'shot')).join(', ');
    speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }
}

// ---------- Session persistence ----------
function ensureSession() {
  if (!S.session) {
    const p = cardProfile();
    S.session = { id: uid(), started: Date.now(), profileId: p.id, profileName: p.name, cards: [] };
  }
  if (!S.session.cards.some(c => c.id === S.card.id)) S.session.cards.push(S.card);
}

let saveT;
function persist(now = false) {
  clearTimeout(saveT);
  const go = async () => {
    if (!S.session) return;
    S.card.image = snapshot();
    S.session.updated = Date.now();
    try { await sessions.put(S.session); } catch (e) { console.error(e); toast('Could not save the session'); }
  };
  if (now) return go();
  saveT = setTimeout(go, 1200);
}

function snapshot() {
  if (!S.src || !S.bulls.length || !frameReady()) return S.card.image;
  const r = roiNow(), k = Math.min(1, 900 / Math.max(r.w, r.h));
  const c = document.createElement('canvas');
  c.width = Math.round(r.w * k); c.height = Math.round(r.h * k);
  const ctx = c.getContext('2d');
  ctx.drawImage(S.src.el, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
  drawOverlay(ctx, { r, sc: k, ox: 0, oy: 0 }, true);
  return c.toDataURL('image/jpeg', 0.8);
}

async function newCardAction() {
  if (S.card.shots.length) await persist(true);
  S.card = newCard(); S.lastId = null; S.sel = null;
  if (S.bulls.length) { track(true); await setReference(); }
  updatePanels(); requestRender();
  toast('New card. Hang it before scoring; if it moved, tap Find target.');
}

async function endSession() {
  if (S.session) { await persist(true); toast('Session saved to History'); }
  S.session = null;
  S.card = newCard(); S.lastId = null; S.sel = null;
  if (S.bulls.length) await setReference();
  updatePanels(); requestRender();
}

// ---------- Sources ----------
function stopSource() {
  if (S.stream) S.stream.getTracks().forEach(t => t.stop());
  S.stream = null; S.track = null; S.src = null; S.demo = null;
  S.bulls = []; S.ref = null; S.auto = false; S.pending = [];
  S.mode = 'idle'; S.calib = null; hideBanner();
}

function afterSourceChange() {
  S.bulls = []; S.ref = null; S.zoom = 1; S.center = null;
  if (S.src?.kind !== 'camera') { S.hwMin = S.hwMax = 1; setZoom(1); }
  $('#empty').hidden = true;
  updatePill(); updateButtons(); sizeView(); updateSourceUI(); requestRender();
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) return toast('The camera needs HTTPS and a recent browser');
  stopSource();
  const video = $('#video');
  const c = { audio: false, video: { width: { ideal: 3840 }, height: { ideal: 2160 } } };
  if (settings.camId) c.video.deviceId = { exact: settings.camId };
  else c.video.facingMode = { ideal: 'environment' };
  try {
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia(c); }
    catch (e) {
      if (!settings.camId) throw e;
      settings.camId = ''; saveSettings();
      return startCamera();
    }
    S.stream = stream; S.track = stream.getVideoTracks()[0];
    video.srcObject = stream;
    await video.play();
    S.src = { kind: 'camera', el: video, w: video.videoWidth, h: video.videoHeight };
    await setupCameraControls();
    afterSourceChange();
    status('Zoom in (pinch or the zoom bar) until the target fills the circle, then tap Find target.');
    enterAim();
  } catch (e) {
    toast('Camera unavailable: ' + e.message);
  }
}

async function setupCameraControls() {
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
  const cur = S.track.getSettings().deviceId;
  $('#camSel').innerHTML = devs.map((d, i) => `<option value="${esc(d.deviceId)}" ${d.deviceId === cur ? 'selected' : ''}>${esc(d.label || 'Camera ' + (i + 1))}</option>`).join('');
  $('#camRow').hidden = devs.length < 2;
  const caps = S.track.getCapabilities ? S.track.getCapabilities() : {};
  S.hwMin = caps.zoom ? caps.zoom.min : 1;
  S.hwMax = caps.zoom ? caps.zoom.max : 1;
  setZoom(settings.camZoom || 1);
  $('#lockRow').hidden = !(caps.focusMode || caps.exposureMode);
  $('#lockIn').checked = !!settings.lock;
}

// ---------- Zoom ----------
// One zoom control: the camera's own zoom first, then a digital crop up to 4× more.
const DIGITAL_MAX = 4;
const maxZoom = () => (S.src?.kind === 'camera' ? S.hwMax / S.hwMin : 1) * DIGITAL_MAX;
let hwPending = null, hwBusy = false;

function applyHwZoom(z) {
  hwPending = z;
  if (hwBusy || !S.track) return;
  hwBusy = true;
  const v = hwPending;
  hwPending = null;
  S.track.applyConstraints({ advanced: [{ zoom: v }] }).catch(() => {}).finally(() => {
    hwBusy = false;
    if (hwPending != null) applyHwZoom(hwPending);
  });
}

function setZoom(z, unlock = false) {
  z = clamp(z, 1, maxZoom());
  if (unlock && S.bulls.length) reaim('Zoom changed. Centre the target and tap Find target.');
  S.camZ = z;
  if (S.aimSel?.length) { S.aimSel = []; aimMessage(); }
  const hwRange = S.src?.kind === 'camera' ? S.hwMax / S.hwMin : 1;
  const hw = Math.min(z, hwRange);
  S.dz = z / hw;
  if (S.src?.kind === 'camera' && S.hwMax > S.hwMin) applyHwZoom(S.hwMin * hw);
  $('#zSlider').value = Math.round((Math.log(z) / Math.log(maxZoom())) * 1000);
  $('#zOut').textContent = z.toFixed(1) + '×';
  if (S.src?.kind === 'camera') { settings.camZoom = z; saveSettings(); }
  requestRender();
}

// The part of the frame shown while aiming (centre crop for digital zoom).
function aimRegion() {
  let w = S.src.w / S.dz, h = S.src.h / S.dz;
  // Full-screen aiming fills the screen (crop, not letterbox), so what you see is what's searched.
  const cv = $('#view');
  if (S.aiming && cv.clientWidth && cv.clientHeight) {
    const A = cv.clientWidth / cv.clientHeight;
    if (w / h > A) w = h * A; else h = w / A;
  }
  return { x: (S.src.w - w) / 2, y: (S.src.h - h) / 2, w, h };
}

function reaim(msg = 'Zoom in, put the target in the circle, then tap Find target.') {
  S.bulls = []; S.ref = null; S.auto = false; S.pending = []; S.zoom = 1;
  S.mode = 'idle'; S.calib = null; hideBanner();
  status(msg, 'warn');
  updatePill(); updateButtons(); sizeView(); requestRender();
}

function applyLock(on) {
  if (!S.track?.getCapabilities) return;
  const caps = S.track.getCapabilities(), adv = {};
  const pick = (modes, want) => (modes || []).includes(want) ? want : null;
  const f = pick(caps.focusMode, on ? 'manual' : 'continuous'), e = pick(caps.exposureMode, on ? 'manual' : 'continuous');
  if (f) adv.focusMode = f;
  if (e) adv.exposureMode = e;
  if (Object.keys(adv).length) S.track.applyConstraints({ advanced: [adv] }).catch(err => toast('Lock not supported: ' + err.message));
}

async function loadPhotos(files) {
  const imgs = [];
  for (const f of files) {
    const img = new Image();
    img.src = URL.createObjectURL(f);
    try { await img.decode(); imgs.push(img); } catch { toast(`Couldn't open ${f.name}`); }
  }
  if (!imgs.length) return;
  if (S.src?.kind === 'photo') {
    S.photos.push(...imgs);
    status(`${S.photos.length} photos loaded. Score shot steps to the next one.`);
    updateSourceUI();
    return;
  }
  stopSource();
  S.photos = imgs;
  showPhoto(0);
  afterSourceChange();
  status(`${imgs.length} photo(s). Score shot steps through them.`);
  enterAim();
}

function showPhoto(i) {
  S.photoIdx = i;
  const img = S.photos[i];
  S.src = { kind: 'photo', el: img, w: img.naturalWidth, h: img.naturalHeight };
  updateSourceUI(); requestRender();
}

function startDemo() {
  stopSource();
  S.demo = new DemoRange(profile(), { pelletD: settings.pellet, sway: 0.6 });
  S.src = { kind: 'demo', el: S.demo.canvas, w: S.demo.o.w, h: S.demo.o.h };
  afterSourceChange();
  status('Demo range: Fire demo shot, then Score shot (or turn on Auto).');
  enterAim();
}

function updateSourceUI() {
  const k = S.src?.kind;
  $('#btnFire').hidden = k !== 'demo';
  $('#btnScore').textContent = k === 'photo' ? 'Next photo ▶' : 'Score shot';
  $('#srcInfo').textContent = !S.src ? '' :
    k === 'photo' ? `Photo ${S.photoIdx + 1} of ${S.photos.length} · ${S.src.w}×${S.src.h}` :
    k === 'demo' ? 'Simulated target at the firing line' : `Camera ${S.src.w}×${S.src.h}`;
}

// ---------- Drawing ----------
const toScreen = (f, x, y) => [f.ox + (x - f.r.x) * f.sc, f.oy + (y - f.r.y) * f.sc];
const toFrame = (f, x, y) => [f.r.x + (x - f.ox) / f.sc, f.r.y + (y - f.oy) / f.sc];

function viewRegion() {
  if (!S.bulls.length) return aimRegion();
  const base = roiNow();
  if (S.zoom <= 1) return base;
  const w = base.w / S.zoom, h = base.h / S.zoom;
  let [cx, cy] = S.center || [base.x + base.w / 2, base.y + base.h / 2];
  cx = clamp(cx, base.x + w / 2, base.x + base.w - w / 2);
  cy = clamp(cy, base.y + h / 2, base.y + base.h - h / 2);
  S.center = [cx, cy];
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

function sizeView() {
  const cv = $('#view');
  if (!S.src) { cv.style.height = ''; return; }
  const r = roiNow(), cw = cv.parentElement.clientWidth;
  cv.style.height = Math.round(Math.min(window.innerHeight * 0.58, (cw * r.h) / r.w)) + 'px';
}

function render() {
  const cv = $('#view'), ctx = cv.getContext('2d'), dpr = window.devicePixelRatio || 1;
  const cw = cv.clientWidth, ch = cv.clientHeight;
  if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(ch * dpr)) {
    cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, cw, ch);
  if (!frameReady()) { S.vf = null; return; }
  const r = viewRegion(), sc = Math.min(cw / r.w, ch / r.h);
  const f = { r, sc, ox: (cw - r.w * sc) / 2, oy: (ch - r.h * sc) / 2 };
  ctx.drawImage(S.src.el, r.x, r.y, r.w, r.h, f.ox, f.oy, r.w * sc, r.h * sc);
  S.vf = f;
  drawOverlay(ctx, f);
}

function drawOverlay(ctx, f, still = false) {
  const p = cardProfile(), pr = S.card.pellet / 2;
  S.bulls.forEach((b, bi) => {
    const M = V.bullMatrix(b), [sx, sy] = toScreen(f, b.cx, b.cy), k = V.pxPerMm(b) * f.sc;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.transform(M[0] * f.sc, M[2] * f.sc, M[1] * f.sc, M[3] * f.sc, 0, 0);
    if (settings.showRings && !still && p.rings.length) {
      ctx.lineWidth = 1 / k;
      ctx.strokeStyle = 'rgba(255,184,0,0.5)';
      for (const d of p.rings) { ctx.beginPath(); ctx.arc(0, 0, d / 2, 0, 2 * Math.PI); ctx.stroke(); }
    } else if (!still) {
      const L = 6;
      ctx.lineWidth = 1.5 / k; ctx.strokeStyle = 'rgba(255,184,0,0.8)';
      ctx.beginPath(); ctx.moveTo(-L, 0); ctx.lineTo(L, 0); ctx.moveTo(0, -L); ctx.lineTo(0, L); ctx.stroke();
    }
    for (const s of S.card.shots) {
      if (s.bull !== bi) continue;
      const latest = s.id === S.lastId, sel = s.id === S.sel;
      ctx.beginPath(); ctx.arc(s.x, s.y, pr, 0, 2 * Math.PI);
      if (latest) { ctx.fillStyle = 'rgba(255,184,0,0.35)'; ctx.fill(); }
      ctx.lineWidth = (sel ? 3 : 2) / k;
      ctx.strokeStyle = sel ? '#ffffff' : latest ? '#ffb800' : '#39d0ff';
      ctx.stroke();
    }
    ctx.restore();
  });
  ctx.font = '600 12px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  S.card.shots.forEach((s, i) => {
    const b = S.bulls[s.bull];
    if (!b) return;
    const [fx, fy] = V.mmToFrame(b, s.x, s.y), [x, y] = toScreen(f, fx, fy), r = pr * V.pxPerMm(b) * f.sc;
    const t = String(i + 1);
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.85)';
    ctx.strokeText(t, x + r + 2, y - r - 1);
    ctx.fillStyle = s.id === S.lastId ? '#ffb800' : '#d8f4ff';
    ctx.fillText(t, x + r + 2, y - r - 1);
  });
  if (!still && !S.bulls.length && S.mode !== 'calib') {
    const cx = f.ox + (f.r.w * f.sc) / 2, cy = f.oy + (f.r.h * f.sc) / 2, rr = Math.min(f.r.w, f.r.h) * f.sc * 0.22;
    ctx.strokeStyle = 'rgba(255,184,0,.9)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy, rr, 0, 2 * Math.PI);
    ctx.moveTo(cx - rr - 14, cy); ctx.lineTo(cx - rr + 10, cy); ctx.moveTo(cx + rr - 10, cy); ctx.lineTo(cx + rr + 14, cy);
    ctx.moveTo(cx, cy - rr - 14); ctx.lineTo(cx, cy - rr + 10); ctx.moveTo(cx, cy + rr - 10); ctx.lineTo(cx, cy + rr + 14);
    ctx.stroke();
  }
  if (!still) for (const b of S.aimSel) {
    const [x, y] = toScreen(f, b.cx, b.cy);
    ctx.strokeStyle = '#48d17a'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.ellipse(x, y, b.a * f.sc, b.b * f.sc, b.theta, 0, 2 * Math.PI); ctx.stroke();
  }
  if (!still) {
    ctx.setLineDash([3, 3]); ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5;
    for (const q of S.pending) {
      const [x, y] = toScreen(f, q.x, q.y);
      ctx.beginPath(); ctx.arc(x, y, Math.max(6, (pelletPx() / 2) * f.sc + 3), 0, 2 * Math.PI); ctx.stroke();
    }
    ctx.setLineDash([]);
    if (S.calib) for (const [cx, cy] of S.calib.centres) {
      const [x, y] = toScreen(f, cx, cy);
      ctx.strokeStyle = '#ffb800'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x - 10, y); ctx.lineTo(x + 10, y); ctx.moveTo(x, y - 10); ctx.lineTo(x, y + 10); ctx.stroke();
    }
  }
}

// Schematic of the card with all shots, zoomed to fit the group.
function drawPlot() {
  const cv = $('#plot'), ctx = cv.getContext('2d'), dpr = window.devicePixelRatio || 1;
  const size = cv.clientWidth;
  if (!size) return;
  if (cv.width !== Math.round(size * dpr)) { cv.width = cv.height = Math.round(size * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const p = cardProfile(), shots = S.card.shots, pr = S.card.pellet / 2;
  const outer = p.rings.length ? p.rings[p.rings.length - 1] / 2 : p.card / 2;
  let ext = p.black ? (p.black / 2) * 1.08 : Math.min(outer, 25);
  for (const s of shots) ext = Math.max(ext, Math.hypot(s.x, s.y) + pr + 2);
  ext = Math.min(ext, outer + 4);
  const k = size / 2 / ext;
  ctx.fillStyle = '#efece4';
  ctx.fillRect(0, 0, size, size);
  ctx.save();
  ctx.translate(size / 2, size / 2);
  ctx.scale(k, k);
  if (p.black) { ctx.fillStyle = '#1d1f22'; ctx.beginPath(); ctx.arc(0, 0, p.black / 2, 0, 2 * Math.PI); ctx.fill(); }
  ctx.lineWidth = 1 / k;
  for (const d of p.rings) {
    ctx.strokeStyle = p.black && d < p.black ? '#d8d5cc' : '#1d1f22';
    ctx.beginPath(); ctx.arc(0, 0, d / 2, 0, 2 * Math.PI); ctx.stroke();
  }
  if (!p.rings.length) {
    ctx.strokeStyle = '#1d1f22';
    ctx.beginPath(); ctx.moveTo(-ext, 0); ctx.lineTo(ext, 0); ctx.moveTo(0, -ext); ctx.lineTo(0, ext); ctx.stroke();
  }
  ctx.font = `${11 / k}px system-ui`;
  ctx.textAlign = 'center';
  p.rings.forEach((d, i) => {
    const r = d / 2, prev = i ? p.rings[i - 1] / 2 : 0, mid = (r + prev) / 2;
    if (i === 0 || mid > ext || (r - prev) * k < 12) return;
    ctx.fillStyle = p.black && d <= p.black ? '#cfccc3' : '#555';
    ctx.fillText(String(p.top - i), 0, -mid + 4 / k);
  });
  for (const s of shots) {
    const latest = s.id === S.lastId, sel = s.id === S.sel;
    ctx.beginPath(); ctx.arc(s.x, s.y, pr, 0, 2 * Math.PI);
    ctx.fillStyle = latest ? 'rgba(255,184,0,.9)' : 'rgba(57,208,255,.75)';
    ctx.fill();
    ctx.lineWidth = (sel ? 2.5 : 1) / k;
    ctx.strokeStyle = sel ? '#fff' : '#0b2730';
    ctx.stroke();
  }
  const st = cardStats(shots);
  if (st.n >= 2) {
    const [mx, my] = st.mpi, L = 3;
    ctx.strokeStyle = '#ff3b3b'; ctx.lineWidth = 2 / k;
    ctx.beginPath(); ctx.moveTo(mx - L, my); ctx.lineTo(mx + L, my); ctx.moveTo(mx, my - L); ctx.lineTo(mx, my + L); ctx.stroke();
  }
  ctx.restore();
}

// ---------- Panels ----------
const fmtScore = (s, p) => (p.rings.length ? (p.decimals ? s.dec.toFixed(1) : String(s.score)) + (s.inner ? '*' : '') : '•');

function updatePanels() {
  const p = cardProfile(), shots = S.card.shots, st = cardStats(shots);
  const last = shots.find(s => s.id === S.lastId);
  $('#rLast').textContent = last ? fmtScore(last, p) : '–';
  $('#rTotal').textContent = st.scored ? st.total : '–';
  $('#rDec').textContent = st.scored && p.decimals ? st.dec.toFixed(1) : '';
  $('#rCount').textContent = st.n;

  const row = (k, v) => `<div class="stat"><span>${k}</span><b>${v}</b></div>`;
  $('#stats').innerHTML = !st.n ? '<h3>Group</h3><p class="hint">Shots will appear here.</p>' :
    '<h3>Group</h3>' +
    (st.scored ? row('Average', (p.decimals ? st.dec / st.n : st.total / st.n).toFixed(2)) : '') +
    (p.innerTen ? row('Inner tens', st.inners) : '') +
    row('Group size', st.n > 1 ? st.es.toFixed(1) + ' mm' : '–') +
    row('Mean radius', st.n > 1 ? st.mr.toFixed(1) + ' mm' : '–') +
    row('Centre offset', describeOffset(st.mpi)) +
    (st.n >= 3 ? `<div class="advice">${esc(sightAdvice(st.mpi, settings.clickMm))}</div>` : '');

  const sr = series(shots, settings.seriesLen);
  $('#series').innerHTML = sr.map((s, i) =>
    `<div class="srow"><span>Series ${i + 1} · ${s.shots.length} shot${s.shots.length === 1 ? '' : 's'}</span><b>${st.scored ? s.total + (p.decimals ? ` (${s.dec.toFixed(1)})` : '') : ''}</b></div>`).join('');
  $('#chips').innerHTML = shots.map((s, i) =>
    `<button class="chip ${s.id === S.sel ? 'sel' : ''} ${s.id === S.lastId ? 'latest' : ''}" data-id="${s.id}"><i>${i + 1}</i>${fmtScore(s, p)}</button>`).join('');
  updateButtons();
  drawPlot();
}

function updateButtons() {
  $('#btnDel').disabled = !S.sel;
  $('#btnUndo').disabled = !S.card.shots.length;
  $('#btnAdd').classList.toggle('on', S.mode === 'add');
  $('#btnAuto').setAttribute('aria-pressed', String(S.auto));
  $('#btnZoom').textContent = '🔍 ' + (Math.round(S.zoom * 10) / 10) + '×';
  const locked = S.bulls.length > 0;
  $('#zoomBar').hidden = !S.aiming || S.mode === 'calib';
  $('#aimTop').hidden = !S.aiming;
  $('#aimEnter').hidden = !S.aiming || S.mode === 'calib';
  $('#btnReaim').hidden = !locked;
  $('#btnZoom').hidden = !locked;
  $('#btnEnd').disabled = !S.session;
}

function updatePill() {
  const el = $('#pill');
  el.textContent = S.bulls.length ? 'Locked on' : S.mode === 'calib' ? 'Calibrating' : 'Not locked';
  el.classList.toggle('ok', !!S.bulls.length);
}

// ---------- Pointer editing on the camera view ----------
function hitShot(sx, sy) {
  let best = null, bd = Infinity;
  for (const s of S.card.shots) {
    const b = S.bulls[s.bull];
    if (!b) continue;
    const [x, y] = toScreen(S.vf, ...V.mmToFrame(b, s.x, s.y));
    const r = Math.max(20, (S.card.pellet / 2) * V.pxPerMm(b) * S.vf.sc * 1.4), d = Math.hypot(x - sx, y - sy);
    if (d < r && d < bd) { bd = d; best = s; }
  }
  return best;
}

function setupPointer() {
  const cv = $('#view');
  const local = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const spread = () => { const [a, b] = [...pointers.values()]; return Math.hypot(a[0] - b[0], a[1] - b[1]); };

  cv.addEventListener('pointerdown', e => {
    if (!S.vf) return;
    const [sx, sy] = local(e);
    pointers.set(e.pointerId, [sx, sy]);
    try { cv.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    // Two fingers: pinch to zoom (camera zoom while aiming, magnifier once locked on).
    if (pointers.size === 2) {
      S.drag = null; S.pan = null; S.tap = null;
      S.pinch = { d0: spread() || 1, z0: S.bulls.length ? S.zoom : S.camZ };
      return;
    }
    if (pointers.size > 2) return;
    // Taps (calibration, adding a shot) are handled on release so a pinch never counts as one.
    if (S.mode === 'calib' || S.mode === 'add' || S.mode === 'aim') { S.tap = [sx, sy]; return; }
    const hit = hitShot(sx, sy);
    if (hit) {
      const b = S.bulls[hit.bull];
      S.sel = hit.id;
      S.drag = { id: hit.id, start: [sx, sy], from: V.mmToFrame(b, hit.x, hit.y), moved: false };
    } else {
      S.sel = null;
      if (S.zoom > 1) S.pan = { sx, sy, c: [...S.center] };
    }
    updatePanels(); requestRender();
  });

  cv.addEventListener('pointermove', e => {
    if (!S.vf || !pointers.has(e.pointerId)) return;
    const [sx, sy] = local(e);
    pointers.set(e.pointerId, [sx, sy]);
    if (S.pinch && pointers.size === 2) {
      const z = S.pinch.z0 * (spread() / S.pinch.d0);
      if (S.bulls.length) { S.zoom = clamp(z, 1, 8); updateButtons(); requestRender(); }
      else setZoom(z);
      return;
    }
    if (S.tap && Math.hypot(sx - S.tap[0], sy - S.tap[1]) > 12) S.tap = null;
    if (S.drag) {
      const s = S.card.shots.find(q => q.id === S.drag.id), b = s && S.bulls[s.bull];
      if (!b) return;
      const fx = S.drag.from[0] + (sx - S.drag.start[0]) / S.vf.sc, fy = S.drag.from[1] + (sy - S.drag.start[1]) / S.vf.sc;
      const [x, y] = V.frameToMm(b, fx, fy);
      s.x = +x.toFixed(2); s.y = +y.toFixed(2); s.auto = false;
      rescore(s);
      S.drag.moved = true;
      updatePanels();
      requestRender();
    } else if (S.pan) {
      S.center = [S.pan.c[0] - (sx - S.pan.sx) / S.vf.sc, S.pan.c[1] - (sy - S.pan.sy) / S.vf.sc];
      requestRender();
    }
  });

  const end = e => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) S.pinch = null;
    if (e.type === 'pointerup' && S.tap && S.vf) {
      const [fx, fy] = toFrame(S.vf, S.tap[0], S.tap[1]);
      if (S.mode === 'calib') onCalibTap(fx, fy);
      else if (S.mode === 'aim') aimTap(fx, fy);
      else if (S.mode === 'add') {
        const s = addShotAtFrame(fx, fy, false);
        S.sel = s && s.id; S.mode = 'idle';
        updatePanels(); requestRender();
      }
    }
    S.tap = null;
    if (S.drag?.moved) persist();
    S.drag = null; S.pan = null;
  };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
}

function cycleZoom() {
  if (!S.src) return;
  S.zoom = [2, 4, 8].find(z => z > S.zoom + 0.01) || 1;
  const s = S.card.shots.find(q => q.id === S.sel) || S.card.shots.find(q => q.id === S.lastId);
  S.center = s && S.bulls[s.bull] ? V.mmToFrame(S.bulls[s.bull], s.x, s.y) : S.bulls[0] ? [S.bulls[0].cx, S.bulls[0].cy] : null;
  updateButtons(); requestRender();
}

// ---------- History ----------
function summarise(sess) {
  const shots = sess.cards.flatMap(c => c.shots), st = cardStats(shots);
  const p = profileById(sess.profileId), dec = p.decimals && st.scored;
  return { st, shots, avg: st.n ? (dec ? st.dec : st.total) / st.n : 0, scored: st.scored, dec };
}

async function renderHistory() {
  const list = await sessions.all();
  const pts = list.map(s => ({ s, m: summarise(s) })).filter(o => o.m.scored && o.m.st.n).slice(0, 30).reverse();
  if (pts.length >= 2) {
    const W = 360, H = 150, pad = 30;
    const vals = pts.map(o => o.m.avg), lo = Math.floor(Math.min(...vals) * 2) / 2 - 0.5, hi = Math.ceil(Math.max(...vals) * 2) / 2 + 0.5;
    const X = i => pad + (i * (W - pad - 8)) / (pts.length - 1), Y = v => H - 18 - ((v - lo) / (hi - lo)) * (H - 30);
    const line = vals.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
    const grid = [lo, (lo + hi) / 2, hi].map(v => `<line x1="${pad}" x2="${W - 8}" y1="${Y(v)}" y2="${Y(v)}" stroke="#2c3136"/><text x="${pad - 6}" y="${Y(v) + 4}" fill="#98a1a9" font-size="11" text-anchor="end">${v.toFixed(1)}</text>`).join('');
    $('#chart').innerHTML = `<svg viewBox="0 0 ${W} ${H}">${grid}<polyline points="${line}" fill="none" stroke="#ffb800" stroke-width="2.5"/>${vals.map((v, i) => `<circle cx="${X(i)}" cy="${Y(v)}" r="3.5" fill="#ffb800"/>`).join('')}</svg><p class="hint">Average score per shot, last ${pts.length} sessions</p>`;
  } else $('#chart').innerHTML = '<p class="hint">Shoot a couple of sessions to see your trend.</p>';

  $('#sessList').innerHTML = list.length ? list.map(s => {
    const m = summarise(s), d = new Date(s.started);
    return `<button class="sess" data-id="${s.id}"><div><div class="t">${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} · ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</div>
      <div class="m">${esc(s.profileName)} · ${s.cards.length} card${s.cards.length === 1 ? '' : 's'} · ${m.st.n} shots${m.scored ? ` · avg ${m.avg.toFixed(2)}` : ''}</div></div>
      <div class="s">${m.scored ? (m.dec ? m.st.dec.toFixed(1) : m.st.total) : m.st.n}</div></button>`;
  }).join('') : '<p class="emptynote">No sessions yet. Scored cards are saved here automatically.</p>';
}

async function openSession(id) {
  const s = await sessions.get(id);
  if (!s) return;
  const p = profileById(s.profileId), d = new Date(s.started);
  const cards = s.cards.map((c, i) => {
    const st = cardStats(c.shots), sr = series(c.shots, settings.seriesLen);
    return `<div class="panel"><div class="phead"><h3>Card ${i + 1} · ${c.shots.length} shots${c.pellet === 5.5 ? ' · .22' : ''}</h3><b>${st.scored ? st.total + (p.decimals ? ` (${st.dec.toFixed(1)})` : '') : ''}</b></div>
      ${c.image ? `<img class="cardimg" src="${c.image}" alt="Card ${i + 1}">` : ''}
      ${sr.map((x, j) => `<div class="srow"><span>Series ${j + 1}</span><b>${st.scored ? x.total + (p.decimals ? ` (${x.dec.toFixed(1)})` : '') : x.shots.length + ' shots'}</b></div>`).join('')}
      <div class="srow"><span>Group size / mean radius</span><b>${st.n > 1 ? `${st.es.toFixed(1)} / ${st.mr.toFixed(1)} mm` : '–'}</b></div>
      <div class="srow"><span>Centre offset</span><b>${describeOffset(st.mpi)}</b></div>
      <div class="chips">${c.shots.map((x, j) => `<span class="chip btn"><i>${j + 1}</i>${fmtScore(x, p)}</span>`).join('')}</div></div>`;
  }).join('');
  $('#dlgBody').innerHTML = `<div class="dlgbar"><div><b>${d.toLocaleString()}</b><div class="hint">${esc(s.profileName)}</div></div>
    <div class="row"><button id="dCsv">Export CSV</button><button class="danger" id="dDel">Delete</button><button id="dClose">Close</button></div></div>${cards}`;
  const dlg = $('#dlg');
  dlg.showModal();
  $('#dClose').onclick = () => dlg.close();
  $('#dCsv').onclick = () => download(`session-${d.toISOString().slice(0, 10)}.csv`, toCsv(s), 'text/csv');
  $('#dDel').onclick = async () => {
    if (!confirm('Delete this session permanently?')) return;
    await sessions.del(id);
    if (S.session?.id === id) S.session = null;
    dlg.close(); renderHistory(); updateButtons();
  };
}

function toCsv(s) {
  const rows = [['session_start', 'card', 'shot', 'bull', 'x_mm', 'y_mm', 'score', 'decimal', 'inner_ten', 'calibre_mm', 'time']];
  s.cards.forEach((c, ci) => c.shots.forEach((x, i) => rows.push([
    new Date(s.started).toISOString(), ci + 1, i + 1, x.bull + 1, x.x, x.y, x.score ?? '', x.dec ?? '', x.inner ? 1 : 0, c.pellet, new Date(x.t).toISOString(),
  ])));
  return rows.map(r => r.join(',')).join('\n');
}

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- Settings ----------
function fillProfileSelect() {
  $('#profileSel').innerHTML = allProfiles().map(p => `<option value="${p.id}" ${p.id === settings.profileId ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  $('#customList').innerHTML = custom.map(p => `<div class="srow"><span>${esc(p.name)} · ${p.rings.length} rings${p.bulls > 1 ? ` · ${p.bulls} bulls` : ''}</span><button class="danger chip" data-del="${p.id}">Remove</button></div>`).join('');
}

function setupSettings() {
  $('#setSeries').value = settings.seriesLen;
  $('#setClick').value = settings.clickMm;
  $('#setRings').checked = settings.showRings;
  $('#setBeep').checked = settings.beep;
  $('#setSpeak').checked = settings.speak;
  $('#setThr').value = settings.minThr;
  const bind = (id, key, conv) => $(id).addEventListener('change', e => {
    settings[key] = conv(e.target);
    saveSettings(); updatePanels(); requestRender();
  });
  bind('#setSeries', 'seriesLen', t => clamp(+t.value || 10, 1, 60));
  bind('#setClick', 'clickMm', t => Math.max(0, +t.value || 0));
  bind('#setRings', 'showRings', t => t.checked);
  bind('#setBeep', 'beep', t => t.checked);
  bind('#setSpeak', 'speak', t => t.checked);
  bind('#setThr', 'minThr', t => +t.value);

  $('#cSave').onclick = () => {
    const v = id => +$(id).value;
    const name = $('#cName').value.trim();
    if (!name || !(v('#cInner') >= 0) || !(v('#cStep') > 0) || !(v('#cCount') >= 1)) return toast('Fill in a name, inner ring diameter, step and number of rings');
    const p = makeProfile({ name, top: v('#cTop'), count: v('#cCount'), innerD: v('#cInner'), step: v('#cStep'), black: v('#cBlack'), bulls: v('#cBulls'), innerTen: v('#cInnerTen') });
    custom.push(p);
    saveJSON('profiles', custom);
    fillProfileSelect();
    toast(`Saved “${name}”. Choose it from the target menu on the Shoot tab.`);
  };
  $('#customList').addEventListener('click', e => {
    const id = e.target.dataset.del;
    if (!id || !confirm('Remove this target?')) return;
    custom = custom.filter(p => p.id !== id);
    saveJSON('profiles', custom);
    if (settings.profileId === id) { settings.profileId = BUILTIN[0].id; saveSettings(); }
    fillProfileSelect();
  });
  $('#btnExportAll').onclick = async () => download('target-scorer-export.json', JSON.stringify({ sessions: await sessions.all(), customTargets: custom }), 'application/json');
  $('#btnWipe').onclick = async () => {
    if (!confirm('Delete ALL saved sessions? This cannot be undone.')) return;
    await sessions.clear();
    S.session = null;
    renderHistory(); updateButtons();
  };
}

// ---------- Wiring ----------
function showTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + name));
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  if (name === 'history') renderHistory();
  if (name === 'shoot') { sizeView(); updatePanels(); requestRender(); }
  window.scrollTo(0, 0);
}

function init() {
  fillProfileSelect();
  $('#calibreSel').value = String(settings.pellet);
  setupSettings();
  setupPointer();

  document.querySelectorAll('.tabs button').forEach(b => { b.onclick = () => showTab(b.dataset.tab); });
  for (const id of ['#btnCam', '#btnCam2']) $(id).onclick = startCamera;
  for (const id of ['#btnDemo', '#btnDemo2']) $(id).onclick = startDemo;
  for (const id of ['#photoIn', '#photoIn2']) $(id).onchange = e => { loadPhotos([...e.target.files]); e.target.value = ''; };

  $('#btnFind').onclick = enterAim;
  $('#aimEnter').onclick = aimEnter;
  $('#aimCancel').onclick = () => exitAim(true);
  window.addEventListener('popstate', () => { if (S.aiming) exitAim(true); }); // phone back button
  $('#btnScore').onclick = () => scoreNow(false);
  $('#btnAuto').onclick = async () => {
    if (!S.bulls.length) return toast('Lock on to the target first');
    if (S.src.kind === 'photo') return toast('Auto mode needs the live camera');
    S.auto = !S.auto; S.pending = [];
    if (S.auto) { await setReference(); status('Auto: watching for new holes…', 'ok'); } else status('Auto off. Tap Score shot after each shot.');
    updateButtons(); requestRender();
  };
  $('#btnAdd').onclick = () => {
    if (!S.bulls.length) return toast('Lock on to the target first');
    S.mode = S.mode === 'add' ? 'idle' : 'add';
    if (S.mode === 'add') toast('Tap the hole on the camera view (use 🔍 to magnify)');
    updateButtons();
  };
  $('#btnDel').onclick = () => {
    S.card.shots = S.card.shots.filter(s => s.id !== S.sel);
    if (S.lastId === S.sel) S.lastId = S.card.shots.length ? S.card.shots[S.card.shots.length - 1].id : null;
    S.sel = null;
    persist(); updatePanels(); requestRender();
  };
  $('#btnUndo').onclick = () => {
    const last = S.card.shots.reduce((a, b) => (!a || b.t > a.t ? b : a), null);
    if (!last) return;
    S.card.shots = S.card.shots.filter(s => s !== last);
    S.lastId = S.card.shots.length ? S.card.shots[S.card.shots.length - 1].id : null;
    if (S.sel === last.id) S.sel = null;
    persist(); updatePanels(); requestRender();
  };
  $('#btnRef').onclick = async () => {
    if (!S.bulls.length) return toast('Lock on to the target first');
    track(true); await setReference(); toast('Reference updated: existing holes will be ignored');
  };
  $('#btnFire').onclick = () => { S.demo?.fire(); requestRender(); };
  $('#btnZoom').onclick = cycleZoom;
  $('#btnNewCard').onclick = newCardAction;
  $('#btnEnd').onclick = endSession;
  $('#chips').addEventListener('click', e => {
    const id = e.target.closest('.chip')?.dataset.id;
    if (!id) return;
    S.sel = S.sel === id ? null : id;
    updatePanels(); requestRender();
  });
  $('#sessList').addEventListener('click', e => { const b = e.target.closest('.sess'); if (b) openSession(b.dataset.id); });

  $('#profileSel').onchange = async e => {
    if (S.card.shots.length && !confirm('Switching target starts a new session. Continue?')) { e.target.value = settings.profileId; return; }
    if (S.session) await endSession();
    settings.profileId = e.target.value; saveSettings();
    S.card = newCard(); S.bulls = []; S.ref = null; S.auto = false;
    if (S.src?.kind === 'demo') startDemo();
    updatePill(); updatePanels(); sizeView(); requestRender();
    if (S.src) status(profile().black ? 'Tap Find target to lock on.' : 'This target has no black aiming mark. Tap Find target to calibrate by hand.');
  };
  $('#calibreSel').onchange = e => {
    settings.pellet = +e.target.value; saveSettings();
    S.card.pellet = settings.pellet;
    S.card.shots.forEach(rescore);
    if (S.card.shots.length) persist();
    updatePanels(); requestRender();
  };
  $('#camSel').onchange = e => { settings.camId = e.target.value; saveSettings(); startCamera(); };
  const zStep = f => setZoom(S.camZ * f, true);
  $('#zSlider').oninput = e => setZoom(Math.exp((+e.target.value / 1000) * Math.log(maxZoom())), true);
  $('#zMinus').onclick = () => zStep(1 / 1.25);
  $('#zPlus').onclick = () => zStep(1.25);
  $('#btnReaim').onclick = enterAim;
  $('#lockIn').onchange = e => { settings.lock = e.target.checked; saveSettings(); applyLock(settings.lock); };
  $('#video').addEventListener('resize', () => {
    const v = $('#video');
    if (S.src?.kind === 'camera' && (v.videoWidth !== S.src.w || v.videoHeight !== S.src.h)) {
      S.src.w = v.videoWidth; S.src.h = v.videoHeight;
      afterSourceChange();
      status('Camera view changed. Tap Find target again.', 'warn');
    }
  });
  window.addEventListener('resize', () => { sizeView(); requestRender(); updatePanels(); });

  const loop = () => {
    if (S.src && (S.src.kind === 'camera' || S.dirty)) { S.dirty = false; render(); }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  setInterval(autoTick, 400);
  updatePanels();

  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
window.__scorer = S; // handy for debugging from the console
