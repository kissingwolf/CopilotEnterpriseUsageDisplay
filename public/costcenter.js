var refreshBtn = document.getElementById("refreshBtn");
var stateSel = document.getElementById("stateSel");
var tbody = document.getElementById("tbody");
var meta = document.getElementById("meta");
var errorBox = document.getElementById("error");
var pageTitle = document.getElementById("pageTitle");
var backLink = document.getElementById("backLink");
var teamAssignPanel = document.getElementById("teamAssignPanel");
var ccTeamAll = document.getElementById("ccTeamAll");
var ccTeamList = document.getElementById("ccTeamList");
var ccPreviewBtn = document.getElementById("ccPreviewBtn");
var ccApplyBtn = document.getElementById("ccApplyBtn");
var ccAssignResult = document.getElementById("ccAssignResult");
var latestMetaText = "尚未刷新数据";
var CC_CACHE_PREFIX = "copilot-dashboard:costcenter:";
var CC_CACHE_TTL_MS = 5 * 60 * 1000;
var CC_RENDER_CHUNK_SIZE = 30;

var pathParts = window.location.pathname.split("/").filter(Boolean);
var detailName = pathParts.length >= 2 && pathParts[0] === "costcenter"
  ? decodeURIComponent(pathParts.slice(1).join("/"))
  : "";
var currentDetailCostCenter = null;
var cachedEnterpriseTeams = null;

if (backLink) {
  if (detailName) {
    backLink.href = "/costcenter";
    backLink.textContent = "返回Cost Center 管理页";
  } else {
    backLink.href = "/";
    backLink.textContent = "返回用量看板";
  }
}

function toNumber(value) {
  var n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatTs(isoText) {
  if (!isoText) return "未刷新";
  var d = new Date(isoText);
  if (Number.isNaN(d.getTime())) return isoText;
  return d.toLocaleString("zh-CN", { hour12: false });
}

function setError(message) {
  if (!message) {
    errorBox.hidden = true;
    errorBox.textContent = "";
    return;
  }
  errorBox.hidden = false;
  errorBox.textContent = message;
}

function isRateLimitPayload(data, status, message) {
  if (data && data.rateLimit && data.rateLimit.limitExceeded) return true;
  if (status === 429) return true;
  return /rate limit|secondary rate limit/i.test(String(message || ""));
}

function formatRateLimitMessage(data) {
  var resetAt = data && data.rateLimit ? data.rateLimit.resetAt : null;
  if (!resetAt) return "GitHub API 速率限制已触发，请稍后再试。";
  var d = new Date(resetAt);
  if (Number.isNaN(d.getTime())) return "GitHub API 速率限制已触发，请稍后再试。";
  return "GitHub API 速率限制已触发，预计 " + d.toLocaleString("zh-CN", { hour12: false }) + " 后恢复。";
}

async function apiFetchJson(url, options, fallbackMessage) {
  var resp = await fetch(url, options);
  var text = await resp.text();
  var data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_e) {
    data = null;
  }

  if (!resp.ok || (data && data.ok === false)) {
    var message = (data && data.message) || fallbackMessage || "请求失败";
    if (isRateLimitPayload(data, resp.status, message)) {
      throw new Error(formatRateLimitMessage(data));
    }
    throw new Error(message);
  }
  return data;
}

function buildCacheKey() {
  var state = stateSel ? stateSel.value : "";
  return CC_CACHE_PREFIX + encodeURIComponent(JSON.stringify({ detailName: detailName || "", state: state || "" }));
}

function getCachedData(key) {
  try {
    var raw = localStorage.getItem(key);
    if (!raw) return null;
    var parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (Date.now() - Number(parsed.ts || 0) > CC_CACHE_TTL_MS) return null;
    return parsed.data || null;
  } catch (_e) {
    return null;
  }
}

function setCachedData(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data: data }));
  } catch (_e) {
    /* Ignore localStorage write failures */
  }
}

function setMetaRefreshing(isRefreshing) {
  meta.classList.toggle("refreshing", Boolean(isRefreshing));
  meta.textContent = isRefreshing ? (latestMetaText + " | 后台刷新中...") : latestMetaText;
}

function renderSkeletonRows(colCount, rowCount) {
  var rows = [];
  for (var i = 0; i < rowCount; i += 1) {
    rows.push(
      '<tr class="skeleton-row">' +
      Array(colCount).fill('<td><span class="skeleton-line"></span></td>').join("") +
      "</tr>"
    );
  }
  tbody.innerHTML = rows.join("");
}

function buildUserCount(resources) {
  var users = 0;
  (resources || []).forEach(function (r) {
    var t = String(r.type || "").toLowerCase();
    if (t === "user") users += 1;
  });
  return users;
}

function buildResourceCount(resources, type) {
  var target = String(type || "").toLowerCase();
  return (resources || []).filter(function (r) {
    return String(r.type || "").toLowerCase() === target;
  }).length;
}

function groupResources(resources) {
  var groups = {
    user: [],
    organization: [],
    repository: [],
    other: [],
  };

  (resources || []).forEach(function (r) {
    var t = String(r.type || "").toLowerCase();
    if (t === "user") groups.user.push(r);
    else if (t === "organization" || t === "org") groups.organization.push(r);
    else if (t === "repository" || t === "repo") groups.repository.push(r);
    else groups.other.push(r);
  });

  return groups;
}

function buildResourceDetails(resources) {
  var groups = groupResources(resources);
  var sections = [
    { key: "user", title: "Users" },
    { key: "organization", title: "Organizations" },
    { key: "repository", title: "Repositories" },
    { key: "other", title: "Others" },
  ];

  var html = '<div class="cc-resource-grid">';
  sections.forEach(function (section) {
    var list = groups[section.key];
    html += '<div class="cc-resource-group">';
    html += '<div class="cc-resource-title">' + section.title + ' (' + list.length + ')</div>';
    if (!list.length) {
      html += '<div class="cc-empty">无 ' + section.title + '</div>';
    } else {
      html += '<div class="cc-resource-list">';
      list.forEach(function (r) {
        html += '<span class="cc-tag">' + escapeHtml(r.name || "-") + '</span>';
      });
      html += '</div>';
    }
    html += '</div>';
  });
  html += "</div>";
  return html;
}

function buildExpandBtn(detailId, expanded) {
  var icon = expanded ? "\u25BE" : "\u25B8";
  var label = expanded ? "收起资源明细" : "展开资源明细";
  return '<button type="button" class="cc-expand-btn" data-detail-id="' + detailId + '" aria-label="' + label + '" aria-expanded="' + (expanded ? "true" : "false") + '">' + icon + '</button>';
}

function formatMoney(value) {
  if (value == null || Number.isNaN(Number(value))) return "--";
  return "$" + Number(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatSeatSubscriptionFee(resources, baseCost) {
  var users = buildUserCount(resources);
  var fee = toNumber(baseCost) * users;
  return formatMoney(fee);
}

function formatBudgetCell(amount, spentAmount) {
  if (amount == null || Number.isNaN(Number(amount))) {
    return '<span class="budget-na">--</span>';
  }
  var budgetNum = toNumber(amount);
  var spentNum = spentAmount == null ? null : toNumber(spentAmount);
  if (spentNum == null) {
    return '<div class="budget-cell"><span class="budget-spent">-- spent</span><span class="budget-total">' + formatMoney(budgetNum) + ' budget</span></div>';
  }

  var ratio = budgetNum > 0 ? spentNum / budgetNum : 0;
  var percent = budgetNum > 0 ? ratio * 100 : 0;
  var width = Math.min(Math.max(percent, 0), 100);
  var level = ratio >= 1 ? "danger" : ratio >= 0.75 ? "warn" : "normal";
  var over = ratio >= 1 ? '<span class="budget-over">超预算</span>' : "";

  return '<div class="budget-cell budget-progress-cell">' +
    '<div class="budget-top"><span class="budget-spent">' + formatMoney(spentNum) + ' / ' + formatMoney(budgetNum) + '</span><span class="budget-pct">' + percent.toFixed(1) + '%</span></div>' +
    '<div class="budget-bar"><div class="budget-bar-fill budget-' + level + '" style="width:' + width.toFixed(1) + '%"></div></div>' +
    over +
    '</div>';
}

function buildDetailInfo(cc) {
  var resources = Array.isArray(cc.resources) ? cc.resources : [];
  var users = buildResourceCount(resources, "user");
  var orgs = buildResourceCount(resources, "organization") + buildResourceCount(resources, "org");
  var repos = buildResourceCount(resources, "repository") + buildResourceCount(resources, "repo");

  return '<div class="cc-info-grid">' +
    '<div class="cc-info-item"><span class="k">ID</span><span class="v">' + escapeHtml(cc.id || "-") + '</span></div>' +
    '<div class="cc-info-item"><span class="k">名称</span><span class="v">' + escapeHtml(cc.name || "-") + '</span></div>' +
    '<div class="cc-info-item"><span class="k">状态</span><span class="v">' + escapeHtml(cc.state || "-") + '</span></div>' +
    '<div class="cc-info-item"><span class="k">Azure Subscription</span><span class="v">' + escapeHtml(cc.azureSubscription || "-") + '</span></div>' +
    '<div class="cc-info-item"><span class="k">Users</span><span class="v">' + users + '</span></div>' +
    '<div class="cc-info-item"><span class="k">Organizations</span><span class="v">' + orgs + '</span></div>' +
    '<div class="cc-info-item"><span class="k">Repositories</span><span class="v">' + repos + '</span></div>' +
    '<div class="cc-info-item"><span class="k">预算进度</span><span class="v">' + formatBudgetCell(cc.budgetAmount, cc.spentAmount) + '</span></div>' +
    '</div>';
}

function renderList(data) {
  var rows = Array.isArray(data.costCenters) ? data.costCenters : [];
  var seatBaseCost = toNumber(data && data.seatBaseCost);

  meta.textContent =
    "Enterprise: " + (data.enterprise || "-") +
    " | 总数: " + (data.total || 0) +
    " | 最后刷新: " + formatTs(data.fetchedAt);
  latestMetaText = meta.textContent;

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">当前筛选下没有 cost center 数据。</td></tr>';
    return;
  }

  tbody.innerHTML = "";
  var index = 0;

  function renderChunk() {
    var end = Math.min(index + CC_RENDER_CHUNK_SIZE, rows.length);
    var html = "";
    for (; index < end; index += 1) {
      var row = rows[index];
      var detailLink = "/costcenter/" + encodeURIComponent(row.name || "");
      var detailId = "cc-detail-" + index;
      html += "<tr>" +
        '<td><div class="cc-name-wrap"><a class="cc-name-link" href="' + detailLink + '">' + escapeHtml(row.name || "-") + '</a>' + buildExpandBtn(detailId, false) + '</div></td>' +
        '<td class="cc-money-col">' + formatSeatSubscriptionFee(row.resources, row.seatBaseCost != null ? row.seatBaseCost : seatBaseCost) + '</td>' +
        '<td>' + formatBudgetCell(row.budgetAmount, row.spentAmount) + '</td>' +
        "<td>" + escapeHtml(row.state || "-") + "</td>" +
        "<td>" + buildUserCount(row.resources) + "</td>" +
        "</tr>";

      html += '<tr id="' + detailId + '" class="cc-detail-row" hidden><td colspan="5">' +
        buildResourceDetails(row.resources) +
        "</td></tr>";
    }
    tbody.insertAdjacentHTML("beforeend", html);
    if (index < rows.length) {
      requestAnimationFrame(renderChunk);
    }
  }

  renderChunk();
}

function renderDetail(data) {
  var cc = data && data.costCenter ? data.costCenter : null;
  if (!cc) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">未找到该 cost center。</td></tr>';
    return;
  }

  pageTitle.textContent = "Cost Center 详情";
  currentDetailCostCenter = cc;
  if (teamAssignPanel) teamAssignPanel.hidden = false;
  meta.textContent =
    "Enterprise: " + (data.enterprise || "-") +
    " | 名称: " + (cc.name || "-") +
    " | 最后刷新: " + formatTs(data.fetchedAt);
  latestMetaText = meta.textContent;

  var html = "";
  var detailId = "cc-detail-single";
  html += "<tr>" +
    '<td><div class="cc-name-wrap">' + escapeHtml(cc.name || "-") + buildExpandBtn(detailId, true) + "</div></td>" +
    '<td class="cc-money-col">' + formatSeatSubscriptionFee(cc.resources, cc.seatBaseCost != null ? cc.seatBaseCost : (data && data.seatBaseCost)) + '</td>' +
    '<td>' + formatBudgetCell(cc.budgetAmount, cc.spentAmount) + '</td>' +
    "<td>" + escapeHtml(cc.state || "-") + "</td>" +
    "<td>" + buildUserCount(cc.resources) + "</td>" +
    "</tr>";

  html += '<tr id="' + detailId + '" class="cc-detail-row"><td colspan="5">' +
    buildDetailInfo(cc) +
    buildResourceDetails(cc.resources) +
    "</td></tr>";

  tbody.innerHTML = html;
  loadTeamOptions().catch(function (err) {
    setError(err instanceof Error ? err.message : String(err));
  });
}

async function loadTeamOptions() {
  if (!detailName || !ccTeamList) return;
  if (!cachedEnterpriseTeams) {
    var data = await apiFetchJson("/api/enterprise-teams", {}, "获取 Team 失败");
    cachedEnterpriseTeams = Array.isArray(data.teams) ? data.teams : [];
  }

  ccTeamList.innerHTML = cachedEnterpriseTeams.map(function (t) {
    return '<label class="cc-team-item">' +
      '<input type="checkbox" class="cc-team-cb" value="' + String(t.id) + '" />' +
      '<span class="name">' + escapeHtml(t.name || "-") + '</span>' +
      '<span class="desc">' + escapeHtml(t.description || "") + '</span>' +
      '</label>';
  }).join("");
  updateTeamAllState();
}

function getSelectedTeamIds() {
  var boxes = ccTeamList ? ccTeamList.querySelectorAll(".cc-team-cb") : [];
  var ids = [];
  boxes.forEach(function (b) {
    if (b.checked) ids.push(String(b.value));
  });
  return ids;
}

function updateTeamAllState() {
  if (!ccTeamAll || !ccTeamList) return;
  var boxes = ccTeamList.querySelectorAll(".cc-team-cb");
  var total = boxes.length;
  var checked = getSelectedTeamIds().length;
  ccTeamAll.checked = total > 0 && checked === total;
  ccTeamAll.indeterminate = checked > 0 && checked < total;
}

function renderAssignResult(payload) {
  if (!ccAssignResult) return;
  ccAssignResult.hidden = false;
  var unresolved = Array.isArray(payload.unresolvedTeams) ? payload.unresolvedTeams : [];
  var existing = Array.isArray(payload.existingUsers) ? payload.existingUsers : [];
  var newcomers = Array.isArray(payload.newUsers) ? payload.newUsers : [];
  var removals = Array.isArray(payload.usersToRemove) ? payload.usersToRemove : [];
  var modeText = payload.dryRun ? "预览结果" : "执行结果";
  ccAssignResult.innerHTML =
    '<div class="cc-assign-title">' + modeText + '</div>' +
    '<div class="cc-assign-summary">请求用户: ' + (payload.requestedUsersCount || 0) +
    ' | 已存在: ' + (payload.existingUsersCount || 0) +
    ' | 可新增: ' + (payload.newUsersCount || 0) +
    ' | 可删除: ' + (payload.usersToRemoveCount || 0) + '</div>' +
    (unresolved.length ? '<div class="cc-assign-warn">未识别 Team ID: ' + unresolved.join(", ") + '</div>' : "") +
    (existing.length ? '<details><summary>已存在用户 (' + existing.length + ')</summary><div class="cc-user-list">' + existing.map(escapeHtml).join(", ") + '</div></details>' : "") +
    (newcomers.length ? '<details open><summary>将新增用户 (' + newcomers.length + ')</summary><div class="cc-user-list">' + newcomers.map(escapeHtml).join(", ") + '</div></details>' : "") +
    (removals.length ? '<details><summary>可删除用户（Cost Center 有 / Team 无）(' + removals.length + ')</summary><div class="cc-user-list">' + removals.map(escapeHtml).join(", ") + '</div></details>' : "");
}

async function runTeamAssign(dryRun, removeMissingUsers) {
  if (!currentDetailCostCenter || !currentDetailCostCenter.id) {
    throw new Error("当前 cost center 信息不完整。");
  }
  var teamIds = getSelectedTeamIds();
  if (!teamIds.length) {
    throw new Error("请至少选择一个 Team。");
  }

  if (!dryRun) {
    var ok = window.confirm("确认将所选 Team 成员批量加入当前 cost center 的 Users 吗？");
    if (!ok) return null;
  }

  var data = await apiFetchJson(
    "/api/cost-centers/" + encodeURIComponent(currentDetailCostCenter.id) + "/add-users-from-teams",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamIds: teamIds, dryRun: dryRun, removeMissingUsers: Boolean(removeMissingUsers) }),
    },
    "批量加入失败"
  );
  return data;
}

async function refresh(options) {
  var opts = options || {};
  setError("");
  var cacheKey = buildCacheKey();
  var cached = getCachedData(cacheKey);
  if (cached) {
    if (detailName) renderDetail(cached);
    else renderList(cached);
  } else {
    renderSkeletonRows(5, detailName ? 4 : 8);
  }

  refreshBtn.disabled = true;
  var oldText = refreshBtn.textContent;
  refreshBtn.textContent = opts.background ? "后台刷新中..." : "刷新中...";
  setMetaRefreshing(true);

  try {
    var data;
    if (detailName) {
      data = await apiFetchJson(
        "/api/cost-centers/by-name/" + encodeURIComponent(detailName),
        {},
        "获取 cost center 详情失败"
      );
    } else {
      var state = stateSel.value;
      var query = state ? ("?state=" + encodeURIComponent(state)) : "";
      data = await apiFetchJson("/api/cost-centers" + query, {}, "获取 cost center 列表失败");
    }
    if (detailName) renderDetail(data);
    else renderList(data);
    setCachedData(cacheKey, data);
  } catch (err) {
    setError(err instanceof Error ? err.message : String(err));
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.textContent = oldText;
    setMetaRefreshing(false);
  }
}

refreshBtn.addEventListener("click", refresh);
if (!detailName) {
  stateSel.addEventListener("change", refresh);
} else {
  stateSel.disabled = true;
}

tbody.addEventListener("click", function (e) {
  var btn = e.target.closest(".cc-expand-btn");
  if (!btn) return;
  e.preventDefault();
  var detailId = btn.getAttribute("data-detail-id");
  var row = document.getElementById(detailId);
  if (!row) return;
  var isExpanded = !row.hidden;
  row.hidden = isExpanded;
  btn.textContent = isExpanded ? "\u25B8" : "\u25BE";
  btn.setAttribute("aria-expanded", isExpanded ? "false" : "true");
  btn.setAttribute("aria-label", isExpanded ? "展开资源明细" : "收起资源明细");
});

if (ccTeamAll) {
  ccTeamAll.addEventListener("change", function () {
    var boxes = ccTeamList ? ccTeamList.querySelectorAll(".cc-team-cb") : [];
    boxes.forEach(function (b) { b.checked = ccTeamAll.checked; });
    updateTeamAllState();
  });
}

if (ccTeamList) {
  ccTeamList.addEventListener("change", function () {
    updateTeamAllState();
  });
}

if (ccPreviewBtn) {
  ccPreviewBtn.addEventListener("click", async function () {
    setError("");
    try {
      ccPreviewBtn.disabled = true;
      ccApplyBtn.disabled = true;
      var result = await runTeamAssign(true, false);
      if (result) renderAssignResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      ccPreviewBtn.disabled = false;
      ccApplyBtn.disabled = false;
    }
  });
}

if (ccApplyBtn) {
  ccApplyBtn.addEventListener("click", async function () {
    setError("");
    try {
      ccApplyBtn.disabled = true;
      ccPreviewBtn.disabled = true;
      var preview = await runTeamAssign(true, false);
      if (preview) renderAssignResult(preview);

      var shouldRemove = false;
      if (preview && Array.isArray(preview.usersToRemove) && preview.usersToRemove.length > 0) {
        var confirmDelete = window.confirm(
          "发现 Cost Center 中存在 Team 中没有的用户（" + preview.usersToRemove.length + " 个）。\n\n点击“确定”=确认删除这些用户\n点击“取消”=忽略本次删除，仅新增缺失用户"
        );
        shouldRemove = confirmDelete;
      }

      var result = await runTeamAssign(false, shouldRemove);
      if (result) renderAssignResult(result);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      ccApplyBtn.disabled = false;
      ccPreviewBtn.disabled = false;
    }
  });
}

renderSkeletonRows(5, detailName ? 4 : 8);
refresh({ background: true });
