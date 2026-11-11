const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const source = path.resolve(
  process.env.CITY_DB_FILE || path.join(__dirname, "data", "city.sqlite"),
);
if (!fs.existsSync(source)) {
  console.error(`City database not found: ${source}`);
  process.exit(1);
}

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const defaultDirectory = path.join(__dirname, "data", "backups");
let destination = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(defaultDirectory, `city-${timestamp}.sqlite`);
if (destination === source) {
  console.error("Backup destination must differ from the city database.");
  process.exit(1);
}
if (fs.existsSync(destination)) {
  console.error(`Backup destination already exists: ${destination}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(destination), { recursive: true });
try {
  const db = new DatabaseSync(source);
  try {
    // VACUUM INTO creates a consistent standalone snapshot, including committed WAL data.
    db.exec(`VACUUM INTO '${destination.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
} catch (error) {
  if (fs.existsSync(destination)) fs.unlinkSync(destination);
  throw error;
}

const backup = new DatabaseSync(destination);
try {
  const integrity = backup.prepare("PRAGMA quick_check").get();
  if (integrity.quick_check !== "ok")
    throw new Error(`SQLite integrity check failed: ${integrity.quick_check}`);
  const city = backup
    .prepare(
      "SELECT coins, population, level FROM city_state WHERE singleton = 1",
    )
    .get();
  const buildingCount = backup
    .prepare("SELECT COUNT(*) AS count FROM buildings")
    .get().count;
  const spatialCount = backup
    .prepare("SELECT COUNT(*) AS count FROM building_bounds")
    .get().count;
  const buildingsWithoutBounds = backup
    .prepare(
      `SELECT COUNT(*) AS count FROM buildings b
      LEFT JOIN building_bounds r ON r.rowid = b.rowid
      WHERE r.rowid IS NULL`,
    )
    .get().count;
  if (spatialCount !== buildingCount || buildingsWithoutBounds !== 0)
    throw new Error(
      `Spatial index mismatch: ${buildingCount} buildings, ${spatialCount} indexed, ${buildingsWithoutBounds} missing bounds`,
    );
  console.log(`Backup created: ${destination}`);
  console.log(
    `City: ${city.population.toLocaleString()} citizens, ${city.coins.toLocaleString()} coins, ${buildingCount.toLocaleString()} buildings`,
  );
} catch (error) {
  fs.unlinkSync(destination);
  throw error;
} finally {
  backup.close();
}
