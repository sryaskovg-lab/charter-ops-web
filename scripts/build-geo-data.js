// Builds the two static data files the Permits tab uses to suggest States:
//   public/data/airports.json   – from OurAirports   (https://github.com/davidmegginson/ourairports-data, public domain)
//   public/data/countries.json  – from Natural Earth (https://github.com/nvkelso/natural-earth-vector, public domain)
// Usage: node scripts/build-geo-data.js <airports.csv> <ne_50m_admin_0_countries.geojson>
const fs = require("fs");
const path = require("path");

const [csvPath, geoPath] = process.argv.slice(2);
if (!csvPath || !geoPath) { console.error("usage: node scripts/build-geo-data.js <airports.csv> <countries.geojson>"); process.exit(1); }

function parseCsvLine(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur); return out;
}

// ---- airports: [iata, icao, lat, lon, country, name]
const lines = fs.readFileSync(csvPath, "utf8").split(/\r?\n/).filter(Boolean);
const head = parseCsvLine(lines[0]); const ix = n => head.indexOf(n);
const I = { type: ix("type"), name: ix("name"), lat: ix("latitude_deg"), lon: ix("longitude_deg"), cc: ix("iso_country"), icao: ix("icao_code"), iata: ix("iata_code"), ident: ix("ident"), sched: ix("scheduled_service") };
const airports = [];
for (let i = 1; i < lines.length; i++) {
  const r = parseCsvLine(lines[i]);
  const type = r[I.type];
  if (!["large_airport", "medium_airport", "small_airport"].includes(type)) continue; // no heliports, closed fields, seaplane bases
  const iata = (r[I.iata] || "").toUpperCase();
  const icao = (r[I.icao] || (/^[A-Z]{4}$/.test(r[I.ident]) ? r[I.ident] : "")).toUpperCase();
  if (!iata && !icao) continue;
  if (!iata && type === "small_airport" && r[I.sched] !== "yes") continue; // small strips with no airline code
  const lat = parseFloat(r[I.lat]), lon = parseFloat(r[I.lon]);
  if (!isFinite(lat) || !isFinite(lon) || !r[I.cc]) continue;
  airports.push([iata, icao, +lat.toFixed(3), +lon.toFixed(3), r[I.cc], r[I.name].slice(0, 48)]);
}

// ---- countries: [{ cc, name, polys: [ [ring, hole...], ... ] }] with rings as flat [lon,lat,lon,lat,...]
const FIX = { SOL: "SO", CYN: "CY" }; // Somaliland -> Somalia, Northern Cyprus -> Cyprus
const SKIP = new Set(["KAS"]); // Siachen Glacier (no ISO code)
const g = JSON.parse(fs.readFileSync(geoPath, "utf8"));
const round = v => Math.round(v * 100) / 100;
function ring(coords) {
  const flat = []; let px = null, py = null;
  for (const [x, y] of coords) {
    const rx = round(x), ry = round(y);
    if (rx === px && ry === py) continue;
    flat.push(rx, ry); px = rx; py = ry;
  }
  return flat.length >= 6 ? flat : null;
}
const byCc = new Map();
for (const f of g.features) {
  const p = f.properties;
  if (SKIP.has(p.ADM0_A3)) continue;
  let cc = FIX[p.ADM0_A3] || p.ISO_A2_EH;
  if (!/^[A-Z]{2}$/.test(cc || "")) cc = /^[A-Z]{2}$/.test(p.ISO_A2) ? p.ISO_A2 : null;
  if (!cc) { console.warn("skipping", p.NAME); continue; }
  const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
  const out = polys.map(pg => pg.map(ring).filter(Boolean)).filter(pg => pg.length);
  const cur = byCc.get(cc) || { cc, name: p.NAME, polys: [] };
  cur.polys.push(...out);
  byCc.set(cc, cur);
}
const countries = [...byCc.values()];

const outDir = path.join(__dirname, "..", "public", "data");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "airports.json"), JSON.stringify(airports));
fs.writeFileSync(path.join(outDir, "countries.json"), JSON.stringify(countries));
console.log(`airports: ${airports.length}, countries: ${countries.length}`);
