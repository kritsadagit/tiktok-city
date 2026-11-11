# TikTok City Builder

Local OBS overlay prototype. Gifts add permanent buildings to `data/city.sqlite`.

## Run

1. Install Node.js 22.13+ and TikFinity Desktop (`node:sqlite` is built into Node but remains experimental).
2. Run `npm install`, then `npm start`.
3. Add `http://localhost:3000` as an OBS Browser Source. Gift test controls stay hidden in this live view.
4. Complete TikFinity Desktop's Setup, connect it to the live, and keep it running on the same computer. The server reconnects to its local Event API at `ws://127.0.0.1:21213/`; TikFinity documents the Setup requirement and endpoint in its [Event API instructions](https://tikfinity.zerody.one/de/tiktok/actionsandevents).
5. Open `http://localhost:3000/?preview=1` locally to preview each Gift mapping and animation before going live.
6. Open `http://localhost:3000/control.html` to start/end a Live and watch session totals without resetting the saved city.

The web server binds to `127.0.0.1` by default so the demo and session-control APIs stay on the OBS computer. Set `HOST` only if you intentionally need to serve it on another interface; set `PORT` to change the web server port. Set `TIKFINITY_WS_URL` to override TikFinity's WebSocket URL.
Set `DISASTER_INTERVAL_MS` or `REPAIR_COST` to adjust the disaster cadence and repair target.
Set `CITY_DB_FILE` to choose the SQLite file location. `CITY_SAVE_FILE` is only used as the legacy JSON import path.

## Stack fit

Node.js + Socket.IO + PixiJS + an OBS Browser Source is a good fit for a low-latency, single-computer 2D overlay. SQLite keeps the permanent city simple to run and back up on that machine. TikFinity's local Event API is a practical TikTok event bridge, but its desktop app must be running and configured. Its public Event API docs describe a Free/Pro service, not a source-code license, so do not describe the whole stack as open source unless TikFinity confirms its licensing. The event adapter is isolated in `tikfinity-adapter.js` so a different connector can be added later if that becomes important. TikTok LIVE Connector is one open-source alternative, but its own README labels it unofficial and not production-ready; evaluate connector stability and current terms before switching just to meet an open-source requirement.

## Back up or restore the city

Create a consistent SQLite snapshot while the server is running:

```sh
npm run backup
```

The server also creates a timestamped snapshot in `data/backups/` after each Live ends. If a new Live ends while a snapshot is still running, it queues another snapshot so that the newer city state also gets a recovery point. Live Control shows the latest snapshot's time and size, plus current backup progress or errors. The saved SQLite database remains the active source of truth; snapshots accumulate until you move or remove older files yourself.

The command writes a timestamped backup under `data/backups/`, checks SQLite integrity and verifies every saved building has its spatial-index entry, then reports the saved city totals. To choose a destination, run `node backup-city.js /path/to/city-backup.sqlite`. To restore, stop the server, move the current database and any matching `-wal`/`-shm` files out of the database directory, copy the chosen snapshot to the configured `CITY_DB_FILE` path, then start the server again. Keep those moved-aside files until you confirm the restored city is correct; do not leave old sidecars beside the restored database.

## Current prototype

- Gift events for Rose, Heart, Perfume, Sunglasses, GG, Galaxy and Universe.
- Gift mappings live in `data/gift-rules.json`, so you can add the small Gifts available in your TikFinity account and map them to houses, trees, streetlamps or shops without changing server code. Mapping keys are normalized by removing spaces, punctuation and emoji; for a gift named `Tiny Tulip 🌷`, use `tinytulip`. Supported building types are `house`, `shop`, `school`, `park`, `hospital`, `mall`, `airport`, `bridge`, `skyscraper`, `metro`, `statue`, `tree` and `streetlamp`. Rules may set `buildings` to a list for multi-building gifts. Restart the server after editing.
- TikFinity adapter supports nested sender/gift details, cumulative streak final frames and quantity sends; Gift names match case-insensitively and ignore emoji/spacing, so `Rose 🌹` maps to Rose. A streak of five Roses creates five houses and adds the combined Coins/population.
- City Coins and TikTok Diamonds are separate values: each Gift adds the configured `coins` reward in `data/gift-rules.json` (Rose adds 5 game Coins per gift), while the incoming diamond total is kept separately on the event. TikTok's diamond count is the in-app gift value, not a guarantee of creator payout.
- Galaxy creates a mall, airport and bridge; Universe creates a skyscraper, metro and statue as separate persistent buildings.
- Persistent city snapshot, population, coins, disaster state, buildings and processed gift IDs in SQLite transactions; use the backup command above to preserve a consistent snapshot during a live run.
- Automatic one-time import from an existing `data/city.json` save when the SQLite database is first created.
- SQLite R-Tree spatial index for viewport building queries; browser and server no longer scan the full building list for each camera move.
- Socket.IO state sync on connection and after each accepted gift.
- Gift, disaster and repair announcements share a short on-screen queue so rapid Gifts do not overwrite earlier contributor names immediately.
- HUD shows whether TikFinity's WebSocket is connected, separately from live-session state.
- PixiJS 7.4.2 is served locally with its MIT license, so the OBS overlay does not depend on a CDN at runtime.
- Drag/zoom camera with unique procedural lots on an unbounded coordinate grid, aligned between roads.
- When a new Gift's building is outside the current view, the camera glides to that district before the builder animation, so growth remains visible as the city expands outward. Gift build events are queued to keep rapid activity ordered; when the animation queue is full, it keeps the newest event visible. All accepted buildings remain saved regardless of animation backlog.
- Viewport-bounded building queries so the browser only draws visible buildings plus a margin.
- Village level 2 unlocks a procedural road grid with streetlamps, moving cars and walking residents; parks add trees, and population goals are shown in the HUD.
- Reaching population goals announces a community milestone in the overlay; thresholds continue every 50,000 citizens after the first five goals.
- Fire, flood, meteor or alien events start every 10 minutes during an active live session; Gifts contribute Coin value toward the saved repair target. Unfinished disasters remain for the next live.
- Each Live starts its own Coins, Population and Gift counters at zero while the overlay restores the saved city's buildings and cumulative population. Viewers see both the permanent city total and the current Live's contribution, so the city never appears empty just to reset a counter. TikFinity's documented Event API does not list a stream-start or stream-end event; the first Gift starts a session as a fallback. Use Live Control to start/end a session, or the matching API endpoints. A `roomUser` event only means a viewer entered and never starts a session. If the server restarts with a session left active, it closes that interrupted session on boot so the next Live can start; city totals and buildings remain saved.
- Gift Preview runs in a separate Socket.IO namespace with an in-memory city overlay. Test gifts show the same toast/build animation and population milestones, and affect preview totals/buildings only; they never write to the permanent SQLite city. Use “ล้าง Preview” to clear them.
- Pixi vector construction workers enter from the visible edge with a walk cycle, trigger a building pop-in, then leave; queued builds avoid overlapping a rapid streak and render consistently without relying on system emoji fonts.

The SQLite database is the source of truth. Use `npm run backup` to preserve the city across machine changes. Keep the server on loopback unless you add authentication before exposing its write endpoints to another machine.

## Next implementation steps

1. Complete TikFinity Desktop Setup on the OBS computer and verify one real Rose, one streak gift and one landmark against the installed Event API payload.
2. Confirm the desired Coin and population values for each configured Gift against your TikTok gift catalog; edit `data/gift-rules.json` to match.
3. Rehearse OBS Browser Source sizing, visibility, camera follow and a full end/start cycle on the streaming computer.
4. Add schema migrations and a backup retention policy before the city is used for long-running production streams.
