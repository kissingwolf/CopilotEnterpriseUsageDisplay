(function () {
  "use strict";

  var C = CopilotDashboard; // alias

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
  var btnBudgetCost = document.getElementById("btnBudgetCost");
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
  var selectedTeams = null;
  var latestMetaText = "尚未刷新数据";
  var PAGE_SIZE = 15;
  var MAX_VISIBLE_PAGES = 5;
  var currentPage = 1;
  var CACHE_PREFIX = "copilot-dashboard:usage:";
  var CACHE_TTL_MS = 5 * 60 * 1000;

  /* ── Local helpers ── */
  function todayStr() { return new Date().toISOString().slice(0, 10); }
  function monthStartStr() {
    var d = new Date();
    return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-01";
  }

  function setError(msg) { C.setError(errorBox, msg); }
  function setMetaRefreshing(isRefreshing) { C.setMetaRefreshing(meta, latestMetaText, isRefreshing); }

  function buildUserCountFromResources(resources) {
    var users = 0;
    (resources || []).forEach(function (r) { if (String(r && r.type || "").toLowerCase() === "user") users += 1; });
    return users;
  }

  function renderBudgetProgressCell(amount, spentAmount) {
    if (amount == null || Number.isNaN(Number(amount))) return '<span class="budget-na">--</span>';
    var budgetNum = C.toNumber(amount);
    var spentNum = spentAmount == null ? null : C.toNumber(spentAmount);
    if (spentNum == null) {
      return '<div class="budget-cell"><span class="budget-spent">-- spent</span><span class="budget-total">' + C.formatUsd(budgetNum) + ' budget</span></div>';
    }
    var ratio = budgetNum > 0 ? spentNum / budgetNum : 0;
    var percent = budgetNum > 0 ? ratio * 100 : 0;
    var width = Math.min(Math.max(percent, 0), 100);
    var level = ratio >= 1 ? "danger" : ratio >= 0.75 ? "warn" : "normal";
    var over = ratio >= 1 ? '<span class="budget-over">超预算</span>' : "";
    return '<div class="budget-cell budget-progress-cell">' +
      '<div class="budget-top"><span class="budget-spent">' + C.formatUsd(spentNum) + ' / ' + C.formatUsd(budgetNum) + '</span><span class="budget-pct">' + percent.toFixed(1) + '%</span></div>' +
      '<div class="budget-bar"><div class="budget-bar-fill budget-' + level + '" style="width:' + width.toFixed(1) + '%"></div></div>' +
      over + '</div>';
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
      } else { arrow.textContent = ""; th.classList.remove("sorted"); }
    });
  }

  function sortRows(rows) {
    return rows.slice().sort(function (a, b) {
      var va = a[sortKey], vb = b[sortKey];
      if (typeof va === "string") return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
      return sortAsc ? va - vb : vb - va;
    });
  }

  function buildMainRowHtml(row, isSingle) {
    var displayName = row.adName || row.user;
    if (isSingle) {
      return "<tr>" +
        "<td>" + C.escapeHtml(displayName) + "</td>" +
        "<td>" + C.escapeHtml(row.team || "-") + "</td>" +
        "<td>" + row.requests + "</td>" +
        "<td>" + buildCycleBar(row.cycleRequests, includedQuota) + "</td>" +
        "<td>" + row.percentage.toFixed(2) + "%</td>" +
        "<td>" + row.amount.toFixed(4) + "</td></tr>";
    }
    return "<tr>" +
      "<td>" + C.escapeHtml(displayName) + "</td>" +
      "<td>" + C.escapeHtml(row.team || "-") + "</td>" +
      "<td>" + buildCycleBar(row.requests, includedQuota) + "</td>" +
      "<td>" + row.percentage.toFixed(2) + "%</td>" +
      "<td>" + row.amount.toFixed(4) + "</td></tr>";
  }

  function renderRows(sortedRows, isSingle) {
    var totalPages = Math.max(1, Math.ceil(sortedRows.length / PAGE_SIZE));
    if (currentPage > totalPages) currentPage = totalPages;
    var start = (currentPage - 1) * PAGE_SIZE;
    var end = Math.min(start + PAGE_SIZE, sortedRows.length);
    var html = "";
    for (var i = start; i < end; i += 1) html += buildMainRowHtml(sortedRows[i], isSingle);
    tbody.innerHTML = html;
    renderPagination(sortedRows.length, totalPages);
  }

  function renderPagination(total, totalPages) {
    if (totalPages <= 1) { paginationEl.innerHTML = ""; paginationEl.classList.add("hidden"); return; }
    paginationEl.classList.remove("hidden");
    var html = "";
    if (currentPage > 1) html += '<button class="page-btn page-prev" data-page="' + (currentPage - 1) + '">上一页</button>';
    var pages = buildVisiblePages(totalPages);
    for (var i = 0; i < pages.length; i += 1) {
      var p = pages[i];
      if (p === "...") { html += '<span class="page-ellipsis">…</span>'; }
      else { html += '<button class="' + (p === currentPage ? "page-btn active" : "page-btn") + '" data-page="' + p + '">' + p + '</button>'; }
    }
    if (currentPage < totalPages) html += '<button class="page-btn page-next" data-page="' + (currentPage + 1) + '">下一页</button>';
    paginationEl.innerHTML = html;
  }

  function buildVisiblePages(totalPages) {
    var pages = [];
    if (totalPages <= MAX_VISIBLE_PAGES + 2) { for (var i = 1; i <= totalPages; i += 1) pages.push(i); return pages; }
    var half = Math.floor(MAX_VISIBLE_PAGES / 2);
    var start = currentPage - half, end = currentPage + half;
    if (start < 1) { start = 1; end = MAX_VISIBLE_PAGES; }
    if (end > totalPages) { end = totalPages; start = totalPages - MAX_VISIBLE_PAGES + 1; }
    pages.push(1);
    if (start > 2) pages.push("...");
    for (var j = start; j <= end; j += 1) { if (j !== 1 && j !== totalPages) pages.push(j); }
    if (end < totalPages - 1) pages.push("...");
    pages.push(totalPages);
    return pages;
  }

  paginationEl.addEventListener("click", function (e) {
    var btn = e.target.closest(".page-btn");
    if (!btn) return;
    var page = parseInt(btn.dataset.page, 10);
    if (page && page !== currentPage) { currentPage = page; render(); }
  });

  document.querySelector("table thead").addEventListener("click", function (e) {
    var th = e.target.closest("th[data-sort]");
    if (!th) return;
    var key = th.dataset.sort;
    if (sortKey === key) { sortAsc = !sortAsc; } else { sortKey = key; sortAsc = (key === "user" || key === "team"); }
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
    rebuildTeamFilter(rows);
    if (selectedTeams) {
      rows = rows.filter(function (r) {
        var t = (r.team || "-").split(",");
        return t.some(function (s) { return selectedTeams.has(s.trim()); });
      });
    }
    meta.textContent = "\u6570\u636e\u6e90: " + (currentData.source || "-") +
      (currentData.dateLabel ? " | \u67e5\u8be2: " + currentData.dateLabel : "") +
      " | \u6700\u540e\u5237\u65b0: " + C.formatTs(currentData.fetchedAt);
    latestMetaText = meta.textContent;

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
      var emptyMsg = currentData.fetchedAt ? "\u8be5\u65e5\u671f\u6682\u65e0\u7528\u91cf\u6570\u636e\uff08\u8d26\u5355\u6570\u636e\u901a\u5e38\u6709 24\uff5e48 \u5c0f\u65f6\u5ef6\u8fdf\uff09\u3002" : "\u6682\u65e0\u6570\u636e\uff0c\u8bf7\u5148\u70b9\u51fb\u201c\u5237\u65b0\u201d\u3002";
      tbody.innerHTML = '<tr><td colspan="' + colCount + '" class="empty">' + emptyMsg + '</td></tr>';
      paginationEl.innerHTML = ""; paginationEl.classList.add("hidden"); updateSortArrows(); return;
    }
    renderRows(sortRows(rows), isSingle);
    updateSortArrows();
  }

  /* ── Team filter ── */
  var allTeams = [];
  function rebuildTeamFilter(rows) {
    var teamSet = new Set();
    rows.forEach(function (r) { (r.team || "-").split(",").forEach(function (s) { teamSet.add(s.trim()); }); });
    var teams = Array.from(teamSet).sort();
    if (JSON.stringify(teams) === JSON.stringify(allTeams)) return;
    allTeams = teams;
    teamFilterList.innerHTML = teams.map(function (team) {
      var checked = !selectedTeams || selectedTeams.has(team) ? "checked" : "";
      return '<label class="team-filter-item"><input type="checkbox" value="' + C.escapeHtml(team) + '" ' + checked + ' /> ' + C.escapeHtml(team) + '</label>';
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
    var total = boxes.length, checked = getCheckedTeams().length;
    teamFilterAll.checked = checked === total;
    teamFilterAll.indeterminate = checked > 0 && checked < total;
    teamFilterBtn.textContent = checked === total ? "Team \u7b5b\u9009 \u25be" : "Team \u7b5b\u9009 (" + checked + ") \u25be";
    teamFilterBtn.classList.toggle("active", checked < total);
  }
  function applyTeamFilter() {
    var checked = getCheckedTeams();
    selectedTeams = checked.length === allTeams.length ? null : new Set(checked);
    currentPage = 1; updateAllCheckbox(); render();
  }
  teamFilterBtn.addEventListener("click", function (e) { e.stopPropagation(); teamFilterDropdown.classList.toggle("open"); });
  teamFilterAll.addEventListener("change", function () {
    var boxes = teamFilterList.querySelectorAll('input[type="checkbox"]');
    var state = teamFilterAll.checked;
    boxes.forEach(function (cb) { cb.checked = state; });
    applyTeamFilter();
  });
  teamFilterList.addEventListener("change", applyTeamFilter);
  document.addEventListener("click", function (e) { if (!e.target.closest("#teamFilter")) teamFilterDropdown.classList.remove("open"); });

  /* ── Cycle bar ── */
  function buildCycleBar(value, quota) {
    if (value == null) return "-";
    var ratio = quota > 0 ? value / quota : 0;
    var pct = Math.min(ratio * 100, 100);
    var level = ratio >= 1 ? "level-danger" : ratio >= 0.75 ? "level-warn" : "level-normal";
    var overTag = ratio > 1 ? ' <span class="cycle-bar-over">(超额)</span>' : '';
    return '<div class="cycle-bar"><span class="cycle-bar-label">' + value + '/' + quota + overTag + '</span>' +
      '<div class="cycle-bar-track"><div class="cycle-bar-fill ' + level + '" style="width:' + pct.toFixed(1) + '%"></div></div></div>';
  }

  /* ── Build body ── */
  function buildBody() {
    if (activeMode === "single") return { queryMode: "single", date: singleDateInput.value };
    return { queryMode: "range", startDate: rangeStartInput.value, endDate: rangeEndInput.value };
  }

  function cacheKeyForBody(body) { return CACHE_PREFIX + encodeURIComponent(JSON.stringify(body || {})); }

  /* ── Refresh ── */
  function refresh(options) {
    var opts = options || {};
    setError("");
    var body = buildBody();
    var key = cacheKeyForBody(body);
    var cached = C.getCachedData(key, CACHE_TTL_MS);
    if (cached) render(cached);
    else if (!currentData) C.renderSkeletonRows(tbody, activeMode === "single" ? 6 : 5, 8);
    currentPage = 1;
    refreshBtn.disabled = true;
    var oldText = refreshBtn.textContent;
    refreshBtn.textContent = opts.background ? "后台刷新中..." : "刷新中...";
    setMetaRefreshing(true);
    return C.apiFetchJson("/api/usage/refresh", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }, "刷新失败").then(function (data) {
      render(data);
      if (data && data.cacheHitRatio !== undefined) {
        meta.textContent += " | 缓存命中 " + data.cacheHitRatio + "%";
        latestMetaText = meta.textContent;
      }
      C.setCachedData(key, data);
    }).catch(function (err) {
      setError(err instanceof Error ? err.message : String(err));
    }).finally(function () {
      refreshBtn.disabled = false; refreshBtn.textContent = oldText; setMetaRefreshing(false);
    });
  }

  refreshBtn.addEventListener("click", function () { refresh(); });
  /* 首屏加载：若有 localStorage 缓存先渲染，然后统一走一次 refresh 即可——只发一个请求 */
  (function initLoad() {
    var body = buildBody();
    var key = cacheKeyForBody(body);
    var cached = C.getCachedData(key, CACHE_TTL_MS);
    if (cached) { currentPage = 1; render(cached); }
    else C.renderSkeletonRows(tbody, activeMode === "single" ? 6 : 5, 8);
    refresh({ background: true }).catch(function (err) {
      setMetaRefreshing(false);
      setError(err instanceof Error ? err.message : String(err));
    });
  })();

  /* ── Auto refresh ── */
  var autoRefreshSel = document.getElementById("autoRefreshSel");
  var autoRefreshTimer = null;
  function startAutoRefresh(seconds) {
    if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
    if (seconds > 0) autoRefreshTimer = setInterval(function () { if (!refreshBtn.disabled) refresh({ background: true }); }, seconds * 1000);
  }
  autoRefreshSel.addEventListener("change", function () { startAutoRefresh(Number(autoRefreshSel.value)); });

  /* ── Modal ── */
  function openModal(title, html) { modalTitle.textContent = title; modalBody.innerHTML = html; modal.classList.add("open"); }
  function closeModal() { modal.classList.remove("open"); }
  function forceRefreshSeatsCache() { return C.apiFetchJson("/api/seats?refresh=1", {}, "刷新用户席位失败"); }
  modalClose.addEventListener("click", closeModal);
  modal.addEventListener("click", function (e) { if (e.target === modal) closeModal(); });

  function modalSortableTable(headers, rows, defaultSortKey, defaultAsc) {
    var mSortKey = defaultSortKey || headers[0].key;
    var mSortAsc = defaultAsc != null ? defaultAsc : false;
    var container = document.createElement("div");
    function renderTable() {
      var sorted = rows.slice().sort(function (a, b) {
        var va = a[mSortKey], vb = b[mSortKey];
        if (va == null) va = ""; if (vb == null) vb = "";
        if (typeof va === "string" && typeof vb === "string") return mSortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
        return mSortAsc ? va - vb : vb - va;
      });
      var html = '<table class="modal-sortable"><thead><tr>';
      headers.forEach(function (h) {
        var arrow = h.key === mSortKey ? (mSortAsc ? " \u25B2" : " \u25BC") : "";
        html += '<th data-mkey="' + h.key + '" style="cursor:pointer">' + C.escapeHtml(h.label) + arrow + '</th>';
      });
      html += '</tr></thead><tbody>';
      sorted.forEach(function (row) {
        html += '<tr>';
        headers.forEach(function (h) { html += '<td>' + (row["__html_" + h.key] || C.escapeHtml(String(row[h.key] != null ? row[h.key] : "-"))) + '</td>'; });
        html += '</tr>';
      });
      html += '</tbody></table>';
      container.innerHTML = html;
      container.querySelectorAll("th[data-mkey]").forEach(function (th) {
        th.addEventListener("click", function () {
          var k = th.getAttribute("data-mkey");
          if (mSortKey === k) mSortAsc = !mSortAsc; else { mSortKey = k; mSortAsc = true; }
          renderTable();
        });
      });
    }
    renderTable();
    return container;
  }

  /* ── Seats modal ── */
  btnSeats.addEventListener("click", async function () {
    openModal("\u7528\u6237 & Team \u4fe1\u606f", '<div class="loading">\u52a0\u8f7d\u4e2d...</div>');
    try {
      var seatsData = await forceRefreshSeatsCache();
      var teamsData = await C.apiFetchJson("/api/enterprise-teams", {}, "获取 Team 列表失败");
      var html = '<div class="modal-tabs"><button class="modal-tab active" data-mtab="teams">Teams</button>';
      html += '<button class="modal-tab" data-mtab="users">\u7528\u6237\u5e2d\u4f4d</button></div>';
      html += '<div id="mtab-teams" class="mtab-pane active"></div>';
      html += '<div id="mtab-users" class="mtab-pane"></div>';
      modalBody.innerHTML = html;
      modalBody.querySelectorAll(".modal-tab").forEach(function (tab) {
        tab.addEventListener("click", function () {
          modalBody.querySelectorAll(".modal-tab").forEach(function (t) { t.classList.remove("active"); });
          modalBody.querySelectorAll(".mtab-pane").forEach(function (p) { p.classList.remove("active"); });
          tab.classList.add("active");
          document.getElementById("mtab-" + tab.dataset.mtab).classList.add("active");
        });
      });
      var teamsPane = document.getElementById("mtab-teams");
      if (teamsData.ok && teamsData.teams && teamsData.teams.length > 0) {
        var tHtml = '<div class="team-list">';
        teamsData.teams.forEach(function (team) {
          tHtml += '<div class="team-card" data-team-id="' + team.id + '"><div class="team-card-header">';
          tHtml += '<span class="team-name-link">' + C.escapeHtml(team.name) + '</span>';
          if (team.membersCount != null) tHtml += '<span class="team-member-count">' + team.membersCount + ' 人</span>';
          tHtml += '<span class="team-toggle">\u25B6</span></div>';
          if (team.description) tHtml += '<div class="team-desc">' + C.escapeHtml(team.description) + '</div>';
          tHtml += '<div class="team-members" style="display:none"><div class="loading">\u70b9\u51fb Team \u540d\u79f0\u52a0\u8f7d\u6210\u5458...</div></div></div>';
        });
        tHtml += '</div>';
        teamsPane.innerHTML = tHtml;
        teamsPane.querySelectorAll(".team-card").forEach(function (card) {
          var header = card.querySelector(".team-card-header");
          var membersDiv = card.querySelector(".team-members");
          var toggle = card.querySelector(".team-toggle");
          var loaded = false;
          header.addEventListener("click", async function () {
            var visible = membersDiv.style.display !== "none";
            if (visible) { membersDiv.style.display = "none"; toggle.textContent = "\u25B6"; return; }
            membersDiv.style.display = "block"; toggle.textContent = "\u25BC";
            if (loaded) return;
            membersDiv.innerHTML = '<div class="loading">\u52a0\u8f7d\u4e2d...</div>';
            try {
              var mData = await C.apiFetchJson("/api/enterprise-teams/" + card.dataset.teamId + "/members", {}, "获取 Team 成员失败");
              var members = mData.members || [];
              if (members.length === 0) { membersDiv.innerHTML = '<div style="color:var(--muted);padding:8px 0">\u65e0\u6210\u5458</div>'; }
              else {
                var mHtml = '<div class="member-grid">';
                members.forEach(function (m) { mHtml += '<div class="member-item"><img src="' + C.escapeHtml(m.avatarUrl) + '&s=32" width="24" height="24" style="border-radius:50%;vertical-align:middle" /> <span>' + C.escapeHtml(m.login) + '</span></div>'; });
                mHtml += '</div>';
                membersDiv.innerHTML = '<div style="padding:4px 0;color:var(--muted);font-size:13px">' + members.length + ' \u4e2a\u6210\u5458</div>' + mHtml;
              }
              loaded = true;
            } catch (err) { membersDiv.innerHTML = '<div style="color:var(--danger)">' + C.escapeHtml(err.message) + '</div>'; }
          });
        });
      } else { teamsPane.innerHTML = '<div style="color:var(--muted);padding:12px 0">\u65e0 Enterprise Teams \u6570\u636e</div>'; }
      var usersPane = document.getElementById("mtab-users");
      var seats = seatsData.seats || [];
      var infoLine = document.createElement("p");
      infoLine.innerHTML = "\u603b\u5e2d\u4f4d: <strong>" + seatsData.totalSeats + "</strong>\u3000\u66f4\u65b0\u65f6\u95f4: " + C.formatTs(seatsData.fetchedAt);
      usersPane.appendChild(infoLine);
      var seatRows = seats.map(function (s) {
        return { login: s.login, team: s.team, planType: s.planType, lastActivityAt: s.lastActivityAt || "", "__html_lastActivityAt": C.formatTs(s.lastActivityAt), lastActivityEditor: s.lastActivityEditor || "-" };
      });
      usersPane.appendChild(modalSortableTable(
        [{ key: "login", label: "\u7528\u6237" }, { key: "team", label: "Team" }, { key: "planType", label: "\u8ba1\u5212" }, { key: "lastActivityAt", label: "\u6700\u540e\u6d3b\u8dc3" }, { key: "lastActivityEditor", label: "\u7f16\u8f91\u5668" }],
        seatRows, "login", true
      ));
    } catch (err) { modalBody.innerHTML = '<div style="color:var(--danger)">' + C.escapeHtml(err.message) + "</div>"; }
  });

  /* ── Billing Summary ── */
  function renderBillingToolbar() {
    var now = new Date();
    var curY = now.getUTCFullYear();
    var curM = now.getUTCMonth() + 1;
    var pad = function (n) { return n < 10 ? "0" + n : String(n); };
    var options = '<option value="current">' + curY + "-" + pad(curM) + "\uFF08\u5F53\u6708\uFF09</option>";
    for (var i = 1; i <= 11; i++) {
      var d = new Date(Date.UTC(curY, curM - 1 - i, 1));
      var y = d.getUTCFullYear();
      var m = d.getUTCMonth() + 1;
      options += '<option value="' + y + "-" + m + '">' + y + "-" + pad(m) + "</option>";
    }
    return '<div class="billing-toolbar" style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;margin-bottom:0.75rem">' +
      '<label style="color:var(--muted)">\u6708\u4EFD\uFF1A</label>' +
      '<select id="billingSummaryMonth" class="month-selector">' + options + "</select>" +
      '<button id="btnBillingForceRefresh" class="info-btn" title="\u8DF3\u8FC7 3 \u5206\u949F\u7F13\u5B58\u76F4\u63A5\u56DE\u6E90 GitHub">\u5F3A\u5236\u5237\u65B0</button>' +
      '<span id="billingSummaryMeta" style="color:var(--muted);font-size:0.85rem;margin-left:auto"></span>' +
      "</div>";
  }

  function renderBillingSummaryBody(data) {
    var monthLabel = data.year + "\u5E74" + data.month + "\u6708" + (data.isCurrentMonth ? "\uFF08\u5F53\u6708\uFF09" : "");
    var html = '<h3>\u5E2D\u4F4D\u8BA2\u9605</h3><table><thead><tr><th>\u8BA2\u9605\u8BA1\u5212</th><th>\u5E2D\u4F4D\u6570</th><th>\u5355\u4EF7(\u6708)</th><th>\u5C0F\u8BA1(USD)</th><th>\u5355\u5E2D\u4F4D\u989D\u5EA6</th><th>\u603B\u989D\u5EA6</th></tr></thead><tbody>';
    (data.planSummary || []).forEach(function (p) {
      html += "<tr><td>Copilot " + C.escapeHtml(p.plan) + "</td><td>" + p.seats + "</td><td>$" + p.baseCost + "</td><td>$" + p.totalCost.toFixed(2) + "</td><td>" + p.quotaPerSeat + " requests</td><td>" + p.totalQuota + " requests</td></tr>";
    });
    html += "</tbody></table>";
    html += "<h3>Premium Requests \u4F7F\u7528\u60C5\u51B5\uFF08" + C.escapeHtml(monthLabel) + "\uFF09</h3><table><thead><tr><th>\u9879\u76EE</th><th>\u503C</th></tr></thead><tbody>";
    html += "<tr><td>" + C.escapeHtml(monthLabel) + "\u603B Premium Requests</td><td>" + data.totalPremiumRequests + "</td></tr>";
    html += "<tr><td>\u8BA2\u9605\u5305\u542B\u989D\u5EA6</td><td>" + data.totalIncludedQuota + " requests (" + data.totalSeats + " \u5E2D\u4F4D)</td></tr>";
    var usedPct = data.totalIncludedQuota > 0 ? (data.totalPremiumRequests / data.totalIncludedQuota * 100).toFixed(1) : "0";
    html += "<tr><td>\u989D\u5EA6\u4F7F\u7528\u7387</td><td>" + usedPct + "%</td></tr>";
    html += "<tr><td>\u8D85\u989D\u8BF7\u6C42\u6570</td><td>" + data.overageRequests + "</td></tr>";
    html += "<tr><td>\u8D85\u989D\u5355\u4EF7</td><td>$" + data.premiumUnitPrice + "/request</td></tr>";
    var srcLabel = data.overageCostSource === "api-netAmount" ? "GitHub API netAmount" : "\u672C\u5730\u516C\u5F0F";
    html += "<tr><td>\u8D85\u989D\u8D39\u7528<span style='color:var(--muted);font-size:0.8em;margin-left:0.3em'>(" + C.escapeHtml(srcLabel) + ")</span></td><td>$" + data.overageCost.toFixed(4) + "</td></tr>";
    if (data.overageCostSource === "api-netAmount" && typeof data.localOverageCost === "number" && Math.abs(data.localOverageCost - data.overageCost) > 0.0001) {
      html += "<tr><td style='color:var(--muted)'>\u672C\u5730\u516C\u5F0F\u53C2\u8003\u503C</td><td style='color:var(--muted)'>$" + data.localOverageCost.toFixed(4) + "</td></tr>";
    }
    html += "</tbody></table>";
    html += "<h3>\u8D39\u7528\u6C47\u603B</h3><table><thead><tr><th>\u9879\u76EE</th><th>\u91D1\u989D(USD)</th></tr></thead><tbody>";
    html += "<tr><td>\u5E2D\u4F4D\u8BA2\u9605\u8D39</td><td>$" + data.totalSeatsCost.toFixed(2) + "</td></tr>";
    html += "<tr><td>Premium Requests \u8D85\u989D\u8D39</td><td>$" + data.overageCost.toFixed(4) + "</td></tr>";
    html += "<tr style='font-weight:bold;border-top:2px solid var(--border)'><td>" + C.escapeHtml(monthLabel) + "\u9884\u4F30\u603B\u8D39\u7528</td><td>$" + data.totalEstimatedCost.toFixed(4) + "</td></tr></tbody></table>";
    html += '<details style="margin-top:1rem"><summary style="cursor:pointer;color:var(--muted)">\u67E5\u770B API \u539F\u59CB\u8BA1\u8D39\u6570\u636E</summary>';
    html += '<table style="margin-top:0.5rem"><thead><tr><th>SKU</th><th>\u6570\u91CF</th><th>\u5355\u4F4D</th><th>\u5355\u4EF7</th><th>\u603B\u989D</th><th>\u6298\u6263</th><th>\u51C0\u989D</th></tr></thead><tbody>';
    (data.rawItems || []).forEach(function (item) {
      html += "<tr><td>" + C.escapeHtml(item.sku) + "</td><td>" + (item.quantity != null ? item.quantity.toFixed(2) : "-") + "</td><td>" + C.escapeHtml(item.unitType) + "</td><td>$" + (item.pricePerUnit != null ? item.pricePerUnit.toFixed(2) : "-") + "</td><td>$" + (item.grossAmount != null ? item.grossAmount.toFixed(4) : "-") + "</td><td>$" + (item.discountAmount != null ? item.discountAmount.toFixed(4) : "-") + "</td><td>$" + (item.netAmount != null ? item.netAmount.toFixed(4) : "-") + "</td></tr>";
    });
    html += "</tbody></table></details>";
    return html;
  }

  async function loadBillingSummary(force) {
    var content = modalBody.querySelector("#billingSummaryContent");
    var metaSpan = modalBody.querySelector("#billingSummaryMeta");
    var sel = modalBody.querySelector("#billingSummaryMonth");
    var btn = modalBody.querySelector("#btnBillingForceRefresh");
    if (!content || !sel) return;
    content.innerHTML = '<div class="loading">\u52A0\u8F7D\u4E2D...</div>';
    if (metaSpan) metaSpan.textContent = "";
    if (btn) btn.disabled = true;
    try {
      var qs = [];
      var v = sel.value;
      if (v && v !== "current") {
        var parts = v.split("-");
        qs.push("year=" + parts[0]);
        qs.push("month=" + parts[1]);
      }
      if (force) qs.push("force=1");
      if (force) { try { await forceRefreshSeatsCache(); } catch (_e) {} }
      var url = "/api/billing/summary" + (qs.length ? "?" + qs.join("&") : "");
      var data = await C.apiFetchJson(url, {}, "\u83B7\u53D6\u8D26\u5355\u6C47\u603B\u5931\u8D25");
      content.innerHTML = renderBillingSummaryBody(data);
      if (metaSpan) {
        var pad = function (n) { return n < 10 ? "0" + n : String(n); };
        var srcLabel = data.overageCostSource === "api-netAmount" ? "GitHub API netAmount" : "\u672C\u5730\u516C\u5F0F";
        metaSpan.textContent =
          (data.isCurrentMonth ? "\u5F53\u6708 " : "\u5386\u53F2\u6708 ") +
          data.year + "-" + pad(data.month) +
          " \uFF5C \u8D85\u989D\u53E3\u5F84\uFF1A" + srcLabel +
          (data.force ? " \uFF5C \u5DF2\u5F3A\u5236\u56DE\u6E90" : "");
      }
    } catch (err) {
      content.innerHTML = '<div style="color:var(--danger)">' + C.escapeHtml(err.message) + "</div>";
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  btnBillingSummary.addEventListener("click", async function () {
    openModal("\u6574\u4F53\u8D26\u5355\u6C47\u603B", renderBillingToolbar() + '<div id="billingSummaryContent"><div class="loading">\u52A0\u8F7D\u4E2D...</div></div>');
    var sel = modalBody.querySelector("#billingSummaryMonth");
    var btnForce = modalBody.querySelector("#btnBillingForceRefresh");
    if (sel) sel.addEventListener("change", function () { loadBillingSummary(false); });
    if (btnForce) btnForce.addEventListener("click", function () { loadBillingSummary(true); });
    try { await forceRefreshSeatsCache(); } catch (_e) { /* non-fatal */ }
    loadBillingSummary(false);
  });

  /* ── Models ── */
  btnModels.addEventListener("click", async function () {
    openModal("\u6a21\u578b\u4f7f\u7528\u6392\u884c", '<div class="loading">\u52a0\u8f7d\u4e2d...</div>');
    try {
      await forceRefreshSeatsCache();
      var now = new Date();
      var data = await C.apiFetchJson("/api/billing/models?year=" + now.getUTCFullYear() + "&month=" + (now.getUTCMonth() + 1), {}, "获取模型排行失败");
      var models = data.models || [];
      var html = "<p>" + data.year + "\u5e74" + data.month + "\u6708\u3000\u603b\u8bf7\u6c42: <strong>" + data.totalQuantity + "</strong>\u3000\u603b\u91d1\u989d: <strong>$" + data.totalAmount.toFixed(4) + "</strong></p>";
      html += '<table><thead><tr><th>\u6a21\u578b</th><th>\u8bf7\u6c42\u91cf</th><th>\u5360\u6bd4(%)</th><th>\u5355\u4ef7</th><th>\u91d1\u989d(USD)</th></tr></thead><tbody>';
      models.forEach(function (m) {
        var pct = data.totalQuantity > 0 ? (m.grossQuantity / data.totalQuantity * 100).toFixed(2) : "0.00";
        html += "<tr><td>" + C.escapeHtml(m.model) + "</td><td>" + m.grossQuantity + "</td><td>" + pct + "%</td><td>$" + m.pricePerUnit.toFixed(2) + "</td><td>$" + m.grossAmount.toFixed(4) + "</td></tr>";
      });
      html += "</tbody></table>";
      modalBody.innerHTML = html;
    } catch (err) { modalBody.innerHTML = '<div style="color:var(--danger)">' + C.escapeHtml(err.message) + "</div>"; }
  });

  /* ── Budget & Cost ── */
  btnBudgetCost.addEventListener("click", async function () {
    openModal("预算和费用", '<div class="loading">加载中...</div>');
    try {
      var data = await C.apiFetchJson("/api/cost-centers?state=active", {}, "获取 Cost Center 预算和费用失败");
      var rows = Array.isArray(data.costCenters) ? data.costCenters : [];
      var seatBaseCost = C.toNumber(data.seatBaseCost);
      if (!rows.length) { modalBody.innerHTML = '<div style="color:var(--muted)">暂无 Cost Center 数据。</div>'; return; }
      var html = '<table><thead><tr><th>名称</th><th class="cc-money-col">席位订阅费</th><th>套餐外预算</th></tr></thead><tbody>';
      rows.forEach(function (row) {
        var users = buildUserCountFromResources(row.resources);
        var baseCost = row.seatBaseCost != null ? row.seatBaseCost : seatBaseCost;
        var fee = C.toNumber(baseCost) * users;
        html += "<tr><td>" + C.escapeHtml(row.name || "-") + "</td>" +
          '<td class="cc-money-col">' + C.formatUsd(fee) + "</td>" +
          "<td>" + renderBudgetProgressCell(row.budgetAmount, row.spentAmount) + "</td></tr>";
      });
      html += "</tbody></table>";
      modalBody.innerHTML = html;
    } catch (err) { modalBody.innerHTML = '<div style="color:var(--danger)">' + C.escapeHtml(err.message) + "</div>"; }
  });
})();
