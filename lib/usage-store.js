const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const USAGE_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const SEATS_TTL_MS = 10 * 60 * 1000; // 10 minutes (matches original seats TTL)

class UsageStore {
  constructor(dataDir) {
    this.dataDir = dataDir || path.join(__dirname, "..", "data");
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.dbPath = path.join(this.dataDir, "usage.db");
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.init();
  }

  init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daily_usage (
        date       TEXT PRIMARY KEY,
        year       INTEGER NOT NULL,
        month      INTEGER NOT NULL,
        day        INTEGER NOT NULL,
        data       TEXT NOT NULL,
        mode       TEXT NOT NULL,
        raw_count  INTEGER NOT NULL,
        source     TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS seats_snapshot (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        data       TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        total      INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS etag_cache (
        pathname   TEXT PRIMARY KEY,
        etag       TEXT NOT NULL,
        data       TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_daily_usage_date ON daily_usage(date);
      CREATE INDEX IF NOT EXISTS idx_seats_snapshot_fetched ON seats_snapshot(fetched_at);
      CREATE INDEX IF NOT EXISTS idx_etag_cache_fetched ON etag_cache(fetched_at);
    `);

    /* Add ranking column if it doesn't exist (migration for existing databases) */
    try {
      this.db.exec("ALTER TABLE daily_usage ADD COLUMN ranking TEXT");
    } catch (e) {
      /* Column already exists, ignore */
    }
  }

  close() {
    this.db.close();
  }

  /* ── Daily usage ── */

  getDay(dateStr) {
    const row = this.db.prepare("SELECT * FROM daily_usage WHERE date = ?").get(dateStr);
    if (!row) return null;
    return {
      date: row.date,
      year: row.year,
      month: row.month,
      day: row.day,
      data: JSON.parse(row.data),
      mode: row.mode,
      raw_count: row.raw_count,
      source: row.source,
      fetched_at: row.fetched_at,
      ranking: row.ranking ? JSON.parse(row.ranking) : null,
    };
  }

  saveDay(dateStr, year, month, day, data, mode, raw_count, source, fetchedAt, ranking) {
    this.db.prepare(`
      INSERT OR REPLACE INTO daily_usage (date, year, month, day, data, mode, raw_count, source, fetched_at, ranking)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(dateStr, year, month, day, JSON.stringify(data), mode, raw_count, source, fetchedAt, ranking ? JSON.stringify(ranking) : null);
  }

  getDaysInRange(startStr, endStr) {
    return this.db.prepare("SELECT * FROM daily_usage WHERE date >= ? AND date <= ? ORDER BY date").all(startStr, endStr);
  }

  getMissingDays(startStr, endStr) {
    const rows = this.db.prepare("SELECT date FROM daily_usage WHERE date >= ? AND date <= ?").all(startStr, endStr);
    const existing = new Set(rows.map((r) => r.date));
    const days = [];
    const cur = new Date(startStr + "T00:00:00Z");
    const end = new Date(endStr + "T00:00:00Z");
    while (cur <= end) {
      const d = cur.toISOString().slice(0, 10);
      if (!existing.has(d)) days.push(d);
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return days;
  }

  getFreshDays(startStr, endStr, ttlMs) {
    const cutoff = new Date(Date.now() - (ttlMs || USAGE_TTL_MS)).toISOString();
    const rows = this.db.prepare(
      "SELECT date FROM daily_usage WHERE date >= ? AND date <= ? AND fetched_at > ?"
    ).all(startStr, endStr, cutoff);
    const fresh = new Set(rows.map((r) => r.date));
    const days = [];
    const cur = new Date(startStr + "T00:00:00Z");
    const end = new Date(endStr + "T00:00:00Z");
    while (cur <= end) {
      const d = cur.toISOString().slice(0, 10);
      if (!fresh.has(d)) days.push(d);
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return days;
  }

  cleanupOldData(maxAgeMs) {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const stmt = this.db.prepare("DELETE FROM daily_usage WHERE fetched_at < ?");
    return stmt.run(cutoff).changes;
  }

  /* ── Seats snapshot ── */

  saveSeatsSnapshot(seatsArray, fetchedAt) {
    this.db.prepare(
      "INSERT INTO seats_snapshot (data, fetched_at, total) VALUES (?, ?, ?)"
    ).run(JSON.stringify(seatsArray), fetchedAt, seatsArray.length);
  }

  getLatestSeatsSnapshot() {
    const row = this.db.prepare(
      "SELECT * FROM seats_snapshot ORDER BY fetched_at DESC LIMIT 1"
    ).get();
    if (!row) return null;
    return {
      data: JSON.parse(row.data),
      fetched_at: row.fetched_at,
      total: row.total,
    };
  }

  /* ── ETag cache ── */

  getEtag(pathname) {
    const row = this.db.prepare("SELECT * FROM etag_cache WHERE pathname = ?").get(pathname);
    if (!row) return null;
    return {
      pathname: row.pathname,
      etag: row.etag,
      data: JSON.parse(row.data),
      fetched_at: row.fetched_at,
    };
  }

  saveEtag(pathname, etag, data, fetchedAt) {
    this.db.prepare(
      "INSERT OR REPLACE INTO etag_cache (pathname, etag, data, fetched_at) VALUES (?, ?, ?, ?)"
    ).run(pathname, etag, JSON.stringify(data), fetchedAt);
  }

  deleteEtag(pathname) {
    this.db.prepare("DELETE FROM etag_cache WHERE pathname = ?").run(pathname);
  }

  loadAllEtags() {
    const rows = this.db.prepare("SELECT * FROM etag_cache").all();
    const map = {};
    for (const row of rows) {
      map[row.pathname] = {
        etag: row.etag,
        data: JSON.parse(row.data),
        fetched_at: row.fetched_at,
      };
    }
    return map;
  }

  cleanupEtagCache(maxAgeMs) {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    return this.db.prepare("DELETE FROM etag_cache WHERE fetched_at < ?").run(cutoff).changes;
  }
}

module.exports = { UsageStore, USAGE_TTL_MS, SEATS_TTL_MS };
