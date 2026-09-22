# The Usual

*Same menu, any town.*

A free map search for the **familiar chain restaurants** — Olive Garden, Chili's, Applebee's,
Outback, Red Lobster, Denny's, Cheesecake Factory, Dave & Buster's and ~95 more. Built for travelers
staying a while, families passing through for a night, and anyone who just wants a calm, known meal.
See `about.html` for the full motivation. Independent bars and eateries,
fast food, and fine dining never show up, because the app searches a whitelist of chains
rather than "restaurants near me".

- **Static site** (HTML/CSS/JS, no build step, no API keys) — hosts free on Cloudflare Pages.
- **Location data**: [All The Places](https://www.alltheplaces.xyz/) (CC-0), scraped weekly from each
  chain's own store locator, matched by Wikidata brand code. Chains it doesn't cover are topped up from
  OpenStreetMap (ODbL). A GitHub Action rebuilds `data/` every Thursday (skipped when there's no new data).
- **Map**: MapLibre GL + [OpenFreeMap](https://openfreemap.org) tiles. **Place search**: [Photon](https://photon.komoot.io).
- **Fallback**: if `data/index.json` is missing, the app queries OpenStreetMap live via Overpass.

## Files
| Path | What it is |
|---|---|
| `index.html`, `style.css`, `app.js` | The app |
| `data/chains.json` | **The whitelist** — edit this to add/remove chains or tiers |
| `scripts/build_data.py` | Pulls All The Places, keeps whitelisted US locations, writes `data/cells/*.json` |
| `.github/workflows/refresh-data.yml` | Weekly data refresh; commits → Cloudflare redeploys |
| `_headers` | Cloudflare caching headers |
| `wrangler.jsonc`, `.assetsignore` | Cloudflare deploy settings; keeps `.git`, scripts and tests off the public site |

## Add a chain
Add an entry to `data/chains.json` (`name`, `tier`, optional `aliases` for other spellings), push.
The workflow rebuilds data automatically. Check the Action log (or `data/report.json`) for chains
with 0 locations — that usually means the brand is spelled differently in the source; add an alias.

## Run locally
    python3 -m http.server 8000     # then open http://localhost:8000
Without `data/cells/`, search falls back to live OpenStreetMap data. To build real data locally:
`python3 scripts/build_data.py` (downloads ~2.3 GB).
