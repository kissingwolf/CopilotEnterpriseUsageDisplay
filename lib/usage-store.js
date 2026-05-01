const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const logger = require("./logger");

const USAGE_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const SEATS_TTL_MS = 10 * 60 * 1000; // 10 minutes (matches original seats TTL)
const MAX_SEATS_SNAPSHOTS = 20; // keep at most N snapshots

class UsageStore {
  constructor(dataDir) {
    this.dataDir = dataDir || path.join(__dirname, "..", "data");
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.dbPath = path.join(this.dataDir, "usage.db");
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this._initSchema();
    this._prepareStatements();
  }

  /* ── Schema ── */

  _initSchema() {
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

      CREATE TABLE IF NOT EXISTS monthly_bill (
        year_month       TEXT NOT NULL,
        team             TEXT NOT NULL,
        login            TEXT NOT NULL,
        ad_name          TEXT,
        plan_type        TEXT NOT NULL,
        seat_cost        REAL NOT NULL,
        requests         REAL NOT NULL,
        quota            INTEGER NOT NULL,
        overage_requests REAL NOT NULL,
        overage_cost     REAL NOT NULL,
        total_cost       REAL NOT NULL,
        computed_at      TEXT NOT NULL,
        PRIMARY KEY (year_month, login)
      );
      CREATE INDEX IF NOT EXISTS idx_monthly_bill_ym ON monthly_bill(year_month);
    `);

    /* Migration: add ranking column if it doesn't exist */
    try {
      this.db.exec("ALTER TABLE daily_usage ADD COLUMN ranking TEXT");
    } catch (_e) {
      /* Column already exists, ignore */
    }

    /* Migration: add ad_name column to monthly_bill if it doesn't exist */
    try {
      this.db.exec("ALTER TABLE monthly_bill ADD COLUMN ad_name TEXT");
    } catch (_e) {
      /* Column already exists, ignore */
    }
  }

  /* ── Prepared statements (created once, reused on every call) ── */

  _prepareStatements() {
    this._stmts = {
      getDay: this.db.prepare("SELECT * FROM daily_usage WHERE date = ?"),
      saveDay: this.db.prepare(`
        INSERT OR REPLACE INTO daily_usage (date, year, month, day, data, mode, raw_count, source, fetched_at, ranking)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      getDaysInRange: this.db.prepare(
        "SELECT * FROM daily_usage WHERE date >= ? AND date <= ? ORDER BY date"
      ),
      getDatesInRange: this.db.prepare(
        "SELECT date FROM daily_usage WHERE date >= ? AND date <= ?"
      ),
      getFreshDates: this.db.prepare(
        "SELECT date FROM daily_usage WHERE date >= ? AND date <= ? AND fetched_at > ?"
      ),
      cleanupOldData: this.db.prepare("DELETE FROM daily_usage WHERE fetched_at < ?"),
      deleteDaysInMonth: this.db.prepare("DELETE FROM daily_usage WHERE year = ? AND month = ?"),

      saveSeats: this.db.prepare(
        "INSERT INTO seats_snapshot (data, fetched_at, total) VALUES (?, ?, ?)"
      ),
      getLatestSeats: this.db.prepare(
        "SELECT * FROM seats_snapshot ORDER BY fetched_at DESC LIMIT 1"
      ),
      countSeatsSnapshots: this.db.prepare("SELECT COUNT(*) AS cnt FROM seats_snapshot"),
      deleteOldSeats: this.db.prepare(
        "DELETE FROM seats_snapshot WHERE id NOT IN (SELECT id FROM seats_snapshot ORDER BY fetched_at DESC LIMIT ?)"
      ),

      getEtag: this.db.prepare("SELECT * FROM etag_cache WHERE pathname = ?"),
      saveEtag: this.db.prepare(
        "INSERT OR REPLACE INTO etag_cache (pathname, etag, data, fetched_at) VALUES (?, ?, ?, ?)"
      ),
      deleteEtag: this.db.prepare("DELETE FROM etag_cache WHERE pathname = ?"),
      loadAllEtags: this.db.prepare("SELECT * FROM etag_cache"),
      cleanupEtags: this.db.prepare("DELETE FROM etag_cache WHERE fetched_at < ?"),

      getBill: this.db.prepare("SELECT * FROM monthly_bill WHERE year_month = ? ORDER BY team, login"),
      getBillMeta: this.db.prepare("SELECT computed_at FROM monthly_bill WHERE year_month = ? LIMIT 1"),
      saveBillRow: this.db.prepare(`
        INSERT OR REPLACE INTO monthly_bill (year_month, team, login, ad_name, plan_type, seat_cost, requests, quota, overage_requests, overage_cost, total_cost, computed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      deleteBill: this.db.prepare("DELETE FROM monthly_bill WHERE year_month = ?"),
    };
  }

  close() {
    this.db.close();
  }

  /* ── Daily usage ── */

  getDay(dateStr) {
    const row = this._stmts.getDay.get(dateStr);
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
    this._stmts.saveDay.run(
      dateStr, year, month, day,
      JSON.stringify(data), mode, raw_count, source, fetchedAt,
      ranking ? JSON.stringify(ranking) : null
    );
  }

  getDaysInRange(startStr, endStr) {
    return this._stmts.getDaysInRange.all(startStr, endStr);
  }

  getMissingDays(startStr, endStr) {
    const rows = this._stmts.getDatesInRange.all(startStr, endStr);
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
    const rows = this._stmts.getFreshDates.all(startStr, endStr, cutoff);
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
    return this._stmts.cleanupOldData.run(cutoff).changes;
  }

  /**
   * Delete all daily_usage rows for a given (year, month).
   * Used by the "force refresh month" flow to drop possibly-stale entries
   * before re-fetching from GitHub.
   */
  deleteDaysInMonth(year, month) {
    return this._stmts.deleteDaysInMonth.run(year, month).changes;
  }

  /* ── Seats snapshot ── */

  saveSeatsSnapshot(seatsArray, fetchedAt) {
    this._stmts.saveSeats.run(JSON.stringify(seatsArray), fetchedAt, seatsArray.length);
    this._trimSeatsSnapshots();
  }

  getLatestSeatsSnapshot() {
    const row = this._stmts.getLatestSeats.get();
    if (!row) return null;
    return {
      data: JSON.parse(row.data),
      fetched_at: row.fetched_at,
      total: row.total,
    };
  }

  /** Keep only the latest N seats snapshots to prevent unbounded growth. */
  _trimSeatsSnapshots() {
    try {
      const { cnt } = this._stmts.countSeatsSnapshots.get();
      if (cnt > MAX_SEATS_SNAPSHOTS) {
        const info = this._stmts.deleteOldSeats.run(MAX_SEATS_SNAPSHOTS);
        if (info.changes > 0) {
          logger.info({ removed: info.changes }, "Trimmed old seats snapshots");
        }
      }
    } catch (e) {
      logger.warn({ err: e.message }, "Failed to trim seats snapshots");
    }
  }

  /* ── ETag cache ── */

  getEtag(pathname) {
    const row = this._stmts.getEtag.get(pathname);
    if (!row) return null;
    return {
      pathname: row.pathname,
      etag: row.etag,
      data: JSON.parse(row.data),
      fetched_at: row.fetched_at,
    };
  }

  saveEtag(pathname, etag, data, fetchedAt) {
    this._stmts.saveEtag.run(pathname, etag, JSON.stringify(data), fetchedAt);
  }

  deleteEtag(pathname) {
    this._stmts.deleteEtag.run(pathname);
  }

  loadAllEtags() {
    const rows = this._stmts.loadAllEtags.all();
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
    return this._stmts.cleanupEtags.run(cutoff).changes;
  }

  /* ── Monthly bill ── */

  getBill(yearMonth) {
    return this._stmts.getBill.all(yearMonth).map((row) => ({
      yearMonth: row.year_month,
      team: row.team,
      login: row.login,
      adName: row.ad_name || null,
      planType: row.plan_type,
      seatCost: row.seat_cost,
      requests: row.requests,
      quota: row.quota,
      overageRequests: row.overage_requests,
      overageCost: row.overage_cost,
      totalCost: row.total_cost,
      computedAt: row.computed_at,
    }));
  }

  hasBill(yearMonth) {
    const row = this._stmts.getBillMeta.get(yearMonth);
    return row ? row.computed_at : null;
  }

  saveBill(yearMonth, rows) {
    const tx = this.db.transaction((items) => {
      this._stmts.deleteBill.run(yearMonth);
      for (const r of items) {
        this._stmts.saveBillRow.run(
          yearMonth, r.team, r.login, r.adName || null, r.planType,
          r.seatCost, r.requests, r.quota,
          r.overageRequests, r.overageCost, r.totalCost,
          r.computedAt
        );
      }
    });
    tx(rows);
  }

  deleteBill(yearMonth) {
    return this._stmts.deleteBill.run(yearMonth).changes;
  }
}

module.exports = { UsageStore, USAGE_TTL_MS, SEATS_TTL_MS };
