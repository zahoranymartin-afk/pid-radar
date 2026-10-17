const express = require("express");
const GtfsRealtimeBindings = require("gtfs-realtime-bindings");
const zlib = require("node:zlib");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const VEHICLE_FEED_URL = process.env.VEHICLE_POSITIONS_URL || "https://api.golemio.cz/v2/vehiclepositions/gtfsrt/vehicle_positions.pb";
const TRIP_UPDATES_URL = process.env.TRIP_UPDATES_URL || "https://api.golemio.cz/v2/vehiclepositions/gtfsrt/trip_updates.pb";
const STATIC_GTFS_URL = process.env.STATIC_GTFS_URL || "https://data.pid.cz/PID_GTFS.zip";
const KEEP_MS = 10 * 60 * 1000;
const POLL_MS = 20000;
const STATIC_REFRESH_MS = 12 * 60 * 60 * 1000;

const vehicles = new Map();
let tripDelays = new Map();
let stopNames = new Map();
let tripStops = new Map();
let staticGtfsLoadedAt = 0;

app.use(express.static("public"));
function text(v) { return v == null ? "" : String(v); }

function parseCsvLine(line) {
  const out = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === "," && !quoted) {
      out.push(value); value = "";
    } else value += ch;
  }
  out.push(value);
  return out;
}

function extractZipFiles(buffer, wanted) {
  const files = new Map();
  let eocd = -1;
  const lowerBound = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= lowerBound; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("GTFS ZIP nemá platnou hlavičku.");
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let n = 0; n < entryCount; n++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength).split("/").pop();
    if (wanted.has(name) && compressedSize !== 0xffffffff && uncompressedSize !== 0xffffffff) {
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = buffer.subarray(start, start + compressedSize);
      let data;
      if (method === 0) data = compressed;
      else if (method === 8) data = zlib.inflateRawSync(compressed);
      else throw new Error(`Nepodporovaný ZIP formát ${method} v ${name}`);
      files.set(name, data.toString("utf8"));
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

async function loadStaticGtfs() {
  try {
    console.log("[PID] Načítám jízdní řády a názvy zastávek…");
    const response = await fetch(STATIC_GTFS_URL, { signal: AbortSignal.timeout(60000), headers: { "User-Agent": "PID-Radar/1.1" } });
    if (!response.ok) throw new Error(`GTFS HTTP ${response.status}`);
    const archive = Buffer.from(await response.arrayBuffer());
    const files = extractZipFiles(archive, new Set(["stops.txt", "stop_times.txt"]));
    if (!files.has("stops.txt") || !files.has("stop_times.txt")) throw new Error("V GTFS archivu chybí stops.txt nebo stop_times.txt.");

    const nextStopNames = new Map();
    const stopLines = files.get("stops.txt").split(/\r?\n/);
    const stopHeader = parseCsvLine(stopLines.shift() || "");
    const stopIdIndex = stopHeader.indexOf("stop_id");
    const stopNameIndex = stopHeader.indexOf("stop_name");
    for (const line of stopLines) {
      if (!line) continue;
      const row = parseCsvLine(line);
      if (row[stopIdIndex]) nextStopNames.set(row[stopIdIndex], row[stopNameIndex] || row[stopIdIndex]);
    }

    const nextTripStops = new Map();
    const timeLines = files.get("stop_times.txt").split(/\r?\n/);
    const timeHeader = parseCsvLine(timeLines.shift() || "");
    const tripIndex = timeHeader.indexOf("trip_id");
    const stopIndex = timeHeader.indexOf("stop_id");
    const sequenceIndex = timeHeader.indexOf("stop_sequence");
    for (const line of timeLines) {
      if (!line) continue;
      const row = parseCsvLine(line);
      const tripId = row[tripIndex];
      const stopId = row[stopIndex];
      const sequence = Number(row[sequenceIndex]);
      if (!tripId || !stopId || !Number.isFinite(sequence)) continue;
      const item = nextTripStops.get(tripId);
      if (!item) nextTripStops.set(tripId, { firstStopId: stopId, firstSeq: sequence, lastStopId: stopId, lastSeq: sequence });
      else {
        if (sequence < item.firstSeq) { item.firstSeq = sequence; item.firstStopId = stopId; }
        if (sequence > item.lastSeq) { item.lastSeq = sequence; item.lastStopId = stopId; }
      }
    }
    stopNames = nextStopNames;
    tripStops = nextTripStops;
    staticGtfsLoadedAt = Date.now();
    console.log(`[PID] GTFS načteno: ${stopNames.size} zastávek, ${tripStops.size} spojů`);
  } catch (err) {
    console.error("[PID] Jízdní řády se nepodařilo načíst:", err.message);
  }
}

function cleanVehicle(entity) {
  const v = entity.vehicle;
  if (!v || !v.position) return null;
  const lat = Number(v.position.latitude);
  const lon = Number(v.position.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const trip = v.trip || {};
  const vehicle = v.vehicle || {};
  return {
    id: text(entity.id || vehicle.id),
    label: text(vehicle.label || vehicle.id),
    route: text(trip.routeId || ""),
    routeName: text(trip.routeShortName || trip.routeId || ""),
    tripId: text(trip.tripId || ""),
    lat, lon,
    bearing: Number(v.position.bearing || 0),
    speed: Number(v.position.speed || 0),
    timestamp: Number(v.timestamp || Math.floor(Date.now() / 1000)) * 1000,
    lastSeen: Date.now()
  };
}

async function updateVehicles() {
  try {
    const response = await fetch(VEHICLE_FEED_URL, { headers: { "User-Agent": "PID-Radar/1.1" }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(Buffer.from(await response.arrayBuffer()));
    for (const entity of feed.entity || []) {
      const item = cleanVehicle(entity);
      if (item && item.id) vehicles.set(item.id, item);
    }
    const now = Date.now();
    for (const [id, item] of vehicles) if (now - item.lastSeen > KEEP_MS) vehicles.delete(id);
    console.log(`[PID] ${vehicles.size} vozidel v paměti`);
  } catch (err) {
    console.error("[PID] Chyba při načítání poloh:", err.message);
  }
}

async function updateTripDelays() {
  try {
    const response = await fetch(TRIP_UPDATES_URL, { headers: { "User-Agent": "PID-Radar/1.1" }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(Buffer.from(await response.arrayBuffer()));
    const next = new Map();
    for (const entity of feed.entity || []) {
      const update = entity.tripUpdate;
      const tripId = text(update?.trip?.tripId);
      if (!tripId) continue;
      let delay = Number.isFinite(Number(update.delay)) ? Number(update.delay) : null;
      if (delay == null) {
        for (const stopUpdate of update.stopTimeUpdate || []) {
          const candidate = stopUpdate.departure?.delay ?? stopUpdate.arrival?.delay;
          if (candidate != null && Number.isFinite(Number(candidate))) { delay = Number(candidate); break; }
        }
      }
      if (delay != null) next.set(tripId, { delaySeconds: delay, updatedAt: Date.now() });
    }
    tripDelays = next;
    console.log(`[PID] Zpoždění načteno pro ${tripDelays.size} spojů`);
  } catch (err) {
    console.error("[PID] Zpoždění se nepodařilo načíst:", err.message);
  }
}

app.get("/api/vehicles", (req, res) => {
  const now = Date.now();
  const result = [...vehicles.values()].map(v => {
    const delay = tripDelays.get(v.tripId);
    const stops = tripStops.get(v.tripId);
    return {
      ...v,
      ageSeconds: Math.max(0, Math.round((now - v.lastSeen) / 1000)),
      stale: now - v.lastSeen > 60 * 1000,
      delaySeconds: delay && now - delay.updatedAt < 2 * 60 * 1000 ? delay.delaySeconds : null,
      firstStop: stops ? (stopNames.get(stops.firstStopId) || stops.firstStopId) : null,
      lastStop: stops ? (stopNames.get(stops.lastStopId) || stops.lastStopId) : null
    };
  });
  res.json({ updatedAt: new Date().toISOString(), count: result.length, vehicles: result, timetableLoaded: Boolean(staticGtfsLoadedAt) });
});
app.get("/api/health", (req, res) => res.json({ ok: true, vehicles: vehicles.size, delayTrips: tripDelays.size, timetableLoaded: Boolean(staticGtfsLoadedAt) }));

updateVehicles();
updateTripDelays();
loadStaticGtfs();
setInterval(updateVehicles, POLL_MS);
setInterval(updateTripDelays, POLL_MS);
setInterval(() => { if (!staticGtfsLoadedAt || Date.now() - staticGtfsLoadedAt > STATIC_REFRESH_MS) loadStaticGtfs(); }, 60 * 60 * 1000);
app.listen(PORT, "0.0.0.0", () => console.log(`PID Radar běží na portu ${PORT}`));
