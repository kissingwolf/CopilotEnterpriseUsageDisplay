/**
 * Lightweight scheduler for daily usage refresh.
 *
 * Behavior:
 *  - On startup: refresh today's data (UTC date) once, after a short delay,
 *    so the dashboard has fresh-as-possible numbers when first accessed.
 *  - At each configured local-time slot (default 03:00 and 12:00):
 *    force-refresh the previous N days (default 2 = yesterday + day before),
 *    bypassing memory + SQLite TTL.
 *
 * Multi-instance safety:
 *  - Set SCHED_DISABLED=true to disable on read replicas / extra workers.
 *
 * Configuration (env vars):
 *  - SCHED_DISABLED         "true" to disable scheduler entirely
 *  - SCHED_DAILY_TIMES      comma-separated HH:MM list, default "03:00,12:00"
 *  - SCHED_BACKFILL_DAYS    integer, default 2 (refresh last N days)
 *  - SCHED_STARTUP_DELAY_MS integer, default 5000 (delay before initial run)
 */

const logger = require("./logger");

function parseTimes(spec) {
  const out = [];
  for (const raw of String(spec || "").split(",")) {
    const s = raw.trim();
    if (!s) continue;
    const m = s.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) continue;
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) continue;
    out.push({ hh, mm });
  }
  return out;
}

function msUntilNext(hh, mm) {
  const now = new Date();
  const target = new Date(now);
  target.setHours(hh, mm, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime() - now.getTime();
}

function utcDateString(offsetDays) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + (offsetDays || 0));
  return d.toISOString().slice(0, 10);
}

function startScheduler({ forceRefreshDay }) {
  if (typeof forceRefreshDay !== "function") {
    throw new Error("startScheduler requires forceRefreshDay()");
  }

  const disabled = String(process.env.SCHED_DISABLED || "").toLowerCase() === "true";
  if (disabled) {
    logger.info("Scheduler disabled via SCHED_DISABLED=true");
    return { stop: () => {} };
  }

  const times = parseTimes(process.env.SCHED_DAILY_TIMES || "03:00,12:00");
  if (times.length === 0) {
    logger.warn("Scheduler: no valid times in SCHED_DAILY_TIMES, scheduler not started");
    return { stop: () => {} };
  }
  const backfillDays = Math.max(1, Number(process.env.SCHED_BACKFILL_DAYS || 2));
  const startupDelayMs = Math.max(0, Number(process.env.SCHED_STARTUP_DELAY_MS || 5000));

  const timers = new Set();
  let stopped = false;

  async function refreshRecentDays(label) {
    const dates = [];
    // Refresh "today" + previous (backfillDays) days. Today is always included
    // so latest partial data is updated; older ones cover GitHub's 24-48h lag.
    for (let i = 0; i <= backfillDays; i += 1) {
      dates.push(utcDateString(-i));
    }
    logger.info({ trigger: label, dates }, "Scheduler: starting refresh");
    for (const dateStr of dates) {
      if (stopped) return;
      try {
        const { result } = await forceRefreshDay(dateStr);
        logger.info(
          { trigger: label, date: dateStr, mode: result.mode, items: result.rawItemsCount },
          "Scheduler: refreshed"
        );
      } catch (err) {
        logger.warn(
          { trigger: label, date: dateStr, err: err.message },
          "Scheduler: refresh failed"
        );
      }
    }
  }

  async function refreshTodayOnly(label) {
    const dateStr = utcDateString(0);
    try {
      const { result } = await forceRefreshDay(dateStr);
      logger.info(
        { trigger: label, date: dateStr, mode: result.mode, items: result.rawItemsCount },
        "Scheduler: startup refresh done"
      );
    } catch (err) {
      logger.warn({ trigger: label, date: dateStr, err: err.message }, "Scheduler: startup refresh failed");
    }
  }

  function scheduleNext(slot) {
    if (stopped) return;
    const delay = msUntilNext(slot.hh, slot.mm);
    const t = setTimeout(async () => {
      timers.delete(t);
      const label = `daily-${String(slot.hh).padStart(2, "0")}:${String(slot.mm).padStart(2, "0")}`;
      try {
        await refreshRecentDays(label);
      } catch (err) {
        logger.error({ err: err.message }, "Scheduler: unexpected error in slot run");
      }
      scheduleNext(slot);
    }, delay);
    timers.add(t);
    logger.info(
      { hh: slot.hh, mm: slot.mm, delayMs: delay },
      "Scheduler: next slot scheduled"
    );
  }

  // Schedule recurring slots
  for (const slot of times) scheduleNext(slot);

  // Initial startup refresh (today only) — delayed so app fully comes up first
  const startupTimer = setTimeout(() => {
    timers.delete(startupTimer);
    refreshTodayOnly("startup").catch(() => { /* logged inside */ });
  }, startupDelayMs);
  timers.add(startupTimer);

  logger.info(
    { times: times.map((t) => `${t.hh}:${String(t.mm).padStart(2, "0")}`), backfillDays, startupDelayMs },
    "Scheduler started"
  );

  return {
    stop() {
      stopped = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      logger.info("Scheduler stopped");
    },
  };
}

module.exports = { startScheduler };
