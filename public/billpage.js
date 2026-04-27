(function () {
  "use strict";

  var C = CopilotDashboard;

  /* ── DOM refs ── */
  var monthPicker = document.getElementById("monthPicker");
  var queryBtn = document.getElementById("queryBtn");
  var statusBanner = document.getElementById("statusBanner");
  var meta = document.getElementById("meta");
  var errorBox = document.getElementById("error");
  var tbody = document.getElementById("tbody");
  var tfoot = document.getElementById("tfoot");

  /* ── Init month picker to current month ── */
  var now = new Date();
  var curYear = now.getFullYear();
  var curMonth = now.getMonth() + 1;
  monthPicker.value = curYear + "-" + String(curMonth).padStart(2, "0");

  /* ── State ── */
  var expandedTeams = {};

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

    var teams = data.teams || [];
    if (teams.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty">' +
        (data.status === "aggregating" ? C.escapeHtml(data.message) : "暂无账单数据") + '</td></tr>';
      tfoot.innerHTML = "";
      return;
    }

    var html = "";
    for (var i = 0; i < teams.length; i++) {
      var t = teams[i];
      var isExpanded = expandedTeams[t.team];
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

    // Grand total footer
    var gt = data.grandTotal || {};
    tfoot.innerHTML = '<tr class="bill-total-row">' +
      '<td></td>' +
      '<td><strong>合计</strong></td>' +
      '<td>' + (gt.totalMembers || 0) + '</td>' +
      '<td><strong>' + formatUsd(gt.seatCost) + '</strong></td>' +
      '<td><strong>' + formatUsd(gt.overageCost) + '</strong></td>' +
      '<td><strong>' + formatUsd(gt.totalCost) + '</strong></td>' +
      '</tr>';

    // Attach toggle events
    tbody.querySelectorAll(".bill-team-row").forEach(function (row) {
      row.style.cursor = "pointer";
      row.addEventListener("click", function () {
        var idx = Number(row.dataset.teamIdx);
        var teamName = teams[idx].team;
        expandedTeams[teamName] = !expandedTeams[teamName];
        renderBill(lastData);
      });
    });
  }

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
})();
