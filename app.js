/* The Usual — familiar chain restaurants near wherever you are. No build step, no keys. */
(() => {
  "use strict";

  const CELL = 2;                         // must match CELL in scripts/build_data.py
  const MAX_LIST = 150;
  const MI = 1609.344;
  const PHOTON = "https://photon.komoot.io/api/";
  const OVERPASS = "https://overpass-api.de/api/interpreter";
  const STYLE = {
    light: "https://tiles.openfreemap.org/styles/positron",
    dark: "https://tiles.openfreemap.org/styles/dark",
  };
  const US_CENTER = [-96.5, 38.5];

  const $ = (id) => document.getElementById(id);
  const store = {
    get(k, d) { try { const v = localStorage.getItem("usual:" + k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem("usual:" + k, JSON.stringify(v)); } catch { /* private mode */ } },
  };

  const state = {
    chains: [], tiers: {}, lookup: new Map(),
    index: null,                           // null => live OSM fallback mode
    cells: new Map(),                      // cell key -> Promise<rows>
    center: store.get("center", null),     // [lon, lat]
    placeLabel: store.get("placeLabel", ""),
    radius: [1, 2, 5, 10].includes(store.get("radius", 5)) ? store.get("radius", 5) : 5,
    tier: store.get("tier", null),         // null = all types; otherwise show only this one
    chainsOff: new Set(store.get("chainsOff", [])),
    favs: new Set(store.get("favs", [])),
    favsOnly: store.get("favsOnly", false),
    openNow: store.get("openNow", false),
    results: [],
    map: null, popup: null, reqId: 0,
  };

  // Same normalisation as build_data.py so aliases match identically.
  function norm(s) {
    return String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
      .replace(/&/g, " and ").replace(/\+/g, " and ")
      .replace(/['’`.]/g, "").replace(/[^a-z0-9]+/g, " ").trim().replace(/^the /, "");
  }
  const STOP = new Set("restaurant restaurants grill kitchen house pizza pizzeria italian italiana mexican american company family neighborhood international coastal tuscan gourmet steakhouse bistreaux brewhouse brewery diner cafe bakery black first golden grand silver shack pizza grille burgers brews sports brothers winery taproom cantina".split(" "));
  // A distinctive word per name ("Chili's Grill & Bar" -> "chili"); must match probe_word() in build_data.py.
  function probeWord(n) {
    const all = n.split(/[^A-Za-z0-9]+/).map((w) => w.toLowerCase()).filter((w) => w.length >= 2);
    const good = all.filter((w) => !STOP.has(w));
    const pool = good.length ? good : all;
    return pool.length ? pool.reduce((a, b) => (b.length > a.length ? b : a)) : n.replace(/[^A-Za-z0-9 ]/g, "").toLowerCase();
  }
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const tierColor = (t) => getComputedStyle(document.documentElement).getPropertyValue("--" + t).trim();

  function haversine(lat1, lon1, lat2, lon2) {
    const r = Math.PI / 180, a = Math.sin((lat2 - lat1) * r / 2) ** 2 +
      Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
    return 2 * 6371008.8 * Math.asin(Math.sqrt(a));
  }

  // ---------- data ----------
  async function loadConfig() {
    const cfg = await fetch("data/chains.json").then((r) => r.json());
    state.tiers = cfg.tiers;
    state.chains = cfg.chains;
    cfg.chains.forEach((c, i) => [c.name, ...(c.aliases || [])].forEach((n) => state.lookup.set(norm(n), i)));
    try {
      const r = await fetch("data/index.json", { cache: "no-cache" });
      if (r.ok) state.index = await r.json();
    } catch { /* fall back to live OSM */ }
    if (state.index) {
      $("dataDate").textContent = `(updated ${state.index.built.slice(0, 10)}, ${state.index.count.toLocaleString()} locations)`;
    } else {
      $("dataDate").textContent = "unavailable — using live OpenStreetMap data";
    }
  }

  function cellsFor(lat, lon, meters) {
    const dLat = meters / 111320, dLon = meters / (111320 * Math.cos(lat * Math.PI / 180));
    const have = new Set(state.index.cells), keys = [];
    for (let a = Math.floor((lat - dLat) / CELL) * CELL; a <= lat + dLat; a += CELL)
      for (let b = Math.floor((lon - dLon) / CELL) * CELL; b <= lon + dLon; b += CELL) {
        const k = `${a}_${b}`;
        if (have.has(k)) keys.push(k);
      }
    return keys;
  }

  function loadCell(key) {
    if (!state.cells.has(key)) {
      const p = fetch(`data/cells/${key}.json`).then((r) => r.ok ? r.json() : []).catch(() => { state.cells.delete(key); return []; });
      state.cells.set(key, p);
    }
    return state.cells.get(key);
  }

  async function rowsFromCells(lat, lon, meters) {
    const parts = await Promise.all(cellsFor(lat, lon, meters).map(loadCell));
    return parts.flat().map(([c, la, lo, street, city, st, zip, phone, hours]) => ({ c, lat: la, lon: lo, street, city, st, zip, phone, hours: hours || "" }));
  }

  // Fallback when data/ hasn't been built yet: query OpenStreetMap live.
  async function rowsFromOverpass(lat, lon, meters) {
    // Pre-filter server-side on a distinctive word from each chain name, then match exactly below.
    const words = new Set();
    state.chains.forEach((c) => [c.name, ...(c.aliases || [])].forEach((n) => {
      words.add(probeWord(n));
    }));
    const rx = [...words].join("|");
    const q = `[out:json][timeout:25];nwr["amenity"~"^(restaurant|fast_food|bar|pub)$"]["name"~"${rx}",i](around:${Math.round(meters)},${lat},${lon});out center tags;`;
    const res = await fetch(OVERPASS, { method: "POST", body: new URLSearchParams({ data: q }) });
    if (!res.ok) throw new Error("OpenStreetMap is busy right now. Try again in a minute.");
    const json = await res.json();
    const rows = [];
    for (const el of json.elements) {
      const t = el.tags || {};
      let c = state.lookup.get(norm(t.brand));
      if (c === undefined) c = state.lookup.get(norm(t.name));
      if (c === undefined) continue;
      rows.push({
        c, lat: el.lat ?? el.center?.lat, lon: el.lon ?? el.center?.lon,
        street: [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" "),
        city: t["addr:city"] || "", st: t["addr:state"] || "", zip: t["addr:postcode"] || "", phone: t.phone || "", hours: t.opening_hours || "",
      });
    }
    return rows;
  }

  // ---------- search ----------
  async function runSearch({ fit = true } = {}) {
    if (!state.center) return;
    const id = ++state.reqId;
    const [lon, lat] = state.center;
    const meters = state.radius * MI;
    $("summary").textContent = "Finding the familiar…";
    $("searchArea").hidden = true;
    let rows;
    try {
      rows = state.index ? await rowsFromCells(lat, lon, meters) : await rowsFromOverpass(lat, lon, meters);
    } catch (e) {
      if (id !== state.reqId) return;
      $("summary").textContent = e.message || "Search failed. Check your connection and try again.";
      return;
    }
    if (id !== state.reqId) return;
    state.results = rows
      .map((r) => ({ ...r, d: haversine(lat, lon, r.lat, r.lon) }))
      .filter((r) => r.d <= meters)
      .sort((a, b) => a.d - b.d);
    render(fit);
  }

  // ---------- opening hours ----------
  // Parses the common subset of OpenStreetMap opening_hours ("Mo-Th 11:00-22:00; Fr,Sa 11:00-23:00", "24/7").
  // Returns a week of [startMin, endMin] intervals (Mon = 0; endMin may pass 1440 for after-midnight closing),
  // or null when the string uses syntax we don't understand — those places count as "hours unknown".
  const DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
  const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const hoursCache = new Map();
  function parseHours(str) {
    if (hoursCache.has(str)) return hoursCache.get(str);
    let week = null;
    try {
      const s = str.trim().replace(/\s+/g, " ");
      if (!s) throw 0;
      if (s === "24/7") week = DAYS.map(() => [[0, 1440]]);
      else {
        week = DAYS.map(() => []);
        for (const rule of s.split(";").map((x) => x.trim()).filter(Boolean)) {
          if (/^(PH|SH)\b/.test(rule)) continue;   // public/school holiday rules: ignored
          const m = rule.match(/^((?:(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?,?\s?)+)?\s*(.*)$/);
          const daysPart = (m[1] || "").replace(/\s/g, "").replace(/,$/, "");
          const timesPart = m[2].trim();
          const days = new Set();
          if (!daysPart) DAYS.forEach((_, i) => days.add(i));
          else for (const tok of daysPart.split(",")) {
            const [a, b] = tok.split("-").map((d) => DAYS.indexOf(d));
            if (a < 0 || (b !== undefined && b < 0)) throw 0;
            for (let i = a; ; i = (i + 1) % 7) { days.add(i); if (b === undefined || i === b) break; }
          }
          let spans = [];
          if (/^(off|closed)$/i.test(timesPart)) spans = [];
          else if (timesPart === "24/7" || timesPart === "00:00-24:00") spans = [[0, 1440]];
          else for (const t of timesPart.split(",").map((x) => x.trim())) {
            const tm = t.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})\+?$/);
            if (!tm) throw 0;
            const a = +tm[1] * 60 + +tm[2]; let b = +tm[3] * 60 + +tm[4];
            if (b <= a) b += 1440;            // closes after midnight
            spans.push([a, b]);
          }
          days.forEach((d) => (week[d] = spans)); // later rules override earlier ones for their days
        }
      }
    } catch { week = null; }
    hoursCache.set(str, week);
    return week;
  }
  const clock = (min) => {
    const h = Math.floor(min / 60) % 24, m = min % 60, ap = h < 12 ? "AM" : "PM", h12 = h % 12 || 12;
    return m ? `${h12}:${String(m).padStart(2, "0")} ${ap}` : `${h12} ${ap}`;
  };
  // Uses this phone's clock, so it assumes you're searching in your current time zone.
  function hoursStatus(r, now = new Date()) {
    const week = r.hours ? parseHours(r.hours) : null;
    if (!week) return null;
    const day = (now.getDay() + 6) % 7, min = now.getHours() * 60 + now.getMinutes();
    const cur = [...week[day].map(([a, b]) => [a, b, a, b]), ...week[(day + 6) % 7].map(([a, b]) => [a - 1440, b - 1440, a, b])]
      .find(([a, b]) => min >= a && min < b);
    if (cur) {
      if (cur[1] - cur[0] >= 1440 && cur[2] === 0) return { open: true, text: "Open 24 hours" };
      return { open: true, soon: cur[1] - min <= 45, text: `${cur[1] - min <= 45 ? "Closes soon" : "Open"} · until ${clock(cur[1])}` };
    }
    for (let k = 0; k < 7; k++) {
      const d = (day + k) % 7;
      const next = week[d].map(([a]) => a).filter((a) => k > 0 || a > min).sort((x, y) => x - y)[0];
      if (next !== undefined) return { open: false, text: `Closed · opens ${k === 0 ? "" : k === 1 ? "tomorrow " : DAY_NAMES[d] + " "}${clock(next)}` };
    }
    return { open: false, text: "Closed" };
  }

  function passesFilters(r) {
    const ch = state.chains[r.c];
    if (!ch || (state.tier && ch.tier !== state.tier) || state.chainsOff.has(ch.id)) return false;
    return !(state.favsOnly && !state.favs.has(ch.id));
  }
  // The list: with "Open now" on, only places whose listed hours say they're open.
  function visible() {
    return state.results.filter((r) => passesFilters(r) && (!state.openNow || hoursStatus(r)?.open));
  }
  // With "Open now" on, places with no listed hours stay off the list but show as faded dots on the map.
  function unlisted() {
    return state.openNow ? state.results.filter((r) => passesFilters(r) && !hoursStatus(r)) : [];
  }

  function directions(r) {
    const apple = /iPhone|iPad|Macintosh/.test(navigator.userAgent) && "ontouchend" in document;
    return apple ? `https://maps.apple.com/?daddr=${r.lat},${r.lon}`
      : `https://www.google.com/maps/dir/?api=1&destination=${r.lat},${r.lon}`;
  }
  const googleLink = (r) =>
    `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${state.chains[r.c].name} ${r.street} ${r.city} ${r.st}`)}`;
  const addr = (r) => [r.street, [r.city, r.st].filter(Boolean).join(", ")].filter(Boolean).join(" · ");
  const miles = (d) => (d / MI < 10 ? (d / MI).toFixed(1) : Math.round(d / MI)) + " mi";

  function render(fit) {
    const rows = visible();
    const faded = unlisted();
    state.mapRows = rows.concat(faded);
    const list = $("list");
    const where = state.placeLabel ? ` of <strong>${esc(state.placeLabel)}</strong>` : "";
    const hidden = state.results.length - rows.length - faded.length;
    const notes = [];
    if (state.openNow) notes.push(`<span class="note">Hours may differ, especially on holidays. Check Google or call ahead to be sure.</span>` +
      (faded.length ? `<span class="note">${faded.length} more ${faded.length === 1 ? "place doesn't" : "places don't"} list hours. ${faded.length === 1 ? "It's" : "They're"} shown faded on the map.</span>` : ""));
    if (state.favsOnly) notes.push(state.favs.size
      ? `<span class="note">Favorites are saved only on this device and may clear after 7 days without a visit.</span>`
      : `<span class="note">No favorites yet. Tap the ☆ on any result, or in Chains, to save one.</span>`);
    $("summary").innerHTML = (rows.length
      ? `<strong>${rows.length}</strong> ${rows.length === 1 ? "place" : "places"} within ${state.radius} mi${where}` +
        (hidden ? ` · ${hidden} hidden by filters` : "")
      : "") + notes.join("");
    if (!rows.length) {
      list.innerHTML = `<li class="empty"><strong>Nothing familiar in range</strong>` +
        (hidden ? `${hidden} match but are hidden by your filters.` : `Try a wider distance or another spot.`) + `</li>`;
    } else {
      list.innerHTML = rows.slice(0, MAX_LIST).map((r, i) => {
        const ch = state.chains[r.c];
        const fav = state.favs.has(ch.id), hs = hoursStatus(r);
        return `<li class="item" data-i="${i}" style="--c:var(--${ch.tier})" tabindex="0">
          <h3><button type="button" class="star" data-fav="${ch.id}" aria-pressed="${fav}" aria-label="${fav ? "Remove" : "Add"} ${esc(ch.name)} ${fav ? "from" : "to"} favorites">${fav ? "★" : "☆"}</button>${esc(ch.name)}</h3><span class="dist">${miles(r.d)}</span>
          <span class="addr">${esc(addr(r)) || "Address unavailable"}</span>
          ${hs ? `<span class="hours ${hs.open ? (hs.soon ? "soon" : "open") : "closed"}">${esc(hs.text)}</span>` : ""}
          <span class="actions">
            <a href="${directions(r)}" target="_blank" rel="noopener">Directions</a>
            <a href="${googleLink(r)}" target="_blank" rel="noopener">Hours &amp; reviews</a>
            ${r.phone ? `<a href="tel:${esc(r.phone.replace(/[^\d+]/g, ""))}">Call</a>` : ""}
          </span></li>`;
      }).join("") + (rows.length > MAX_LIST ? `<li class="empty">Showing the closest ${MAX_LIST}. Narrow the distance to see the rest.</li>` : "");
    }
    drawMap(state.mapRows, rows.length, fit);
  }

  // ---------- map ----------
  function initMap() {
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    const map = new maplibregl.Map({
      container: "map",
      style: dark ? STYLE.dark : STYLE.light,
      center: state.center || US_CENTER,
      zoom: state.center ? 10 : 3.2,
      attributionControl: { compact: true },
    });
    state.map = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.on("load", () => {
      map.addSource("hits", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addSource("me", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: "radius", type: "line", source: "me", filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "line-color": tierColor("accent"), "line-width": 1.5, "line-dasharray": [2, 2], "line-opacity": 0.7 } });
      map.addLayer({ id: "hits", type: "circle", source: "hits", paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 3, 10, 6, 14, 9],
        "circle-color": ["match", ["get", "tier"], "casual", tierColor("casual"), "family", tierColor("family"), "novelty", tierColor("novelty"), tierColor("polished")],
        "circle-stroke-color": "#fff", "circle-stroke-width": 1.5,
        "circle-opacity": ["case", ["==", ["get", "faded"], 1], 0.35, 1],
        "circle-stroke-opacity": ["case", ["==", ["get", "faded"], 1], 0.5, 1] } });
      map.addLayer({ id: "labels", type: "symbol", source: "hits", minzoom: 11.5,
        layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Bold"], "text-size": 12,
          "text-offset": [0, 1.1], "text-anchor": "top", "text-optional": true },
        paint: { "text-color": dark ? "#eceef3" : "#1a1f2b", "text-halo-color": dark ? "#12151c" : "#ffffff", "text-halo-width": 1.4,
          "text-opacity": ["case", ["==", ["get", "faded"], 1], 0.5, 1] } });
      map.addLayer({ id: "me-dot", type: "circle", source: "me", filter: ["==", ["geometry-type"], "Point"],
        paint: { "circle-radius": 7, "circle-color": "#2f6fed", "circle-stroke-color": "#fff", "circle-stroke-width": 2.5 } });
      map.on("click", "hits", (e) => openPopup(+e.features[0].properties.i, false));
      map.on("mouseenter", "hits", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "hits", () => (map.getCanvas().style.cursor = ""));
      map.on("dragend", () => { if (state.center) $("searchArea").hidden = false; });
      if (state.center) runSearch();
    });
  }

  function circle(lon, lat, meters, steps = 72) {
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * 2 * Math.PI;
      pts.push([lon + (meters / (111320 * Math.cos(lat * Math.PI / 180))) * Math.cos(t), lat + (meters / 111320) * Math.sin(t)]);
    }
    return pts;
  }

  function drawMap(rows, listed, fit) {
    const map = state.map;
    if (!map || !map.getSource("hits")) return;
    const [lon, lat] = state.center;
    map.getSource("hits").setData({ type: "FeatureCollection", features: rows.map((r, i) => ({
      type: "Feature", geometry: { type: "Point", coordinates: [r.lon, r.lat] },
      properties: { i, faded: i >= listed ? 1 : 0, name: state.chains[r.c].name, tier: state.chains[r.c].tier } })) });
    map.getSource("me").setData({ type: "FeatureCollection", features: [
      { type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: {} },
      { type: "Feature", geometry: { type: "Polygon", coordinates: [circle(lon, lat, state.radius * MI)] }, properties: {} } ] });
    if (fit) {
      const dLat = (state.radius * MI) / 111320, dLon = dLat / Math.cos(lat * Math.PI / 180);
      map.fitBounds([[lon - dLon, lat - dLat], [lon + dLon, lat + dLat]], { padding: 24, duration: 600 });
    }
  }

  function openPopup(i, fly) {
    const r = (state.mapRows || [])[i];
    if (!r || !state.map) return;
    const ch = state.chains[r.c];
    const noHours = state.openNow && !hoursStatus(r);
    state.popup?.remove();
    state.popup = new maplibregl.Popup({ offset: 10, maxWidth: "260px" })
      .setLngLat([r.lon, r.lat])
      .setHTML(`<b>${esc(ch.name)}</b>${esc(addr(r))}<br>` +
        (noHours ? `<span class="pop-note">Hours not listed. <a href="${googleLink(r)}" target="_blank" rel="noopener">Check Google</a> before you go.</span><br>` : "") +
        `${miles(r.d)} away · <a href="${directions(r)}" target="_blank" rel="noopener">Directions</a>`)
      .addTo(state.map);
    if (fly) state.map.easeTo({ center: [r.lon, r.lat], zoom: Math.max(state.map.getZoom(), 13), duration: 500 });
    document.querySelectorAll(".item.active").forEach((el) => el.classList.remove("active"));
    const el = document.querySelector(`.item[data-i="${i}"]`);
    if (el) { el.classList.add("active"); if (!fly) el.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
  }

  // ---------- place search ----------
  function setCenter(lon, lat, label) {
    state.center = [lon, lat];
    state.placeLabel = label || "";
    store.set("center", state.center);
    store.set("placeLabel", state.placeLabel);
    runSearch();
  }

  let suggestTimer, suggestions = [], activeSuggest = -1;
  function photonLabel(p) {
    const pr = p.properties;
    if (pr._zip) return { top: pr._zip, sub: [pr.city, pr.state].filter(Boolean).join(", ") };
    const top = pr.name || [pr.housenumber, pr.street].filter(Boolean).join(" ") || pr.postcode;
    const sub = [pr.city && pr.city !== top ? pr.city : pr.county, pr.state, pr.postcode && pr.postcode !== top ? pr.postcode : ""].filter(Boolean).join(", ");
    return { top, sub };
  }
  // What kind of thing is being typed decides which results are worth suggesting.
  const queryKind = (q) => /^\d{3,5}$/.test(q) ? "zip" : /^\d+\s+\S/.test(q) ? "address" : "place";
  const PLACE_TYPES = new Set(["city", "locality", "district", "county", "state"]);
  function refine(q, feats) {
    const kind = queryKind(q), seen = new Set(), out = [];
    if (kind === "zip") {
      for (const f of feats) {
        const z = (f.properties.postcode || "").slice(0, 5);
        if (!z.startsWith(q) || seen.has(z)) continue;
        seen.add(z);
        out.push({ ...f, properties: { ...f.properties, _zip: z } });
      }
      return out.slice(0, 4);
    }
    for (const f of feats) {
      if (kind === "place" && !PLACE_TYPES.has(f.properties.type)) continue;
      const l = photonLabel(f), key = `${l.top}|${l.sub}`;
      if (seen.has(key)) continue;
      seen.add(key); out.push(f);
    }
    return out.slice(0, 6);
  }
  // ZIPs are looked up in our own files (data/zips/<first 3 digits>.json, built from GeoNames),
  // so typing a ZIP never suggests a random address.
  const zipFiles = new Map();
  function zipFile(prefix) {
    if (!zipFiles.has(prefix)) zipFiles.set(prefix, fetch(`data/zips/${prefix}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null));
    return zipFiles.get(prefix);
  }
  async function zipLookup(q) {
    const table = await zipFile(q.slice(0, 3));
    if (!table) return null;                       // files not built yet: fall back to the geocoder
    return Object.keys(table).filter((z) => z.startsWith(q)).sort().slice(0, 5).map((z) => {
      const [lat, lon, city, st] = table[z];
      return { geometry: { coordinates: [lon, lat] }, properties: { _zip: z, city, state: st } };
    });
  }
  async function geocode(q) {
    q = q.trim();
    if (queryKind(q) === "zip") {
      const hits = await zipLookup(q);
      if (hits) return { best: hits, all: hits };
    }
    const u = new URL(PHOTON);
    u.searchParams.set("q", queryKind(q) === "zip" ? `${q} USA` : q);
    u.searchParams.set("limit", "15");
    u.searchParams.set("lang", "en");
    u.searchParams.set("bbox", "-170,18,-66,72");
    if (state.center) { u.searchParams.set("lon", state.center[0]); u.searchParams.set("lat", state.center[1]); }
    const r = await fetch(u);
    if (!r.ok) throw new Error("Place search is unavailable right now.");
    const us = (await r.json()).features.filter((f) => !f.properties.countrycode || f.properties.countrycode === "US");
    return { best: refine(q, us), all: us };
  }
  function showSuggest(list) {
    suggestions = list; activeSuggest = -1;
    const ul = $("suggest");
    ul.innerHTML = list.map((f, i) => { const l = photonLabel(f);
      return `<li role="option" data-i="${i}">${esc(l.top)}<small>${esc(l.sub)}</small></li>`; }).join("");
    ul.hidden = !list.length;
  }
  function pick(i) {
    const f = suggestions[i]; if (!f) return;
    const l = photonLabel(f);
    $("place").value = l.sub ? `${l.top}, ${l.sub}` : l.top;
    $("suggest").hidden = true;
    const pr = f.properties;
    setCenter(f.geometry.coordinates[0], f.geometry.coordinates[1], pr._zip && pr.city ? `${pr.city} ${pr._zip}` : l.top);
  }

  // ---------- UI wiring ----------
  function buildControls() {
    const chips = $("tierChips");
    if (state.tier && !state.tiers[state.tier]) state.tier = null;
    chips.innerHTML = Object.entries(state.tiers).map(([k, label]) =>
      `<button type="button" class="chip" data-tier="${k}" style="--c:var(--${k})"><span class="dot"></span>${esc(label)}</button>`).join("");
    // Tap a type to show only that type; tap it again to go back to all types.
    const paintChips = () => {
      chips.classList.toggle("one", !!state.tier);
      chips.querySelectorAll(".chip").forEach((b) => b.setAttribute("aria-pressed", state.tier === b.dataset.tier));
    };
    paintChips();
    chips.addEventListener("click", (e) => {
      const b = e.target.closest(".chip"); if (!b) return;
      state.tier = state.tier === b.dataset.tier ? null : b.dataset.tier;
      store.set("tier", state.tier);
      paintChips();
      render(false);
    });

    $("radius").value = String(state.radius);
    $("radius").addEventListener("change", (e) => { state.radius = +e.target.value; store.set("radius", state.radius); runSearch(); });

    const groups = $("chainGroups");
    groups.innerHTML = Object.entries(state.tiers).map(([k, label]) => `<section style="--c:var(--${k})"><h4>${esc(label)}</h4>` +
      state.chains.filter((c) => c.tier === k).sort((a, b) => a.name.localeCompare(b.name)).map((c) =>
        `<div class="chain-row" data-n="${esc(norm(c.name))}"><label><input type="checkbox" value="${c.id}" ${state.chainsOff.has(c.id) ? "" : "checked"}>${esc(c.name)}</label>` +
        `<button type="button" class="star" data-fav="${c.id}" aria-pressed="${state.favs.has(c.id)}" aria-label="Favorite ${esc(c.name)}">${state.favs.has(c.id) ? "★" : "☆"}</button></div>`).join("") + `</section>`).join("");
    const sync = () => {
      store.set("chainsOff", [...state.chainsOff]);
      $("chainCount").textContent = state.chainsOff.size ? `${state.chains.length - state.chainsOff.size}/${state.chains.length}` : "";
      render(false);
    };
    groups.addEventListener("change", (e) => {
      const id = e.target.value; e.target.checked ? state.chainsOff.delete(id) : state.chainsOff.add(id); sync();
    });
    $("allOn").onclick = () => { state.chainsOff.clear(); groups.querySelectorAll("input").forEach((i) => (i.checked = true)); sync(); };
    $("allOff").onclick = () => { state.chains.forEach((c) => state.chainsOff.add(c.id)); groups.querySelectorAll("input").forEach((i) => (i.checked = false)); sync(); };
    $("chainFilter").addEventListener("input", (e) => {
      const q = norm(e.target.value);
      groups.querySelectorAll(".chain-row").forEach((l) => (l.hidden = q && !l.dataset.n.includes(q)));
    });
    $("chainsBtn").onclick = () => $("chainsDialog").showModal();

    const toggle = (id, key) => {
      const b = $(id);
      b.setAttribute("aria-pressed", state[key]);
      b.onclick = () => { state[key] = !state[key]; store.set(key, state[key]); b.setAttribute("aria-pressed", state[key]); render(false); };
    };
    toggle("favsBtn", "favsOnly");
    toggle("openBtn", "openNow");
    // One handler for every ☆ in the list and the Chains panel.
    document.addEventListener("click", (e) => {
      const b = e.target.closest(".star"); if (!b) return;
      e.stopPropagation();
      const id = b.dataset.fav;
      state.favs.has(id) ? state.favs.delete(id) : state.favs.add(id);
      store.set("favs", [...state.favs]);
      document.querySelectorAll(`.star[data-fav="${id}"]`).forEach((s) => {
        s.setAttribute("aria-pressed", state.favs.has(id)); s.textContent = state.favs.has(id) ? "★" : "☆";
      });
      render(false);
    }, true);
    $("chainsDialog").addEventListener("click", (e) => { if (e.target === $("chainsDialog")) $("chainsDialog").close(); });
    $("chainCount").textContent = state.chainsOff.size ? `${state.chains.length - state.chainsOff.size}/${state.chains.length}` : "";

    const input = $("place");
    if (state.placeLabel) input.value = state.placeLabel;
    input.addEventListener("input", () => {
      clearTimeout(suggestTimer);
      const q = input.value.trim();
      if (q.length < 3) return showSuggest([]);
      suggestTimer = setTimeout(() => geocode(q).then((r) => showSuggest(r.best)).catch(() => showSuggest([])), 300);
    });
    input.addEventListener("keydown", (e) => {
      const items = $("suggest").querySelectorAll("li");
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault(); if (!items.length) return;
        activeSuggest = (activeSuggest + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items.forEach((li, i) => li.setAttribute("aria-selected", i === activeSuggest));
      } else if (e.key === "Escape") $("suggest").hidden = true;
    });
    $("suggest").addEventListener("mousedown", (e) => { const li = e.target.closest("li"); if (li) { e.preventDefault(); pick(+li.dataset.i); } });
    $("searchForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (activeSuggest >= 0) return pick(activeSuggest);
      const q = input.value.trim(); if (!q) return;
      try {
        const { best, all } = await geocode(q);
        const list = best.length ? best : all;   // Enter still works if the only match is an address
        if (list.length) { suggestions = list; pick(0); } else $("summary").textContent = `Couldn't find "${q}". Try a city and state, or a ZIP.`;
      }
      catch (err) { $("summary").textContent = err.message; }
    });
    document.addEventListener("click", (e) => { if (!e.target.closest(".search")) $("suggest").hidden = true; });

    $("locate").onclick = () => {
      if (!navigator.geolocation) { $("summary").textContent = "This browser can't share your location. Type a place instead."; return; }
      $("locate").setAttribute("aria-busy", "true");
      navigator.geolocation.getCurrentPosition(
        (p) => { $("locate").removeAttribute("aria-busy"); input.value = ""; setCenter(p.coords.longitude, p.coords.latitude, "you"); },
        () => { $("locate").removeAttribute("aria-busy"); $("summary").textContent = "Location is blocked. Allow it in your browser settings, or type a place."; },
        { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
    };

    $("list").addEventListener("click", (e) => {
      if (e.target.closest("a, .star")) return;
      const li = e.target.closest(".item"); if (li) openPopup(+li.dataset.i, true);
    });
    $("list").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches(".item")) openPopup(+e.target.dataset.i, true); });
    $("searchArea").onclick = () => { const c = state.map.getCenter(); setCenter(c.lng, c.lat, "map center"); };
  }

  async function start() {
    try { await loadConfig(); } catch { $("summary").textContent = "Couldn't load the chain list. Refresh to try again."; return; }
    buildControls();
    if (window.maplibregl) initMap(); else if (state.center) runSearch();
    if (!state.center) $("summary").textContent = "Somewhere familiar is close by. Search a city, address, or ZIP — or tap the location button.";
  }
  start();
})();
