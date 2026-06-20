import { describe, expect, it } from "vitest";

const { buildInsightsPayload } = require("../lib/insights-aggregator");

describe("buildInsightsPayload", () => {
  it("normalizes Copilot usage metrics into the IDE usage dashboard shape", () => {
    const payload = buildInsightsPayload({
      usage: {
        total_active_users: 189,
        breakdown: [
          {
            language: "Java",
            total_suggestions_count: 100,
            total_acceptances_count: 25,
            total_lines_suggested: 1000,
            total_lines_accepted: 280,
          },
          {
            language: "Vue",
            total_suggestions_count: 60,
            total_acceptances_count: 15,
            total_lines_suggested: 500,
            total_lines_accepted: 120,
          },
        ],
      },
    }, { range: 28 });

    expect(payload.tabs.usage.metrics.ideActiveUsers).toBe(189);
    expect(payload.tabs.usage.charts.languageUsage).toEqual([
      { label: "Java", value: 1000, percent: 66.67 },
      { label: "Vue", value: 500, percent: 33.33 },
    ]);
    expect(payload.tabs.usage.charts.completionAcceptanceRate.summary).toEqual({
      suggestions: 160,
      acceptances: 40,
      rate: 25,
      linesSuggested: 1500,
      linesAccepted: 400,
    });
  });

  it("emits ROI and refactoring recommendations from agent contribution thresholds", () => {
    const payload = buildInsightsPayload({
      usage: {
        total_active_users: 189,
        total_engaged_users: 154,
      },
      codeGeneration: {
        agent_contribution_percent: 43.35,
        average_lines_deleted_by_agent: 412,
      },
    }, { range: 28 });

    expect(payload.tabs.usage.metrics.agentAdoption).toEqual({
      percent: 81,
      engagedUsers: 154,
      activeUsers: 189,
    });
    expect(payload.tabs.codeGeneration.metrics.agentContribution).toBe(43.35);
    expect(payload.tabs.codeGeneration.metrics.averageLinesDeletedByAgent).toBe(412);
    expect(payload.insights.map((item) => item.title)).toEqual([
      "高价值警报",
      "代码资产重构评估",
    ]);
  });

  it("emits model allocation and language coverage recommendations", () => {
    const payload = buildInsightsPayload({
      usage: {
        total_active_users: 100,
        total_engaged_users: 65,
        breakdown: [
          { language: "Java", total_lines_suggested: 3000, total_acceptances_count: 30, total_suggestions_count: 100 },
          { language: "Vue", total_lines_suggested: 1600, total_acceptances_count: 20, total_suggestions_count: 80 },
          { language: "TypeScript", total_lines_suggested: 300, total_acceptances_count: 3, total_suggestions_count: 50 },
        ],
      },
      codeGeneration: {
        models: [
          { model: "Claude Sonnet 4.6", mode: "agent", added: 18000, deleted: 7000, accepted: 1200, suggested: 1600 },
          { model: "GPT-5.3-Codex", mode: "agent", added: 9000, deleted: 3000, accepted: 500, suggested: 900 },
        ],
      },
    }, { range: 28 });

    expect(payload.tabs.usage.charts.languageUsage.map((item) => item.label)).toEqual([
      "Java",
      "Vue",
      "TypeScript",
    ]);
    expect(payload.tabs.codeGeneration.charts.modelEfficiency).toEqual([
      { label: "Claude Sonnet 4.6", mode: "agent", suggested: 1600, added: 18000, deleted: 7000, accepted: 1200, throughput: 25000, acceptanceRate: 75 },
      { label: "GPT-5.3-Codex", mode: "agent", suggested: 900, added: 9000, deleted: 3000, accepted: 500, throughput: 12000, acceptanceRate: 55.56 },
    ]);
    expect(payload.insights.map((item) => item.title)).toEqual([
      "模型配额优化",
      "技术栈失衡提示",
    ]);
  });

  it("maps report feature totals into chat mode and code generation charts", () => {
    const payload = buildInsightsPayload({
      metricsReport: {
        dayTotals: [
          {
            day: "2026-06-16",
            daily_active_users: 7,
            user_initiated_interaction_count: 28,
            totals_by_feature: [
              { feature: "code_completion", code_generation_activity_count: 50, code_acceptance_activity_count: 10, loc_suggested_to_add_sum: 100, loc_added_sum: 20, loc_deleted_sum: 0 },
            ],
          },
          {
            day: "2026-06-17",
            monthly_active_agent_users: 4,
            daily_active_users: 5,
            user_initiated_interaction_count: 20,
            loc_added_sum: 600,
            loc_deleted_sum: 400,
            totals_by_feature: [
              { feature: "code_completion", code_generation_activity_count: 100, code_acceptance_activity_count: 25, loc_suggested_to_add_sum: 120, loc_added_sum: 30, loc_deleted_sum: 0 },
              { feature: "copilot_cli", loc_added_sum: 80, loc_deleted_sum: 70 },
              { feature: "agent_edit", loc_added_sum: 200, loc_deleted_sum: 100 },
              { feature: "Edit", user_initiated_interaction_count: 12, loc_suggested_to_add_sum: 200, loc_added_sum: 80, loc_deleted_sum: 10 },
              { feature: "chat_panel_agent_mode", user_initiated_interaction_count: 7, loc_suggested_to_add_sum: 300, loc_added_sum: 140, loc_deleted_sum: 60 },
            ],
            totals_by_model_feature: [
              { model: "gpt-5.3-codex", feature: "agent_edit", loc_added_sum: 120, loc_deleted_sum: 80 },
              { model: "gpt-5.4", feature: "chat_panel_agent_mode", loc_suggested_to_add_sum: 300, loc_added_sum: 140 },
              { model: "other", feature: "copilot_cli", loc_added_sum: 80, loc_deleted_sum: 70 },
            ],
            totals_by_language_feature: [
              { language: "vue", feature: "agent_edit", loc_added_sum: 120, loc_deleted_sum: 80 },
              { language: "java", feature: "chat_panel_agent_mode", loc_suggested_to_add_sum: 300, loc_added_sum: 140 },
              { language: "other", feature: "copilot_cli", loc_added_sum: 80, loc_deleted_sum: 70 },
            ],
          },
        ],
      },
    }, { range: 28 });

    expect(payload.tabs.usage.charts.requestsPerChatMode).toEqual([
      { date: "2026-06-16", edit: 0, ask: 0, agent: 0, custom: 0, inline: 0, plan: 0 },
      { date: "2026-06-17", edit: 12, ask: 0, agent: 7, custom: 0, inline: 0, plan: 0 },
    ]);
    expect(payload.tabs.usage.charts.averageChatRequests).toEqual([
      { date: "2026-06-16", requests: 4 },
      { date: "2026-06-17", requests: 4 },
    ]);
    expect(payload.tabs.usage.charts.completionAcceptanceRate.series).toEqual([
      { date: "2026-06-16", rate: 20 },
      { date: "2026-06-17", rate: 25 },
    ]);
    expect(payload.tabs.usage.charts.codeCompletions).toEqual([
      { date: "2026-06-16", suggested: 50, accepted: 10 },
      { date: "2026-06-17", suggested: 100, accepted: 25 },
    ]);
    expect(payload.tabs.usage.charts.completionAcceptanceRate.summary).toEqual({
      suggestions: 150,
      acceptances: 35,
      rate: 23.33,
      linesSuggested: 220,
      linesAccepted: 50,
    });
    expect(payload.tabs.codeGeneration.metrics).toEqual({
      linesChangedWithAi: 1000,
      agentContribution: 30,
      averageLinesDeletedByAgent: 25,
    });
    expect(payload.tabs.codeGeneration.charts.userInitiatedByMode).toEqual([
      { label: "Completions", suggested: 220, added: 50, deleted: 0 },
      { label: "Edit", suggested: 200, added: 80, deleted: 10 },
      { label: "Agent", suggested: 300, added: 140, deleted: 60 },
    ]);
    expect(payload.tabs.codeGeneration.charts.agentInitiated).toEqual([
      { label: "Agent", added: 200, deleted: 100 },
    ]);
    expect(payload.tabs.codeGeneration.charts.userInitiatedByModel).toEqual([
      { label: "gpt-5.4", suggested: 300, added: 140, deleted: 0 },
    ]);
    expect(payload.tabs.codeGeneration.charts.agentInitiatedByModel).toEqual([
      { label: "gpt-5.3-codex", added: 120, deleted: 80 },
    ]);
    expect(payload.tabs.codeGeneration.charts.userInitiatedByLanguage).toEqual([
      { label: "java", suggested: 300, added: 140, deleted: 0 },
    ]);
    expect(payload.tabs.codeGeneration.charts.agentInitiatedByLanguage).toEqual([
      { label: "vue", added: 120, deleted: 80 },
    ]);
  });

  it("maps report model-feature totals into model usage and efficiency charts", () => {
    const payload = buildInsightsPayload({
      metricsReport: {
        dayTotals: [
          {
            day: "2026-06-17",
            totals_by_model_feature: [
              { model: "Claude Sonnet 4.6", feature: "Agent", user_initiated_interaction_count: 12, code_acceptance_activity_count: 9, loc_suggested_to_add_sum: 300, loc_added_sum: 120, loc_deleted_sum: 40 },
              { model: "GPT-5.3-Codex", feature: "Ask", user_initiated_interaction_count: 8, code_acceptance_activity_count: 3, loc_suggested_to_add_sum: 100, loc_added_sum: 30, loc_deleted_sum: 10 },
            ],
          },
        ],
      },
    }, { range: 28 });

    expect(payload.tabs.usage.metrics.mostUsedChatModel).toBe("Claude Sonnet 4.6");
    expect(payload.tabs.usage.charts.chatModelUsage).toEqual([
      { label: "Claude Sonnet 4.6", value: 12, percent: 60 },
      { label: "GPT-5.3-Codex", value: 8, percent: 40 },
    ]);
    expect(payload.tabs.usage.charts.modelPerChatMode).toEqual([
      { model: "Claude Sonnet 4.6", edit: 0, ask: 0, agent: 12, custom: 0, inline: 0, plan: 0 },
      { model: "GPT-5.3-Codex", edit: 0, ask: 8, agent: 0, custom: 0, inline: 0, plan: 0 },
    ]);
    expect(payload.tabs.codeGeneration.charts.modelEfficiency).toEqual([
      { label: "Claude Sonnet 4.6", mode: "agent", suggested: 300, added: 120, deleted: 40, accepted: 9, throughput: 160, acceptanceRate: 3 },
      { label: "GPT-5.3-Codex", mode: "ask", suggested: 100, added: 30, deleted: 10, accepted: 3, throughput: 40, acceptanceRate: 3 },
    ]);
  });

  it("maps report language totals into language charts and coverage insights", () => {
    const payload = buildInsightsPayload({
      metricsReport: {
        dayTotals: [
          {
            day: "2026-06-17",
            totals_by_language_feature: [
              { language: "Java", feature: "Edit", loc_suggested_to_add_sum: 3000, loc_added_sum: 1200, loc_deleted_sum: 200 },
              { language: "Vue", feature: "Ask", loc_suggested_to_add_sum: 1500, loc_added_sum: 600, loc_deleted_sum: 100 },
              { language: "TypeScript", feature: "Agent", loc_suggested_to_add_sum: 300, loc_added_sum: 90, loc_deleted_sum: 20 },
            ],
          },
        ],
      },
    }, { range: 28 });

    expect(payload.tabs.usage.charts.languageUsage).toEqual([
      { label: "Java", value: 3000, percent: 62.5 },
      { label: "Vue", value: 1500, percent: 31.25 },
      { label: "TypeScript", value: 300, percent: 6.25 },
    ]);
    expect(payload.tabs.codeGeneration.charts.userInitiatedByLanguage).toEqual([
      { label: "Java", suggested: 3000, added: 1200, deleted: 200 },
      { label: "Vue", suggested: 1500, added: 600, deleted: 100 },
      { label: "TypeScript", suggested: 300, added: 90, deleted: 20 },
    ]);
    expect(payload.insights.map((item) => item.title)).toContain("技术栈失衡提示");
  });

  it("maps report agent active users into Agent adoption metrics", () => {
    const payload = buildInsightsPayload({
      metricsReport: {
        dayTotals: [
          { day: "2026-05-25", monthly_active_users: 200, monthly_active_agent_users: 160 },
          { day: "2026-06-17", monthly_active_users: 189, monthly_active_agent_users: 154 },
        ],
      },
    }, { range: 28 });

    expect(payload.tabs.usage.metrics.agentAdoption).toEqual({
      percent: 81,
      engagedUsers: 154,
      activeUsers: 189,
    });
  });

  it("excludes the report 'others' catch-all bucket from language and model charts", () => {
    const payload = buildInsightsPayload({
      metricsReport: {
        dayTotals: [
          {
            day: "2026-06-17",
            totals_by_language_feature: [
              { language: "java", feature: "code_completion", loc_suggested_to_add_sum: 3000, loc_added_sum: 1200, loc_deleted_sum: 0 },
              // GitHub's synthetic catch-all: language `others` paired with feature `others`,
              // carrying non user-initiated deletions. Must not surface as a language.
              { language: "others", feature: "others", loc_suggested_to_add_sum: 49781, loc_added_sum: 117075, loc_deleted_sum: 123791 },
            ],
            totals_by_model_feature: [
              { model: "gpt-5.3-codex", feature: "chat_panel_ask_mode", user_initiated_interaction_count: 10, loc_suggested_to_add_sum: 1000, loc_added_sum: 300, loc_deleted_sum: 0 },
              { model: "others", feature: "others", user_initiated_interaction_count: 3775, loc_suggested_to_add_sum: 14987, loc_added_sum: 78655, loc_deleted_sum: 30287 },
            ],
          },
        ],
      },
    }, { range: 28 });

    expect(payload.tabs.codeGeneration.charts.userInitiatedByLanguage).toEqual([
      { label: "java", suggested: 3000, added: 1200, deleted: 0 },
    ]);
    expect(payload.tabs.codeGeneration.charts.userInitiatedByModel).toEqual([
      { label: "gpt-5.3-codex", suggested: 1000, added: 300, deleted: 0 },
    ]);
    expect(payload.tabs.usage.charts.languageUsage).toEqual([
      { label: "java", value: 3000, percent: 100 },
    ]);
    expect(payload.tabs.usage.charts.chatModelUsage).toEqual([
      { label: "gpt-5.3-codex", value: 10, percent: 100 },
    ]);
  });
});