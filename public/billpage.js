(function () {
  "use strict";

  var C = CopilotDashboard;

  /* ── DOM refs ── */
  var monthPicker = document.getElementById("monthPicker");
  var queryBtn = document.getElementById("queryBtn");
  var forceRefreshBtn = document.getElementById("forceRefreshBtn");
  var statusBanner = document.getElementById("statusBanner");
  var meta = document.getElementById("meta");
  var errorBox = document.getElementById("error");
  var tbody = document.getElementById("tbody");
  var tfoot = document.getElementById("tfoot");
  var teamFilterBtn = document.getElementById("teamFilterBtn");
  var teamFilterDropdown = document.getElementById("teamFilterDropdown");
  var teamFilterAll = document.getElementById("teamFilterAll");
  var teamFilterList = document.getElementById("teamFilterList");

  /* ── Init month picker to current month ── */
  var now = new Date();
  var curYear = now.getFullYear();
  var curMonth = now.getMonth() + 1;
  monthPicker.value = curYear + "-" + String(curMonth).padStart(2, "0");

  /* ── State ── */
  var expandedTeams = {};
  // null = all selected (default). Otherwise a Set of selected team names.
  var selectedTeams = null;
  var allTeams = [];

  /* ── Helpers ── */
  function setError(msg) { C.setError(errorBox, msg); }

  function formatUsd(val) {
    if (val == null) return "--";
    return "$" + Number(val).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function showBanner(status, message) {
    if (!message) { statusBanner.hidden = true; return; }
    statusBanner.hidden = false;
    statusBanner.className = "bill-banner";
    if (status === "aggregating") statusBanner.classList.add("bill-banner-warn");
    else if (status === "partial") statusBanner.classList.add("bill-banner-info");
    statusBanner.textContent = message;
  }

  /* ── Render ── */
  function renderBill(data) {
    showBanner(data.status, data.message);

    if (data.dateRange) {
      meta.textContent = "账单周期: " + data.dateRange.start + " ~ " + data.dateRange.end +
        " | 状态: " + (data.status === "complete" ? "已完结" : "进行中");
    } else {
      meta.textContent = data.yearMonth + " | " + data.message;
    }

    var allTeamsData = data.teams || [];
    rebuildTeamFilter(allTeamsData);

    // Apply filter: when a subset is selected, hide unselected teams entirely.
    var teams = allTeamsData;
    var hasFilter = selectedTeams !== null;
    if (hasFilter) {
      teams = allTeamsData.filter(function (t) { return selectedTeams.has(t.team); });
    }

    if (teams.length === 0) {
      var emptyMsg = allTeamsData.length === 0
        ? (data.status === "aggregating" ? C.escapeHtml(data.message) : (data.message ? C.escapeHtml(data.message) : "暂无账单数据"))
        : "当前筛选下无 Team";
      tbody.innerHTML = '<tr><td colspan="6" class="empty">' + emptyMsg + '</td></tr>';
      tfoot.innerHTML = "";
      return;
    }

    var html = "";
    for (var i = 0; i < teams.length; i++) {
      var t = teams[i];
      // When user filters a subset, force-expand selected teams to show details.
      // When all are selected (default), respect manual click toggles.
      var isExpanded = hasFilter ? true : !!expandedTeams[t.team];
      var arrow = isExpanded ? "\u25BC" : "\u25B6";

      html += '<tr class="bill-team-row" data-team-idx="' + i + '">' +
        '<td class="bill-toggle">' + arrow + '</td>' +
        '<td><strong>' + C.escapeHtml(t.team) + '</strong></td>' +
        '<td>' + t.members + '</td>' +
        '<td>' + formatUsd(t.seatCost) + '</td>' +
        '<td>' + formatUsd(t.overageCost) + '</td>' +
        '<td><strong>' + formatUsd(t.totalCost) + '</strong></td>' +
        '</tr>';

      if (isExpanded && t.users) {
        for (var j = 0; j < t.users.length; j++) {
          var u = t.users[j];
          html += '<tr class="bill-user-row">' +
            '<td></td>' +
            '<td class="bill-user-login">' + C.escapeHtml(u.adName || u.login) + '</td>' +
            '<td class="bill-user-detail">' + C.escapeHtml(u.planType) +
              ' (' + u.requests + '/' + u.quota + ')</td>' +
            '<td>' + formatUsd(u.seatCost) + '</td>' +
            '<td>' + (u.overageRequests > 0 ? formatUsd(u.overageCost) + ' (' + u.overageRequests + ' reqs)' : '--') + '</td>' +
            '<td>' + formatUsd(u.totalCost) + '</td>' +
            '</tr>';
        }
      }
    }
    tbody.innerHTML = html;

    // Grand total footer — reflect only visible teams when filtered
    var gt;
    if (hasFilter) {
      gt = { seatCost: 0, overageCost: 0, totalCost: 0, totalMembers: 0 };
      for (var k = 0; k < teams.length; k++) {
        gt.seatCost += teams[k].seatCost || 0;
        gt.overageCost += teams[k].overageCost || 0;
        gt.totalCost += teams[k].totalCost || 0;
        gt.totalMembers += teams[k].members || 0;
      }
    } else {
      gt = data.grandTotal || {};
    }
    tfoot.innerHTML = '<tr class="bill-total-row">' +
      '<td></td>' +
      '<td><strong>合计</strong></td>' +
      '<td>' + (gt.totalMembers || 0) + '</td>' +
      '<td><strong>' + formatUsd(gt.seatCost) + '</strong></td>' +
      '<td><strong>' + formatUsd(gt.overageCost) + '</strong></td>' +
      '<td><strong>' + formatUsd(gt.totalCost) + '</strong></td>' +
      '</tr>';

    // Attach toggle events (only meaningful when no filter is active)
    tbody.querySelectorAll(".bill-team-row").forEach(function (row) {
      row.style.cursor = "pointer";
      row.addEventListener("click", function () {
        if (selectedTeams !== null) return; // ignore clicks when filtered
        var idx = Number(row.dataset.teamIdx);
        var teamName = teams[idx].team;
        expandedTeams[teamName] = !expandedTeams[teamName];
        renderBill(lastData);
      });
    });
  }

  /* ── Team filter ── */
  function rebuildTeamFilter(teamsData) {
    var teamSet = new Set();
    teamsData.forEach(function (t) { teamSet.add(t.team); });
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
    teamFilterAll.checked = checked === total && total > 0;
    teamFilterAll.indeterminate = checked > 0 && checked < total;
    teamFilterBtn.textContent = (total === 0 || checked === total) ? "Team \u7b5b\u9009 \u25be" : "Team \u7b5b\u9009 (" + checked + ") \u25be";
    teamFilterBtn.classList.toggle("active", total > 0 && checked < total);
  }
  function applyTeamFilter() {
    var checked = getCheckedTeams();
    selectedTeams = checked.length === allTeams.length ? null : new Set(checked);
    updateAllCheckbox();
    if (lastData) renderBill(lastData);
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

  /* ── Query ── */
  var lastData = null;

  function query() {
    setError("");
    var val = monthPicker.value;
    if (!val) { setError("请选择月份"); return; }
    var parts = val.split("-");
    var year = Number(parts[0]);
    var month = Number(parts[1]);

    queryBtn.disabled = true;
    queryBtn.textContent = "查询中...";
    C.renderSkeletonRows(tbody, 6, 5);
    tfoot.innerHTML = "";
    showBanner(null, null);

    C.apiFetchJson("/api/bill?year=" + year + "&month=" + month, {}, "查询账单失败")
      .then(function (data) {
        lastData = data;
        renderBill(data);
      })
      .catch(function (err) {
        setError(err instanceof Error ? err.message : String(err));
        tbody.innerHTML = '<tr><td colspan="6" class="empty">查询失败</td></tr>';
        tfoot.innerHTML = "";
      })
      .finally(function () {
        queryBtn.disabled = false;
        queryBtn.textContent = "查询";
      });
  }

  queryBtn.addEventListener("click", query);
  monthPicker.addEventListener("keydown", function (e) {
    if (e.key === "Enter") query();
  });

  /* ── Force refresh: bypass all caches and recompute the whole month. ── */
  function forceRefresh() {
    setError("");
    var val = monthPicker.value;
    if (!val) { setError("请选择月份"); return; }
    var parts = val.split("-");
    var year = Number(parts[0]);
    var month = Number(parts[1]);

    var ok = window.confirm(
      "强制刷新 " + val + " 数据？\n\n" +
      "将清除该月本地缓存并逐日回源 GitHub API，可能耗时较长（30+ 次 API 调用）。"
    );
    if (!ok) return;

    queryBtn.disabled = true;
    forceRefreshBtn.disabled = true;
    forceRefreshBtn.textContent = "刷新中...";
    C.renderSkeletonRows(tbody, 6, 5);
    tfoot.innerHTML = "";
    showBanner("partial", "正在强制刷新 " + val + "，请稍候...");

    C.apiFetchJson(
      "/api/bill/refresh",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ year: year, month: month }),
      },
      "强制刷新失败"
    )
      .then(function (data) {
        lastData = data;
        renderBill(data);
        var extra = "已刷新 " + (data.refreshedDays || 0) + " 天";
        if (data.failedDates && data.failedDates.length > 0) {
          extra += "，失败 " + data.failedDates.length + " 天: " + data.failedDates.join(", ");
        }
        var existing = meta.textContent || "";
        meta.textContent = existing + " | " + extra;
      })
      .catch(function (err) {
        setError(err instanceof Error ? err.message : String(err));
        tbody.innerHTML = '<tr><td colspan="6" class="empty">强制刷新失败</td></tr>';
        tfoot.innerHTML = "";
        showBanner(null, null);
      })
      .finally(function () {
        queryBtn.disabled = false;
        forceRefreshBtn.disabled = false;
        forceRefreshBtn.textContent = "强制刷新";
      });
  }

  forceRefreshBtn.addEventListener("click", forceRefresh);
})();
