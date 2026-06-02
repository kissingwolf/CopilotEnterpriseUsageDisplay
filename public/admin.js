/* Admin 登录/控制台前端逻辑
 * - 加载时通过 GET /admin/session 判断当前是否已登录
 * - 未登录显示登录表单，POST /admin/login
 * - 已登录显示 4 个入口按钮，POST /admin/logout 退出
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const loadingPane = $("loadingPane");
  const loginPane = $("loginPane");
  const consolePane = $("consolePane");
  const loginForm = $("loginForm");
  const loginUser = $("loginUser");
  const loginPassword = $("loginPassword");
  const loginError = $("loginError");
  const loginSubmit = $("loginSubmit");
  const adminUserLabel = $("adminUserLabel");
  const logoutBtn = $("logoutBtn");

  // 登录成功后的跳转目标：?next=/user 优先；否则停留在控制台
  function getNextUrl() {
    try {
      const params = new URLSearchParams(window.location.search);
      const next_ = params.get("next");
      if (next_ && next_.startsWith("/") && !next_.startsWith("//")) {
        return next_;
      }
    } catch (_) {
      /* ignore */
    }
    return null;
  }

  function show(pane) {
    loadingPane.hidden = pane !== loadingPane;
    loginPane.hidden = pane !== loginPane;
    consolePane.hidden = pane !== consolePane;
  }

  function showLogin(message) {
    loginError.textContent = message || "";
    show(loginPane);
    setTimeout(() => loginUser.focus(), 0);
  }

  function showConsole(user) {
    adminUserLabel.textContent = user || "admin";
    show(consolePane);
  }

  async function fetchSession() {
    try {
      const res = await fetch("/admin/session", {
        method: "GET",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return { authenticated: false };
      return await res.json();
    } catch (_) {
      return { authenticated: false };
    }
  }

  async function handleLogin(e) {
    e.preventDefault();
    loginError.textContent = "";
    loginSubmit.disabled = true;

    const user = loginUser.value.trim();
    const password = loginPassword.value;

    try {
      const res = await fetch("/admin/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ user, password }),
      });

      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        const next_ = getNextUrl();
        if (next_) {
          window.location.replace(next_);
          return;
        }
        showConsole(data.user || user);
        return;
      }

      if (res.status === 401) {
        loginError.textContent = "用户名或密码错误";
      } else {
        loginError.textContent = `登录失败（HTTP ${res.status}）`;
      }
      loginPassword.value = "";
      loginPassword.focus();
    } catch (err) {
      loginError.textContent = "网络错误，请重试";
    } finally {
      loginSubmit.disabled = false;
    }
  }

  async function handleLogout() {
    logoutBtn.disabled = true;
    try {
      await fetch("/admin/logout", {
        method: "POST",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
    } catch (_) {
      /* ignore */
    } finally {
      logoutBtn.disabled = false;
      showLogin("");
    }
  }

  async function init() {
    show(loadingPane);
    const session = await fetchSession();
    if (session && session.authenticated) {
      showConsole(session.user);
    } else {
      showLogin("");
    }
  }

  loginForm.addEventListener("submit", handleLogin);
  logoutBtn.addEventListener("click", handleLogout);

  init();
})();
