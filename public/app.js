const HOME = { center: [49.95, 14.55], zoom: 9 };
const map = L.map("map", { preferCanvas: true, zoomControl: false, updateWhenZooming: false }).setView(HOME.center, HOME.zoom);
L.control.zoom({ position: "bottomright" }).addTo(map);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

const markers = new Map();
let allVehicles = [];
let loading = false;
let lastSuccessfulLoad = 0;

const $ = id => document.getElementById(id);
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"
  })[c]);
}
function routeNumber(route) {
  const m = String(route || "").match(/\d+/);
  return m ? Number(m[0]) : null;
}
function matchesFilter(v) {
  const f = $("filter").value;
  if (f === "all") return true;
  const n = routeNumber(v.routeName || v.route);
  if (n == null) return false;
  if (f === "100-299") return n >= 100 && n <= 299;
  if (f === "300-899") return n >= 300 && n <= 899;
  if (f === "900-999") return n >= 900 && n <= 999;
  return true;
}
function matchesSearch(v) {
  const q = $("search").value.trim().toLowerCase();
  if (!q) return true;
  return [v.routeName, v.route, v.label, v.id, v.tripId].some(x =>
    String(x || "").toLowerCase().includes(q)
  );
}
function delayClass(v) {
  if (v.delaySeconds == null || !Number.isFinite(Number(v.delaySeconds))) return "unknown";
  const minutes = Math.max(0, Math.round(Number(v.delaySeconds) / 60));
  if (minutes <= 1) return "green";
  if (minutes <= 5) return "yellow";
  return "red";
}
function delayLabel(v) {
  if (v.delaySeconds == null || !Number.isFinite(Number(v.delaySeconds))) return "Nedostupné";
  const seconds = Number(v.delaySeconds);
  if (seconds < -30) return `Předčasně ${Math.round(Math.abs(seconds) / 60)} min`;
  const minutes = Math.max(0, Math.round(seconds / 60));
  return minutes === 0 ? "0 min" : `${minutes} min`;
}
function iconFor(v) {
  const stale = v.stale ? " stale" : "";
  const text = escapeHtml(v.routeName || "?");
  const bearing = Number(v.bearing) || 0;
  const color = delayClass(v);
  return L.divIcon({
    className: "vehicle-marker-shell",
    html: `<div class="vehicle-icon${stale}" title="Linka ${text}"><span class="vehicle-dot ${color}"><span class="vehicle-arrow" style="transform:rotate(${bearing - 90}deg)">➤</span></span><span class="vehicle-label">${text}</span></div>`,
    iconSize: [42, 42],
    iconAnchor: [21, 21]
  });
}
function ageLabel(seconds) {
  if (seconds < 60) return `${seconds} s`;
  return `${Math.round(seconds / 60)} min`;
}
function popup(v) {
  const speed = Math.round((Number(v.speed) || 0) * 3.6);
  return `<div class="popup-card">
    <div class="popup-title">Linka ${escapeHtml(v.routeName || v.route || "?")}</div>
    <div class="popup-row"><span>Vozidlo</span><b>${escapeHtml(v.label || v.id || "—")}</b></div>
    <div class="popup-row"><span>Zpoždění</span><b class="delay-value ${delayClass(v)}">${escapeHtml(delayLabel(v))}</b></div>
    <div class="popup-row"><span>Počáteční zastávka</span><b>${escapeHtml(v.firstStop || "Nedostupná")}</b></div>
    <div class="popup-row"><span>Konečná zastávka</span><b>${escapeHtml(v.lastStop || "Nedostupná")}</b></div>
    <div class="popup-row"><span>Rychlost</span><b>${speed} km/h</b></div>
    <div class="popup-row"><span>Poslední data</span><b>před ${ageLabel(v.ageSeconds || 0)}</b></div>
    ${v.stale ? '<div class="popup-note">Poloha může být zastaralá.</div>' : '<div class="popup-note good">Poloha je aktuální.</div>'}
  </div>`;
}
function render() {
  const visible = allVehicles.filter(v => matchesFilter(v) && matchesSearch(v));
  const visibleIds = new Set(visible.map(v => v.id));
  for (const [id, marker] of markers) {
    if (!visibleIds.has(id)) {
      map.removeLayer(marker);
      markers.delete(id);
    }
  }
  for (const v of visible) {
    if (!Number.isFinite(Number(v.lat)) || !Number.isFinite(Number(v.lon))) continue;
    let marker = markers.get(v.id);
    if (!marker) {
      marker = L.marker([v.lat, v.lon], { icon: iconFor(v), keyboard: true, title: `Linka ${v.routeName || "?"}` }).addTo(map);
      markers.set(v.id, marker);
    } else {
      const old = marker.getLatLng();
      if (old.lat !== v.lat || old.lng !== v.lon) marker.setLatLng([v.lat, v.lon]);
      marker.setIcon(iconFor(v));
    }
    marker.bindPopup(popup(v), { closeButton: true, maxWidth: 260 });
  }
  $("count").textContent = visible.length.toLocaleString("cs-CZ");
  $("fresh").textContent = visible.filter(v => !v.stale).length.toLocaleString("cs-CZ");
  $("liveBadge").classList.toggle("offline", Date.now() - lastSuccessfulLoad > 60000);
}
function setStatus(message, state = "ok") {
  $("status").textContent = message;
  $("statusDot").className = `status-dot ${state}`;
}
function toast(message) {
  $("toast").textContent = message;
  $("toast").classList.add("show");
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => $("toast").classList.remove("show"), 2800);
}
async function load(manual = false) {
  if (loading) return;
  loading = true;
  $("refresh").classList.add("spinning");
  try {
    const r = await fetch("/api/vehicles", { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    allVehicles = Array.isArray(data.vehicles) ? data.vehicles : [];
    lastSuccessfulLoad = Date.now();
    setStatus(`Aktualizováno ${new Date().toLocaleTimeString("cs-CZ", {hour:"2-digit",minute:"2-digit",second:"2-digit"})}`, "ok");
    render();
    if (manual) toast("Data byla obnovena.");
  } catch (e) {
    setStatus("Data se nepodařilo načíst", "error");
    if (manual) toast("Obnova se nezdařila. Zkus to za chvíli.");
  } finally {
    loading = false;
    $("refresh").classList.remove("spinning");
  }
}
$("search").addEventListener("input", render);
$("clearSearch").addEventListener("click", () => { $("search").value = ""; render(); $("search").focus(); });
$("filter").addEventListener("change", render);
$("refresh").addEventListener("click", () => load(true));
$("locate").addEventListener("click", () => {
  if (!navigator.geolocation) return toast("Tento prohlížeč nepodporuje polohu.");
  setStatus("Zjišťuji tvoji polohu…", "loading");
  map.locate({ setView: true, maxZoom: 15, timeout: 10000 });
});
map.on("locationfound", e => {
  L.circleMarker(e.latlng, { radius: 8, color: "#fff", weight: 3, fillColor: "#2677ff", fillOpacity: 1 }).addTo(map)
    .bindPopup("Tvoje poloha").openPopup();
  setStatus("Poloha byla nalezena", "ok");
});
map.on("locationerror", () => { setStatus("Poloha není dostupná", "error"); toast("Povol přístup k poloze v prohlížeči."); });
$("zoomHome").addEventListener("click", () => map.setView(HOME.center, HOME.zoom));
load();
setInterval(() => load(false), 10000);
