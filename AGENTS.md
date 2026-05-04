# Agent Guide: UAE Threat Monitor

Compact context for OpenCode sessions to avoid common pitfalls.

## Critical Commands
- **Start/Manage:** Use `./manage.sh {start|stop|restart|status}`. It handles background execution (`nohup`), PID tracking (`.uae-threat-monitor.pid`), and logging (`.uae-threat-monitor.log`).
- **Dev Start:** `npm start` (runs in foreground).
- **Syntax Check:** `npm run check` (calls `node --check server.js`).
- **Manual Refresh:** `curl -X POST http://127.0.0.1:3000/api/refresh` to trigger a live OSINT scrape.

## Architecture & Flow
- **Tech Stack:** Vanilla Node.js (no Express/Fastify) and Vanilla Frontend (no React/Vue/Build step).
- **Data Pipeline:** `server.js` fetches Google News RSS -> Regex-based parsing -> Classification logic -> `data/cache.json`.
- **Classification:** Logic for "direct_attack" vs "strategic_signal" is entirely in `server.js` via regex patterns.
- **Map:** Uses Leaflet. Geometry and strategic sites are defined in `data/map-data.json`.
- **Persistence:** JSON files in `data/`. `cache.json` is the primary state.

## Environmental Gotchas
- **X Integration:** Official X (Twitter) search requires `X_BEARER_TOKEN` env var. Without it, the app silently falls back to RSS only.
- **Timezone:** All logic assumes UAE time (UTC+4). Cutoffs for "Today's items" are calculated in `server.js`.
- **Network:** Server needs outbound HTTPS access to `news.google.com` and `api.x.com`.

## Development Constraints
- **No Build Step:** Edit `public/app.js` or `public/styles.css` directly. Browser caches may need clearing.
- **No Tests:** No automated test suite. Verify changes by running the server and checking `/api/items` or the UI.
- **RSS Parsing:** Do not use DOM-based parsers in `server.js`; it uses a custom regex-based `parseRss` for zero-dependency portability.
