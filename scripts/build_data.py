#!/usr/bin/env python3
"""
Build The Usual's location data from All The Places (CC-0).

  python3 scripts/build_data.py                 # download latest run, build data/cells/
  python3 scripts/build_data.py --zip output.zip   # use an already-downloaded output.zip

Stdlib only. Reads data/chains.json (the whitelist) and writes:
  data/cells/<lat>_<lon>.json  locations bucketed into CELL-degree grid cells
  data/index.json              which cells exist + build metadata
  data/report.json             per-chain counts (chains with 0 hits need an alias)
"""
import argparse, gzip, io, json, math, os, re, sys, time, unicodedata, urllib.parse, urllib.request, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
MIN_ROWS = int(os.environ.get("MIN_ROWS", "1000"))  # safety check
CELL = 2  # degrees; must match CELL in app.js
LATEST = "https://data.alltheplaces.xyz/runs/latest.json"
# Some data hosts reject Python's default user agent (HTTP 403), so identify the script properly.
HEADERS = {"User-Agent": "the-usual-data-builder/1.0 (+https://github.com; weekly chain-restaurant refresh)",
           "Accept": "*/*"}
COUNTRIES = {"US"}  # add "CA" to include Canada
US_BOXES = [(24.3, -125.0, 49.5, -66.8), (51.0, -180.0, 71.5, -129.0), (18.8, -160.5, 22.4, -154.7)]  # lower48, AK, HI


def norm(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    s = s.replace("&", " and ").replace("+", " and ")
    s = re.sub(r"['’`.]", "", s)
    s = re.sub(r"[^a-z0-9]+", " ", s).strip()
    s = re.sub(r"^the ", "", s)
    return s


STOP = set("restaurant restaurants grill kitchen house pizza pizzeria italian italiana mexican american company family neighborhood international coastal tuscan gourmet steakhouse bistreaux brewhouse brewery diner cafe bakery black first golden grand silver shack pizza grille burgers brews sports brothers winery taproom cantina".split())


def probe_word(n):
    """A distinctive raw-text word per name ("Chili's Grill & Bar" -> "chili"); mirrors probeWord() in app.js."""
    allw = [w.lower() for w in re.split(r"[^A-Za-z0-9]+", n) if len(w) >= 2]
    pool = [w for w in allw if w not in STOP] or allw
    return max(pool, key=len) if pool else re.sub(r"[^A-Za-z0-9 ]", "", n).lower()


def load_chains():
    cfg = json.load(open(os.path.join(DATA, "chains.json"), encoding="utf-8"))
    lookup, keywords = {}, set()
    for i, c in enumerate(cfg["chains"]):
        for n in [c["name"], *c.get("aliases", [])]:
            lookup[norm(n)] = i
            keywords.add(probe_word(n))
    return cfg, lookup, [k.encode() for k in keywords]


def in_country(p, lat, lon):
    cc = (p.get("addr:country") or "").upper()
    if cc:
        return cc in COUNTRIES
    return "US" in COUNTRIES and any(a <= lat <= c and b <= lon <= d for a, b, c, d in US_BOXES)


def iter_features(raw):
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    head = raw[:200].lstrip()
    if b'"FeatureCollection"' in head:
        try:
            yield from json.loads(raw).get("features", [])
            return
        except ValueError:
            pass  # damaged or truncated file: fall back to reading it one feature per line
    for line in raw.splitlines():
        line = line.strip().rstrip(b",")
        if line.startswith(b"{") and b'"Feature"' in line:
            try:
                f = json.loads(line)
            except ValueError:
                continue
            if isinstance(f, dict) and f.get("type") == "Feature":
                yield f


def fetch(url, tries=4):
    """urlopen with a real User-Agent and a few retries."""
    for i in range(tries):
        try:
            return urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=120)
        except Exception as e:  # noqa: BLE001
            if i == tries - 1:
                raise
            print(f"  retrying {url} after error: {e}", flush=True)
            time.sleep(10 * (i + 1))


def download(url, dest):
    print(f"downloading {url}", flush=True)
    with fetch(url) as r, open(dest, "wb") as f:
        total, got, t0 = int(r.headers.get("Content-Length") or 0), 0, time.time()
        while chunk := r.read(1 << 20):
            f.write(chunk); got += len(chunk)
            if got % (100 << 20) < (1 << 20):
                print(f"  {got >> 20} / {total >> 20} MB ({time.time() - t0:.0f}s)", flush=True)


def norm_title(s):
    """Wikidata titles often carry a qualifier: 'Twin Peaks (restaurant chain)' -> 'twin peaks'."""
    return norm(re.sub(r"\s*\(.*?\)", "", s or ""))


def brand_codes(cfg, insights_url):
    """Map Wikidata brand codes to whitelist chains using the run's insights file.

    Spiders often store a short brand ("BJ's") and drop the name, so the Wikidata
    code is the reliable key. Also honours an optional "wikidata" list per chain.
    """
    code_map = {}
    for i, c in enumerate(cfg["chains"]):
        for q in c.get("wikidata", []):
            code_map[q] = i
    if not insights_url:
        return code_map, []
    try:
        with fetch(insights_url) as r:
            data = json.load(r).get("data", [])
    except Exception as e:  # noqa: BLE001
        print(f"  insights unavailable ({e}); matching by name only", flush=True)
        return code_map, []
    names = {}
    for i, c in enumerate(cfg["chains"]):
        for n in [c["name"], *c.get("aliases", [])]:
            names[norm(n)] = i
    for e in data:
        code = e.get("code")
        if not code or code in code_map:
            continue
        for label in (e.get("atp_brand"), e.get("nsi_brand"), e.get("q_title")):
            i = names.get(norm_title(label)) if label else None
            if i is not None:
                code_map[code] = i
                break
    print(f"  {len(code_map)} Wikidata brand codes matched to {len(set(code_map.values()))} chains", flush=True)
    return code_map, data


OVERPASS = "https://overpass-api.de/api/interpreter"


def osm_rows(codes_by_chain):
    """Fill chains that All The Places doesn't cover from OpenStreetMap (ODbL)."""
    codes = sorted({q for qs in codes_by_chain.values() for q in qs})
    if not codes:
        return []
    code_to_chain = {q: i for i, qs in codes_by_chain.items() for q in qs}
    out = []
    for start in range(0, len(codes), 15):
        chunk = codes[start:start + 15]
        q = (f'[out:json][timeout:600];area["ISO3166-1"="US"][admin_level=2]->.us;'
             f'nwr["brand:wikidata"~"^({"|".join(chunk)})$"](area.us);out center tags;')
        try:
            req = urllib.request.Request(OVERPASS, data=urllib.parse.urlencode({"data": q}).encode(), headers=HEADERS)
            with urllib.request.urlopen(req, timeout=700) as r:
                els = json.load(r).get("elements", [])
        except Exception as e:  # noqa: BLE001
            print(f"  OpenStreetMap lookup failed for {chunk}: {e}", flush=True)
            continue
        for el in els:
            t = el.get("tags", {})
            i = code_to_chain.get(t.get("brand:wikidata"))
            lat, lon = el.get("lat", el.get("center", {}).get("lat")), el.get("lon", el.get("center", {}).get("lon"))
            if i is None or lat is None or t.get("disused:amenity") or t.get("end_date"):
                continue
            out.append([i, round(lat, 5), round(lon, 5),
                        " ".join(x for x in [t.get("addr:housenumber"), t.get("addr:street")] if x),
                        t.get("addr:city", ""), t.get("addr:state", "")[:2].upper(), t.get("addr:postcode", "")[:5],
                        t.get("phone") or t.get("contact:phone") or "", t.get("opening_hours", "")])
        print(f"  OpenStreetMap: {len(els)} places for {len(chunk)} brand codes", flush=True)
        time.sleep(5)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip", help="path to an already-downloaded ATP output.zip")
    args = ap.parse_args()

    cfg, lookup, keywords = load_chains()
    run = {"run_id": "local"}
    zpath = args.zip
    if not zpath:
        override = os.environ.get("ATP_OUTPUT_URL", "").strip()
        if override:
            run = {"run_id": override.rstrip("/").split("/")[-2], "output_url": override,
                   "insights_url": override.rsplit("/", 1)[0] + "/stats/_insights.json"}
        else:
            with fetch(LATEST) as r:
                run = json.load(r)
        print(f"All The Places run {run['run_id']}", flush=True)
        zpath = os.path.join(ROOT, "atp-output.zip")
        download(run["output_url"], zpath)

    code_map, _ = brand_codes(cfg, run.get("insights_url"))
    keywords = list(keywords) + [f'"{q.lower()}"'.encode() for q in code_map]

    rows, counts, spiders = [], [0] * len(cfg["chains"]), {}
    with zipfile.ZipFile(zpath) as z:
        names = [n for n in z.namelist() if not n.endswith("/")]
        for k, name in enumerate(names):
            raw = z.read(name)
            probe = (gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw).lower()
            if not any(kw in probe for kw in keywords):
                continue
            try:
                feats = list(iter_features(raw))
            except Exception as e:  # noqa: BLE001 — one bad file should never sink the weekly build
                print(f"  skipped {name}: {e}", flush=True)
                continue
            for f in feats:
                p, g = f.get("properties") or {}, f.get("geometry") or {}
                if g.get("type") != "Point":
                    continue
                idx = code_map.get(p.get("brand:wikidata"))
                if idx is None and p.get("brand"):
                    idx = lookup.get(norm(p.get("brand")))
                if idx is None:
                    idx = lookup.get(norm(p.get("name")))
                if idx is None:
                    continue
                lon, lat = g["coordinates"][:2]
                if not in_country(p, lat, lon) or p.get("end_date"):
                    continue
                street = p.get("addr:street_address") or " ".join(
                    x for x in [p.get("addr:housenumber"), p.get("addr:street")] if x) or (p.get("addr:full") or "").split(",")[0]
                rows.append([idx, round(lat, 5), round(lon, 5), street or "", p.get("addr:city") or "",
                             (p.get("addr:state") or "")[:2].upper(), (p.get("addr:postcode") or "")[:5],
                             p.get("phone") or "", p.get("opening_hours") or ""])
                spiders.setdefault(cfg["chains"][idx]["id"], set()).add(p.get("@spider") or name)
            if k % 500 == 0:
                print(f"  scanned {k}/{len(names)} files, {len(rows)} matches", flush=True)

    # Chains with (almost) nothing from All The Places: top up from OpenStreetMap by Wikidata code.
    atp_counts = [0] * len(cfg["chains"])
    for r in rows:
        atp_counts[r[0]] += 1
    thin = {}
    for q, i in code_map.items():
        if atp_counts[i] < 5:
            thin.setdefault(i, []).append(q)
    if thin and os.environ.get("SKIP_OSM") != "1":
        print(f"topping up {len(thin)} chains from OpenStreetMap", flush=True)
        extra = osm_rows(thin)
        for r in extra:
            spiders.setdefault(cfg["chains"][r[0]]["id"], set()).add("openstreetmap")
        rows += extra

    # de-duplicate the same chain within ~40 m (two spiders can cover one brand)
    seen, uniq = set(), []
    for r in rows:
        key = (r[0], round(r[1] * 2500), round(r[2] * 2500))
        if key not in seen:
            seen.add(key); uniq.append(r); counts[r[0]] += 1

    if len(uniq) < MIN_ROWS:
        sys.exit(f"Only {len(uniq)} locations found — refusing to overwrite existing data. Check the ATP format.")

    cells = {}
    for r in uniq:
        cells.setdefault(f"{math.floor(r[1] / CELL) * CELL}_{math.floor(r[2] / CELL) * CELL}", []).append(r)
    out = os.path.join(DATA, "cells")
    os.makedirs(out, exist_ok=True)
    for fn in os.listdir(out):
        os.remove(os.path.join(out, fn))
    for key, rs in cells.items():
        with open(os.path.join(out, key + ".json"), "w", encoding="utf-8") as f:
            json.dump(rs, f, separators=(",", ":"), ensure_ascii=False)

    json.dump({"run_id": run["run_id"], "built": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
               "cell": CELL, "count": len(uniq), "cells": sorted(cells)},
              open(os.path.join(DATA, "index.json"), "w"), separators=(",", ":"))
    codes_of = {}
    for q, i in code_map.items():
        codes_of.setdefault(i, []).append(q)
    report = sorted(({"chain": c["name"], "tier": c["tier"], "locations": counts[i], "wikidata": sorted(codes_of.get(i, [])),
                      "sources": sorted(spiders.get(c["id"], []))} for i, c in enumerate(cfg["chains"])),
                    key=lambda x: x["locations"])
    json.dump(report, open(os.path.join(DATA, "report.json"), "w"), indent=1)
    print(f"\n{len(uniq)} locations in {len(cells)} cells")
    missing = [r["chain"] for r in report if r["locations"] == 0]
    if missing:
        print("No locations found (add an alias in data/chains.json):", ", ".join(missing))


if __name__ == "__main__":
    main()
