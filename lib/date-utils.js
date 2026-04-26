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
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/**
 * Enumerate every day between startStr and endStr (inclusive).
 * Returns [{ year, month, day }].
 */
function enumerateDays(startStr, endStr) {
  const days = [];
  const cur = new Date(startStr + "T00:00:00Z");
  const end = new Date(endStr + "T00:00:00Z");
  if (Number.isNaN(cur.getTime()) || Number.isNaN(end.getTime())) return days;
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

module.exports = { parseDateStr, enumerateDays, buildDateKey };
