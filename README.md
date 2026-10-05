# Target Scorer

Point a phone at an air pistol target from the firing line; it finds new holes, scores them,
and keeps a history of your sessions. All processing happens on the phone with plain
JavaScript, so it works offline with no AI or API costs.

## How it works

1. **Lock on.** The app finds the black aiming mark (`findDarkBlobs`), then casts rays to its edge
   and fits an ellipse (`refineBull`). That ellipse gives the mm ↔ pixel mapping, including the
   squash from a camera that isn't square-on. Targets without a black mark are calibrated by
   tapping the centre and one ring.
2. **Reference frame.** It saves an averaged frame of the card.
3. **New holes.** After a shot it compares the new frame with the reference (`detectNewHoles`):
   - sub-pixel alignment for sway
   - a comparison that tolerates 3×3 printed edges, so lines don't shimmer
   - hysteresis thresholding
   - a pellet-sized disc fitted to each hole, which handles ring lines crossing holes and shots overlapping old holes
4. **Score.** Gauge rule: a shot takes the higher ring if the pellet's edge touches the line
   (`scoring.js`). It also reports decimals, inner tens, group size, mean point of impact and sight advice.
5. **Auto mode.** A candidate hole must be seen in 3 consecutive checks before it's scored.

## Run locally

```
python3 -m http.server 8642
```

Open http://localhost:8642. On a desktop, use **Try demo** (a simulated target at the firing
line) or **Photos**. `test/index.html` runs the detection accuracy tests against the simulator.

## On the phone

Browsers only allow camera access over **HTTPS**, so host the folder on any static HTTPS
host, e.g. GitHub Pages, Netlify or Cloudflare Pages. Open it in Chrome on Android and choose
**Add to Home screen**; it then runs full-screen and offline.

## APK

Once it's hosted over HTTPS, either:
- **PWABuilder** (pwabuilder.com): enter the URL and download an Android package (a Trusted Web
  Activity). No Android Studio needed.
- **Capacitor**: `npm i @capacitor/core @capacitor/cli @capacitor/android`, then `npx cap init`,
  `npx cap add android`, copy these files into `www/`, and build in Android Studio. This needs
  the Android SDK and a JDK.

## Getting good results

- Each hole should be at least ~8–10 px wide; the status line shows this after locking on.
  Use the telephoto lens or zoom.
- Holes in the black only show if light comes through them. A small light behind the target helps a lot.
- Mount the phone firmly. Drag a marker to correct it, or use ＋ Add / Delete.

## Files

| File | Purpose |
| --- | --- |
| `js/vision.js` | Target detection, ellipse fit, hole detection |
| `js/scoring.js` | Scores, decimals, group statistics, sight advice |
| `js/targets.js` | Target profiles (ISSF pistol and rifle, holes-only, custom) |
| `js/app.js` | UI, camera, auto mode, editing, history |
| `js/store.js` | IndexedDB sessions, localStorage settings |
| `js/demo.js` | Simulated range used by the demo and the tests |
| `sw.js`, `manifest.webmanifest` | Offline support and installable app |
