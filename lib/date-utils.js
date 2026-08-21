/**
 * Date utility helpers – used by usage-store, server routes, and tests.
 */

/**
 * Parse a "YYYY-MM-DD" string into { year, month, day } or null.
 */
function parseDateStr(str) {
  if (!str || typeof str !== "string") return null;
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const parsed = new Date(`${str}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== str) return null;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/**
 * Enumerate every day between startStr and endStr (inclusive).
 * Returns [{ year, month, day }].
 */
function enumerateDays(startStr, endStr) {
  const days = [];
  const startParts = parseDateStr(startStr);
  const endParts = parseDateStr(endStr);
  if (!startParts || !endParts) return days;
  const cur = new Date(Date.UTC(startParts.year, startParts.month - 1, startParts.day));
  const end = new Date(Date.UTC(endParts.year, endParts.month - 1, endParts.day));
  while (cur <= end) {
    days.push({
      year: cur.getUTCFullYear(),
      month: cur.getUTCMonth() + 1,
      day: cur.getUTCDate(),
    });
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

/**
 * Build a date key like "YYYY-MM-DD" or "YYYY-MM".
 */
function buildDateKey(year, month, day) {
  if (day) {
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  return `${year}-${String(month).padStart(2, "0")}`;
}

function assessPeriodCoverage(startStr, endStr, availableDates) {
  const expectedDates = enumerateDays(startStr, endStr)
    .map(({ year, month, day }) => buildDateKey(year, month, day));
  const available = new Set(availableDates || []);
  const missingDates = expectedDates.filter((date) => !available.has(date));
  return {
    complete: expectedDates.length > 0 && missingDates.length === 0,
    expectedDays: expectedDates.length,
    missingDates,
  };
}

module.exports = { parseDateStr, enumerateDays, buildDateKey, assessPeriodCoverage };
