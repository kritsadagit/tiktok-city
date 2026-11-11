const express = require("express");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const { randomUUID } = require("crypto");
const WebSocket = require("ws");
const { Server } = require("socket.io");
const { CityStorage } = require("./storage");
const { normalizeGiftMessage } = require("./tikfinity-adapter");
const { lotCoordinates } = require("./city-grid");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
let tikFinityStatus = "connecting";
let tikFinityMessage = "";
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const DB_FILE =
  process.env.CITY_DB_FILE || path.join(__dirname, "data", "city.sqlite");
const LEGACY_FILE =
  process.env.CITY_SAVE_FILE || path.join(__dirname, "data", "city.json");
const BACKUP_DIR = path.join(__dirname, "data", "backups");
const DEFAULT_GIFT_RULES = {
  rose: { building: "house", label: "บ้าน", coins: 5, population: 5 },
  heart: { building: "shop", label: "ร้านค้า", coins: 10, population: 10 },
  perfume: {
    building: "school",
    label: "โรงเรียน",
    coins: 100,
    population: 50,
  },
  sunglasses: {
    building: "park",
    label: "สวนสาธารณะ",
    coins: 100,
    population: 30,
  },
  gg: { building: "hospital", label: "โรงพยาบาล", coins: 500, population: 100 },
  galaxy: {
    building: "mall",
    buildings: ["mall", "airport", "bridge"],
    label: "แลนด์มาร์ก: ห้าง สนามบิน และสะพาน",
    coins: 1000,
    population: 250,
  },
  universe: {
    building: "skyscraper",
    buildings: ["skyscraper", "metro", "statue"],
    label: "แลนด์มาร์ก: ตึกระฟ้า รถไฟฟ้า และอนุสาวรีย์",
    coins: 5000,
    population: 1000,
  },
  tree: { building: "tree", label: "ต้นไม้", coins: 5, population: 1 },
  streetlamp: {
    building: "streetlamp",
    label: "เสาไฟ",
    coins: 5,
    population: 0,
  },
};
const GIFT_RULES_FILE =
  process.env.CITY_GIFT_RULES_FILE ||
  path.join(__dirname, "data", "gift-rules.json");
let GIFT_RULES = DEFAULT_GIFT_RULES;
try {
  const configuredRules = JSON.parse(fs.readFileSync(GIFT_RULES_FILE, "utf8"));
  const supportedBuildings = new Set([
    "house",
    "shop",
    "school",
    "park",
    "hospital",
    "mall",
    "airport",
    "bridge",
    "skyscraper",
    "metro",
    "statue",
    "tree",
    "streetlamp",
  ]);
  for (const [key, rule] of Object.entries(configuredRules)) {
    if (
      !rule ||
      !supportedBuildings.has(rule.building) ||
      !rule.label ||
      !Number.isFinite(Number(rule.coins)) ||
      Number(rule.coins) < 0 ||
      !Number.isFinite(Number(rule.population)) ||
      Number(rule.population) < 0 ||
      (rule.buildings &&
        (!Array.isArray(rule.buildings) ||
          rule.buildings.some((type) => !supportedBuildings.has(type))))
    )
      throw new Error(`Invalid gift rule for ${key}`);
  }
  GIFT_RULES = { ...DEFAULT_GIFT_RULES, ...configuredRules };
} catch (error) {
  if (error.code !== "ENOENT")
    console.error(
      `Could not load gift rules from ${GIFT_RULES_FILE}: ${error.message}`,
    );
}
const POPULATION_MILESTONES = [2000, 5000, 10000, 25000, 50000];
const MAX_PREVIEW_BUILDINGS = 1000;
const DISASTERS = [
  { type: "fire", label: "ไฟไหม้", emoji: "🔥" },
  { type: "flood", label: "น้ำท่วม", emoji: "🌊" },
  { type: "meteor", label: "อุกกาบาตตก", emoji: "☄️" },
  { type: "aliens", label: "เอเลียนบุก", emoji: "👽" },
];
const DISASTER_INTERVAL_MS = Number(
  process.env.DISASTER_INTERVAL_MS || 10 * 60 * 1000,
);
const REPAIR_COST = Number(process.env.REPAIR_COST || 500);

function emptyCity() {
  return {
    version: 3,
    coins: 0,
    population: 0,
    level: 1,
    nextBuilding: 0,
    lastLiveSession: null,
    disaster: null,
    nextDisasterAt: Date.now() + DISASTER_INTERVAL_MS,
  };
}
const storage = new CityStorage(DB_FILE, LEGACY_FILE, emptyCity());
let city = storage.loadCity(emptyCity());
let backupInProgress = false;
let backupPending = false;
const previewIo = io.of("/preview");
let previewCoins = 0;
let previewPopulation = 0;
let previewNextBuilding = city.nextBuilding;
let previewBuildings = [];
function saveCity(buildings = null, eventId = null, state = city) {
  storage.saveCity(
    state,
    buildings ? (Array.isArray(buildings) ? buildings : [buildings]) : [],
    eventId == null ? [] : [eventId],
  );
}
function isLiveSessionActive(session = city.lastLiveSession) {
  return Boolean(session && !session.endedAt);
}
function snapshot(includeBuildings = false) {
  const isLive = isLiveSessionActive();
  return {
    coins: city.coins,
    population: city.population,
    level: city.level,
    disaster: isLive ? city.disaster : null,
    isLive,
    liveSession: isLive ? city.lastLiveSession : null,
    tikFinityStatus,
    tikFinityMessage,
    nextDisasterAt: city.nextDisasterAt,
    ...(includeBuildings ? { buildings: storage.allBuildings() } : {}),
    lastLiveSession: city.lastLiveSession,
  };
}
function previewSnapshot() {
  const current = snapshot();
  const coins = current.coins + previewCoins;
  const population = current.population + previewPopulation;
  return {
    ...current,
    coins,
    population,
    level: 1 + Math.floor(coins / 500),
    preview: true,
  };
}
function broadcastCityState() {
  io.emit("city:state", snapshot());
  previewIo.emit("city:state", previewSnapshot());
}
function rebasePreviewBuildings() {
  if (!previewBuildings.length) {
    previewNextBuilding = city.nextBuilding;
    return;
  }
  previewBuildings = previewBuildings.map((building, index) => ({
    ...building,
    ...placeBuilding(city.nextBuilding + index, building.type),
  }));
  previewNextBuilding = city.nextBuilding + previewBuildings.length;
}
function applyPreviewGift({
  username = "ผู้ชมทดลอง",
  giftName = "Rose",
  coins,
  giftCount = 1,
}) {
  const rule = GIFT_RULES[giftKey(giftName)];
  if (!rule) return { ignored: true, reason: `ไม่รู้จัก Gift: ${giftName}` };
  const countValue = Math.floor(Number(giftCount));
  const count = Number.isFinite(countValue)
    ? Math.max(1, Math.min(1000, countValue))
    : 1;
  const requestedCoins = Number(coins);
  const amount =
    Number.isFinite(requestedCoins) && requestedCoins > 0
      ? requestedCoins
      : rule.coins * count;
  const buildingTypes = rule.buildings || [rule.building];
  if (
    previewBuildings.length + count * buildingTypes.length >
    MAX_PREVIEW_BUILDINGS
  )
    return {
      ignored: true,
      reason: "Preview เต็มแล้ว กด “ล้าง Preview” ก่อนทดลองต่อ",
    };
  const newBuildings = Array.from({ length: count }, (_, giftIndex) =>
    buildingTypes.map((type, buildingIndex) =>
      placeBuilding(
        previewNextBuilding + giftIndex * buildingTypes.length + buildingIndex,
        type,
      ),
    ),
  )
    .flat()
    .map((building) => ({
      ...building,
      createdBy: String(username),
      giftName: String(giftName),
    }));
  previewBuildings.push(...newBuildings);
  previewNextBuilding += newBuildings.length;
  previewCoins += amount;
  const populationAdded = rule.population * count;
  const previousPopulation = city.population + previewPopulation;
  previewPopulation += populationAdded;
  const currentPopulation = city.population + previewPopulation;
  const reachedMilestones = POPULATION_MILESTONES.filter(
    (value) => previousPopulation < value && currentPopulation >= value,
  );
  for (let value = 100000; value <= currentPopulation; value += 50000) {
    if (previousPopulation < value) reachedMilestones.push(value);
  }
  const state = previewSnapshot();
  const event = {
    username: String(username),
    giftName: String(giftName),
    giftCount: count,
    coins: amount,
    building: rule.building,
    buildingLabel: rule.label,
    buildingCount: newBuildings.length,
    populationAdded,
    buildings: newBuildings.map(({ type, x, y }) => ({ type, x, y })),
    source: "preview",
    at: new Date().toISOString(),
  };
  const milestone = reachedMilestones.length
    ? {
        username: String(username),
        population: reachedMilestones.at(-1),
        reachedMilestones,
      }
    : null;
  return { event, snapshot: state, milestone };
}
function resetPreview() {
  previewCoins = 0;
  previewPopulation = 0;
  previewBuildings = [];
  previewNextBuilding = city.nextBuilding;
  return previewSnapshot();
}
function setTikFinityStatus(status, message = null) {
  const nextMessage =
    status === "connected" ? "" : (message ?? tikFinityMessage);
  if (tikFinityStatus === status && tikFinityMessage === nextMessage) return;
  tikFinityStatus = status;
  tikFinityMessage = nextMessage;
  broadcastCityState();
}
function backupCityAfterLive() {
  if (backupInProgress) {
    backupPending = true;
    return;
  }
  backupInProgress = true;
  io.emit("backup:status", { status: "running" });
  const backup = spawn(
    process.execPath,
    [path.join(__dirname, "backup-city.js")],
    {
      stdio: ["ignore", "ignore", "pipe"],
      env: process.env,
    },
  );
  let errorOutput = "";
  backup.stderr.setEncoding("utf8");
  backup.stderr.on("data", (chunk) => {
    errorOutput = (errorOutput + chunk).slice(-4000);
  });
  let settled = false;
  const finishBackup = (code, message = "") => {
    if (settled) return;
    settled = true;
    backupInProgress = false;
    if (code === 0) {
      console.log("Automatic city backup completed after Live.");
      io.emit("backup:status", {
        status: "completed",
        at: new Date().toISOString(),
      });
    } else {
      const details =
        message || errorOutput.trim() || `Backup process exited with ${code}`;
      console.error(`Automatic city backup failed (exit ${code}): ${details}`);
      io.emit("backup:status", { status: "failed", message: details });
    }
    if (backupPending) {
      backupPending = false;
      setImmediate(backupCityAfterLive);
    }
  };
  backup.once("error", (error) => finishBackup(-1, error.message));
  backup.once("close", (code) => finishBackup(code));
}
function startLiveSession(source = "manual") {
  if (isLiveSessionActive()) return city.lastLiveSession;
  const updatedCity = {
    ...city,
    lastLiveSession: {
      startedAt: new Date().toISOString(),
      source,
      coins: 0,
      population: 0,
      gifts: 0,
    },
    nextDisasterAt: Date.now() + DISASTER_INTERVAL_MS,
  };
  saveCity(null, null, updatedCity);
  city = updatedCity;
  io.emit("live:started", city.lastLiveSession);
  broadcastCityState();
  return city.lastLiveSession;
}
function endLiveSession(source = "manual") {
  if (!isLiveSessionActive()) return city.lastLiveSession;
  const updatedCity = {
    ...city,
    lastLiveSession: {
      ...city.lastLiveSession,
      endedAt: new Date().toISOString(),
      endedBy: source,
    },
  };
  saveCity(null, null, updatedCity);
  city = updatedCity;
  io.emit("live:ended", city.lastLiveSession);
  broadcastCityState();
  backupCityAfterLive();
  return city.lastLiveSession;
}
// A process restart means the previous controller may have missed the manual/stream-end action.
// Close that session on boot so the next Live can start cleanly; cumulative city data is untouched.
if (isLiveSessionActive()) {
  endLiveSession("server-restart");
  console.warn(
    "Closed an interrupted Live session from the previous server run. The saved city is unchanged.",
  );
}
function startDisaster() {
  const incident = DISASTERS[Math.floor(Math.random() * DISASTERS.length)];
  const updatedCity = {
    ...city,
    disaster: {
      ...incident,
      id: randomUUID(),
      requiredCoins: REPAIR_COST,
      contributedCoins: 0,
      startedAt: new Date().toISOString(),
    },
    nextDisasterAt: Date.now() + DISASTER_INTERVAL_MS,
  };
  saveCity(null, null, updatedCity);
  city = updatedCity;
  io.emit("disaster:started", city.disaster);
  broadcastCityState();
}
function placeBuilding(index, type) {
  const { x, y } = lotCoordinates(index);
  return {
    id: randomUUID(),
    type,
    x,
    y,
    level: 1,
    createdAt: new Date().toISOString(),
  };
}
function giftKey(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}]/gu, "");
}
function applyGift({
  username = "ผู้ชม",
  giftName = "Rose",
  diamonds,
  giftCount = 1,
  eventId,
  source = "demo",
}) {
  if (eventId && storage.hasProcessedEvent(eventId))
    return { duplicate: true, snapshot: snapshot() };
  const rule = GIFT_RULES[giftKey(giftName)];
  if (!rule) return { ignored: true, reason: `ไม่รู้จัก Gift: ${giftName}` };
  if (source === "tikfinity" && !isLiveSessionActive())
    startLiveSession("first-gift");
  const countValue = Math.floor(Number(giftCount));
  const count = Number.isFinite(countValue)
    ? Math.max(1, Math.min(1000, countValue))
    : 1;
  const amount = rule.coins * count;
  const buildingTypes = rule.buildings || [rule.building];
  const buildings = Array.from({ length: count }, (_, giftIndex) =>
    buildingTypes.map((type, buildingIndex) =>
      placeBuilding(
        city.nextBuilding + giftIndex * buildingTypes.length + buildingIndex,
        type,
      ),
    ),
  ).flat();
  const updatedCity = {
    ...city,
    nextBuilding: city.nextBuilding + buildings.length,
    coins: city.coins + amount,
  };
  const populationAdded = rule.population * count;
  updatedCity.population = city.population + populationAdded;
  updatedCity.level = 1 + Math.floor(updatedCity.coins / 500);
  const reachedMilestones = POPULATION_MILESTONES.filter(
    (value) => city.population < value && updatedCity.population >= value,
  );
  for (let value = 100000; value <= updatedCity.population; value += 50000) {
    if (city.population < value) reachedMilestones.push(value);
  }
  if (source === "tikfinity" && isLiveSessionActive()) {
    updatedCity.lastLiveSession = {
      ...city.lastLiveSession,
      coins: (city.lastLiveSession.coins || 0) + amount,
      population: (city.lastLiveSession.population || 0) + populationAdded,
      gifts: (city.lastLiveSession.gifts || 0) + count,
    };
  }
  let repaired = false;
  let completedDisaster = null;
  if (updatedCity.disaster) {
    updatedCity.disaster = {
      ...city.disaster,
      contributedCoins: Math.min(
        city.disaster.requiredCoins,
        city.disaster.contributedCoins + amount,
      ),
    };
    if (
      updatedCity.disaster.contributedCoins >=
      updatedCity.disaster.requiredCoins
    ) {
      completedDisaster = updatedCity.disaster;
      updatedCity.disaster = null;
      repaired = true;
    }
  }
  const savedBuildings = buildings.map((building) => ({
    ...building,
    createdBy: String(username),
    giftName: String(giftName),
  }));
  saveCity(savedBuildings, eventId, updatedCity);
  city = updatedCity;
  rebasePreviewBuildings();
  if (completedDisaster)
    io.emit("disaster:repaired", {
      id: completedDisaster.id,
      repairedBy: String(username),
    });
  const event = {
    username: String(username),
    giftName: String(giftName),
    giftCount: count,
    coins: amount,
    diamonds:
      Number.isFinite(Number(diamonds)) && Number(diamonds) > 0
        ? Number(diamonds)
        : null,
    building: rule.building,
    buildingLabel: rule.label,
    buildingCount: buildings.length,
    populationAdded,
    buildings: buildings.map(({ type, x, y }) => ({ type, x, y })),
    source,
    at: new Date().toISOString(),
  };
  broadcastCityState();
  io.emit("gift:built", event);
  if (reachedMilestones.length)
    io.emit("city:milestone", {
      username: String(username),
      population: reachedMilestones.at(-1),
      reachedMilestones,
    });
  if (repaired)
    io.emit("city:announcement", {
      text: `${username} และชุมชนช่วยกันซ่อมเมืองสำเร็จ!`,
    });
  return { event, snapshot: snapshot() };
}

app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));
app.get("/api/city", (_req, res) => res.json(snapshot()));
app.get("/api/backups/latest", async (_req, res) => {
  try {
    const files = (await fs.promises.readdir(BACKUP_DIR)).filter((name) =>
      /^city-.+\.sqlite$/.test(name),
    );
    const backups = await Promise.all(
      files.map(async (name) => {
        const stat = await fs.promises.stat(path.join(BACKUP_DIR, name));
        return { name, modifiedAt: stat.mtime.toISOString(), bytes: stat.size };
      }),
    );
    backups.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    res.json({ latest: backups[0] || null });
  } catch (error) {
    if (error.code === "ENOENT") return res.json({ latest: null });
    console.error("Could not read backup directory:", error.message);
    res.status(500).json({ error: "Could not read backup directory." });
  }
});
app.get("/api/buildings", (req, res) => {
  const left = Number(req.query.left);
  const top = Number(req.query.top);
  const right = Number(req.query.right);
  const bottom = Number(req.query.bottom);
  if (![left, top, right, bottom].every(Number.isFinite))
    return res
      .status(400)
      .json({ error: "Provide finite left, top, right and bottom bounds." });
  const bounds = {
    left: Math.min(left, right),
    right: Math.max(left, right),
    top: Math.min(top, bottom),
    bottom: Math.max(top, bottom),
  };
  res.json({ buildings: storage.getBuildings(bounds) });
});
app.get("/api/preview/city", (_req, res) => res.json(previewSnapshot()));
app.get("/api/preview/buildings", (req, res) => {
  const left = Number(req.query.left);
  const top = Number(req.query.top);
  const right = Number(req.query.right);
  const bottom = Number(req.query.bottom);
  if (![left, top, right, bottom].every(Number.isFinite))
    return res
      .status(400)
      .json({ error: "Provide finite left, top, right and bottom bounds." });
  const bounds = {
    left: Math.min(left, right),
    right: Math.max(left, right),
    top: Math.min(top, bottom),
    bottom: Math.max(top, bottom),
  };
  const savedBuildings = storage.getBuildings(bounds);
  const simulatedBuildings = previewBuildings.filter(
    (building) =>
      building.x >= bounds.left &&
      building.x <= bounds.right &&
      building.y >= bounds.top &&
      building.y <= bounds.bottom,
  );
  res.json({ buildings: [...savedBuildings, ...simulatedBuildings] });
});
function previewGiftRoute(req, res) {
  const result = applyPreviewGift(req.body || {});
  res.status(result.ignored ? 400 : 200).json(result);
}
app.post("/api/preview/gift", previewGiftRoute);
// Keep the former demo URL safe for older local preview tabs: it is memory-only too.
app.post("/api/demo/gift", previewGiftRoute);
app.post("/api/preview/reset", (_req, res) => {
  const state = resetPreview();
  previewIo.emit("city:state", state);
  res.json({ snapshot: state });
});
app.post("/api/live/start", (_req, res) =>
  res.json({ liveSession: startLiveSession("manual"), snapshot: snapshot() }),
);
app.post("/api/live/end", (_req, res) =>
  res.json({ liveSession: endLiveSession("manual"), snapshot: snapshot() }),
);
io.on("connection", (socket) => socket.emit("city:state", snapshot()));
previewIo.on("connection", (socket) =>
  socket.emit("city:state", previewSnapshot()),
);

// Persist the next due time so a restart does not silently reset the disaster cadence.
const disasterTimer = setInterval(() => {
  if (
    isLiveSessionActive() &&
    !city.disaster &&
    city.nextDisasterAt &&
    Date.now() >= city.nextDisasterAt
  )
    startDisaster();
}, 1000);
disasterTimer.unref();

// TikFinity runs locally beside OBS. Override the URL if its Event API is configured elsewhere.
const tikfinityUrl = process.env.TIKFINITY_WS_URL || "ws://127.0.0.1:21213/";
let reconnectDelay = 2000;
function connectTikFinity() {
  const ws = new WebSocket(tikfinityUrl);
  ws.on("open", () => {
    reconnectDelay = 2000;
    setTikFinityStatus("connected");
    console.log(`Connected to TikFinity at ${tikfinityUrl}`);
  });
  ws.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      // roomUser means a viewer entered the room, not that the broadcast started.
      // TikFinity's documented Event API does not include a stream lifecycle event;
      // the first gift starts a session as a fallback, with manual endpoints available.
      if (
        ["streamEnd", "stream_end", "liveEnd", "live_end"].includes(
          message.event,
        )
      )
        endLiveSession(`tikfinity:${message.event}`);
      const gift = normalizeGiftMessage(message);
      if (!gift) return;
      applyGift({ ...gift, source: "tikfinity" });
    } catch (error) {
      console.error("Invalid TikFinity event:", error.message);
    }
  });
  ws.on("error", (error) => {
    console.error(
      `TikFinity WebSocket error at ${tikfinityUrl}: ${error.message}`,
    );
    const message =
      error.code === "ECONNREFUSED"
        ? "Event API ไม่ตอบที่ localhost:21213 — เปิด TikFinity Desktop, ทำ Setup และเชื่อมกับ LIVE บนเครื่องนี้"
        : `Event API error: ${error.code || error.message}`;
    setTikFinityStatus("reconnecting", message);
    ws.close();
  });
  ws.on("close", () => {
    setTikFinityStatus("reconnecting");
    setTimeout(connectTikFinity, reconnectDelay);
    reconnectDelay = Math.min(30000, reconnectDelay * 2);
  });
}
connectTikFinity();

server.listen(PORT, HOST, () =>
  console.log(`TikTok City Builder running at http://${HOST}:${PORT}`),
);
process.once("exit", () => storage.close());
