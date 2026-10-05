// Target profiles. All sizes are diameters in mm.
// rings[0] is the highest-scoring ring (score `top`), rings[i] scores top - i.
// `black` is the dark aiming mark used for auto-detection (null = calibrate by tapping).

export const BUILTIN = [
  {
    id: 'issf-ap10', name: 'ISSF 10m Air Pistol', builtin: true, top: 10,
    rings: [11.5, 27.5, 43.5, 59.5, 75.5, 91.5, 107.5, 123.5, 139.5, 155.5],
    innerTen: 5.0, black: 59.5, bulls: 1, card: 170, decimals: true,
  },
  {
    id: 'issf-ar10', name: 'ISSF 10m Air Rifle', builtin: true, top: 10,
    rings: [0.5, 5.5, 10.5, 15.5, 20.5, 25.5, 30.5, 35.5, 40.5, 45.5],
    innerTen: null, black: 30.5, bulls: 1, card: 80, decimals: true,
  },
  {
    id: 'holes-only', name: 'Any target (holes and groups only)', builtin: true, top: 0,
    rings: [], innerTen: null, black: null, bulls: 1, card: 170, decimals: false,
  },
];

// Most club targets have equally spaced rings, so a custom target is described
// by its innermost ring and the step between ring diameters.
export function makeProfile({ name, top, count, innerD, step, black, bulls, innerTen }) {
  const rings = Array.from({ length: count }, (_, i) => +(innerD + step * i).toFixed(2));
  return {
    id: 'custom-' + Date.now().toString(36), name, top, rings,
    innerTen: innerTen || null, black: black || null, bulls: Math.max(1, bulls | 0),
    card: Math.ceil(rings[rings.length - 1] + 15), decimals: true,
  };
}

// Radius (mm) used to calibrate by tapping a ring edge.
export function calibrationRings(p) {
  return p.rings.map((d, i) => ({ label: `Edge of ring ${p.top - i} (${d} mm)`, r: d / 2 }));
}
