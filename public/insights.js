(function () {
  "use strict";

  var C = CopilotDashboard;
  var refreshBtn = document.getElementById("refreshBtn");
  var meta = document.getElementById("meta");
  var errorBox = document.getElementById("error");
  var rangeTabs = document.querySelectorAll("#rangeTabs .tab");
  var paneTabs = document.querySelectorAll(".insights-tabs .analytics-tab");
  var usageMetrics = document.getElementById("usageMetrics");
  var codeMetrics = document.getElementById("codeMetrics");
  var insightList = document.getElementById("insightList");
  var currentRange = 28;
  var charts = {};

  var COLORS = {
    blue: "#0969da",
    green: "#1a7f37",
    lightGreen: "#8ddb8c",
    teal: "#1b7c83",
    orange: "#fb8f2d",
    purple: "#8250df",
    pink: "#bf3989",
    slate: "#57606a",
    line: "rgba(31, 35, 40, 0.12)",
  };

  function formatNumber(value) {
    return Number(value || 0).toLocaleString("zh-CN");
  }

  function formatCompact(value) {
    var n = Number(value || 0);
    if (Math.abs(n) >= 1000000) return Math.round(n / 100000) / 10 + "m";
    if (Math.abs(n) >= 1000) return Math.round(n / 100) / 10 + "k";
    return formatNumber(n);
  }

  function setError(message) {
    C.setError(errorBox, message);
  }

  function destroyChart(id) {
    if (charts[id]) {
      charts[id].destroy();
      charts[id] = null;
    }
  }

  function getCanvas(id) {
    return document.getElementById(id).getContext("2d");
  }

  function baseOptions(extra) {
    return Object.assign({
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { position: "top", labels: { boxWidth: 10, usePointStyle: true } },
      },
      scales: {
        x: { grid: { color: "rgba(31, 35, 40, 0.06)" }, ticks: { maxRotation: 45, autoSkip: true } },
        y: { grid: { color: "rgba(31, 35, 40, 0.08)" }, beginAtZero: true },
      },
    }, extra || {});
  }

  function renderMetricCards(container, cards) {
    container.innerHTML = cards.map(function (card) {
      var progress = card.progress == null ? "" :
        '<div class="insights-progress"><span style="width:' + Math.max(0, Math.min(100, card.progress)) + '%"></span></div>';
      var detail = card.detail ? '<div class="insights-metric-detail">' + C.escapeHtml(card.detail) + '</div>' : "";
      return '<div class="insights-metric-card"><div class="label">' + C.escapeHtml(card.label) +
        '</div><div class="value">' + C.escapeHtml(card.value) + '</div>' + progress + detail + '</div>';
    }).join("");
  }

  function renderUsageMetrics(data) {
    var metrics = data.tabs.usage.metrics;
    var adoption = metrics.agentAdoption || { percent: 0, engagedUsers: 0, activeUsers: 0 };
    renderMetricCards(usageMetrics, [
      { label: "IDE active users", value: formatNumber(metrics.ideActiveUsers), detail: "Copilot-licensed users who interacted with Copilot in the current calendar month" },
      { label: "Agent adoption", value: adoption.percent + "%", progress: adoption.percent, detail: adoption.engagedUsers + " out of " + adoption.activeUsers + " active users" },
      { label: "Most used chat model", value: metrics.mostUsedChatModel || "-", detail: "Model with the highest number of chat requests in the last 28 days" },
    ]);
  }

  function renderCodeMetrics(data) {
    var metrics = data.tabs.codeGeneration.metrics;
    renderMetricCards(codeMetrics, [
      { label: "Lines of code changed with AI", value: formatCompact(metrics.linesChangedWithAi), detail: "Lines of code added and deleted across all modes in the last 28 days" },
      { label: "Agent Contribution", value: metrics.agentContribution + "%", progress: metrics.agentContribution, detail: "Percentage of lines of code added and deleted by agents in the last 28 days" },
      { label: "Average lines deleted by agent", value: formatNumber(metrics.averageLinesDeletedByAgent), detail: "Average lines of code deleted by agents on behalf of active users in the current calendar month" },
    ]);
  }

  function lineChart(id, labels, datasets, yTitle) {
    destroyChart(id);
    charts[id] = new Chart(getCanvas(id), {
      type: "line",
      data: { labels: labels, datasets: datasets },
      options: baseOptions({ scales: { y: { beginAtZero: true, title: { display: Boolean(yTitle), text: yTitle } } } }),
    });
  }

  function barChart(id, labels, datasets, stacked, horizontal) {
    destroyChart(id);
    charts[id] = new Chart(getCanvas(id), {
      type: "bar",
      data: { labels: labels, datasets: datasets },
      options: baseOptions({
        indexAxis: horizontal ? "y" : "x",
        scales: {
          x: { stacked: Boolean(stacked), beginAtZero: true, grid: { color: "rgba(31, 35, 40, 0.06)" } },
          y: { stacked: Boolean(stacked), beginAtZero: true, grid: { color: "rgba(31, 35, 40, 0.08)" } },
        },
      }),
    });
  }

  function doughnutChart(id, rows) {
    destroyChart(id);
    charts[id] = new Chart(getCanvas(id), {
      type: "doughnut",
      data: {
        labels: rows.map(function (row) { return row.label; }),
        datasets: [{
          data: rows.map(function (row) { return row.value; }),
          backgroundColor: [COLORS.blue, COLORS.green, COLORS.orange, COLORS.teal, COLORS.purple, COLORS.pink, COLORS.slate],
          borderWidth: 2,
          borderColor: "#ffffff",
        }],
      },
      options: baseOptions({ cutout: "58%", scales: {} }),
    });
  }

  function renderUsageCharts(data) {
    var chartsData = data.tabs.usage.charts;
    var daily = chartsData.dailyActiveUsers || [];
    var weekly = chartsData.weeklyActiveUsers || [];
    var avgChat = chartsData.averageChatRequests || [];
    var modes = chartsData.requestsPerChatMode || [];
    var completions = chartsData.codeCompletions || [];
    var acceptance = (chartsData.completionAcceptanceRate || {}).series || [];

    lineChart("dailyActiveChart", daily.map(function (row) { return row.date; }), [{ label: "Users", data: daily.map(function (row) { return row.users; }), borderColor: COLORS.blue, backgroundColor: "rgba(9,105,218,0.12)", fill: true, tension: 0.32 }], "Users");
    lineChart("weeklyActiveChart", weekly.map(function (row) { return row.date; }), [{ label: "Users", data: weekly.map(function (row) { return row.users; }), borderColor: COLORS.blue, backgroundColor: "rgba(9,105,218,0.12)", fill: true, tension: 0.32 }], "Users");
    lineChart("avgChatChart", avgChat.map(function (row) { return row.date; }), [{ label: "Requests", data: avgChat.map(function (row) { return row.requests; }), borderColor: COLORS.green, backgroundColor: "rgba(26,127,55,0.1)", fill: true, tension: 0.32 }], "Requests");
    barChart("chatModeChart", modes.map(function (row) { return row.date; }), [
      { label: "Edit", data: modes.map(function (row) { return row.edit; }), backgroundColor: "#8ddb8c" },
      { label: "Ask", data: modes.map(function (row) { return row.ask; }), backgroundColor: "#57ab5a" },
      { label: "Agent", data: modes.map(function (row) { return row.agent; }), backgroundColor: "#2da44e" },
      { label: "Custom", data: modes.map(function (row) { return row.custom; }), backgroundColor: "#1a7f37" },
      { label: "Inline", data: modes.map(function (row) { return row.inline; }), backgroundColor: "#116329" },
      { label: "Plan", data: modes.map(function (row) { return row.plan; }), backgroundColor: "#0d4f22" },
    ], true, false);
    lineChart("codeCompletionsChart", completions.map(function (row) { return row.date; }), [
      { label: "Accepted completions", data: completions.map(function (row) { return row.accepted; }), borderColor: COLORS.purple, backgroundColor: "rgba(130,80,223,0.1)", fill: true, tension: 0.28 },
      { label: "Suggested completions", data: completions.map(function (row) { return row.suggested; }), borderColor: "#a475f9", borderDash: [4, 3], backgroundColor: "rgba(164,117,249,0.04)", fill: false, tension: 0.28 },
    ], "Completions");
    lineChart("acceptanceChart", acceptance.map(function (row) { return row.date; }), [{ label: "Acceptance rate", data: acceptance.map(function (row) { return row.rate; }), borderColor: COLORS.green, backgroundColor: "rgba(26,127,55,0.08)", tension: 0.28 }], "%");
    doughnutChart("modelUsageChart", chartsData.chatModelUsage || []);
    doughnutChart("languageUsageChart", chartsData.languageUsage || []);

    var modelMode = chartsData.modelPerChatMode || [];
    barChart("modelModeChart", modelMode.map(function (row) { return row.model; }), [
      { label: "Edit", data: modelMode.map(function (row) { return row.edit || 0; }), backgroundColor: "#80ccff" },
      { label: "Ask", data: modelMode.map(function (row) { return row.ask || 0; }), backgroundColor: COLORS.blue },
      { label: "Agent", data: modelMode.map(function (row) { return row.agent || 0; }), backgroundColor: "#1f6feb" },
      { label: "Custom", data: modelMode.map(function (row) { return row.custom || 0; }), backgroundColor: "#174ea6" },
      { label: "Plan", data: modelMode.map(function (row) { return row.plan || 0; }), backgroundColor: "#0a3069" },
      { label: "Inline", data: modelMode.map(function (row) { return row.inline || 0; }), backgroundColor: "#57606a" },
    ], true, false);
  }

  function twoSeriesBar(id, rows, firstLabel, secondLabel, firstKey, secondKey, horizontal) {
    barChart(id, rows.map(function (row) { return row.label; }), [
      { label: firstLabel, data: rows.map(function (row) { return row[firstKey] || 0; }), backgroundColor: COLORS.lightGreen },
      { label: secondLabel, data: rows.map(function (row) { return row[secondKey] || 0; }), backgroundColor: COLORS.green },
    ], false, horizontal);
  }

  function renderCodeCharts(data) {
    var chartsData = data.tabs.codeGeneration.charts;
    var daily = chartsData.dailyLinesChanged || [];
    barChart("dailyLinesChart", daily.map(function (row) { return row.date; }), [
      { label: "Added", data: daily.map(function (row) { return row.added; }), backgroundColor: "#c8b6ff" },
      { label: "Deleted", data: daily.map(function (row) { return row.deleted; }), backgroundColor: COLORS.purple },
    ], false, false);
    twoSeriesBar("userModeChart", chartsData.userInitiatedByMode || [], "Suggested", "Added", "suggested", "added", false);
    twoSeriesBar("agentChart", chartsData.agentInitiated || [], "Added", "Deleted", "added", "deleted", false);
    twoSeriesBar("userModelChart", chartsData.userInitiatedByModel || [], "Suggested", "Added", "suggested", "added", false);
    twoSeriesBar("agentModelChart", chartsData.agentInitiatedByModel || [], "Added", "Deleted", "added", "deleted", false);
    twoSeriesBar("userLanguageChart", chartsData.userInitiatedByLanguage || [], "Suggested", "Added", "suggested", "added", false);
    twoSeriesBar("agentLanguageChart", chartsData.agentInitiatedByLanguage || [], "Added", "Deleted", "added", "deleted", false);

    var modelEfficiency = chartsData.modelEfficiency || [];
    barChart("modelEfficiencyChart", modelEfficiency.map(function (row) { return row.label; }), [
      { label: "Throughput", data: modelEfficiency.map(function (row) { return row.throughput; }), backgroundColor: COLORS.blue },
      { label: "Accepted", data: modelEfficiency.map(function (row) { return row.accepted; }), backgroundColor: COLORS.green },
    ], false, true);
  }

  function renderInsights(items) {
    if (!items || items.length === 0) {
      insightList.innerHTML = '<div class="insight-empty">当前数据未触发高优先级优化建议。</div>';
      return;
    }
    insightList.innerHTML = items.map(function (item) {
      return '<article class="insight-item severity-' + C.escapeHtml(item.severity || "low") + '">' +
        '<div class="insight-title">' + C.escapeHtml(item.title) + '</div>' +
        '<p>' + C.escapeHtml(item.message) + '</p>' +
        '<div class="insight-evidence">' + C.escapeHtml(item.evidence || "") + '</div>' +
        '<div class="insight-recommendation">' + C.escapeHtml(item.recommendation || "") + '</div>' +
      '</article>';
    }).join("");
  }

  function render(data) {
    renderUsageMetrics(data);
    renderCodeMetrics(data);
    renderUsageCharts(data);
    renderCodeCharts(data);
    renderInsights(data.insights || []);
    meta.textContent = "Timeframe: Last " + data.meta.range + " days | Source: " + data.meta.source + " | " + C.formatTs(data.meta.generatedAt);
    setError((data.meta.warnings || []).join("；"));
  }

  function loadData() {
    setError("");
    refreshBtn.disabled = true;
    meta.textContent = "加载中...";
    var url = "/api/insights?range=" + currentRange;
    C.apiFetchJson(url, {}, "获取 Insights 数据失败")
      .then(function (body) { render(body.data || body); })
      .catch(function (error) { setError(error instanceof Error ? error.message : String(error)); })
      .finally(function () { refreshBtn.disabled = false; });
  }

  rangeTabs.forEach(function (tab) {
    tab.addEventListener("click", function () {
      rangeTabs.forEach(function (item) { item.classList.remove("active"); });
      tab.classList.add("active");
      currentRange = Number(tab.dataset.range || 28);
      loadData();
    });
  });

  paneTabs.forEach(function (tab) {
    tab.addEventListener("click", function () {
      paneTabs.forEach(function (item) { item.classList.remove("active"); });
      document.querySelectorAll(".insights-pane").forEach(function (pane) { pane.classList.remove("active"); });
      tab.classList.add("active");
      document.getElementById(tab.dataset.pane).classList.add("active");
      Object.keys(charts).forEach(function (id) { if (charts[id]) charts[id].resize(); });
    });
  });

  refreshBtn.addEventListener("click", loadData);
  loadData();
})();