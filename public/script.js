/* ── DOM refs ── */
var refreshBtn = document.getElementById("refreshBtn");
var tbody = document.getElementById("tbody");
var meta = document.getElementById("meta");
var errorBox = document.getElementById("error");
var singleDateInput = document.getElementById("singleDate");
var rangeStartInput = document.getElementById("rangeStart");
var rangeEndInput = document.getElementById("rangeEnd");
var tabs = document.querySelectorAll(".query-tabs .tab");
var singlePane = document.getElementById("singlePane");
var rangePane = document.getElementById("rangePane");
var modal = document.getElementById("modal");
var modalTitle = document.getElementById("modalTitle");
var modalBody = document.getElementById("modalBody");
var modalClose = document.getElementById("modalClose");
var btnSeats = document.getElementById("btnSeats");
var btnBillingSummary = document.getElementById("btnBillingSummary");
var btnModels = document.getElementById("btnModels");
var teamFilterBtn = document.getElementById("teamFilterBtn");
var teamFilterDropdown = document.getElementById("teamFilterDropdown");
var teamFilterAll = document.getElementById("teamFilterAll");
var teamFilterList = document.getElementById("teamFilterList");
var paginationEl = document.getElementById("pagination");

/* ── State ── */
var activeMode = "range";
var currentData = null;
var sortKey = "requests";
var sortAsc = false;
var includedQuota = 300;
var selectedTeams = null; /* null = all selected */
var latestMetaText = "尚未刷新数据";
var PAGE_SIZE = 15;
var MAX_VISIBLE_PAGES = 5;
var currentPage = 1;
var CACHE_PREFIX = "copilot-dashboard:usage:";
var CACHE_TTL_MS = 5 * 60 * 1000;

/* ── Helpers ── */
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function monthStartStr() {
  var d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-01";
}

function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatTs(isoText) {
  if (!isoText) return "\u672a\u5237\u65b0";
  var d = new Date(isoText);
  if (Number.isNaN(d.getTime())) return isoText;
  return d.toLocaleString("zh-CN", { hour12: false });
}

function setError(message) {
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
  if (Number.isNaN(d.getTime())) {
    return "GitHub API 速率限制已触发，系统会在稍后自动恢复，请稍后重试。";
  }
  return "GitHub API 速率限制已触发，预计 " + d.toLocaleString("zh-CN", { hour12: false }) + " 后恢复。";
}

async function apiFetchJson(url, options, fallbackMessage) {
  var resp = await fetch(url, options);
  var text = await resp.text();
  var data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_e) {
    data = null;
  }

  if (!resp.ok || (data && data.ok === false)) {
    var message = (data && data.message) || fallbackMessage || "请求失败";
    if (isRateLimitPayload(data, resp.status, message)) {
      throw new Error(formatRateLimitMessage(data));
    }
    throw new Error(message);
  }

  return data;
}

function cacheKeyForBody(body) {
  return CACHE_PREFIX + encodeURIComponent(JSON.stringify(body || {}));
}

function getCachedData(key) {
  try {
    var raw = localStorage.getItem(key);
    if (!raw) return null;
    var parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (Date.now() - Number(parsed.ts || 0) > CACHE_TTL_MS) return null;
    return parsed.data || null;
  } catch (_e) {
    return null;
  }
}

function setCachedData(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data: data }));
  } catch (_e) {
    /* Ignore localStorage write failures */
  }
}

function setMetaRefreshing(isRefreshing) {
  meta.classList.toggle("refreshing", Boolean(isRefreshing));
  meta.textContent = isRefreshing ? (latestMetaText + " | 后台刷新中...") : latestMetaText;
}

function renderSkeletonRows(colCount, rowCount) {
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

/* ── Date defaults ── */
singleDateInput.value = todayStr();
rangeStartInput.value = monthStartStr();
rangeEndInput.value = todayStr();

/* ── Query mode tabs ── */
tabs.forEach(function (tab) {
  tab.addEventListener("click", function () {
    tabs.forEach(function (t) { t.classList.remove("active"); });
    tab.classList.add("active");
    activeMode = tab.dataset.mode;
    singlePane.classList.toggle("active", activeMode === "single");
    rangePane.classList.toggle("active", activeMode === "range");
  });
});

/* ── Sort ── */
function updateSortArrows() {
  document.querySelectorAll("thead th[data-sort]").forEach(function (th) {
    var arrow = th.querySelector(".sort-arrow");
    if (th.dataset.sort === sortKey) {
      arrow.textContent = sortAsc ? " \u25B2" : " \u25BC";
      th.classList.add("sorted");
    } else {
      arrow.textContent = "";
      th.classList.remove("sorted");
    }
  });
}

function sortRows(rows) {
  return rows.slice().sort(function (a, b) {
    var va = a[sortKey], vb = b[sortKey];
    if (typeof va === "string") {
      return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
    }
    return sortAsc ? va - vb : vb - va;
  });
}

function buildMainRowHtml(row, isSingle) {
  var displayName = row.adName || row.user;
  if (isSingle) {
    return "<tr>" +
      "<td>" + escapeHtml(displayName) + "</td>" +
      "<td>" + escapeHtml(row.team || "-") + "</td>" +
      "<td>" + row.requests + "</td>" +
      "<td>" + buildCycleBar(row.cycleRequests, includedQuota) + "</td>" +
      "<td>" + row.percentage.toFixed(2) + "%</td>" +
      "<td>" + row.amount.toFixed(4) + "</td>" +
      "</tr>";
  }

  return "<tr>" +
    "<td>" + escapeHtml(displayName) + "</td>" +
    "<td>" + escapeHtml(row.team || "-") + "</td>" +
    "<td>" + buildCycleBar(row.requests, includedQuota) + "</td>" +
    "<td>" + row.percentage.toFixed(2) + "%</td>" +
    "<td>" + row.amount.toFixed(4) + "</td>" +
    "</tr>";
}

function renderRows(sortedRows, isSingle) {
  var totalPages = Math.max(1, Math.ceil(sortedRows.length / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;
  var start = (currentPage - 1) * PAGE_SIZE;
  var end = Math.min(start + PAGE_SIZE, sortedRows.length);
  var html = "";
  for (var i = start; i < end; i += 1) {
    html += buildMainRowHtml(sortedRows[i], isSingle);
  }
  tbody.innerHTML = html;
  renderPagination(sortedRows.length, totalPages);
}

function renderPagination(total, totalPages) {
  if (totalPages <= 1) {
    paginationEl.innerHTML = "";
    paginationEl.classList.add("hidden");
    return;
  }
  paginationEl.classList.remove("hidden");

  var html = "";

  /* Prev button */
  if (currentPage > 1) {
    html += '<button class="page-btn page-prev" data-page="' + (currentPage - 1) + '">上一页</button>';
  }

  /* Page numbers */
  var pages = buildVisiblePages(totalPages);
  for (var i = 0; i < pages.length; i += 1) {
    var p = pages[i];
    if (p === "...") {
      html += '<span class="page-ellipsis">…</span>';
    } else {
      var cls = p === currentPage ? "page-btn active" : "page-btn";
      html += '<button class="' + cls + '" data-page="' + p + '">' + p + '</button>';
    }
  }

  /* Next button */
  if (currentPage < totalPages) {
    html += '<button class="page-btn page-next" data-page="' + (currentPage + 1) + '">下一页</button>';
  }

  paginationEl.innerHTML = html;
}

function buildVisiblePages(totalPages) {
  var pages = [];
  if (totalPages <= MAX_VISIBLE_PAGES + 2) {
    for (var i = 1; i <= totalPages; i += 1) pages.push(i);
    return pages;
  }

  /* Determine window around currentPage */
  var half = Math.floor(MAX_VISIBLE_PAGES / 2);
  var start = currentPage - half;
  var end = currentPage + half;

  if (start < 1) { start = 1; end = MAX_VISIBLE_PAGES; }
  if (end > totalPages) { end = totalPages; start = totalPages - MAX_VISIBLE_PAGES + 1; }

  pages.push(1);
  if (start > 2) pages.push("...");
  for (var j = start; j <= end; j += 1) {
    if (j !== 1 && j !== totalPages) pages.push(j);
  }
  if (end < totalPages - 1) pages.push("...");
  pages.push(totalPages);
  return pages;
}

/* Pagination click handler */
paginationEl.addEventListener("click", function (e) {
  var btn = e.target.closest(".page-btn");
  if (!btn) return;
  var page = parseInt(btn.dataset.page, 10);
  if (page && page !== currentPage) {
    currentPage = page;
    render();
  }
});

document.querySelector("table thead").addEventListener("click", function (e) {
  var th = e.target.closest("th[data-sort]");
  if (!th) return;
  var key = th.dataset.sort;
  if (sortKey === key) { sortAsc = !sortAsc; }
  else { sortKey = key; sortAsc = (key === "user" || key === "team"); }
  currentPage = 1;
  render();
});

/* ── Render main table ── */
function render(data) {
  if (data) currentData = data;
  if (!currentData) return;

  var rows = Array.isArray(currentData.ranking) ? currentData.ranking : [];
  var isSingle = currentData.queryMode === "single";
  var colCount = isSingle ? 6 : 5;
  if (currentData.includedQuota) includedQuota = currentData.includedQuota;

  /* Build team filter checkboxes */
  rebuildTeamFilter(rows);

  /* Apply team filter */
  if (selectedTeams) {
    rows = rows.filter(function (r) {
      var t = (r.team || "-").split(",");
      return t.some(function (s) { return selectedTeams.has(s.trim()); });
    });
  }

  meta.textContent =
    "\u6570\u636e\u6e90: " + (currentData.source || "-") +
    (currentData.dateLabel ? " | \u67e5\u8be2: " + currentData.dateLabel : "") +
    " | \u6700\u540e\u5237\u65b0: " + formatTs(currentData.fetchedAt);
  latestMetaText = meta.textContent;

  /* Dynamic headers */
  var theadTr = document.querySelector("table thead tr");
  if (isSingle) {
    theadTr.innerHTML =
      '<th data-sort="user">\u7528\u6237 <span class="sort-arrow"></span></th>' +
      '<th data-sort="team">Team <span class="sort-arrow"></span></th>' +
      '<th data-sort="requests">\u5f53\u65e5\u8bf7\u6c42\u91cf <span class="sort-arrow"></span></th>' +
      '<th data-sort="cycleRequests">\u672c\u5468\u671f\u8bf7\u6c42\u91cf <span class="sort-arrow"></span></th>' +
      '<th data-sort="percentage">Premium requests(%) <span class="sort-arrow"></span></th>' +
      '<th data-sort="amount">\u91d1\u989d(USD) <span class="sort-arrow"></span></th>';
  } else {
    theadTr.innerHTML =
      '<th data-sort="user">\u7528\u6237 <span class="sort-arrow"></span></th>' +
      '<th data-sort="team">Team <span class="sort-arrow"></span></th>' +
      '<th data-sort="requests">\u672c\u5468\u671f\u8bf7\u6c42\u91cf <span class="sort-arrow"></span></th>' +
      '<th data-sort="percentage">Premium requests(%) <span class="sort-arrow"></span></th>' +
      '<th data-sort="amount">\u91d1\u989d(USD) <span class="sort-arrow"></span></th>';
  }

  if (!rows.length) {
    var emptyMsg = currentData.fetchedAt
      ? "\u8be5\u65e5\u671f\u6682\u65e0\u7528\u91cf\u6570\u636e\uff08\u8d26\u5355\u6570\u636e\u901a\u5e38\u6709 24\uff5e48 \u5c0f\u65f6\u5ef6\u8fdf\uff09\u3002"
      : "\u6682\u65e0\u6570\u636e\uff0c\u8bf7\u5148\u70b9\u51fb\u201c\u5237\u65b0\u201d\u3002";
    tbody.innerHTML = '<tr><td colspan="' + colCount + '" class="empty">' + emptyMsg + '</td></tr>';
    paginationEl.innerHTML = "";
    paginationEl.classList.add("hidden");
    updateSortArrows();
    return;
  }

  var sorted = sortRows(rows);
  renderRows(sorted, isSingle);
  updateSortArrows();
}

/* ── Team filter ── */
var allTeams = [];

function rebuildTeamFilter(rows) {
  var teamSet = new Set();
  rows.forEach(function (r) {
    var t = (r.team || "-").split(",");
    t.forEach(function (s) { teamSet.add(s.trim()); });
  });
  var teams = Array.from(teamSet).sort();
  if (JSON.stringify(teams) === JSON.stringify(allTeams)) return;
  allTeams = teams;

  teamFilterList.innerHTML = teams.map(function (team) {
    var checked = !selectedTeams || selectedTeams.has(team) ? "checked" : "";
    return '<label class="team-filter-item">' +
      '<input type="checkbox" value="' + escapeHtml(team) + '" ' + checked + ' /> ' +
      escapeHtml(team) + '</label>';
  }).join("");

  updateAllCheckbox();
}

function getCheckedTeams() {
  var boxes = teamFilterList.querySelectorAll('input[type="checkbox"]');
  var checked = [];
  boxes.forEach(function (cb) { if (cb.checked) checked.push(cb.value); });
  return checked;
}

function updateAllCheckbox() {
  var boxes = teamFilterList.querySelectorAll('input[type="checkbox"]');
  var total = boxes.length;
  var checked = getCheckedTeams().length;
  teamFilterAll.checked = checked === total;
  teamFilterAll.indeterminate = checked > 0 && checked < total;
  teamFilterBtn.textContent = checked === total ? "Team \u7b5b\u9009 \u25be" : "Team \u7b5b\u9009 (" + checked + ") \u25be";
  teamFilterBtn.classList.toggle("active", checked < total);
}

function applyTeamFilter() {
  var checked = getCheckedTeams();
  if (checked.length === allTeams.length) {
    selectedTeams = null;
  } else {
    selectedTeams = new Set(checked);
  }
  currentPage = 1;
  updateAllCheckbox();
  render();
}

teamFilterBtn.addEventListener("click", function (e) {
  e.stopPropagation();
  teamFilterDropdown.classList.toggle("open");
});

teamFilterAll.addEventListener("change", function () {
  var boxes = teamFilterList.querySelectorAll('input[type="checkbox"]');
  var state = teamFilterAll.checked;
  boxes.forEach(function (cb) { cb.checked = state; });
  applyTeamFilter();
});

teamFilterList.addEventListener("change", function () {
  applyTeamFilter();
});

document.addEventListener("click", function (e) {
  if (!e.target.closest("#teamFilter")) {
    teamFilterDropdown.classList.remove("open");
  }
});

/* ── Cycle requests progress bar ── */
function buildCycleBar(value, quota) {
  if (value == null) return "-";
  var ratio = quota > 0 ? value / quota : 0;
  var pct = Math.min(ratio * 100, 100);
  var level = ratio >= 1 ? "level-danger" : ratio >= 0.75 ? "level-warn" : "level-normal";
  var overTag = ratio > 1 ? ' <span class="cycle-bar-over">(超额)</span>' : '';
  return '<div class="cycle-bar">' +
    '<span class="cycle-bar-label">' + value + '/' + quota + overTag + '</span>' +
    '<div class="cycle-bar-track"><div class="cycle-bar-fill ' + level + '" style="width:' + pct.toFixed(1) + '%"></div></div>' +
    '</div>';
}

/* ── Build refresh body ── */
function buildBody() {
  if (activeMode === "single") return { queryMode: "single", date: singleDateInput.value };
  return { queryMode: "range", startDate: rangeStartInput.value, endDate: rangeEndInput.value };
}

/* ── Refresh ── */
async function loadCached() {
  setError("");
  var initialBody = buildBody();
  var key = cacheKeyForBody(initialBody);
  var cached = getCachedData(key);
  if (cached) {
    currentPage = 1;
    render(cached);
    setMetaRefreshing(true);
    return;
  }

  renderSkeletonRows(activeMode === "single" ? 6 : 5, 8);

  try {
    var data = await apiFetchJson("/api/usage", {}, "获取缓存数据失败");
    render(data);
    if (data && data.ranking && data.ranking.length) {
      setCachedData(key, data);
    }
  } catch (_e) {
    /* Keep skeleton until first refresh completes */
  }
}

async function refresh(options) {
  var opts = options || {};
  setError("");
  var body = buildBody();
  var key = cacheKeyForBody(body);
  var cached = getCachedData(key);

  if (cached) {
    render(cached);
  } else if (!currentData) {
    renderSkeletonRows(activeMode === "single" ? 6 : 5, 8);
  }

  currentPage = 1;

  refreshBtn.disabled = true;
  var oldText = refreshBtn.textContent;
  refreshBtn.textContent = opts.background ? "后台刷新中..." : "\u5237\u65b0\u4e2d...";
  setMetaRefreshing(true);
  try {
    var data = await apiFetchJson("/api/usage/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, "\u5237\u65b0\u5931\u8d25");
    render(data);
    setCachedData(key, data);
  } catch (err) {
    setError(err instanceof Error ? err.message : String(err));
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.textContent = oldText;
    setMetaRefreshing(false);
  }
}

refreshBtn.addEventListener("click", refresh);
loadCached()
  .then(function () {
    return refresh({ background: true });
  })
  .catch(function (err) {
    setMetaRefreshing(false);
    setError(err instanceof Error ? err.message : String(err));
  });

/* ── Auto refresh ── */
var autoRefreshSel = document.getElementById("autoRefreshSel");
var autoRefreshTimer = null;

function startAutoRefresh(seconds) {
  if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
  if (seconds > 0) {
    autoRefreshTimer = setInterval(function () {
      if (!refreshBtn.disabled) refresh({ background: true });
    }, seconds * 1000);
  }
}

autoRefreshSel.addEventListener("change", function () {
  startAutoRefresh(Number(autoRefreshSel.value));
});

/* ── Modal ── */
function openModal(title, html) {
  modalTitle.textContent = title;
  modalBody.innerHTML = html;
  modal.classList.add("open");
}
function closeModal() { modal.classList.remove("open"); }

async function forceRefreshSeatsCache() {
  return apiFetchJson("/api/seats?refresh=1", {}, "刷新用户席位失败");
}

modalClose.addEventListener("click", closeModal);
modal.addEventListener("click", function (e) {
  if (e.target === modal) closeModal();
});

/* ── Seats (用户 & Team) ── */

function modalSortableTable(headers, rows, defaultSortKey, defaultAsc) {
  var mSortKey = defaultSortKey || headers[0].key;
  var mSortAsc = defaultAsc != null ? defaultAsc : false;
  var container = document.createElement("div");

  function renderTable() {
    var sorted = rows.slice().sort(function (a, b) {
      var va = a[mSortKey], vb = b[mSortKey];
      if (va == null) va = "";
      if (vb == null) vb = "";
      if (typeof va === "string" && typeof vb === "string") {
        return mSortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
      }
      return mSortAsc ? va - vb : vb - va;
    });
    var html = '<table class="modal-sortable"><thead><tr>';
    headers.forEach(function (h) {
      var arrow = h.key === mSortKey ? (mSortAsc ? " \u25B2" : " \u25BC") : "";
      html += '<th data-mkey="' + h.key + '" style="cursor:pointer">' + escapeHtml(h.label) + arrow + '</th>';
    });
    html += '</tr></thead><tbody>';
    sorted.forEach(function (row) {
      html += '<tr>';
      headers.forEach(function (h) {
        html += '<td>' + (row["__html_" + h.key] || escapeHtml(String(row[h.key] != null ? row[h.key] : "-"))) + '</td>';
      });
      html += '</tr>';
    });
    html += '</tbody></table>';
    container.innerHTML = html;

    container.querySelectorAll("th[data-mkey]").forEach(function (th) {
      th.addEventListener("click", function () {
        var k = th.getAttribute("data-mkey");
        if (mSortKey === k) { mSortAsc = !mSortAsc; }
        else { mSortKey = k; mSortAsc = true; }
        renderTable();
      });
    });
  }

  renderTable();
  return container;
}

btnSeats.addEventListener("click", async function () {
  openModal("\u7528\u6237 & Team \u4fe1\u606f", '<div class="loading">\u52a0\u8f7d\u4e2d...</div>');
  try {
    var seatsData = await forceRefreshSeatsCache();
    var teamsData = await apiFetchJson("/api/enterprise-teams", {}, "获取 Team 列表失败");

    var html = "";

    /* Tab bar */
    html += '<div class="modal-tabs"><button class="modal-tab active" data-mtab="teams">Teams</button>';
    html += '<button class="modal-tab" data-mtab="users">\u7528\u6237\u5e2d\u4f4d</button></div>';
    html += '<div id="mtab-teams" class="mtab-pane active"></div>';
    html += '<div id="mtab-users" class="mtab-pane"></div>';

    modalBody.innerHTML = html;

    /* Tab switching */
    modalBody.querySelectorAll(".modal-tab").forEach(function (tab) {
      tab.addEventListener("click", function () {
        modalBody.querySelectorAll(".modal-tab").forEach(function (t) { t.classList.remove("active"); });
        modalBody.querySelectorAll(".mtab-pane").forEach(function (p) { p.classList.remove("active"); });
        tab.classList.add("active");
        document.getElementById("mtab-" + tab.dataset.mtab).classList.add("active");
      });
    });

    /* Teams tab content */
    var teamsPane = document.getElementById("mtab-teams");
    if (teamsData.ok && teamsData.teams && teamsData.teams.length > 0) {
      var tHtml = '<div class="team-list">';
      teamsData.teams.forEach(function (team) {
        tHtml += '<div class="team-card" data-team-id="' + team.id + '">';
        tHtml += '<div class="team-card-header">';
        tHtml += '<span class="team-name-link">' + escapeHtml(team.name) + '</span>';
        tHtml += '<span class="team-toggle">\u25B6</span>';
        tHtml += '</div>';
        if (team.description) {
          tHtml += '<div class="team-desc">' + escapeHtml(team.description) + '</div>';
        }
        tHtml += '<div class="team-members" style="display:none"><div class="loading">\u70b9\u51fb Team \u540d\u79f0\u52a0\u8f7d\u6210\u5458...</div></div>';
        tHtml += '</div>';
      });
      tHtml += '</div>';
      teamsPane.innerHTML = tHtml;

      /* Click team name to load members */
      teamsPane.querySelectorAll(".team-card").forEach(function (card) {
        var header = card.querySelector(".team-card-header");
        var membersDiv = card.querySelector(".team-members");
        var toggle = card.querySelector(".team-toggle");
        var loaded = false;

        header.addEventListener("click", async function () {
          var visible = membersDiv.style.display !== "none";
          if (visible) {
            membersDiv.style.display = "none";
            toggle.textContent = "\u25B6";
            return;
          }
          membersDiv.style.display = "block";
          toggle.textContent = "\u25BC";

          if (loaded) return;
          membersDiv.innerHTML = '<div class="loading">\u52a0\u8f7d\u4e2d...</div>';
          try {
            var mData = await apiFetchJson("/api/enterprise-teams/" + card.dataset.teamId + "/members", {}, "获取 Team 成员失败");
            var members = mData.members || [];
            if (members.length === 0) {
              membersDiv.innerHTML = '<div style="color:var(--muted);padding:8px 0">\u65e0\u6210\u5458</div>';
            } else {
              var mHtml = '<div class="member-grid">';
              members.forEach(function (m) {
                mHtml += '<div class="member-item">';
                mHtml += '<img src="' + escapeHtml(m.avatarUrl) + '&s=32" width="24" height="24" style="border-radius:50%;vertical-align:middle" /> ';
                mHtml += '<span>' + escapeHtml(m.login) + '</span>';
                mHtml += '</div>';
              });
              mHtml += '</div>';
              membersDiv.innerHTML = '<div style="padding:4px 0;color:var(--muted);font-size:13px">' + members.length + ' \u4e2a\u6210\u5458</div>' + mHtml;
            }
            loaded = true;
          } catch (err) {
            membersDiv.innerHTML = '<div style="color:var(--danger)">' + escapeHtml(err.message) + '</div>';
          }
        });
      });
    } else {
      teamsPane.innerHTML = '<div style="color:var(--muted);padding:12px 0">\u65e0 Enterprise Teams \u6570\u636e</div>';
    }

    /* Users tab content — sortable table */
    var usersPane = document.getElementById("mtab-users");
    var seats = seatsData.seats || [];
    var infoLine = document.createElement("p");
    infoLine.innerHTML = "\u603b\u5e2d\u4f4d: <strong>" + seatsData.totalSeats + "</strong>\u3000\u66f4\u65b0\u65f6\u95f4: " + formatTs(seatsData.fetchedAt);
    usersPane.appendChild(infoLine);

    var seatRows = seats.map(function (s) {
      return {
        login: s.login,
        team: s.team,
        planType: s.planType,
        lastActivityAt: s.lastActivityAt || "",
        "__html_lastActivityAt": formatTs(s.lastActivityAt),
        lastActivityEditor: s.lastActivityEditor || "-",
      };
    });
    var seatTable = modalSortableTable(
      [
        { key: "login", label: "\u7528\u6237" },
        { key: "team", label: "Team" },
        { key: "planType", label: "\u8ba1\u5212" },
        { key: "lastActivityAt", label: "\u6700\u540e\u6d3b\u8dc3" },
        { key: "lastActivityEditor", label: "\u7f16\u8f91\u5668" },
      ],
      seatRows,
      "login",
      true
    );
    usersPane.appendChild(seatTable);
  } catch (err) {
    modalBody.innerHTML = '<div style="color:var(--danger)">' + escapeHtml(err.message) + "</div>";
  }
});

/* ── Billing Summary (整体账单汇总) ── */
btnBillingSummary.addEventListener("click", async function () {
  openModal("\u6574\u4f53\u8d26\u5355\u6c47\u603b", '<div class="loading">\u52a0\u8f7d\u4e2d...</div>');
  try {
    await forceRefreshSeatsCache();
    var data = await apiFetchJson("/api/billing/summary", {}, "获取账单汇总失败");

    var html = "";

    /* Section 1: Seat subscription */
    html += '<h3>\u5e2d\u4f4d\u8ba2\u9605</h3>';
    html += '<table><thead><tr><th>\u8ba2\u9605\u8ba1\u5212</th><th>\u5e2d\u4f4d\u6570</th><th>\u5355\u4ef7(\u6708)</th><th>\u5c0f\u8ba1(USD)</th><th>\u5355\u5e2d\u4f4d\u989d\u5ea6</th><th>\u603b\u989d\u5ea6</th></tr></thead><tbody>';
    (data.planSummary || []).forEach(function (p) {
      html += "<tr>" +
        "<td>Copilot " + escapeHtml(p.plan) + "</td>" +
        "<td>" + p.seats + "</td>" +
        "<td>$" + p.baseCost + "</td>" +
        "<td>$" + p.totalCost.toFixed(2) + "</td>" +
        "<td>" + p.quotaPerSeat + " requests</td>" +
        "<td>" + p.totalQuota + " requests</td>" +
        "</tr>";
    });
    html += '</tbody></table>';

    /* Section 2: Premium requests overview */
    html += '<h3>Premium Requests \u4f7f\u7528\u60c5\u51b5</h3>';
    html += '<table><thead><tr><th>\u9879\u76ee</th><th>\u503c</th></tr></thead><tbody>';
    html += '<tr><td>\u672c\u6708\u603b Premium Requests</td><td>' + data.totalPremiumRequests + '</td></tr>';
    html += '<tr><td>\u8ba2\u9605\u5305\u542b\u989d\u5ea6</td><td>' + data.totalIncludedQuota + ' requests (' + data.totalSeats + ' \u5e2d\u4f4d)</td></tr>';
    var usedPct = data.totalIncludedQuota > 0 ? (data.totalPremiumRequests / data.totalIncludedQuota * 100).toFixed(1) : "0";
    html += '<tr><td>\u989d\u5ea6\u4f7f\u7528\u7387</td><td>' + usedPct + '%</td></tr>';
    html += '<tr><td>\u8d85\u989d\u8bf7\u6c42\u6570</td><td>' + data.overageRequests + '</td></tr>';
    html += '<tr><td>\u8d85\u989d\u5355\u4ef7</td><td>$' + data.premiumUnitPrice + '/request</td></tr>';
    html += '<tr><td>\u8d85\u989d\u8d39\u7528</td><td>$' + data.overageCost.toFixed(4) + '</td></tr>';
    html += '</tbody></table>';

    /* Section 3: Cost summary */
    html += '<h3>\u8d39\u7528\u6c47\u603b</h3>';
    html += '<table><thead><tr><th>\u9879\u76ee</th><th>\u91d1\u989d(USD)</th></tr></thead><tbody>';
    html += '<tr><td>\u5e2d\u4f4d\u8ba2\u9605\u8d39</td><td>$' + data.totalSeatsCost.toFixed(2) + '</td></tr>';
    html += '<tr><td>Premium Requests \u8d85\u989d\u8d39</td><td>$' + data.overageCost.toFixed(4) + '</td></tr>';
    html += '<tr style="font-weight:bold;border-top:2px solid var(--border)"><td>\u672c\u6708\u9884\u4f30\u603b\u8d39\u7528</td><td>$' + data.totalEstimatedCost.toFixed(4) + '</td></tr>';
    html += '</tbody></table>';

    /* Section 4: Raw billing items (collapsed) */
    html += '<details style="margin-top:1rem"><summary style="cursor:pointer;color:var(--muted)">\u67e5\u770b API \u539f\u59cb\u8ba1\u8d39\u6570\u636e</summary>';
    html += '<table style="margin-top:0.5rem"><thead><tr><th>SKU</th><th>\u6570\u91cf</th><th>\u5355\u4f4d</th><th>\u5355\u4ef7</th><th>\u603b\u989d</th><th>\u6298\u6263</th><th>\u51c0\u989d</th></tr></thead><tbody>';
    (data.rawItems || []).forEach(function (item) {
      html += "<tr>" +
        "<td>" + escapeHtml(item.sku) + "</td>" +
        "<td>" + (item.quantity != null ? item.quantity.toFixed(2) : "-") + "</td>" +
        "<td>" + escapeHtml(item.unitType) + "</td>" +
        "<td>$" + (item.pricePerUnit != null ? item.pricePerUnit.toFixed(2) : "-") + "</td>" +
        "<td>$" + (item.grossAmount != null ? item.grossAmount.toFixed(4) : "-") + "</td>" +
        "<td>$" + (item.discountAmount != null ? item.discountAmount.toFixed(4) : "-") + "</td>" +
        "<td>$" + (item.netAmount != null ? item.netAmount.toFixed(4) : "-") + "</td>" +
        "</tr>";
    });
    html += '</tbody></table></details>';

    modalBody.innerHTML = html;
  } catch (err) {
    modalBody.innerHTML = '<div style="color:var(--danger)">' + escapeHtml(err.message) + "</div>";
  }
});

/* ── Models (模型使用排行) ── */
btnModels.addEventListener("click", async function () {
  openModal("\u6a21\u578b\u4f7f\u7528\u6392\u884c", '<div class="loading">\u52a0\u8f7d\u4e2d...</div>');
  try {
    await forceRefreshSeatsCache();
    var now = new Date();
    var year = now.getFullYear();
    var month = now.getMonth() + 1;
    var data = await apiFetchJson("/api/billing/models?year=" + year + "&month=" + month, {}, "获取模型排行失败");
    var models = data.models || [];
    var html = "<p>" + data.year + "\u5e74" + data.month + "\u6708\u3000\u603b\u8bf7\u6c42: <strong>" + data.totalQuantity + "</strong>\u3000\u603b\u91d1\u989d: <strong>$" + data.totalAmount.toFixed(4) + "</strong></p>";
    html += '<table><thead><tr><th>\u6a21\u578b</th><th>\u8bf7\u6c42\u91cf</th><th>\u5360\u6bd4(%)</th><th>\u5355\u4ef7</th><th>\u91d1\u989d(USD)</th></tr></thead><tbody>';
    models.forEach(function (m) {
      var pct = data.totalQuantity > 0 ? (m.grossQuantity / data.totalQuantity * 100).toFixed(2) : "0.00";
      html += "<tr>" +
        "<td>" + escapeHtml(m.model) + "</td>" +
        "<td>" + m.grossQuantity + "</td>" +
        "<td>" + pct + "%</td>" +
        "<td>$" + m.pricePerUnit.toFixed(2) + "</td>" +
        "<td>$" + m.grossAmount.toFixed(4) + "</td>" +
        "</tr>";
    });
    html += "</tbody></table>";
    modalBody.innerHTML = html;
  } catch (err) {
    modalBody.innerHTML = '<div style="color:var(--danger)">' + escapeHtml(err.message) + "</div>";
  }
});
