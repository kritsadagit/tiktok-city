const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

class CityStorage {
  constructor(filename, legacyFilename, defaults) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;",
    );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS city_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        version INTEGER NOT NULL,
        coins INTEGER NOT NULL,
        population INTEGER NOT NULL,
        level INTEGER NOT NULL,
        next_building INTEGER NOT NULL,
        last_live_session TEXT,
        disaster TEXT,
        next_disaster_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS buildings (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        x REAL NOT NULL,
        y REAL NOT NULL,
        level INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        gift_name TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS building_bounds USING rtree(rowid, min_x, max_x, min_y, max_y);
      CREATE TRIGGER IF NOT EXISTS buildings_rtree_insert AFTER INSERT ON buildings BEGIN
        INSERT INTO building_bounds VALUES (new.rowid, new.x, new.x, new.y, new.y);
      END;
      CREATE TRIGGER IF NOT EXISTS buildings_rtree_update AFTER UPDATE OF x, y ON buildings BEGIN
        UPDATE building_bounds SET min_x = new.x, max_x = new.x, min_y = new.y, max_y = new.y WHERE rowid = new.rowid;
      END;
      CREATE TRIGGER IF NOT EXISTS buildings_rtree_delete AFTER DELETE ON buildings BEGIN
        DELETE FROM building_bounds WHERE rowid = old.rowid;
      END;
      CREATE TABLE IF NOT EXISTS processed_events (
        event_id TEXT PRIMARY KEY,
        processed_at TEXT NOT NULL
      );
    `);
    this.statements = {
      state: this.db.prepare("SELECT * FROM city_state WHERE singleton = 1"),
      saveState: this.db
        .prepare(`INSERT INTO city_state VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET version=excluded.version, coins=excluded.coins,
        population=excluded.population, level=excluded.level, next_building=excluded.next_building,
        last_live_session=excluded.last_live_session, disaster=excluded.disaster,
        next_disaster_at=excluded.next_disaster_at`),
      addBuilding: this.db
        .prepare(`INSERT INTO buildings (id,type,x,y,level,created_at,created_by,gift_name)
        VALUES (?,?,?,?,?,?,?,?)`),
      addEvent: this.db.prepare(
        "INSERT OR IGNORE INTO processed_events (event_id, processed_at) VALUES (?,?)",
      ),
      hasEvent: this.db.prepare(
        "SELECT 1 AS found FROM processed_events WHERE event_id = ?",
      ),
      bounds: this.db
        .prepare(`SELECT b.id,b.type,b.x,b.y,b.level,b.created_at AS createdAt,
          b.created_by AS createdBy,b.gift_name AS giftName
        FROM building_bounds r JOIN buildings b ON b.rowid = r.rowid
        WHERE r.min_x <= ? AND r.max_x >= ? AND r.min_y <= ? AND r.max_y >= ?
        ORDER BY b.rowid`),
      all: this.db
        .prepare(`SELECT id,type,x,y,level,created_at AS createdAt,created_by AS createdBy,gift_name AS giftName
        FROM buildings ORDER BY rowid`),
    };
    if (!this.statements.state.get())
      this.importLegacy(legacyFilename, defaults);
  }

  importLegacy(filename, defaults) {
    let legacy = null;
    try {
      legacy = JSON.parse(fs.readFileSync(filename, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT")
        console.error("Legacy city save could not be read:", error.message);
    }
    const city = { ...defaults, ...(legacy || {}) };
    delete city.buildings;
    delete city.processedEvents;
    this.saveCity(city, legacy?.buildings || [], legacy?.processedEvents || []);
    if (legacy) console.log(`Imported legacy city save from ${filename}`);
  }

  loadCity(defaults) {
    const row = this.statements.state.get();
    if (!row) return defaults;
    return {
      version: row.version,
      coins: row.coins,
      population: row.population,
      level: row.level,
      nextBuilding: row.next_building,
      lastLiveSession: row.last_live_session
        ? JSON.parse(row.last_live_session)
        : null,
      disaster: row.disaster ? JSON.parse(row.disaster) : null,
      nextDisasterAt: row.next_disaster_at,
    };
  }

  saveCity(city, buildings = [], eventIds = []) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.statements.saveState.run(
        city.version,
        city.coins,
        city.population,
        city.level,
        city.nextBuilding,
        city.lastLiveSession ? JSON.stringify(city.lastLiveSession) : null,
        city.disaster ? JSON.stringify(city.disaster) : null,
        city.nextDisasterAt,
      );
      for (const b of buildings)
        this.statements.addBuilding.run(
          b.id,
          b.type,
          b.x,
          b.y,
          b.level || 1,
          b.createdAt,
          b.createdBy || "",
          b.giftName || "",
        );
      const now = new Date().toISOString();
      for (const id of eventIds) this.statements.addEvent.run(String(id), now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  hasProcessedEvent(id) {
    return Boolean(this.statements.hasEvent.get(String(id)));
  }
  getBuildings(bounds) {
    return this.statements.bounds.all(
      bounds.right,
      bounds.left,
      bounds.bottom,
      bounds.top,
    );
  }
  allBuildings() {
    return this.statements.all.all();
  }
  close() {
    this.db.close();
  }
}

module.exports = { CityStorage };
