function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function normalizeLanguageUsage(breakdown) {
  const totals = new Map();

  for (const item of Array.isArray(breakdown) ? breakdown : []) {
    const language = item.language || item.programming_language || item.name;
    if (!language) continue;

    const value = toNumber(item.total_lines_suggested) ||
      toNumber(item.total_suggestions_count) ||
      toNumber(item.value);
    totals.set(language, (totals.get(language) || 0) + value);
  }

  const total = Array.from(totals.values()).reduce((sum, value) => sum + value, 0);
  return Array.from(totals.entries())
    .map(([label, value]) => ({
      label,
      value,
      percent: total > 0 ? round2((value / total) * 100) : 0,
    }))
    .sort((a, b) => b.value - a.value);
}

function summarizeCompletions(breakdown) {
  const summary = {
    suggestions: 0,
    acceptances: 0,
    rate: 0,
    linesSuggested: 0,
    linesAccepted: 0,
  };

  for (const item of Array.isArray(breakdown) ? breakdown : []) {
    summary.suggestions += toNumber(item.total_suggestions_count);
    summary.acceptances += toNumber(item.total_acceptances_count);
    summary.linesSuggested += toNumber(item.total_lines_suggested);
    summary.linesAccepted += toNumber(item.total_lines_accepted);
  }

  summary.rate = summary.suggestions > 0
    ? round2((summary.acceptances / summary.suggestions) * 100)
    : 0;
  return summary;
}

function normalizeModelEfficiency(models) {
  return (Array.isArray(models) ? models : [])
    .map((item) => {
      const added = toNumber(item.added || item.lines_added || item.total_lines_added);
      const deleted = toNumber(item.deleted || item.lines_deleted || item.total_lines_deleted);
      const suggested = toNumber(item.suggested || item.total_lines_suggested || item.total_suggestions_count);
      const accepted = toNumber(item.accepted || item.total_lines_accepted || item.total_acceptances_count);
      return {
        label: item.model || item.name || "Unknown model",
        mode: item.mode || item.chat_mode || "unknown",
        suggested,
        added,
        deleted,
        accepted,
        throughput: added + deleted || suggested,
        acceptanceRate: suggested > 0 ? round2((accepted / suggested) * 100) : 0,
      };
    })
    .sort((a, b) => b.throughput - a.throughput);
}

function normalizeDistribution(items, labelKeys = ["label", "model", "language", "name"]) {
  const rows = (Array.isArray(items) ? items : []).map((item) => {
    const labelKey = labelKeys.find((key) => item[key]);
    return {
      label: labelKey ? String(item[labelKey]) : "Unknown",
      value: toNumber(item.value || item.total || item.count || item.requests || item.total_lines_suggested),
    };
  }).filter((item) => item.value > 0);

  const total = rows.reduce((sum, item) => sum + item.value, 0);
  return rows
    .map((item) => ({ ...item, percent: total > 0 ? round2((item.value / total) * 100) : 0 }))
    .sort((a, b) => b.value - a.value);
}

function normalizeDailySeries(items, keys) {
  return (Array.isArray(items) ? items : []).map((item) => {
    const row = { date: item.date || item.day || item.bucket || "" };
    for (const key of keys) row[key] = toNumber(item[key]);
    return row;
  }).filter((item) => item.date);
}

function normalizeReportSeries(dayTotals, mappings) {
  return (Array.isArray(dayTotals) ? dayTotals : []).map((item) => {
    const row = { date: item.day || item.date || "" };
    for (const [targetKey, sourceKey] of Object.entries(mappings)) {
      row[targetKey] = toNumber(item[sourceKey]);
    }
    return row;
  }).filter((item) => item.date);
}

function normalizeReportDayTotals(dayTotals) {
  return (Array.isArray(dayTotals) ? dayTotals : [])
    .slice()
    .sort((a, b) => String(a.day || a.date || "").localeCompare(String(b.day || b.date || "")));
}

function normalizeFeatureMode(feature) {
  const value = String(feature || "").toLowerCase();
  if (isCodeCompletionFeature(value) || /inline/.test(value)) return "inline";
  if (/agent|cloud/.test(value)) return "agent";
  if (/custom/.test(value)) return "custom";
  if (/edit/.test(value)) return "edit";
  if (/ask|chat/.test(value)) return "ask";
  if (/plan/.test(value)) return "plan";
  return null;
}

function isCodeCompletionFeature(feature) {
  return String(feature || "").toLowerCase() === "code_completion";
}

function isAgentInitiatedFeature(feature) {
  return String(feature || "").toLowerCase() === "agent_edit";
}

function isCopilotCliFeature(feature) {
  return String(feature || "").toLowerCase() === "copilot_cli";
}

function normalizeCodeChangeMode(feature) {
  if (isCodeCompletionFeature(feature)) return "Completions";
  const mode = normalizeFeatureMode(feature);
  return titleMode(mode);
}

function titleMode(mode) {
  if (!mode) return "Other";
  return mode.charAt(0).toUpperCase() + mode.slice(1);
}

function buildReportRequestsByMode(dayTotals) {
  return (Array.isArray(dayTotals) ? dayTotals : []).map((day) => {
    const row = { date: day.day || day.date || "", edit: 0, ask: 0, agent: 0, custom: 0, inline: 0, plan: 0 };
    for (const item of Array.isArray(day.totals_by_feature) ? day.totals_by_feature : []) {
      const mode = normalizeFeatureMode(item.feature);
      if (mode) row[mode] += toNumber(item.user_initiated_interaction_count);
    }
    return row;
  }).filter((row) => row.date);
}

function buildReportAverageChatRequests(dayTotals) {
  return (Array.isArray(dayTotals) ? dayTotals : []).map((day) => {
    const activeUsers = toNumber(day.daily_active_users);
    return {
      date: day.day || day.date || "",
      requests: activeUsers > 0 ? round2(toNumber(day.user_initiated_interaction_count) / activeUsers) : 0,
    };
  }).filter((row) => row.date);
}

function buildReportCompletionAcceptance(dayTotals) {
  const summary = {
    suggestions: 0,
    acceptances: 0,
    rate: 0,
    linesSuggested: 0,
    linesAccepted: 0,
  };
  const series = [];

  for (const day of Array.isArray(dayTotals) ? dayTotals : []) {
    const completions = (Array.isArray(day.totals_by_feature) ? day.totals_by_feature : [])
      .filter((item) => isCodeCompletionFeature(item.feature));
    const suggestions = completions.reduce((sum, item) => sum + toNumber(item.code_generation_activity_count), 0);
    const acceptances = completions.reduce((sum, item) => sum + toNumber(item.code_acceptance_activity_count), 0);
    const linesSuggested = completions.reduce((sum, item) => sum + toNumber(item.loc_suggested_to_add_sum) + toNumber(item.loc_suggested_to_delete_sum), 0);
    const linesAccepted = completions.reduce((sum, item) => sum + toNumber(item.loc_added_sum) + toNumber(item.loc_deleted_sum), 0);
    const date = day.day || day.date || "";

    summary.suggestions += suggestions;
    summary.acceptances += acceptances;
    summary.linesSuggested += linesSuggested;
    summary.linesAccepted += linesAccepted;
    if (date) series.push({ date, rate: suggestions > 0 ? round2((acceptances / suggestions) * 100) : 0 });
  }

  summary.rate = summary.suggestions > 0 ? round2((summary.acceptances / summary.suggestions) * 100) : 0;
  return { series, summary };
}

function buildReportCodeCompletions(dayTotals) {
  return (Array.isArray(dayTotals) ? dayTotals : []).map((day) => {
    const completions = (Array.isArray(day.totals_by_feature) ? day.totals_by_feature : [])
      .filter((item) => isCodeCompletionFeature(item.feature));
    return {
      date: day.day || day.date || "",
      suggested: completions.reduce((sum, item) => sum + toNumber(item.code_generation_activity_count), 0),
      accepted: completions.reduce((sum, item) => sum + toNumber(item.code_acceptance_activity_count), 0),
    };
  }).filter((row) => row.date);
}

function buildReportCodeChangesByMode(dayTotals) {
  const totals = new Map();
  for (const day of Array.isArray(dayTotals) ? dayTotals : []) {
    for (const item of Array.isArray(day.totals_by_feature) ? day.totals_by_feature : []) {
      if (isAgentInitiatedFeature(item.feature) || isCopilotCliFeature(item.feature)) continue;
      const mode = normalizeCodeChangeMode(item.feature);
      if (!mode || mode === "Other") continue;
      const current = totals.get(mode) || { label: mode, suggested: 0, added: 0, deleted: 0 };
      current.suggested += toNumber(item.loc_suggested_to_add_sum) + toNumber(item.loc_suggested_to_delete_sum);
      current.added += toNumber(item.loc_added_sum);
      current.deleted += toNumber(item.loc_deleted_sum);
      totals.set(mode, current);
    }
  }
  const order = new Map(["Completions", "Ask", "Inline", "Edit", "Agent", "Custom", "Plan"].map((label, index) => [label, index]));
  return Array.from(totals.values()).sort((a, b) => (order.get(a.label) ?? 99) - (order.get(b.label) ?? 99));
}

function buildReportAgentInitiated(dayTotals) {
  const total = { label: "Agent", added: 0, deleted: 0 };
  for (const day of Array.isArray(dayTotals) ? dayTotals : []) {
    for (const item of Array.isArray(day.totals_by_feature) ? day.totals_by_feature : []) {
      if (!isAgentInitiatedFeature(item.feature)) continue;
      total.added += toNumber(item.loc_added_sum);
      total.deleted += toNumber(item.loc_deleted_sum);
    }
  }
  return total.added || total.deleted ? [total] : [];
}

function buildReportCodeChangesByModel(dayTotals, agentInitiated) {
  const totals = new Map();
  for (const day of Array.isArray(dayTotals) ? dayTotals : []) {
    for (const item of Array.isArray(day.totals_by_model_feature) ? day.totals_by_model_feature : []) {
      const isAgent = isAgentInitiatedFeature(item.feature);
      if (agentInitiated !== isAgent || isCopilotCliFeature(item.feature)) continue;
      const suggested = toNumber(item.loc_suggested_to_add_sum) + toNumber(item.loc_suggested_to_delete_sum);
      if (!agentInitiated && suggested <= 0) continue;
      const model = item.model || "Other models";
      const current = totals.get(model) || { label: model, suggested: 0, added: 0, deleted: 0 };
      current.suggested += suggested;
      current.added += toNumber(item.loc_added_sum);
      current.deleted += toNumber(item.loc_deleted_sum);
      totals.set(model, current);
    }
  }
  return Array.from(totals.values()).sort((a, b) => agentInitiated
    ? (b.added + b.deleted) - (a.added + a.deleted)
    : b.suggested - a.suggested);
}

function buildReportCodeChangesByLanguage(dayTotals, agentInitiated = false) {
  const totals = new Map();
  for (const day of Array.isArray(dayTotals) ? dayTotals : []) {
    for (const item of Array.isArray(day.totals_by_language_feature) ? day.totals_by_language_feature : []) {
      const isAgent = isAgentInitiatedFeature(item.feature);
      if (agentInitiated !== isAgent || isCopilotCliFeature(item.feature)) continue;
      const suggested = toNumber(item.loc_suggested_to_add_sum) + toNumber(item.loc_suggested_to_delete_sum);
      if (!agentInitiated && suggested <= 0) continue;
      const language = item.language || "Other languages";
      const current = totals.get(language) || { label: language, suggested: 0, added: 0, deleted: 0 };
      current.suggested += suggested;
      current.added += toNumber(item.loc_added_sum);
      current.deleted += toNumber(item.loc_deleted_sum);
      totals.set(language, current);
    }
  }
  return Array.from(totals.values()).sort((a, b) => agentInitiated
    ? (b.added + b.deleted) - (a.added + a.deleted)
    : b.suggested - a.suggested);
}

function buildReportChatModelUsage(dayTotals) {
  const totals = new Map();
  for (const day of Array.isArray(dayTotals) ? dayTotals : []) {
    for (const item of Array.isArray(day.totals_by_model_feature) ? day.totals_by_model_feature : []) {
      const model = item.model || "Other models";
      totals.set(model, (totals.get(model) || 0) + toNumber(item.user_initiated_interaction_count));
    }
  }
  return normalizeDistribution(Array.from(totals.entries()).map(([label, value]) => ({ label, value })));
}

function buildReportModelPerChatMode(dayTotals) {
  const totals = new Map();
  for (const day of Array.isArray(dayTotals) ? dayTotals : []) {
    for (const item of Array.isArray(day.totals_by_model_feature) ? day.totals_by_model_feature : []) {
      const model = item.model || "Other models";
      const mode = normalizeFeatureMode(item.feature);
      if (!mode) continue;
      const current = totals.get(model) || { model, edit: 0, ask: 0, agent: 0, custom: 0, inline: 0, plan: 0 };
      current[mode] += toNumber(item.user_initiated_interaction_count);
      totals.set(model, current);
    }
  }
  return Array.from(totals.values());
}

function buildReportModelEfficiency(dayTotals) {
  const totals = new Map();
  for (const day of Array.isArray(dayTotals) ? dayTotals : []) {
    for (const item of Array.isArray(day.totals_by_model_feature) ? day.totals_by_model_feature : []) {
      const model = item.model || "Other models";
      const mode = normalizeFeatureMode(item.feature) || "unknown";
      const key = `${model}\u0000${mode}`;
      const current = totals.get(key) || { model, mode, suggested: 0, added: 0, deleted: 0, accepted: 0 };
      current.suggested += toNumber(item.loc_suggested_to_add_sum) + toNumber(item.loc_suggested_to_delete_sum);
      current.added += toNumber(item.loc_added_sum);
      current.deleted += toNumber(item.loc_deleted_sum);
      current.accepted += toNumber(item.code_acceptance_activity_count);
      totals.set(key, current);
    }
  }
  return normalizeModelEfficiency(Array.from(totals.values()));
}

function buildReportLanguageUsage(dayTotals) {
  const totals = new Map();
  for (const day of Array.isArray(dayTotals) ? dayTotals : []) {
    for (const item of Array.isArray(day.totals_by_language_feature) ? day.totals_by_language_feature : []) {
      const language = item.language || "Other languages";
      const value = toNumber(item.loc_suggested_to_add_sum) + toNumber(item.loc_suggested_to_delete_sum);
      totals.set(language, (totals.get(language) || 0) + value);
    }
  }
  return normalizeDistribution(Array.from(totals.entries()).map(([label, value]) => ({ label, value })));
}

function buildAgentAdoption(usage) {
  const activeUsers = toNumber(usage.total_active_users);
  const engagedUsers = toNumber(usage.total_engaged_users || usage.agent_active_users || usage.total_agent_users);
  return {
    percent: activeUsers > 0 ? Math.round((engagedUsers / activeUsers) * 100) : 0,
    engagedUsers,
    activeUsers,
  };
}

function buildReportAgentAdoption(latestDay) {
  const activeUsers = toNumber(latestDay.monthly_active_users) || toNumber(latestDay.daily_active_users);
  const engagedUsers = toNumber(latestDay.monthly_active_agent_users) ||
    toNumber(latestDay.monthly_active_copilot_cloud_agent_users) ||
    toNumber(latestDay.daily_active_copilot_cloud_agent_users);
  return {
    percent: activeUsers > 0 ? Math.round((engagedUsers / activeUsers) * 100) : 0,
    engagedUsers,
    activeUsers,
  };
}

function generateInsightRecommendations(summary) {
  const recommendations = [];
  const agentAdoption = summary.agentAdoption?.percent || 0;
  const agentContribution = summary.agentContribution || 0;
  const averageLinesDeletedByAgent = summary.averageLinesDeletedByAgent || 0;
  const agentModels = (summary.modelEfficiency || []).filter((model) => model.mode === "agent");
  const languageUsage = summary.languageUsage || [];

  if (agentAdoption > 70 && agentContribution > 40) {
    recommendations.push({
      type: "roi",
      title: "高价值警报",
      severity: "high",
      message: "团队已深度进入 AI 驱动的 Agent 研发模式，AI 独立变更代码接近半数。",
      evidence: `Agent adoption ${agentAdoption}%，Agent Contribution ${agentContribution}%。`,
      recommendation: "建议对未覆盖用户进行进阶 Agent 培训，并沉淀高频任务提示词模板。",
    });
  }

  if (averageLinesDeletedByAgent > 400) {
    recommendations.push({
      type: "refactoring",
      title: "代码资产重构评估",
      severity: "medium",
      message: "AI 正在通过重构大幅精简代码，技术债清理成效显著。",
      evidence: `Average lines deleted by agent ${averageLinesDeletedByAgent}。`,
      recommendation: "建议结合 CI/CD 的单元测试覆盖率评估重构安全性。",
    });
  }

  if (agentModels.length > 1) {
    const bestModel = agentModels[0];
    const nextModel = agentModels[1];
    if (bestModel.throughput > nextModel.throughput || bestModel.acceptanceRate > nextModel.acceptanceRate) {
      recommendations.push({
        type: "model-allocation",
        title: "模型配额优化",
        severity: "medium",
        message: `检测到复杂 Agent 场景下 ${bestModel.label} 表现更优。`,
        evidence: `${bestModel.label} throughput ${bestModel.throughput}，acceptance rate ${bestModel.acceptanceRate}%。`,
        recommendation: "建议将复杂 Agent 模式的底层模型优先分配给高吞吐、高接受率模型。",
      });
    }
  }

  const languagePercent = Object.fromEntries(languageUsage.map((item) => [item.label.toLowerCase(), item.percent]));
  const hasStrongCoreStack = (languagePercent.java || 0) >= 20 || (languagePercent.vue || 0) >= 20;
  const typeScriptShare = languagePercent.typescript || 0;
  if (hasStrongCoreStack && typeScriptShare > 0 && typeScriptShare < 10) {
    recommendations.push({
      type: "language-coverage",
      title: "技术栈失衡提示",
      severity: "low",
      message: "核心语言采纳率较高，但 TypeScript 覆盖率偏低。",
      evidence: `TypeScript usage ${typeScriptShare}%。`,
      recommendation: "建议为前端团队配置统一的 .github/copilot-instructions.md 提示词上下文。",
    });
  }

  return recommendations;
}

function buildInsightsPayload(rawSources = {}, options = {}) {
  const metricsReport = rawSources.metricsReport || {};
  const dayTotals = normalizeReportDayTotals(metricsReport.dayTotals || metricsReport.day_totals || []);
  const latestDay = dayTotals.length > 0 ? dayTotals[dayTotals.length - 1] : {};
  const usage = rawSources.usage || {};
  const codeGeneration = rawSources.codeGeneration || {};
  const breakdown = usage.breakdown || [];
  const reportRequestsPerChatMode = buildReportRequestsByMode(dayTotals);
  const reportAverageChatRequests = buildReportAverageChatRequests(dayTotals);
  const reportCompletionAcceptance = buildReportCompletionAcceptance(dayTotals);
  const reportCodeCompletions = buildReportCodeCompletions(dayTotals);
  const reportCodeChangesByMode = buildReportCodeChangesByMode(dayTotals);
  const reportAgentInitiated = buildReportAgentInitiated(dayTotals);
  const reportUserCodeChangesByModel = buildReportCodeChangesByModel(dayTotals, false);
  const reportAgentCodeChangesByModel = buildReportCodeChangesByModel(dayTotals, true).map(({ label, added, deleted }) => ({ label, added, deleted }));
  const reportUserCodeChangesByLanguage = buildReportCodeChangesByLanguage(dayTotals, false);
  const reportAgentCodeChangesByLanguage = buildReportCodeChangesByLanguage(dayTotals, true).map(({ label, added, deleted }) => ({ label, added, deleted }));
  const reportChatModelUsage = buildReportChatModelUsage(dayTotals);
  const reportModelPerChatMode = buildReportModelPerChatMode(dayTotals);
  const reportModelEfficiency = buildReportModelEfficiency(dayTotals);
  const languageUsage = normalizeLanguageUsage(breakdown);
  const reportLanguageUsage = buildReportLanguageUsage(dayTotals);
  const effectiveLanguageUsage = languageUsage.length > 0 ? languageUsage : reportLanguageUsage;
  const reportCodeChangesByLanguage = buildReportCodeChangesByLanguage(dayTotals);
  const modelEfficiency = normalizeModelEfficiency(codeGeneration.models || codeGeneration.breakdown);
  const effectiveModelEfficiency = reportModelEfficiency.length > 0 ? reportModelEfficiency : modelEfficiency;
  const chatModelUsage = normalizeDistribution(usage.models || usage.model_usage || []);
  const effectiveChatModelUsage = chatModelUsage.length > 0 ? chatModelUsage : reportChatModelUsage;
  const mostUsedChatModel = effectiveChatModelUsage[0]?.label || usage.most_used_chat_model || effectiveModelEfficiency[0]?.label || "-";
  const usageAgentAdoption = buildAgentAdoption(usage);
  const reportAgentAdoption = buildReportAgentAdoption(latestDay);
  const agentAdoption = usageAgentAdoption.activeUsers > 0 ? usageAgentAdoption : reportAgentAdoption;
  const totalLinesChanged = dayTotals.reduce((sum, item) => sum + toNumber(item.loc_added_sum) + toNumber(item.loc_deleted_sum), 0);
  const agentLines = reportAgentInitiated.reduce((sum, item) => sum + item.added + item.deleted, 0);
  const agentDeletedLines = reportAgentInitiated.reduce((sum, item) => sum + item.deleted, 0);
  const agentContribution = round2(toNumber(codeGeneration.agent_contribution_percent || codeGeneration.agentContributionPercent)) ||
    (totalLinesChanged > 0 ? round2((agentLines / totalLinesChanged) * 100) : 0);
  const averageLinesDeletedByAgent = round2(toNumber(codeGeneration.average_lines_deleted_by_agent || codeGeneration.averageLinesDeletedByAgent)) ||
    (agentAdoption.engagedUsers > 0 ? round2(agentDeletedLines / agentAdoption.engagedUsers) : 0);
  const linesChangedWithAi = round2(toNumber(codeGeneration.lines_changed_with_ai || codeGeneration.linesChangedWithAi)) || totalLinesChanged ||
    modelEfficiency.reduce((sum, model) => sum + model.added + model.deleted, 0);
  const insights = generateInsightRecommendations({
    agentAdoption,
    agentContribution,
    averageLinesDeletedByAgent,
    languageUsage: effectiveLanguageUsage,
    modelEfficiency: effectiveModelEfficiency,
  });

  return {
    meta: {
      range: Number(options.range || 28),
      generatedAt: new Date().toISOString(),
      warnings: [],
    },
    tabs: {
      usage: {
        metrics: {
          ideActiveUsers: toNumber(usage.total_active_users) || toNumber(latestDay.monthly_active_users) || toNumber(latestDay.daily_active_users),
          agentAdoption,
          mostUsedChatModel,
        },
        charts: {
          dailyActiveUsers: normalizeDailySeries(usage.daily_active_users || usage.dailyActiveUsers, ["users"]).length > 0
            ? normalizeDailySeries(usage.daily_active_users || usage.dailyActiveUsers, ["users"])
            : normalizeReportSeries(dayTotals, { users: "daily_active_users" }),
          weeklyActiveUsers: normalizeDailySeries(usage.weekly_active_users || usage.weeklyActiveUsers, ["users"]).length > 0
            ? normalizeDailySeries(usage.weekly_active_users || usage.weeklyActiveUsers, ["users"])
            : normalizeReportSeries(dayTotals, { users: "weekly_active_users" }),
          averageChatRequests: normalizeDailySeries(usage.average_chat_requests || usage.averageChatRequests, ["requests"]).length > 0
            ? normalizeDailySeries(usage.average_chat_requests || usage.averageChatRequests, ["requests"])
            : reportAverageChatRequests,
          requestsPerChatMode: normalizeDailySeries(usage.requests_per_chat_mode || usage.requestsPerChatMode, ["edit", "ask", "agent", "custom", "inline", "plan"]).length > 0
            ? normalizeDailySeries(usage.requests_per_chat_mode || usage.requestsPerChatMode, ["edit", "ask", "agent", "custom", "inline", "plan"])
            : reportRequestsPerChatMode,
          languageUsage: effectiveLanguageUsage,
          completionAcceptanceRate: {
            series: normalizeDailySeries(usage.completion_acceptance_rate || usage.completionAcceptanceRate, ["rate"]).length > 0
              ? normalizeDailySeries(usage.completion_acceptance_rate || usage.completionAcceptanceRate, ["rate"])
              : reportCompletionAcceptance.series,
            summary: breakdown.length > 0 ? summarizeCompletions(breakdown) : reportCompletionAcceptance.summary,
          },
          codeCompletions: reportCodeCompletions,
          chatModelUsage: effectiveChatModelUsage,
          modelPerChatMode: usage.model_per_chat_mode || usage.modelPerChatMode || reportModelPerChatMode,
        },
      },
      codeGeneration: {
        metrics: {
          linesChangedWithAi,
          agentContribution,
          averageLinesDeletedByAgent,
        },
        charts: {
          modelEfficiency: effectiveModelEfficiency,
          dailyLinesChanged: normalizeDailySeries(codeGeneration.daily_lines_changed || codeGeneration.dailyLinesChanged, ["added", "deleted"]).length > 0
            ? normalizeDailySeries(codeGeneration.daily_lines_changed || codeGeneration.dailyLinesChanged, ["added", "deleted"])
            : normalizeReportSeries(dayTotals, { added: "loc_added_sum", deleted: "loc_deleted_sum" }),
          userInitiatedByMode: codeGeneration.user_initiated_by_mode || codeGeneration.userInitiatedByMode || reportCodeChangesByMode,
          agentInitiated: codeGeneration.agent_initiated || codeGeneration.agentInitiated || reportAgentInitiated,
          userInitiatedByModel: codeGeneration.user_initiated_by_model || codeGeneration.userInitiatedByModel || reportUserCodeChangesByModel,
          agentInitiatedByModel: codeGeneration.agent_initiated_by_model || codeGeneration.agentInitiatedByModel || reportAgentCodeChangesByModel,
          userInitiatedByLanguage: codeGeneration.user_initiated_by_language || codeGeneration.userInitiatedByLanguage || reportUserCodeChangesByLanguage,
          agentInitiatedByLanguage: codeGeneration.agent_initiated_by_language || codeGeneration.agentInitiatedByLanguage || reportAgentCodeChangesByLanguage,
        },
      },
    },
    insights,
  };
}

module.exports = {
  buildInsightsPayload,
  __testables: {
    buildAgentAdoption,
    buildReportAverageChatRequests,
    buildReportAgentAdoption,
    buildReportCodeCompletions,
    buildReportCompletionAcceptance,
    generateInsightRecommendations,
    normalizeDailySeries,
    normalizeDistribution,
    buildReportCodeChangesByMode,
    buildReportChatModelUsage,
    buildReportCodeChangesByLanguage,
    buildReportModelEfficiency,
    buildReportModelPerChatMode,
    buildReportRequestsByMode,
    buildReportLanguageUsage,
    normalizeReportSeries,
    normalizeModelEfficiency,
    normalizeLanguageUsage,
    summarizeCompletions,
  },
};