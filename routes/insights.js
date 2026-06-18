const express = require("express");
const { requiredEnv } = require("../lib/billing-config");
const { githubGetJson } = require("../lib/github-api");
const { writeError } = require("../lib/helpers");
const { buildInsightsPayload } = require("../lib/insights-aggregator");

function parseRange(value) {
  const range = Number(value || 28);
  if ([7, 14, 28, 30, 60, 90].includes(range)) return range;
  return 28;
}

function normalizeModelUsageItems(usageItems) {
  return (Array.isArray(usageItems) ? usageItems : [])
    .filter((item) => String(item.product || "").toLowerCase() === "copilot" || item.model || item.sku)
    .map((item) => ({
      model: item.model || item.sku || "Other models",
      mode: item.mode || item.chat_mode || "agent",
      suggested: item.suggested || item.total_lines_suggested || item.grossQuantity || item.netQuantity || item.quantity || 0,
      accepted: item.accepted || item.total_lines_accepted || item.netQuantity || item.quantity || 0,
      added: item.added || item.lines_added || item.total_lines_added || item.netQuantity || item.quantity || 0,
      deleted: item.deleted || item.lines_deleted || item.total_lines_deleted || 0,
    }));
}

function warningMessage(label, error) {
  const message = error instanceof Error ? error.message : String(error || "unknown error");
  return `${label} unavailable: ${message}`;
}

function parseReportRows(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) return JSON.parse(trimmed);
  return trimmed.split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function downloadMetricsReport(downloadLinks) {
  const rows = [];
  for (const link of Array.isArray(downloadLinks) ? downloadLinks : []) {
    const response = await fetch(link);
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText || "Report download failed"}`);
    }
    rows.push(...parseReportRows(await response.text()));
  }

  const dayTotals = [];
  for (const row of rows) {
    if (Array.isArray(row?.day_totals)) dayTotals.push(...row.day_totals);
  }

  return {
    rows,
    dayTotals,
  };
}

async function fetchLiveSources(range) {
  const enterprise = requiredEnv("ENTERPRISE_SLUG");
  const modelParams = new URLSearchParams();
  modelParams.set("product", "Copilot");

  const metricsReportPromise = githubGetJson(
    `/enterprises/${encodeURIComponent(enterprise)}/copilot/metrics/reports/enterprise-28-day/latest`,
    null
  ).then(async (reportIndex) => ({
    reportIndex,
    report: await downloadMetricsReport(reportIndex?.download_links),
  }));

  const [metricsReportResult, modelUsageResult] = await Promise.allSettled([
    metricsReportPromise,
    githubGetJson(`/enterprises/${encodeURIComponent(enterprise)}/settings/billing/ai_credit/usage`, modelParams),
  ]);

  const warnings = [];
  const metricsReport = metricsReportResult.status === "fulfilled" ? metricsReportResult.value : null;
  const modelUsage = modelUsageResult.status === "fulfilled" ? modelUsageResult.value : {};

  if (metricsReportResult.status === "rejected") {
    warnings.push(warningMessage("Copilot usage endpoint", metricsReportResult.reason));
  }
  if (modelUsageResult.status === "rejected") {
    warnings.push(warningMessage("Copilot model usage endpoint", modelUsageResult.reason));
  }

  return {
    usage: {},
    metricsReport: {
      reportStartDay: metricsReport?.reportIndex?.report_start_day || null,
      reportEndDay: metricsReport?.reportIndex?.report_end_day || null,
      dayTotals: metricsReport?.report?.dayTotals || [],
    },
    codeGeneration: {
      models: normalizeModelUsageItems(modelUsage?.usageItems),
    },
    warnings,
  };
}

module.exports = function createInsightsRouter() {
  const router = express.Router();

  router.get("/api/insights", async (req, res) => {
    try {
      const range = parseRange(req.query.range);
      const sources = await fetchLiveSources(range);
      const data = buildInsightsPayload(sources, { range });
      data.meta.warnings = sources.warnings || [];
      data.meta.source = data.meta.warnings.length > 0 ? "github-partial" : "github-reports";
      res.json({ ok: true, data });
    } catch (error) {
      writeError(res, error);
    }
  });

  return router;
};

module.exports.__testables = {
  downloadMetricsReport,
  normalizeModelUsageItems,
  parseReportRows,
  parseRange,
  warningMessage,
};