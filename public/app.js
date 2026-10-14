const map = L.map("map", { preferCanvas: true }).setView([50.0755,14.4378], 9);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

const markers = new Map();
let allVehicles = [];

function routeNumber(route) {
  const m = String(route || "").match(/\d+/);
  return m ? Number(m[0]) : null;
}

function matchesFilter(v) {
  const f = document.getElementById("filter").value;
  if (f === "all") return true;
  const n = routeNumber(v.routeName || v.route);
  if (n == null) return false;
  if (f === "100-299") return n >= 100 && n <= 299;
  if (f === "300-899") return n >= 300 && n <= 899;
  if (f === "900-999") return n >= 900 && n <= 999;
  return true;
}

function matchesSearch(v) {
  const q = document.getElementById("search").value.trim().toLowerCase();
  if (!q) return true;
  return [v.routeName, v.route, v.label, v.id, v.tripId].some(x =>
    String(x || "").toLowerCase().includes(q)
  );
}

function iconFor(v) {
  const stale = v.stale ? " stale" : "";
  const text = v.routeName || "?";
  return L.divIcon({
    className: "",
    html: `<div class="vehicle-icon${stale}" style="transform:rotate(${Number(v.bearing)||0}deg)"><span style="transform:rotate(${-Number(v.bearing)||0}deg)">${text}</span></div>`,
    iconSize: [34,34],
    iconAnchor: [17,17]
  });
}

function popup(v) {
  const age = v.ageSeconds < 60 ? `${v.ageSeconds} s` : `${Math.round(v.ageSeconds/60)} min`;
  return `<div class="popup-title">Linka ${v.routeName || "?"}</div>
    <div class="popup-row"><b>Vozidlo:</b> ${v.label || v.id || "—"}</div>
    <div class="popup-row"><b>Trip:</b> ${v.tripId || "—"}</div>
    <div class="popup-row"><b>Rychlost:</b> ${Math.round((v.speed||0)*3.6)} km/h</div>
    <div class="popup-row"><b>Směr:</b> ${Math.round(v.bearing||0)}°</div>
    <div class="popup-row"><b>Poslední data:</b> před ${age}</div>`;
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
    let marker = markers.get(v.id);
    if (!marker) {
      marker = L.marker([v.lat,v.lon], { icon: iconFor(v) }).addTo(map);
      markers.set(v.id, marker);
    } else {
      marker.setLatLng([v.lat,v.lon]);
      marker.setIcon(iconFor(v));
    }
    marker.bindPopup(popup(v));
  }

  document.getElementById("count").textContent = visible.length;
  document.getElementById("fresh").textContent = visible.filter(v => !v.stale).length;
}

async function load() {
  try {
    const r = await fetch("/api/vehicles", { cache: "no-store" });
    const data = await r.json();
    allVehicles = data.vehicles || [];
    document.getElementById("status").textContent =
      `Poslední načtení: ${new Date().toLocaleTimeString("cs-CZ")} · ${data.count} vozidel`;
    render();
  } catch (e) {
    document.getElementById("status").textContent = "Nepodařilo se načíst data.";
  }
}

document.getElementById("search").addEventListener("input", render);
document.getElementById("filter").addEventListener("change", render);
document.getElementById("locate").addEventListener("click", () => {
  map.locate({ setView:true, maxZoom:15 });
});

load();
setInterval(load, 5000);