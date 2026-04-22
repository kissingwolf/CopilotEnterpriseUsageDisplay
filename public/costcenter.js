var refreshBtn = document.getElementById("refreshBtn");
var stateSel = document.getElementById("stateSel");
var tbody = document.getElementById("tbody");
var meta = document.getElementById("meta");
var errorBox = document.getElementById("error");
var pageTitle = document.getElementById("pageTitle");

var pathParts = window.location.pathname.split("/").filter(Boolean);
var detailName = pathParts.length >= 2 && pathParts[0] === "costcenter"
  ? decodeURIComponent(pathParts.slice(1).join("/"))
  : "";

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

function buildUserCount(resources) {
  var users = 0;
  (resources || []).forEach(function (r) {
    var t = String(r.type || "").toLowerCase();
    if (t === "user") users += 1;
  });
  return users;
}

function buildResourceDetails(resources) {
  if (!resources || resources.length === 0) {
    return '<div class="cc-empty">无资源</div>';
  }

  var html = '<div class="cc-resource-list">';
  resources.forEach(function (r) {
    html += '<span class="cc-tag">' + escapeHtml(r.type || "Unknown") + ': ' + escapeHtml(r.name || "-") + '</span>';
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
  return "$" + Number(value).toFixed(2);
}

function formatBudgetCell(amount, spentAmount) {
  if (amount == null || Number.isNaN(Number(amount))) {
    return '<span class="budget-na">--</span>';
  }
  var spent = formatMoney(spentAmount);
  var budget = formatMoney(amount);
  return '<div class="budget-cell"><span class="budget-spent">' + spent + ' spent</span><span class="budget-total">' + budget + ' budget</span></div>';
}

function renderList(data) {
  var rows = Array.isArray(data.costCenters) ? data.costCenters : [];

  meta.textContent =
    "Enterprise: " + (data.enterprise || "-") +
    " | 总数: " + (data.total || 0) +
    " | 最后刷新: " + formatTs(data.fetchedAt);

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty">当前筛选下没有 cost center 数据。</td></tr>';
    return;
  }

  var html = "";
  rows.forEach(function (row, idx) {
    var detailLink = "/costcenter/" + encodeURIComponent(row.name || "");
    var detailId = "cc-detail-" + idx;
    html += "<tr>" +
      '<td><div class="cc-name-wrap"><a class="cc-name-link" href="' + detailLink + '">' + escapeHtml(row.name || "-") + '</a>' + buildExpandBtn(detailId, false) + '</div></td>' +
      '<td>' + formatBudgetCell(row.budgetAmount, row.spentAmount) + '</td>' +
      "<td>" + escapeHtml(row.state || "-") + "</td>" +
      "<td>" + buildUserCount(row.resources) + "</td>" +
      "</tr>";

    html += '<tr id="' + detailId + '" class="cc-detail-row" hidden><td colspan="4">' +
      buildResourceDetails(row.resources) +
      "</td></tr>";
  });

  tbody.innerHTML = html;
}

function renderDetail(data) {
  var cc = data && data.costCenter ? data.costCenter : null;
  if (!cc) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty">未找到该 cost center。</td></tr>';
    return;
  }

  pageTitle.textContent = "Cost Center 详情";
  meta.textContent =
    "Enterprise: " + (data.enterprise || "-") +
    " | 名称: " + (cc.name || "-") +
    " | 最后刷新: " + formatTs(data.fetchedAt);

  var html = "";
  var detailId = "cc-detail-single";
  html += "<tr>" +
    '<td><div class="cc-name-wrap">' + escapeHtml(cc.name || "-") + buildExpandBtn(detailId, true) + "</div></td>" +
    '<td>' + formatBudgetCell(cc.budgetAmount, cc.spentAmount) + '</td>' +
    "<td>" + escapeHtml(cc.state || "-") + "</td>" +
    "<td>" + buildUserCount(cc.resources) + "</td>" +
    "</tr>";

  html += '<tr id="' + detailId + '" class="cc-detail-row"><td colspan="4">' +
    buildResourceDetails(cc.resources) +
    "</td></tr>";

  tbody.innerHTML = html;
}

async function refresh() {
  setError("");
  refreshBtn.disabled = true;
  var oldText = refreshBtn.textContent;
  refreshBtn.textContent = "刷新中...";

  try {
    var resp;
    if (detailName) {
      resp = await fetch("/api/cost-centers/by-name/" + encodeURIComponent(detailName));
    } else {
      var state = stateSel.value;
      var query = state ? ("?state=" + encodeURIComponent(state)) : "";
      resp = await fetch("/api/cost-centers" + query);
    }

    var data = await resp.json();
    if (!resp.ok || !data.ok) {
      throw new Error((data && data.message) || "获取 cost center 失败");
    }
    if (detailName) renderDetail(data);
    else renderList(data);
  } catch (err) {
    setError(err instanceof Error ? err.message : String(err));
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.textContent = oldText;
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

refresh();
