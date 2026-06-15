/**
 * userbudget.js — User Budget management page.
 * Loads /api/user-budgets, supports create / update / delete via modal forms.
 */
(function () {
  "use strict";
  var C = CopilotDashboard;

  var refreshBtn = document.getElementById("refreshBtn");
  var skuSel = document.getElementById("skuSel");
  var searchInput = document.getElementById("searchInput");
  var newBudgetBtn = document.getElementById("newBudgetBtn");
  var tbody = document.getElementById("tbody");
  var meta = document.getElementById("meta");
  var errorBox = document.getElementById("error");
  var modal = document.getElementById("modal");
  var modalTitle = document.getElementById("modalTitle");
  var modalBody = document.getElementById("modalBody");
  var modalClose = document.getElementById("modalClose");
  var seatsDatalist = document.getElementById("seatsDatalist");

  var latestMetaText = "尚未刷新数据";
  var allBudgets = [];
  var seatsCache = null;

  function setError(msg) { C.setError(errorBox, msg); }
  function openModal(title, html) { modalTitle.textContent = title; modalBody.innerHTML = html; modal.classList.add("open"); }
  function closeModal() { modal.classList.remove("open"); modalBody.innerHTML = ""; }
  modalClose.addEventListener("click", closeModal);
  modal.addEventListener("click", function (e) { if (e.target === modal) closeModal(); });

  function escapeAttr(s) { return C.escapeHtml(s).replace(/"/g, "&quot;"); }

  function applyFilter(rows) {
    var sku = (skuSel.value || "").trim().toLowerCase();
    var q = (searchInput.value || "").trim().toLowerCase();
    return rows.filter(function (r) {
      if (sku && r.budgetProductSku.toLowerCase() !== sku) return false;
      if (!q) return true;
      var hay = (r.user + " " + (r.adName || "")).toLowerCase();
      return hay.indexOf(q) !== -1;
    });
  }

  function renderRows() {
    var rows = applyFilter(allBudgets);
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty">无符合条件的 User Budget。</td></tr>';
      return;
    }
    var html = "";
    rows.forEach(function (b) {
      var displayName = b.adName || "--";
      var alertText = b.willAlert ? "✓" : "✗";
      var alertTitle = b.willAlert
        ? ("接收人: " + (b.alertRecipients.join(", ") || "(无)"))
        : "未启用警告";
      html += "<tr>" +
        '<td><span title="' + escapeAttr(b.user) + '">' + C.escapeHtml(b.user) + "</span></td>" +
        '<td><span title="' + escapeAttr(b.user) + '">' + C.escapeHtml(displayName) + "</span></td>" +
        '<td><span class="cc-tag">' + C.escapeHtml(b.budgetProductSku) + "</span></td>" +
        '<td class="cc-money-col">' + C.formatUsd(b.budgetAmount) + "</td>" +
        "<td>" + (b.preventFurtherUsage ? "✓" : "✗") + "</td>" +
        '<td title="' + escapeAttr(alertTitle) + '">' + alertText + "</td>" +
        "<td>" +
          '<button class="info-btn ub-edit" data-id="' + escapeAttr(b.id) + '" type="button">编辑</button> ' +
          '<button class="info-btn ub-del" data-id="' + escapeAttr(b.id) + '" type="button" style="margin-left:6px;">删除</button>' +
        "</td>" +
        "</tr>";
    });
    tbody.innerHTML = html;
    tbody.querySelectorAll(".ub-edit").forEach(function (btn) {
      btn.addEventListener("click", function () { openEditModal(btn.dataset.id); });
    });
    tbody.querySelectorAll(".ub-del").forEach(function (btn) {
      btn.addEventListener("click", function () { openDeleteModal(btn.dataset.id); });
    });
  }

  function setMeta(text, refreshing) {
    latestMetaText = text;
    C.setMetaRefreshing(meta, latestMetaText, Boolean(refreshing));
  }

  async function loadList() {
    setError("");
    setMeta(latestMetaText, true);
    C.renderSkeletonRows(tbody, 7, 5);
    try {
      var data = await C.apiFetchJson("/api/user-budgets", {}, "获取 User Budget 失败");
      allBudgets = Array.isArray(data.budgets) ? data.budgets : [];
      var when = data.fetchedAt ? C.formatTs(data.fetchedAt) : "刚刚";
      setMeta("共 " + allBudgets.length + " 条预算 · fetchedAt: " + when, false);
      renderRows();
    } catch (err) {
      setError(err.message || "加载失败");
      tbody.innerHTML = '<tr><td colspan="7" class="empty">加载失败。</td></tr>';
      setMeta(latestMetaText, false);
    }
  }

  async function ensureSeats() {
    if (seatsCache) return seatsCache;
    try {
      var data = await C.apiFetchJson("/api/seats", {}, "获取席位失败");
      seatsCache = Array.isArray(data.seats) ? data.seats : [];
    } catch (_e) {
      seatsCache = [];
    }
    return seatsCache;
  }

  function fillSeatsDatalist(seats) {
    var html = "";
    seats.forEach(function (s) {
      var label = s.adName ? (s.login + " (" + s.adName + ")") : s.login;
      html += '<option value="' + escapeAttr(s.login) + '">' + C.escapeHtml(label) + "</option>";
    });
    seatsDatalist.innerHTML = html;
  }

  function findSeat(login) {
    var key = String(login || "").trim().toLowerCase();
    if (!key || !seatsCache) return null;
    for (var i = 0; i < seatsCache.length; i += 1) {
      if (String(seatsCache[i].login || "").trim().toLowerCase() === key) return seatsCache[i];
    }
    return null;
  }

  function buildFormHtml(mode, b) {
    /* mode: "create" | "edit" */
    var isEdit = mode === "edit";
    var login = isEdit ? b.user : "";
    var sku = isEdit ? b.budgetProductSku : "ai_credits";
    var amount = isEdit ? b.budgetAmount : "";
    var willAlert = isEdit ? b.willAlert : false;
    var recipients = isEdit ? (b.alertRecipients || []).join(", ") : "";
    var adName = isEdit ? (b.adName || "") : "";

    var html = '<div class="ub-form">';
    html += '<div class="ub-row"><label>GitHub 登录</label>';
    if (isEdit) {
      html += '<input id="ub-user" type="text" value="' + escapeAttr(login) + '" disabled />';
    } else {
      html += '<input id="ub-user" type="text" list="seatsDatalist" autocomplete="off" placeholder="如 alice" />';
    }
    html += "</div>";

    html += '<div class="ub-row"><label>AD 名称</label>' +
      '<input id="ub-adname" type="text" value="' + escapeAttr(adName) + '" placeholder="自动映射" disabled />' +
      "</div>";

    html += '<div class="ub-row"><label>产品 SKU</label>' +
      '<select id="ub-sku"' + (isEdit ? " disabled" : "") + ">" +
        '<option value="ai_credits"' + (sku === "ai_credits" ? " selected" : "") + ">ai_credits</option>" +
        '<option value="premium_requests"' + (sku === "premium_requests" ? " selected" : "") + ">premium_requests</option>" +
      "</select></div>";

    html += '<div class="ub-row"><label>预算金额 (USD 整数)</label>' +
      '<input id="ub-amount" type="number" min="1" step="1" value="' + escapeAttr(String(amount)) + '" />' +
      "</div>";

    html += '<div class="ub-row"><label>防止超支</label>' +
      '<label style="display:flex;align-items:center;gap:8px;color:var(--muted);"><input type="checkbox" checked disabled /> user scope 强制开启，不可关闭</label>' +
      "</div>";

    html += '<div class="ub-row"><label>启用警告通知</label>' +
      '<label style="display:flex;align-items:center;gap:8px;"><input id="ub-willalert" type="checkbox"' + (willAlert ? " checked" : "") + " /> 启用</label>" +
      "</div>";

    html += '<div class="ub-row"><label>警告接收人 (逗号分隔)</label>' +
      '<input id="ub-recipients" type="text" placeholder="alice, bob" value="' + escapeAttr(recipients) + '" />' +
      "</div>";

    if (isEdit && b.consumedAmount != null) {
      var pct = b.budgetAmount > 0 ? (b.consumedAmount / b.budgetAmount) * 100 : 0;
      var width = Math.min(Math.max(pct, 0), 100);
      var level = pct >= 100 ? "danger" : pct >= 75 ? "warn" : "normal";
      html += '<div class="ub-row"><label>当月已用</label>' +
        '<div class="budget-cell budget-progress-cell" style="flex:1;">' +
          '<div class="budget-top"><span class="budget-spent">' + C.formatUsd(b.consumedAmount) + ' / ' + C.formatUsd(b.budgetAmount) + '</span><span class="budget-pct">' + pct.toFixed(1) + "%</span></div>" +
          '<div class="budget-bar"><div class="budget-bar-fill budget-' + level + '" style="width:' + width.toFixed(1) + '%"></div></div>' +
        "</div></div>";
    }

    html += '<div id="ub-formerr" class="error" hidden style="margin-top:12px;"></div>';
    html += '<div class="ub-actions" style="margin-top:16px;display:flex;gap:8px;justify-content:flex-end;">' +
      '<button id="ub-cancel" class="info-btn" type="button">取消</button>' +
      '<button id="ub-submit" class="refresh-btn" type="button">' + (isEdit ? "保存" : "创建") + "</button>" +
      "</div>";
    html += "</div>";
    return html;
  }

  function bindFormHandlers(mode, budget) {
    var userInput = document.getElementById("ub-user");
    var adInput = document.getElementById("ub-adname");
    var skuSelEl = document.getElementById("ub-sku");
    var amountInput = document.getElementById("ub-amount");
    var willAlertEl = document.getElementById("ub-willalert");
    var recipientsInput = document.getElementById("ub-recipients");
    var submitBtn = document.getElementById("ub-submit");
    var cancelBtn = document.getElementById("ub-cancel");
    var formErr = document.getElementById("ub-formerr");

    function showFormErr(msg) {
      if (!formErr) return;
      if (!msg) { formErr.hidden = true; formErr.textContent = ""; return; }
      formErr.hidden = false;
      formErr.textContent = msg;
    }

    if (userInput && !userInput.disabled) {
      userInput.addEventListener("input", function () {
        var seat = findSeat(userInput.value);
        adInput.value = seat && seat.adName ? seat.adName : "";
      });
    }

    cancelBtn.addEventListener("click", closeModal);

    submitBtn.addEventListener("click", async function () {
      showFormErr("");
      var user = userInput.value.trim();
      var sku = skuSelEl.value;
      var amount = Number(amountInput.value);
      var willAlert = !!(willAlertEl && willAlertEl.checked);
      var alertRecipients = recipientsInput.value.split(",").map(function (s) { return s.trim(); }).filter(Boolean);

      if (!user) { showFormErr("请填写 GitHub 登录名。"); return; }
      if (!Number.isInteger(amount) || amount <= 0) { showFormErr("预算金额必须为正整数。"); return; }
      if (willAlert && alertRecipients.length === 0) { showFormErr("启用警告时请至少填写一名接收人。"); return; }

      submitBtn.disabled = true;
      submitBtn.textContent = "提交中...";
      try {
        if (mode === "create") {
          /* duplicate check */
          var dup = allBudgets.find(function (x) {
            return x.user.toLowerCase() === user.toLowerCase() && x.budgetProductSku.toLowerCase() === sku.toLowerCase();
          });
          if (dup) throw new Error("该用户已存在 " + sku + " 预算，请改用编辑。");

          await C.apiFetchJson("/api/user-budgets", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ user: user, budgetProductSku: sku, budgetAmount: amount, willAlert: willAlert, alertRecipients: alertRecipients }),
          }, "创建 User Budget 失败");
        } else {
          await C.apiFetchJson("/api/user-budgets/" + encodeURIComponent(budget.id), {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ budgetAmount: amount, willAlert: willAlert, alertRecipients: alertRecipients }),
          }, "更新 User Budget 失败");
        }
        closeModal();
        await loadList();
      } catch (err) {
        showFormErr(err.message || "操作失败");
        submitBtn.disabled = false;
        submitBtn.textContent = mode === "edit" ? "保存" : "创建";
      }
    });
  }

  async function openCreateModal() {
    openModal("新建 User Budget", '<div class="loading">加载中...</div>');
    var seats = await ensureSeats();
    fillSeatsDatalist(seats);
    modalBody.innerHTML = buildFormHtml("create", null);
    bindFormHandlers("create", null);
  }

  async function openEditModal(id) {
    var basic = allBudgets.find(function (b) { return b.id === id; });
    if (!basic) { setError("未找到该预算。"); return; }
    openModal("编辑 User Budget – " + basic.user, '<div class="loading">加载中...</div>');
    try {
      var data = await C.apiFetchJson("/api/user-budgets/" + encodeURIComponent(id), {}, "获取 User Budget 详情失败");
      var detail = data.budget || basic;
      /* merge: prefer detail fields; keep adName from list if detail missing */
      if (!detail.adName && basic.adName) detail.adName = basic.adName;
      modalBody.innerHTML = buildFormHtml("edit", detail);
      bindFormHandlers("edit", detail);
    } catch (err) {
      modalBody.innerHTML = '<div class="error">' + C.escapeHtml(err.message || "加载失败") + "</div>";
    }
  }

  function openDeleteModal(id) {
    var b = allBudgets.find(function (x) { return x.id === id; });
    if (!b) { setError("未找到该预算。"); return; }
    var displayName = b.adName || b.user;
    var html = '<div style="line-height:1.7;">' +
      "你即将删除 <b>" + C.escapeHtml(displayName) + "</b> (登录: " + C.escapeHtml(b.user) + ") 的 " +
      "<b>" + C.escapeHtml(b.budgetProductSku) + "</b> 预算 (" + C.formatUsd(b.budgetAmount) + ")。<br />" +
      "删除后该用户将不再受 SKU 级预算限制。" +
      "</div>" +
      '<div id="ub-formerr" class="error" hidden style="margin-top:12px;"></div>' +
      '<div class="ub-actions" style="margin-top:16px;display:flex;gap:8px;justify-content:flex-end;">' +
      '<button id="ub-cancel" class="info-btn" type="button">取消</button>' +
      '<button id="ub-confirm-del" class="refresh-btn" type="button" style="background:var(--danger,#d33);">确认删除</button>' +
      "</div>";
    openModal("确认删除", html);
    document.getElementById("ub-cancel").addEventListener("click", closeModal);
    var confirmBtn = document.getElementById("ub-confirm-del");
    var formErr = document.getElementById("ub-formerr");
    confirmBtn.addEventListener("click", async function () {
      confirmBtn.disabled = true;
      confirmBtn.textContent = "删除中...";
      try {
        await C.apiFetchJson("/api/user-budgets/" + encodeURIComponent(id), { method: "DELETE" }, "删除 User Budget 失败");
        closeModal();
        await loadList();
      } catch (err) {
        if (formErr) { formErr.hidden = false; formErr.textContent = err.message || "删除失败"; }
        confirmBtn.disabled = false;
        confirmBtn.textContent = "确认删除";
      }
    });
  }

  /* ── Bind toolbar ── */
  refreshBtn.addEventListener("click", function () { loadList(); });
  skuSel.addEventListener("change", renderRows);
  searchInput.addEventListener("input", renderRows);
  newBudgetBtn.addEventListener("click", openCreateModal);

  /* ── Initial load ── */
  loadList();
})();
