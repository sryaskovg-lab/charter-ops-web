// Great-circle route -> States crossed. Pure functions, no dependencies.
//
// Data (built by scripts/build-geo-data.js):
//   airports:  [[iata, icao, lat, lon, country, name], ...]            (OurAirports)
//   countries: [{ cc, name, polys: [[ringFlat, holeFlat...], ...] }]   (Natural Earth 1:50m)
// A ring is a flat array [lon, lat, lon, lat, ...].
//
// This is an estimate of the straight line between two airports, not the filed route.
// A point over open water counts for a State when it is within the 12 nautical mile
// territorial sea (22.2 km); a point over land counts only for the State it is in.

const R_KM = 6371.0088;
export const TERRITORIAL_SEA_KM = 22.2;
const rad = d => d * Math.PI / 180;
const deg = r => r * 180 / Math.PI;

export function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Points along the great circle from A to B about stepKm apart, both ends included.
export function greatCirclePoints(lat1, lon1, lat2, lon2, stepKm = 3) {
  const d = haversineKm(lat1, lon1, lat2, lon2);
  const n = Math.max(1, Math.ceil(d / stepKm));
  const phi1 = rad(lat1), lam1 = rad(lon1), phi2 = rad(lat2), lam2 = rad(lon2);
  const delta = d / R_KM;
  const out = [];
  for (let i = 0; i <= n; i++) {
    if (delta < 1e-9) { out.push({ lat: lat1, lon: lon1, km: 0 }); break; }
    const f = i / n;
    const A = Math.sin((1 - f) * delta) / Math.sin(delta), B = Math.sin(f * delta) / Math.sin(delta);
    const x = A * Math.cos(phi1) * Math.cos(lam1) + B * Math.cos(phi2) * Math.cos(lam2);
    const y = A * Math.cos(phi1) * Math.sin(lam1) + B * Math.cos(phi2) * Math.sin(lam2);
    const z = A * Math.sin(phi1) + B * Math.sin(phi2);
    out.push({ lat: deg(Math.atan2(z, Math.sqrt(x * x + y * y))), lon: deg(Math.atan2(y, x)), km: f * d });
  }
  return out;
}

function ringBox(r) {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (let i = 0; i < r.length; i += 2) { if (r[i] < x0) x0 = r[i]; if (r[i] > x1) x1 = r[i]; if (r[i + 1] < y0) y0 = r[i + 1]; if (r[i + 1] > y1) y1 = r[i + 1]; }
  return [x0, y0, x1, y1];
}
function inRing(r, x, y) {
  let inside = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function distToRingKm(r, lon, lat) {
  const kx = Math.cos(rad(lat)) * 111.195, ky = 111.195;
  let best = Infinity;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    // shortest way round in longitude, so rings near the antimeridian behave
    let ax = r[j] - lon, bx = r[i] - lon;
    if (ax > 180) ax -= 360; if (ax < -180) ax += 360;
    if (bx > 180) bx -= 360; if (bx < -180) bx += 360;
    const x1 = ax * kx, y1 = (r[j + 1] - lat) * ky, x2 = bx * kx, y2 = (r[i + 1] - lat) * ky;
    const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
    let t = len2 ? -(x1 * dx + y1 * dy) / len2 : 0; t = Math.max(0, Math.min(1, t));
    const px = x1 + t * dx, py = y1 + t * dy, d = Math.sqrt(px * px + py * py);
    if (d < best) best = d;
  }
  return best;
}

// Index once, query many times.
export function buildCountryIndex(countries) {
  const items = [];
  (countries || []).forEach(c => (c.polys || []).forEach(rings => {
    items.push({ cc: c.cc, name: c.name, rings, box: ringBox(rings[0]) });
  }));
  return items;
}

const insidePoly = (p, lon, lat) => inRing(p.rings[0], lon, lat) && !p.rings.slice(1).some(h => inRing(h, lon, lat));

// Which State a point is in; or, over water, the States whose coast is within the territorial sea.
export function statesAtPoint(index, lon, lat, seaKm = TERRITORIAL_SEA_KM) {
  for (const p of index) {
    const b = p.box;
    if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
    if (insidePoly(p, lon, lat)) return { land: p.cc, sea: [] };
  }
  const sea = new Set();
  const dLat = seaKm / 111.195 + 0.05;
  for (const p of index) {
    const b = p.box, dLon = dLat / Math.max(0.05, Math.cos(rad(lat)));
    if (lon < b[0] - dLon || lon > b[2] + dLon || lat < b[1] - dLat || lat > b[3] + dLat) continue;
    if (sea.has(p.cc)) continue;
    if (distToRingKm(p.rings[0], lon, lat) <= seaKm) sea.add(p.cc);
  }
  return { land: null, sea: [...sea] };
}

// States a straight route crosses, in order of first contact.
//   [{ state, name, km, viaSeaOnly }]   viaSeaOnly = only touched through its territorial sea
export function statesAlong(index, nameOf, a, b, opts = {}) {
  const pts = greatCirclePoints(a.lat, a.lon, b.lat, b.lon, opts.stepKm || 3);
  const seen = new Map();
  for (const pt of pts) {
    const r = statesAtPoint(index, pt.lon, pt.lat, opts.seaKm ?? TERRITORIAL_SEA_KM);
    if (r.land) {
      const cur = seen.get(r.land);
      if (!cur) seen.set(r.land, { state: r.land, name: nameOf(r.land), km: Math.round(pt.km), viaSeaOnly: false });
      else cur.viaSeaOnly = false;
    } else r.sea.forEach(cc => { if (!seen.has(cc)) seen.set(cc, { state: cc, name: nameOf(cc), km: Math.round(pt.km), viaSeaOnly: true }); });
  }
  return [...seen.values()].sort((x, y) => x.km - y.km);
}
