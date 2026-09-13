(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  let token = localStorage.getItem("adminToken");
  let refreshTimer = null;
  let refreshBusy = false;
  let adminSocket = null;
  let access = { user_id: null, username: "", role: "user", permissions: [], definitions: [], can_manage_admins: false };
  let usersCache = [];
  let accessTargetId = null;

  function setMsg(text, ok) {
    $("aAuthMsg").textContent = text;
    $("aAuthMsg").style.color = ok ? "var(--green)" : "var(--red)";
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[char]);
  }

  function serverDate(value) {
    if (!value) return null;
    const raw = String(value);
    const date = new Date(raw.includes("T") ? raw : raw.replace(" ", "T") + "Z");
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function dateTime(value) {
    const date = serverDate(value);
    return date ? date.toLocaleString("en-US", {
      day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true
    }) : "—";
  }

  function dateOnly(value) {
    const date = serverDate(value);
    return date ? date.toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" }) : "—";
  }

  function relativeTime(value) {
    const date = serverDate(value);
    if (!date) return "Not recorded";
    const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
    if (seconds < 45) return "just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} hr ago`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)} day ago`;
    return dateOnly(value);
  }

  function messagePreview(message) {
    const raw = message.text || (message.file_name ? `📎 ${message.file_name}` : message.system ? "System message" : "Attachment");
    const clean = String(raw).replace(/\s+/g, " ").trim();
    return clean.length > 85 ? `${clean.slice(0, 84)}…` : clean;
  }

  function can(permission) {
    return access.role === "owner" || access.permissions.includes(permission);
  }

  function permissionLabel(key) {
    return access.definitions.find((item) => item.key === key)?.label || key;
  }

  async function api(path, options = {}) {
    options.headers = Object.assign({}, options.headers, token ? { Authorization: `Bearer ${token}` } : {});
    if (options.body && !(options.body instanceof FormData)) options.headers["Content-Type"] = "application/json";
    const response = await fetch(path, options);
    let data = null;
    try { data = await response.json(); } catch (_error) { /* no response body */ }
    if (!response.ok) {
      if (response.status === 401 && token) clearAdminSession();
      const error = new Error(data?.error || "Request failed");
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function stopAutoRefresh() {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }

  function disconnectAdminSocket() {
    if (adminSocket) adminSocket.disconnect();
    adminSocket = null;
  }

  function clearAdminSession() {
    localStorage.removeItem("adminToken");
    token = null;
    showLogin();
  }

  function connectAdminSocket() {
    if (!token || typeof window.io !== "function") return;
    disconnectAdminSocket();
    adminSocket = window.io({ auth: { token } });
    adminSocket.on("presence", () => {
      const tasks = [];
      if (can("view_stats")) tasks.push(loadStats());
      if (can("view_users")) tasks.push(loadUsers());
      Promise.all(tasks).catch(() => {});
    });
    adminSocket.on("message", () => {
      const tasks = [];
      if (can("view_stats")) tasks.push(loadStats());
      if (can("view_messages")) tasks.push(loadMessages());
      Promise.all(tasks).catch(() => {});
    });
    adminSocket.on("messages_seen", () => { if (can("view_messages")) loadMessages().catch(() => {}); });
    adminSocket.on("messages_delivered", () => { if (can("view_messages")) loadMessages().catch(() => {}); });
    adminSocket.on("admin_access_changed", async (update) => {
      if (!update?.is_admin) {
        alert("Your admin access was removed by the owner.");
        clearAdminSession();
        return;
      }
      try {
        await loadAccess();
        applyAccessUI();
        await loadAll();
      } catch (_error) { clearAdminSession(); }
    });
  }

  function showLogin() {
    stopAutoRefresh();
    disconnectAdminSocket();
    closeAccessModal();
    $("adminLoginPage").classList.remove("hidden");
    $("adminDash").classList.add("hidden");
  }

  async function showDash() {
    $("adminLoginPage").classList.add("hidden");
    $("adminDash").classList.remove("hidden");
    try {
      await loadAccess();
      applyAccessUI();
      connectAdminSocket();
      await loadAll();
      startAutoRefresh();
    } catch (error) {
      alert(error.message || "Admin access could not be loaded");
      clearAdminSession();
    }
  }

  async function loadAccess() {
    access = await api("/api/admin/access");
  }

  function applyAccessUI() {
    $("adminIdentity").innerHTML = `@${escapeHtml(access.username)} <b>${escapeHtml(access.role)}</b>`;
    $("adminStats").classList.toggle("hidden", !can("view_stats"));
    $("usersSection").classList.toggle("hidden", !can("view_users"));
    $("messagesSection").classList.toggle("hidden", !can("view_messages"));
    $("deletedSection").classList.toggle("hidden", !can("moderate_messages"));
  }

  function startAutoRefresh() {
    stopAutoRefresh();
    refreshTimer = setInterval(async () => {
      if (document.hidden || refreshBusy || !token) return;
      refreshBusy = true;
      try { await loadAll(); } catch (_error) { /* retry on next refresh */ }
      finally { refreshBusy = false; }
    }, 5000);
  }

  async function loadAll() {
    const tasks = [];
    if (can("view_stats")) tasks.push(loadStats());
    if (can("view_users")) tasks.push(loadUsers());
    if (can("view_messages")) tasks.push(loadMessages());
    if (can("moderate_messages")) tasks.push(loadDeleted());
    await Promise.all(tasks);
  }

  async function loadStats() {
    const stats = await api("/api/admin/stats");
    $("adminStats").innerHTML = `
      <div class="statCard"><div class="num">${stats.totalUsers}</div><div class="lbl">Total Users</div></div>
      <div class="statCard onlineStat"><div class="num"><i></i>${stats.onlineUsers}</div><div class="lbl">Online Now</div></div>
      <div class="statCard"><div class="num">${stats.totalMessages}</div><div class="lbl">Messages</div></div>
      <div class="statCard"><div class="num">${stats.deletedMessages}</div><div class="lbl">Deleted</div></div>
      <div class="statCard"><div class="num">${stats.totalPosts || 0}</div><div class="lbl">Posts</div></div>
      <div class="statCard"><div class="num">${stats.activeStories || 0}</div><div class="lbl">Active Stories</div></div>`;
  }

  function roleBadge(user) {
    if (user.admin_role === "owner") return ' <span class="badge owner">owner</span>';
    if (user.admin_role === "admin") return ' <span class="badge admin">admin</span>';
    return "";
  }

  function actionButtons(user) {
    const targetIsAdmin = user.admin_role === "admin" || user.admin_role === "owner";
    const canControlTarget = access.role === "owner" || !targetIsAdmin;
    const buttons = [];
    if (can("reset_passwords") && canControlTarget && user.admin_role !== "owner") {
      buttons.push(`<button class="miniBtn" data-act="reset" data-id="${user.id}">Reset Password</button>`);
    }
    if (can("delete_users") && canControlTarget && user.id !== access.user_id && user.admin_role !== "owner") {
      buttons.push(`<button class="miniBtn danger" data-act="del" data-id="${user.id}">Delete</button>`);
    }
    if (access.can_manage_admins && user.admin_role !== "owner") {
      buttons.push(`<button class="miniBtn access" data-act="access" data-id="${user.id}">Manage Access</button>`);
    }
    return buttons.join("") || '<span class="noActions">No actions</span>';
  }

  async function loadUsers() {
    usersCache = await api("/api/admin/users");
    const body = $("usersBody");
    if (!usersCache.length) {
      body.innerHTML = `<tr><td colspan="6" class="tableEmpty">No users</td></tr>`;
      return;
    }
    body.innerHTML = usersCache.map((user) => {
      const permissionText = user.admin_role === "admin" && user.admin_permissions.length
        ? `<span class="roleAccess">${user.admin_permissions.map(permissionLabel).map(escapeHtml).join(" • ")}</span>` : "";
      return `<tr>
        <td>${user.id}</td>
        <td><span class="userNameCell">${escapeHtml(user.display_name || user.username)}${roleBadge(user)}<small>@${escapeHtml(user.username)}</small>${permissionText}</span></td>
        <td>${dateOnly(user.created_at)}</td>
        <td><span class="badge ${user.online ? "online" : "offline"}"><i></i>${user.online ? "Online" : "Offline"}</span></td>
        <td>${user.online ? '<span class="lastActive activeNow">Active now</span>' : `<span class="lastActive">${dateTime(user.last_seen)}<small>${relativeTime(user.last_seen)}</small></span>`}</td>
        <td>${actionButtons(user)}</td>
      </tr>`;
    }).join("");
  }

  function openAccessModal(user) {
    if (!access.can_manage_admins || !user || user.admin_role === "owner") return;
    accessTargetId = user.id;
    $("accessTarget").textContent = `${user.display_name || user.username} (@${user.username})`;
    $("makeAdminToggle").checked = user.admin_role === "admin";
    $("permissionList").innerHTML = access.definitions.map((item) => `
      <label class="permissionItem"><input type="checkbox" value="${escapeHtml(item.key)}" ${user.admin_permissions.includes(item.key) ? "checked" : ""}><span>${escapeHtml(item.label)}</span></label>`).join("");
    updatePermissionPanel();
    $("accessModal").classList.remove("hidden");
  }

  function closeAccessModal() {
    if ($("accessModal")) $("accessModal").classList.add("hidden");
    accessTargetId = null;
  }

  function updatePermissionPanel() {
    $("permissionPanel").classList.toggle("disabled", !$("makeAdminToggle").checked);
  }

  async function saveAccess() {
    const user = usersCache.find((item) => item.id === accessTargetId);
    if (!user) return closeAccessModal();
    const makeAdmin = $("makeAdminToggle").checked;
    const permissions = [...$("permissionList").querySelectorAll("input:checked")].map((input) => input.value);
    const actionText = makeAdmin ? `save admin access for @${user.username}` : `remove admin access from @${user.username}`;
    if (!confirm(`Confirm: ${actionText}?`)) return;
    const button = $("saveAccess");
    button.disabled = true;
    try {
      await api(`/api/admin/users/${user.id}/access`, {
        method: "PATCH",
        body: JSON.stringify({ is_admin: makeAdmin, permissions })
      });
      closeAccessModal();
      await loadUsers();
      if (can("view_stats")) await loadStats();
    } catch (error) { alert(error.message); }
    finally { button.disabled = false; }
  }

  async function loadMessages() {
    const messages = await api("/api/admin/messages?limit=200");
    const body = $("messagesBody");
    if (!messages.length) {
      body.innerHTML = `<tr><td colspan="6" class="tableEmpty">No messages yet</td></tr>`;
      return;
    }
    body.innerHTML = messages.map((message) => {
      let status = '<span class="deliveryBadge sent">✓ Sent</span>';
      if (message.delivered_at) status = '<span class="deliveryBadge delivered">✓✓ Delivered</span>';
      if (message.seen_at) status = '<span class="deliveryBadge seen">✓✓ Seen</span>';
      return `<tr>
        <td><b class="personLabel">${escapeHtml(message.sender_name)}</b></td>
        <td><b class="personLabel">${escapeHtml(message.receiver_name)}</b></td>
        <td><span class="messagePreview" title="${escapeHtml(messagePreview(message))}">${escapeHtml(messagePreview(message))}</span></td>
        <td><span class="timeCell">${dateTime(message.created_at)}</span></td>
        <td>${status}</td>
        <td>${message.seen_at ? `<span class="seenAtTime">${dateTime(message.seen_at)}<small>${relativeTime(message.seen_at)}</small></span>` : '<span class="notSeen">Not seen yet</span>'}</td>
      </tr>`;
    }).join("");
  }

  async function loadDeleted() {
    const rows = await api("/api/admin/deleted-messages");
    const body = $("deletedBody");
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="5" class="tableEmpty">No deleted messages</td></tr>`;
      return;
    }
    body.innerHTML = rows.map((message) => `
      <tr>
        <td>${escapeHtml(message.sender_name)}</td>
        <td>${escapeHtml(message.receiver_name)}</td>
        <td><span class="messagePreview">${escapeHtml(messagePreview(message))}</span></td>
        <td>${dateTime(message.deleted_at)}</td>
        <td><button class="miniBtn" data-act="restore" data-id="${message.id}">Restore</button><button class="miniBtn danger" data-act="purge" data-id="${message.id}">Purge</button></td>
      </tr>`).join("");
  }

  $("aLoginBtn").addEventListener("click", async () => {
    const username = $("aUsername").value.trim();
    const password = $("aPassword").value;
    if (!username || !password) return setMsg("Enter username and password", false);
    const button = $("aLoginBtn");
    button.disabled = true;
    button.textContent = "Checking…";
    try {
      const data = await api("/api/login", { method: "POST", body: JSON.stringify({ username, password }) });
      token = data.token;
      if (!data.user.is_admin) {
        token = null;
        return setMsg("This account is not an admin.", false);
      }
      localStorage.setItem("adminToken", token);
      setMsg("", true);
      await showDash();
    } catch (error) { setMsg(error.message, false); }
    finally {
      button.disabled = false;
      button.textContent = "Open dashboard →";
    }
  });

  [$("aUsername"), $("aPassword")].forEach((input) => input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") $("aLoginBtn").click();
  }));
  $("aLogout").addEventListener("click", clearAdminSession);

  $("usersBody").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-act]");
    if (!button) return;
    const user = usersCache.find((item) => item.id === Number(button.dataset.id));
    if (!user) return;
    if (button.dataset.act === "access") return openAccessModal(user);
    if (button.dataset.act === "reset") {
      const password = prompt("New password for this user (min 6 characters):");
      if (!password) return;
      try {
        await api(`/api/admin/users/${user.id}/reset-password`, { method: "POST", body: JSON.stringify({ password }) });
        alert("Password updated.");
      } catch (error) { alert(error.message); }
    }
    if (button.dataset.act === "del") {
      if (!confirm("Delete this user permanently? This also removes their messages.")) return;
      try { await api(`/api/admin/users/${user.id}`, { method: "DELETE" }); await loadAll(); }
      catch (error) { alert(error.message); }
    }
  });

  $("deletedBody").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-act]");
    if (!button) return;
    try {
      if (button.dataset.act === "restore") {
        await api(`/api/admin/messages/${button.dataset.id}/restore`, { method: "POST" });
        await Promise.all([loadDeleted(), can("view_messages") ? loadMessages() : Promise.resolve(), can("view_stats") ? loadStats() : Promise.resolve()]);
      }
      if (button.dataset.act === "purge") {
        if (!confirm("Permanently delete this message? This cannot be undone.")) return;
        await api(`/api/admin/messages/${button.dataset.id}/purge`, { method: "DELETE" });
        await Promise.all([loadDeleted(), can("view_stats") ? loadStats() : Promise.resolve()]);
      }
    } catch (error) { alert(error.message); }
  });

  $("makeAdminToggle").addEventListener("change", updatePermissionPanel);
  $("saveAccess").addEventListener("click", saveAccess);
  $("cancelAccess").addEventListener("click", closeAccessModal);
  $("closeAccessModal").addEventListener("click", closeAccessModal);
  $("accessModalBackdrop").addEventListener("click", closeAccessModal);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeAccessModal(); });
  window.addEventListener("storage", (event) => { if (event.key === "adminToken" && event.newValue !== token) window.location.reload(); });

  if (token) {
    api("/api/me").then((me) => {
      if (me.is_admin) showDash();
      else clearAdminSession();
    }).catch(clearAdminSession);
  } else showLogin();
})();
