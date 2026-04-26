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

  /* ── State ── */
  var currentRange = 30;
  var trendChart = null;
  var topChart = null;
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
          y: { ticks: { maxTicksLimit: 20 } },
        },
      },
    });
  }

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
    });
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
