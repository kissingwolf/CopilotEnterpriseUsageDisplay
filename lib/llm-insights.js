/**
 * LLM-powered insight generation for the Copilot Insights dashboard.
 *
 * Calls an OpenAI-compatible chat completions endpoint and converts the
 * aggregated usage metrics into natural-language optimization recommendations.
 *
 * Config (secrets live only in .env):
 *   LLM_URL        - OpenAI-compatible base URL, e.g. https://.../v1
 *   LLM_API_KEY    - API key (Bearer token)
 *   LLM_MODEL      - model name, e.g. qwen3.7-plus
 *   LLM_ENABLED    - "false" disables LLM insights entirely (default enabled)
 *   LLM_TIMEOUT_MS - request timeout in ms (default 15000)
 *
 * The rule engine remains the fallback: if the LLM is unconfigured, disabled,
 * times out, or errors, this returns an empty list and the caller keeps the
 * deterministic rule-based recommendations.
 */
const logger = require("./logger");

const VALID_SEVERITY = new Set(["high", "medium", "low"]);

function llmConfig() {
  return {
    url: (process.env.LLM_URL || "").trim().replace(/\/+$/, ""),
    apiKey: (process.env.LLM_API_KEY || "").trim(),
    model: (process.env.LLM_MODEL || "").trim(),
    enabled: String(process.env.LLM_ENABLED ?? "true").toLowerCase() !== "false",
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS) || 15000,
  };
}

function isLlmConfigured(cfg = llmConfig()) {
  return Boolean(cfg.enabled && cfg.url && cfg.apiKey && cfg.model);
}

function buildPromptPayload(data) {
  const usage = data?.tabs?.usage || {};
  const code = data?.tabs?.codeGeneration || {};
  return {
    range: data?.meta?.range,
    usageMetrics: usage.metrics || {},
    codeMetrics: code.metrics || {},
    languageUsage: usage.charts?.languageUsage || [],
    chatModelUsage: usage.charts?.chatModelUsage || [],
    modelEfficiency: code.charts?.modelEfficiency || [],
    ruleInsights: (data?.insights || []).map((i) => ({ type: i.type, title: i.title, severity: i.severity })),
  };
}

function extractJsonArray(text) {
  const trimmed = String(text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return [];
  return JSON.parse(trimmed.slice(start, end + 1));
}

function sanitizeRecommendations(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => item && (item.title || item.message))
    .slice(0, 6)
    .map((item) => ({
      type: String(item.type || "llm-insight"),
      title: String(item.title || "AI 洞察"),
      severity: VALID_SEVERITY.has(String(item.severity)) ? String(item.severity) : "low",
      message: String(item.message || ""),
      evidence: String(item.evidence || ""),
      recommendation: String(item.recommendation || ""),
      source: "llm",
    }));
}

const SYSTEM_PROMPT = [
  "你是 GitHub Copilot 企业用量分析专家。",
  "根据提供的聚合指标（JSON）给出高价值、可执行的优化建议。",
  "只输出一个 JSON 数组，不要包含任何额外文字或 Markdown。",
  '每个元素形如：{"type":string,"title":string,"severity":"high"|"medium"|"low","message":string,"evidence":string,"recommendation":string}。',
  "title/message/recommendation 用简体中文；evidence 需引用具体数字。最多 5 条，按 severity 由高到低排序。",
  "若数据不足以得出结论，返回空数组 []。",
].join("\n");

async function generateLlmInsights(data, options = {}) {
  const cfg = { ...llmConfig(), ...options };
  if (!isLlmConfigured(cfg)) return { insights: [], used: false, reason: "not_configured" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const response = await fetch(`${cfg.url}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.3,
        // Disable the model's chain-of-thought (Qwen/DashScope). Reasoning mode
        // can spend thousands of tokens and take >60s; other OpenAI-compatible
        // providers ignore this unknown field.
        enable_thinking: false,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(buildPromptPayload(data)) },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`${response.status} ${response.statusText} ${body}`.trim());
    }

    const json = await response.json();
    const content = json?.choices?.[0]?.message?.content || "";
    const insights = sanitizeRecommendations(extractJsonArray(content));
    return { insights, used: insights.length > 0, reason: insights.length > 0 ? "ok" : "empty" };
  } catch (error) {
    const reason = error.name === "AbortError" ? "timeout" : "error";
    logger.warn({ err: error.message, reason }, "LLM insights failed; falling back to rule engine");
    return { insights: [], used: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

function mergeInsights(ruleInsights = [], llmInsights = []) {
  const rank = { high: 0, medium: 1, low: 2 };
  const ruled = (ruleInsights || []).map((i) => ({ ...i, source: i.source || "rule" }));
  return [...llmInsights, ...ruled].sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3));
}

module.exports = {
  generateLlmInsights,
  mergeInsights,
  isLlmConfigured,
  llmConfig,
  __testables: { buildPromptPayload, extractJsonArray, sanitizeRecommendations },
};
