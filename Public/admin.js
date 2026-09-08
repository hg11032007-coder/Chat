(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  let token = localStorage.getItem("adminToken");
  let refreshTimer = null;
  let refreshBusy = false;
  let adminSocket = null;

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
    return date ? date.toLocaleString([], {
      day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit"
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

  async function api(path, options = {}) {
    options.headers = Object.assign({}, options.headers, token ? { Authorization: `Bearer ${token}` } : {});
    if (options.body && !(options.body instanceof FormData)) options.headers["Content-Type"] = "application/json";
    const response = await fetch(path, options);
    let data = null;
    try { data = await response.json(); } catch (_error) { /* no response body */ }
    if (!response.ok) {
      if (response.status === 401 && token) {
        localStorage.removeItem("adminToken");
        token = null;
        showLogin();
      }
      throw new Error(data?.error || "Request failed");
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

  function connectAdminSocket() {
    if (!token || typeof window.io !== "function") return;
    disconnectAdminSocket();
    adminSocket = window.io({ auth: { token } });
    // Presence events update the table immediately; the 5-second refresh remains as a fallback.
    adminSocket.on("presence", () => {
      Promise.all([loadStats(), loadUsers()]).catch(() => {});
    });
    adminSocket.on("message", () => {
      Promise.all([loadStats(), loadMessages()]).catch(() => {});
    });
    adminSocket.on("messages_seen", () => loadMessages().catch(() => {}));
    adminSocket.on("messages_delivered", () => loadMessages().catch(() => {}));
  }

  function showLogin() {
    stopAutoRefresh();
    disconnectAdminSocket();
    $("adminLoginPage").classList.remove("hidden");
    $("adminDash").classList.add("hidden");
  }

  function showDash() {
    $("adminLoginPage").classList.add("hidden");
    $("adminDash").classList.remove("hidden");
    connectAdminSocket();
    loadAll().catch((error) => setMsg(error.message, false));
    startAutoRefresh();
  }

  function startAutoRefresh() {
    stopAutoRefresh();
    refreshTimer = setInterval(async () => {
      if (document.hidden || refreshBusy || !token) return;
      refreshBusy = true;
      try {
        await Promise.all([loadStats(), loadUsers(), loadMessages(), loadDeleted()]);
      } catch (_error) {
        // A temporary network error will be retried on the next refresh.
      } finally {
        refreshBusy = false;
      }
    }, 5000);
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
      showDash();
    } catch (error) {
      setMsg(error.message, false);
    } finally {
      button.disabled = false;
      button.textContent = "Open dashboard →";
    }
  });

  [$("aUsername"), $("aPassword")].forEach((input) => input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") $("aLoginBtn").click();
  }));

  $("aLogout").addEventListener("click", () => {
    localStorage.removeItem("adminToken");
    token = null;
    showLogin();
  });

  async function loadAll() {
    await Promise.all([loadStats(), loadUsers(), loadMessages(), loadDeleted()]);
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

  async function loadUsers() {
    const users = await api("/api/admin/users");
    const body = $("usersBody");
    if (!users.length) {
      body.innerHTML = `<tr><td colspan="6" class="tableEmpty">No users</td></tr>`;
      return;
    }
    body.innerHTML = users.map((user) => `
      <tr>
        <td>${user.id}</td>
        <td><span class="userNameCell">${escapeHtml(user.display_name || user.username)}${user.is_admin ? ' <span class="badge admin">admin</span>' : ""}<small>@${escapeHtml(user.username)}</small></span></td>
        <td>${dateOnly(user.created_at)}</td>
        <td><span class="badge ${user.online ? "online" : "offline"}"><i></i>${user.online ? "Online" : "Offline"}</span></td>
        <td>${user.online ? '<span class="lastActive activeNow">Active now</span>' : `<span class="lastActive">${dateTime(user.last_seen)}<small>${relativeTime(user.last_seen)}</small></span>`}</td>
        <td><button class="miniBtn" data-act="reset" data-id="${user.id}">Reset Password</button><button class="miniBtn danger" data-act="del" data-id="${user.id}">Delete</button></td>
      </tr>`).join("");

    body.querySelectorAll("[data-act='reset']").forEach((button) => button.addEventListener("click", async () => {
      const password = prompt("New password for this user (min 6 characters):");
      if (!password) return;
      try {
        await api(`/api/admin/users/${button.dataset.id}/reset-password`, { method: "POST", body: JSON.stringify({ password }) });
        alert("Password updated.");
      } catch (error) { alert(error.message); }
    }));

    body.querySelectorAll("[data-act='del']").forEach((button) => button.addEventListener("click", async () => {
      if (!confirm("Delete this user permanently? This also removes their messages.")) return;
      try {
        await api(`/api/admin/users/${button.dataset.id}`, { method: "DELETE" });
        await loadAll();
      } catch (error) { alert(error.message); }
    }));
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

    body.querySelectorAll("[data-act='restore']").forEach((button) => button.addEventListener("click", async () => {
      try {
        await api(`/api/admin/messages/${button.dataset.id}/restore`, { method: "POST" });
        await Promise.all([loadDeleted(), loadMessages(), loadStats()]);
      } catch (error) { alert(error.message); }
    }));
    body.querySelectorAll("[data-act='purge']").forEach((button) => button.addEventListener("click", async () => {
      if (!confirm("Permanently delete this message? This cannot be undone.")) return;
      try {
        await api(`/api/admin/messages/${button.dataset.id}/purge`, { method: "DELETE" });
        await Promise.all([loadDeleted(), loadStats()]);
      } catch (error) { alert(error.message); }
    }));
  }

  if (token) {
    api("/api/me").then((me) => {
      if (me.is_admin) showDash();
      else {
        token = null;
        localStorage.removeItem("adminToken");
        showLogin();
      }
    }).catch(() => {
      localStorage.removeItem("adminToken");
      token = null;
      showLogin();
    });
  } else showLogin();
})();
