(function () {
  "use strict";

  var C = CopilotDashboard;

  /* ── DOM refs ── */
  var refreshBtn = document.getElementById("refreshBtn");
  var meta = document.getElementById("meta");
  var errorBox = document.getElementById("error");
  var summaryCards = document.getElementById("summaryCards");
  var tabs = document.querySelectorAll(".query-tabs .tab");
  var analyticTabs = document.querySelectorAll(".analytics-tab");
  var trendPane = document.getElementById("trendPane");
  var topPane = document.getElementById("topPane");
  var teamPane = document.getElementById("teamPane");
  var teamSelect = document.getElementById("teamSelect");
  var activityPane = document.getElementById("activityPane");
  var activityTeamSelect = document.getElementById("activityTeamSelect");

  /* ── State ── */
  var currentRange = 30;
  var trendChart = null;
  var topChart = null;
  var teamChart = null;
  var activityChart = null;
  var teamListLoaded = false;
  var activityRawMembers = null;
  var activityCurrentBucket = null;
  var latestMetaText = "";

  /* ── Local helpers ── */
  function setError(msg) { C.setError(errorBox, msg); }

  function formatNumber(n) {
    if (n == null) return "-";
    return Number(n).toLocaleString("zh-CN");
  }

  function formatMoney(n) {
    if (n == null) return "-";
    return "$" + Number(n).toFixed(4);
  }

  /* ── Render summary cards ── */
  function renderSummaryCards(data) {
    var cards = [
      { label: "总请求量", value: formatNumber(data.totalRequests) },
      { label: "总费用(USD)", value: formatMoney(data.totalAmount) },
      { label: "日均请求", value: formatNumber(Math.round(data.avgDailyRequests)) },
      { label: "日均费用", value: formatMoney(Math.round(data.avgDailyAmount * 10000) / 10000) },
      { label: "有数据天数", value: formatNumber(data.daysWithData) + " / " + formatNumber(data.totalDaysInRange) },
    ];
    summaryCards.innerHTML = cards.map(function (c) {
      return '<div class="summary-card"><div class="label">' + C.escapeHtml(c.label) + '</div><div class="value">' + c.value + '</div></div>';
    }).join("");
  }

  /* ── Render trend chart ── */
  function renderTrendChart(trendData) {
    var ctx = document.getElementById("trendChart").getContext("2d");
    if (trendChart) trendChart.destroy();

    var labels = trendData.map(function (d) { return d.date; });
    var requests = trendData.map(function (d) { return d.requests; });
    var amounts = trendData.map(function (d) { return Math.round(d.amount * 10000) / 10000; });

    trendChart = new Chart(ctx, {
      type: "line",
      data: {
        labels: labels,
        datasets: [
          {
            label: "请求量",
            data: requests,
            borderColor: "#00704a",
            backgroundColor: "rgba(0,112,74,0.1)",
            fill: true,
            tension: 0.3,
            yAxisID: "y",
          },
          {
            label: "费用(USD)",
            data: amounts,
            borderColor: "#b42318",
            backgroundColor: "rgba(180,35,24,0.1)",
            fill: false,
            tension: 0.3,
            yAxisID: "y1",
          },
        ],
      },
      options: {
        responsive: true,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { position: "top" },
          tooltip: {
            callbacks: {
              label: function (ctx) {
                return ctx.dataset.label + ": " + formatNumber(ctx.parsed.y);
              },
            },
          },
        },
        scales: {
          x: { ticks: { maxTicksLimit: 15, maxRotation: 45 } },
          y: {
            type: "linear",
            display: true,
            position: "left",
            title: { display: true, text: "请求量" },
          },
          y1: {
            type: "linear",
            display: true,
            position: "right",
            title: { display: true, text: "费用(USD)" },
            grid: { drawOnChartArea: false },
          },
        },
      },
    });
  }

  /* ── Render top users chart ── */
  function renderTopChart(topUsers) {
    var ctx = document.getElementById("topChart").getContext("2d");
    if (topChart) topChart.destroy();

    // Dynamic container height: ensure enough room for all user labels
    var barHeight = 30;
    var minH = Math.max(300, topUsers.length * barHeight + 60);
    ctx.canvas.parentElement.style.minHeight = minH + "px";

    var labels = topUsers.map(function (u) { return u.user; });
    var requests = topUsers.map(function (u) { return Math.round(u.requests); });

    topChart = new Chart(ctx, {
      type: "bar",
      data: {
        labels: labels,
        datasets: [
          {
            label: "请求量",
            data: requests,
            backgroundColor: "#00704a",
            borderRadius: 4,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: "y",
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: function (ctx) {
                return formatNumber(ctx.parsed.x) + " requests";
              },
            },
          },
        },
        scales: {
          x: { title: { display: true, text: "请求量" } },
          y: { ticks: { autoSkip: false } },
        },
      },
    });
  }

  /* ── Render team view chart ── */
  function renderTeamChart(data) {
    var container = document.getElementById("teamChartContainer");
    var ctx = document.getElementById("teamChart").getContext("2d");
    if (teamChart) teamChart.destroy();

    var labels, values, xLabel;
    if (data.mode === "teams") {
      labels = (data.teamStats || []).map(function (t) { return t.team; });
      values = (data.teamStats || []).map(function (t) { return t.avgRequests; });
      xLabel = "人均请求量";
    } else {
      labels = (data.teamMembers || []).map(function (m) { return m.user; });
      values = (data.teamMembers || []).map(function (m) { return m.requests; });
      xLabel = "请求量";
    }

    var barHeight = 30;
    var minH = Math.max(300, labels.length * barHeight + 60);
    container.style.minHeight = minH + "px";

    teamChart = new Chart(ctx, {
      type: "bar",
      data: {
        labels: labels,
        datasets: [{
          label: xLabel,
          data: values,
          backgroundColor: "#1a7f5a",
          borderRadius: 4,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: "y",
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: function (ctx) {
                return formatNumber(ctx.parsed.x) + " requests";
              },
            },
          },
        },
        scales: {
          x: { title: { display: true, text: xLabel } },
          y: { ticks: { autoSkip: false } },
        },
      },
    });
  }

  /* ── Load team list into select ── */
  function loadTeamList() {
    if (teamListLoaded) return;
    C.apiFetchJson("/api/enterprise-teams", {}, "获取 Team 列表失败")
      .then(function (data) {
        var teams = (data.teams || []).map(function (t) { return t.name || t.slug; }).sort();
        teams.forEach(function (name) {
          var opt = document.createElement("option");
          opt.value = name;
          opt.textContent = name;
          teamSelect.appendChild(opt);
        });
        teamListLoaded = true;
      })
      .catch(function () { /* silently ignore — select stays with "全部 Team" only */ });
  }

  /* ── Refresh team chart ── */
  function refreshTeamChart() {
    var team = teamSelect.value;
    var url = "/api/analytics/team-view?range=" + currentRange + (team ? "&team=" + encodeURIComponent(team) : "");
    C.apiFetchJson(url, {}, "获取 Team 视角数据失败")
      .then(function (data) { renderTeamChart(data); })
      .catch(function (err) { setError(err instanceof Error ? err.message : String(err)); });
  }

  teamSelect.addEventListener("change", refreshTeamChart);

  /* ── Refresh data ── */
  async function refresh() {
    setError("");
    refreshBtn.disabled = true;
    refreshBtn.textContent = "加载中...";
    meta.textContent = "加载 " + currentRange + " 天数据中...";

    try {
      var results = await Promise.all([
        C.apiFetchJson("/api/analytics/daily-summary?range=" + currentRange, {}, "获取汇总数据失败"),
        C.apiFetchJson("/api/analytics/trends?range=" + currentRange, {}, "获取趋势数据失败"),
        C.apiFetchJson("/api/analytics/top-users?range=" + currentRange, {}, "获取Top用户失败"),
      ]);
      var summary = results[0], trend = results[1], top = results[2];

      renderSummaryCards(summary);
      if (trend.trend && trend.trend.length > 0) renderTrendChart(trend.trend);
      if (top.topUsers && top.topUsers.length > 0) renderTopChart(top.topUsers);
      // Refresh team chart if its pane is active; otherwise it will load on first tab switch
      if (teamPane.classList.contains("active")) refreshTeamChart();

      var now = new Date();
      var loadTimeStr = now.toLocaleString("zh-CN", { hour12: false });
      latestMetaText = "数据范围: " + currentRange + " 天 | 最后加载: " + loadTimeStr;
      meta.innerHTML = latestMetaText + ' <span class="freshness-badge freshness-fresh">✓ 已是最新</span>';
      startFreshnessTimer(now);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      meta.textContent = "加载失败";
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.textContent = "刷新";
    }
  }

  refreshBtn.addEventListener("click", refresh);

  /* ── Range tabs ── */
  tabs.forEach(function (tab) {
    tab.addEventListener("click", function () {
      tabs.forEach(function (t) { t.classList.remove("active"); });
      tab.classList.add("active");
      currentRange = Number(tab.dataset.range);
      refresh();
    });
  });

  /* ── Chart tabs ── */
  analyticTabs.forEach(function (tab) {
    tab.addEventListener("click", function () {
      analyticTabs.forEach(function (t) { t.classList.remove("active"); });
      tab.classList.add("active");
      trendPane.classList.toggle("active", tab.dataset.pane === "trend");
      topPane.classList.toggle("active", tab.dataset.pane === "top");
      teamPane.classList.toggle("active", tab.dataset.pane === "team");
      activityPane.classList.toggle("active", tab.dataset.pane === "activity");
      // Resize visible chart so it measures the now-visible container correctly
      if (tab.dataset.pane === "trend" && trendChart) trendChart.resize();
      if (tab.dataset.pane === "top" && topChart) topChart.resize();
      if (tab.dataset.pane === "team") {
        loadTeamList();
        refreshTeamChart();
      }
      if (tab.dataset.pane === "activity") {
        loadActivityData();
      }
    });
  });

  /* ── User activity classification (mirrors lib/helpers.js:classifyUserActivity) ── */
  var BUCKET_NAMES = ["1~5日不活跃", "6~10日不活跃", "10日以上不活跃", "注册后未活跃"];
  var BUCKET_COLORS = ["#00704a", "#f1c232", "#b42318", "#9e9e9e"];

  function classifyUserActivity(members, nowMs) {
    var MS_PER_DAY = 24 * 60 * 60 * 1000;
    var buckets = { "1~5日不活跃": [], "6~10日不活跃": [], "10日以上不活跃": [], "注册后未活跃": [] };
    for (var i = 0; i < members.length; i++) {
      var m = members[i];
      var displayName = (m.adName && m.adName.trim()) ? m.adName : m.login;
      var entry = { displayName: displayName, team: m.team || "--", lastActivityAt: m.lastActivityAt };
      if (!m.lastActivityAt) {
        buckets["注册后未活跃"].push(entry);
        continue;
      }
      var daysInactive = Math.floor((nowMs - new Date(m.lastActivityAt).getTime()) / MS_PER_DAY);
      if (daysInactive <= 5) {
        buckets["1~5日不活跃"].push(entry);
      } else if (daysInactive <= 10) {
        buckets["6~10日不活跃"].push(entry);
      } else {
        buckets["10日以上不活跃"].push(entry);
      }
    }
    return buckets;
  }

  /* ── Render activity pie chart ── */
  function renderActivityChart(members) {
    var nowMs = Date.now();
    var buckets = classifyUserActivity(members, nowMs);
    var counts = BUCKET_NAMES.map(function (n) { return buckets[n].length; });

    var ctx = document.getElementById("activityChart").getContext("2d");
    if (activityChart) activityChart.destroy();

    activityChart = new Chart(ctx, {
      type: "doughnut",
      data: {
        labels: BUCKET_NAMES,
        datasets: [{
          data: counts,
          backgroundColor: BUCKET_COLORS,
          borderWidth: 2,
          borderColor: "#fff",
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "right", labels: { font: { size: 13 }, padding: 16 } },
          tooltip: {
            callbacks: {
              label: function (ctx) {
                var label = ctx.label || "";
                var val = ctx.parsed;
                var total = ctx.dataset.data.reduce(function (a, b) { return a + b; }, 0);
                var pct = total > 0 ? Math.round(val / total * 100) : 0;
                return label + ": " + val + " 人 (" + pct + "%)";
              },
            },
          },
        },
        onClick: function (_evt, elements) {
          if (!elements || elements.length === 0) return;
          var idx = elements[0].index;
          var bucketName = BUCKET_NAMES[idx];
          var userList = document.getElementById("activityUserList");
          // Toggle: click same bucket → collapse
          if (activityCurrentBucket === bucketName && !userList.classList.contains("hidden")) {
            userList.classList.add("hidden");
            activityCurrentBucket = null;
            return;
          }
          activityCurrentBucket = bucketName;
          renderActivityUserList(bucketName, buckets[bucketName]);
        },
      },
    });

    // Reset user list when chart re-renders
    document.getElementById("activityUserList").classList.add("hidden");
    activityCurrentBucket = null;
  }

  /* ── Render user list below pie chart ── */
  function renderActivityUserList(bucketName, users) {
    var container = document.getElementById("activityUserList");
    container.classList.remove("hidden");

    var html = '<div class="activity-list-title">' + C.escapeHtml(bucketName) + ' — 共 ' + users.length + ' 人</div>';
    if (users.length === 0) {
      html += '<p class="activity-list-empty">此分类暂无用户</p>';
    } else {
      html += '<table class="activity-list-table"><thead><tr><th>用户名</th><th>Team</th><th>最后活跃</th></tr></thead><tbody>';
      users.forEach(function (u) {
        var lastActive = u.lastActivityAt ? new Date(u.lastActivityAt).toLocaleString("zh-CN", { hour12: false }) : "--";
        html += '<tr><td>' + C.escapeHtml(u.displayName) + '</td><td>' + C.escapeHtml(u.team) + '</td><td>' + C.escapeHtml(lastActive) + '</td></tr>';
      });
      html += '</tbody></table>';
    }
    container.innerHTML = html;
  }

  /* ── Load activity data (call /api/user/members, populate Team select, render chart) ── */
  function loadActivityData() {
    if (activityRawMembers !== null) {
      // Already loaded; just re-render with current team filter
      renderActivityChart(filteredActivityMembers());
      return;
    }
    C.apiFetchJson("/api/user/members", {}, "获取用户成员数据失败")
      .then(function (data) {
        activityRawMembers = data.members || [];
        // Populate Team dropdown (unique, sorted)
        var teams = [];
        var seen = {};
        activityRawMembers.forEach(function (m) {
          var t = m.team || "";
          if (t && t !== "-" && !seen[t]) { seen[t] = true; teams.push(t); }
        });
        teams.sort();
        // Clear existing options except "全部 Team"
        while (activityTeamSelect.options.length > 1) activityTeamSelect.remove(1);
        teams.forEach(function (name) {
          var opt = document.createElement("option");
          opt.value = name;
          opt.textContent = name;
          activityTeamSelect.appendChild(opt);
        });
        renderActivityChart(filteredActivityMembers());
      })
      .catch(function (err) { setError(err instanceof Error ? err.message : String(err)); });
  }

  function filteredActivityMembers() {
    var team = activityTeamSelect.value;
    if (!team) return activityRawMembers;
    return (activityRawMembers || []).filter(function (m) { return (m.team || "") === team; });
  }

  activityTeamSelect.addEventListener("change", function () {
    if (activityRawMembers !== null) {
      renderActivityChart(filteredActivityMembers());
    }
  });

  /* ── Data freshness timer ── */
  var freshnessTimer = null;
  function startFreshnessTimer(loadTime) {
    if (freshnessTimer) clearInterval(freshnessTimer);
    freshnessTimer = setInterval(function () {
      var elapsed = Math.floor((Date.now() - loadTime.getTime()) / 1000);
      var badge;
      if (elapsed < 120) badge = '<span class="freshness-badge freshness-fresh">✓ 已是最新</span>';
      else if (elapsed < 600) {
        var mins = Math.floor(elapsed / 60);
        badge = '<span class="freshness-badge freshness-aging">' + mins + ' 分钟前加载</span>';
      } else {
        var mins2 = Math.floor(elapsed / 60);
        badge = '<span class="freshness-badge freshness-stale">⚠ ' + mins2 + ' 分钟前加载，建议刷新</span>';
      }
      meta.innerHTML = C.escapeHtml(latestMetaText) + ' ' + badge;
    }, 30000);
  }

  /* ── Auto load ── */
  refresh();
})();
