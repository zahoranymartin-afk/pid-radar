const express = require("express");
const GtfsRealtimeBindings = require("gtfs-realtime-bindings");

const app = express();
const PORT = 3000;
const FEED_URL = "https://api.golemio.cz/v2/vehiclepositions/gtfsrt/vehicle_positions.pb";
const KEEP_MS = 10 * 60 * 1000;
const POLL_MS = 20000;

const vehicles = new Map();

app.use(express.static("public"));

function text(v) {
  return v == null ? "" : String(v);
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
    lat,
    lon,
    bearing: Number(v.position.bearing || 0),
    speed: Number(v.position.speed || 0),
    timestamp: Number(v.timestamp || Math.floor(Date.now() / 1000)) * 1000,
    lastSeen: Date.now()
  };
}

async function updateVehicles() {
  try {
    const response = await fetch(FEED_URL, {
      headers: { "User-Agent": "PID-Mapa-Free/1.0" }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer);

    for (const entity of feed.entity || []) {
      const item = cleanVehicle(entity);
      if (item && item.id) vehicles.set(item.id, item);
    }

    const now = Date.now();
    for (const [id, item] of vehicles) {
      if (now - item.lastSeen > KEEP_MS) vehicles.delete(id);
    }

    console.log(`[PID] ${vehicles.size} vozidel v pameti`);
  } catch (err) {
    console.error("[PID] Chyba pri nacitani dat:", err.message);
  }
}

app.get("/api/vehicles", (req, res) => {
  const now = Date.now();
  const result = [...vehicles.values()].map(v => ({
    ...v,
    ageSeconds: Math.max(0, Math.round((now - v.lastSeen) / 1000)),
    stale: now - v.lastSeen > 60 * 1000
  }));
  res.json({
    updatedAt: new Date().toISOString(),
    count: result.length,
    vehicles: result
  });
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, vehicles: vehicles.size });
});

updateVehicles();
setInterval(updateVehicles, POLL_MS);

app.listen(PORT, () => {
  console.log(`PID mapa bezi na http://localhost:${PORT}`);
});