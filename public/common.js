/**
 * common.js – shared frontend utilities used by script.js, costcenter.js, analytics.js
 * Loaded before page-specific scripts.
 */
var CopilotDashboard = (function () {
  "use strict";

  function escapeHtml(str) {
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function formatTs(isoText) {
    if (!isoText) return "\u672a\u5237\u65b0";
    var d = new Date(isoText);
    if (Number.isNaN(d.getTime())) return isoText;
    return d.toLocaleString("zh-CN", { hour12: false });
  }

  function setError(errorBox, message) {
    if (!message) { errorBox.hidden = true; errorBox.textContent = ""; return; }
    errorBox.hidden = false;
    errorBox.textContent = message;
  }

  function isRateLimitPayload(data, status, message) {
    if (data && data.rateLimit && data.rateLimit.limitExceeded) return true;
    if (status === 429) return true;
    return /rate limit|secondary rate limit/i.test(String(message || ""));
  }

  function formatRateLimitMessage(data) {
    var resetAt = data && data.rateLimit ? data.rateLimit.resetAt : null;
    if (!resetAt) return "GitHub API 速率限制已触发，系统会在稍后自动恢复，请稍后重试。";
    var d = new Date(resetAt);
    if (Number.isNaN(d.getTime())) return "GitHub API 速率限制已触发，系统会在稍后自动恢复，请稍后重试。";
    return "GitHub API 速率限制已触发，预计 " + d.toLocaleString("zh-CN", { hour12: false }) + " 后恢复。";
  }

  function apiFetchJson(url, options, fallbackMessage) {
    return fetch(url, options)
      .then(function (resp) {
        return resp.text().then(function (text) {
          var data = null;
          try { data = text ? JSON.parse(text) : null; } catch (_e) { data = null; }
          if (!resp.ok || (data && data.ok === false)) {
            var message = (data && data.message) || fallbackMessage || "请求失败";
            if (isRateLimitPayload(data, resp.status, message)) throw new Error(formatRateLimitMessage(data));
            throw new Error(message);
          }
          return data;
        });
      });
  }

  function toNumber(value) {
    var n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function formatUsd(value) {
    if (value == null || Number.isNaN(Number(value))) return "--";
    return "$" + Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function renderSkeletonRows(tbody, colCount, rowCount) {
    var rows = [];
    for (var i = 0; i < rowCount; i += 1) {
      rows.push(
        '<tr class="skeleton-row">' +
        Array(colCount).fill('<td><span class="skeleton-line"></span></td>').join("") +
        "</tr>"
      );
    }
    tbody.innerHTML = rows.join("");
  }

  function setMetaRefreshing(metaEl, latestMetaText, isRefreshing) {
    metaEl.classList.toggle("refreshing", Boolean(isRefreshing));
    metaEl.textContent = isRefreshing ? (latestMetaText + " | 后台刷新中...") : latestMetaText;
  }

  /* localStorage cache helpers */
  function getCachedData(key, ttl) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      if (Date.now() - Number(parsed.ts || 0) > ttl) return null;
      return parsed.data || null;
    } catch (_e) { return null; }
  }

  function setCachedData(key, data) {
    try { localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data: data })); } catch (_e) { /* noop */ }
  }

  return {
    escapeHtml: escapeHtml,
    formatTs: formatTs,
    setError: setError,
    isRateLimitPayload: isRateLimitPayload,
    formatRateLimitMessage: formatRateLimitMessage,
    apiFetchJson: apiFetchJson,
    toNumber: toNumber,
    formatUsd: formatUsd,
    renderSkeletonRows: renderSkeletonRows,
    setMetaRefreshing: setMetaRefreshing,
    getCachedData: getCachedData,
    setCachedData: setCachedData,
  };
})();
