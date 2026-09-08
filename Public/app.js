(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const state = {
    token: localStorage.getItem("sandeep_token") || localStorage.getItem("token") || "",
    me: null,
    socket: null,
    view: "home",
    users: [],
    requests: { received: [], sent: [] },
    requestTab: "received",
    posts: [],
    stories: [],
    profile: null,
    profileViewing: null,
    activeChat: null,
    chatMessages: [],
    replyTo: null,
    currentCommentPost: null,
    storyIndex: -1,
    storyTimer: null,
    aiLoaded: false,
    aiBusy: false,
    recorder: null,
    recordingStream: null,
    recordingChunks: [],
    recordingStarted: 0,
    recordingClock: null,
    typingTimer: null,
    lastTypingState: false,
    postPreviewUrl: "",
    storyPreviewUrl: "",
    storyBackground: "aurora"
  };

  const viewMeta = {
    home: ["Home", "SANDEEP CHAT"],
    stories: ["Stories", "24-HOUR MOMENTS"],
    chats: ["Chats", "PRIVATE MESSAGES"],
    requests: ["Requests", "FRIENDS & DISCOVERY"],
    ai: ["Nova AI", "YOUR ASSISTANT"],
    profile: ["Profile", "YOUR SPACE"]
  };

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[char]);
  }

  function safeUrl(value) {
    const url = String(value || "");
    return url.startsWith("/uploads/") || url === "chat-bg.png" ? escapeHtml(url) : "";
  }

  function serverDate(value) {
    if (!value) return null;
    const raw = String(value);
    const normalized = raw.includes("T") ? raw : raw.replace(" ", "T") + "Z";
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function formatTime(value) {
    const date = serverDate(value);
    return date ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  }

  function formatDate(value) {
    const date = serverDate(value);
    return date ? date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }) : "";
  }

  function relativeTime(value) {
    const date = serverDate(value);
    if (!date) return "just now";
    const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
    if (seconds < 45) return "just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
    return formatDate(value);
  }

  function isSameDay(a, b) {
    const first = serverDate(a), second = serverDate(b);
    return first && second && first.toDateString() === second.toDateString();
  }

  function truncate(value, length = 45) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    return text.length > length ? `${text.slice(0, length - 1)}…` : text;
  }

  function avatarHtml(user = {}, size = 42, online = false) {
    const name = user.display_name || user.username || "?";
    const initial = Array.from(name.trim())[0] || "?";
    const photo = safeUrl(user.avatar);
    return `<span class="avatar${online ? " online" : ""}" style="width:${size}px;height:${size}px">${photo ? `<img src="${photo}" alt="">` : escapeHtml(initial)}</span>`;
  }

  function emptyState(icon, title, text) {
    return `<div class="emptyState"><span>${icon}</span><h3>${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p></div>`;
  }

  function toast(message, type = "") {
    const node = document.createElement("div");
    node.className = `toast ${type}`.trim();
    node.textContent = message;
    $("toastHost").appendChild(node);
    setTimeout(() => node.remove(), 3500);
  }

  function setButtonLoading(button, loading, label = "Please wait…") {
    if (!button) return;
    if (loading) {
      button.dataset.oldText = button.innerHTML;
      button.disabled = true;
      button.textContent = label;
    } else {
      button.disabled = false;
      if (button.dataset.oldText) button.innerHTML = button.dataset.oldText;
      delete button.dataset.oldText;
    }
  }

  async function api(url, options = {}) {
    const config = { ...options, headers: { ...(options.headers || {}) } };
    if (state.token) config.headers.Authorization = `Bearer ${state.token}`;
    if (config.body && !(config.body instanceof FormData)) {
      config.headers["Content-Type"] = "application/json";
    }
    const response = await fetch(url, config);
    let data = null;
    try { data = await response.json(); } catch (_error) { /* empty response */ }
    if (!response.ok) {
      if (response.status === 401 && state.me) logout(false);
      throw new Error(data?.error || "Request failed");
    }
    return data;
  }

  function applyTheme(theme) {
    const chosen = theme || localStorage.getItem("sandeep_theme") || "dark";
    document.documentElement.dataset.theme = chosen;
    localStorage.setItem("sandeep_theme", chosen);
    if ($("themeSwitch")) $("themeSwitch").checked = chosen === "light";
    if ($("themeQuickBtn")) $("themeQuickBtn").textContent = chosen === "light" ? "☀" : "☾";
  }

  function toggleTheme() {
    applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
  }

  function showAuth() {
    $("authPage").classList.remove("hidden");
    $("appShell").classList.add("hidden");
  }

  function showApp() {
    $("authPage").classList.add("hidden");
    $("appShell").classList.remove("hidden");
  }

  function setAuthMessage(message, ok = false) {
    $("authMessage").textContent = message;
    $("authMessage").classList.toggle("ok", ok);
  }

  function storeSession(data) {
    state.token = data.token;
    state.me = data.user;
    localStorage.setItem("sandeep_token", state.token);
    localStorage.setItem("sandeep_me", JSON.stringify(state.me));
    localStorage.removeItem("token");
    localStorage.removeItem("me");
  }

  async function login() {
    const username = $("authUsername").value.trim();
    const password = $("authPassword").value;
    if (!username || !password) return setAuthMessage("Enter your username and password.");
    setButtonLoading($("loginBtn"), true, "Logging in…");
    try {
      const data = await api("/api/login", { method: "POST", body: JSON.stringify({ username, password }) });
      storeSession(data);
      setAuthMessage("Welcome back!", true);
      await bootApp();
    } catch (error) {
      setAuthMessage(error.message);
    } finally {
      setButtonLoading($("loginBtn"), false);
    }
  }

  async function register() {
    const username = $("registerUsername").value.trim();
    const password = $("registerPassword").value;
    const confirmPassword = $("registerConfirm").value;
    if (!/^[a-zA-Z0-9_.]{3,24}$/.test(username)) return setAuthMessage("Use 3–24 letters, numbers, _ or . in your username.");
    if (password.length < 6) return setAuthMessage("Password must be at least 6 characters.");
    if (password !== confirmPassword) return setAuthMessage("Passwords do not match.");
    setButtonLoading($("registerBtn"), true, "Creating account…");
    try {
      const data = await api("/api/register", { method: "POST", body: JSON.stringify({ username, password }) });
      storeSession(data);
      setAuthMessage("Account created!", true);
      await bootApp();
    } catch (error) {
      setAuthMessage(error.message);
    } finally {
      setButtonLoading($("registerBtn"), false);
    }
  }

  function logout(showMessage = true) {
    if (state.socket) state.socket.disconnect();
    stopRecording(true);
    localStorage.removeItem("sandeep_token");
    localStorage.removeItem("sandeep_me");
    localStorage.removeItem("token");
    localStorage.removeItem("me");
    state.token = "";
    state.me = null;
    state.users = [];
    state.posts = [];
    state.stories = [];
    closeDrawer();
    showAuth();
    if (showMessage) setAuthMessage("You have been logged out.", true);
  }

  function renderIdentity() {
    if (!state.me) return;
    const displayName = state.me.display_name || state.me.username;
    $("sideName").textContent = displayName;
    $("sideUsername").textContent = `@${state.me.username}`;
    $("sideAvatar").innerHTML = avatarHtml(state.me, 38, true);
    $("topAvatarBtn").innerHTML = avatarHtml(state.me, 40, true);
    document.querySelectorAll(".currentAvatar").forEach((node) => { node.innerHTML = avatarHtml(state.me, 42, true); });
    document.querySelectorAll(".currentName").forEach((node) => { node.textContent = displayName; });
    $("drawerAvatar").innerHTML = avatarHtml(state.me, 52, true);
    $("drawerName").textContent = displayName;
    $("drawerHandle").textContent = `@${state.me.username}`;
    $("adminLink").classList.toggle("hidden", !state.me.is_admin);
    $("drawerAdminLink").classList.toggle("hidden", !state.me.is_admin);
  }

  async function bootApp() {
    showApp();
    renderIdentity();
    connectSocket();
    navigate("home");
    const results = await Promise.allSettled([loadUsers(), loadRequests(), loadStories(), loadPosts()]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed) toast(failed.reason?.message || "Some content could not be loaded", "error");
  }

  function activateView(view) {
    if (!viewMeta[view]) view = "home";
    state.view = view;
    document.querySelectorAll(".appView").forEach((node) => node.classList.toggle("active", node.id === `${view}View`));
    document.querySelectorAll("[data-view]").forEach((node) => node.classList.toggle("active", node.dataset.view === view));
    $("viewTitle").textContent = viewMeta[view][0];
    $("viewEyebrow").textContent = viewMeta[view][1];
    closeDrawer();
    $("createMenu").classList.add("hidden");
    try { history.replaceState(null, "", `#${view}`); } catch (_error) { /* ignored */ }
  }

  function navigate(view, profileId = null) {
    // Never keep a conversation silently open behind another page. Otherwise a new
    // message could look “seen” even though the user is viewing Home/Profile/etc.
    if (state.activeChat && (view !== "chats" || state.view === "chats")) closeConversation();
    activateView(view);
    if (view === "home") { loadPosts(); loadStories(); }
    if (view === "stories") loadStories();
    if (view === "chats") { renderChatList(); loadUsers(); }
    if (view === "requests") { loadRequests(); renderDiscover(); }
    if (view === "ai") loadAiHistory();
    if (view === "profile") loadProfile(profileId || state.me.id);
  }

  // ----------------------- People, chat list & requests -----------------------
  async function loadUsers() {
    state.users = await api("/api/users");
    if (state.activeChat) {
      const updated = state.users.find((user) => user.id === state.activeChat.id);
      if (updated) state.activeChat = updated;
    }
    renderChatList();
    renderHomeDiscover();
    renderDiscover();
    renderBadges();
    updateActiveChatHeader();
  }

  async function loadRequests() {
    const data = await api("/api/friend-requests");
    // Keep a stable object even when an older/empty database returns null.
    state.requests = {
      received: Array.isArray(data?.received) ? data.received : [],
      sent: Array.isArray(data?.sent) ? data.sent : []
    };
    renderRequests();
    renderBadges();
  }

  function renderBadges() {
    const unread = (Array.isArray(state.users) ? state.users : []).reduce((sum, user) => sum + Number(user.unread_count || 0), 0);
    const receivedRequests = Array.isArray(state.requests?.received) ? state.requests.received : [];
    const sentRequests = Array.isArray(state.requests?.sent) ? state.requests.sent : [];
    const requests = receivedRequests.length;
    const badgeSets = [
      ["chatNavBadge", unread], ["mobileChatBadge", unread],
      ["requestNavBadge", requests], ["topRequestBadge", requests], ["mobileRequestBadge", requests]
    ];
    badgeSets.forEach(([id, count]) => {
      const node = $(id);
      if (!node) return;
      node.textContent = count > 99 ? "99+" : count;
      node.classList.toggle("hidden", !count);
    });
    $("drawerRequestCount").textContent = requests;
    $("receivedCount").textContent = requests;
    $("sentCount").textContent = sentRequests.length;
  }

  function chatPreview(user) {
    const message = user.last_message;
    if (!message) return user.online ? "Online now" : "Start a conversation";
    const mine = message.sender_id === state.me.id ? "You: " : "";
    return `${mine}${message.text ? truncate(message.text, 32) : `📎 ${truncate(message.file_name || "Attachment", 27)}`}`;
  }

  function renderChatList() {
    const host = $("chatList");
    if (!host || !state.me) return;
    const query = $("chatSearch")?.value.trim().toLowerCase() || "";
    const friends = state.users
      .filter((user) => user.friendStatus === "friend" && !user.hidden && !user.blocked)
      .filter((user) => !query || `${user.display_name} ${user.username}`.toLowerCase().includes(query))
      .sort((a, b) => {
        const aTime = serverDate(a.last_message?.created_at)?.getTime() || 0;
        const bTime = serverDate(b.last_message?.created_at)?.getTime() || 0;
        return bTime - aTime || Number(b.online) - Number(a.online) || a.username.localeCompare(b.username);
      });
    if (!friends.length) {
      host.innerHTML = emptyState("◌", query ? "No matching chat" : "No chats yet", query ? "Try another name." : "Find a person and send a friend request.");
      return;
    }
    host.innerHTML = friends.map((user) => `
      <button class="chatRow${state.activeChat?.id === user.id ? " active" : ""}" data-open-chat="${user.id}" type="button">
        ${avatarHtml(user, 49, user.online)}
        <span class="chatRowText">
          <span class="chatRowTop"><b>${escapeHtml(user.display_name || user.username)}</b><em class="chatPresence ${user.online ? "online" : "offline"}"><i></i>${user.online ? "Online" : "Offline"}</em><time>${formatTime(user.last_message?.created_at)}</time></span>
          <span class="chatRowBottom"><span>${escapeHtml(chatPreview(user))}</span>${user.unread_count ? `<b class="unreadBadge">${user.unread_count > 99 ? "99+" : user.unread_count}</b>` : ""}</span>
        </span>
      </button>`).join("");
  }

  function userActionButton(user, compact = false) {
    if (user.blocked) return `<button class="personAction" data-user-action="unblock" data-user-id="${user.id}" type="button">Unblock</button>`;
    if (user.friendStatus === "friend") return `<button class="personAction" data-user-action="message" data-user-id="${user.id}" type="button">Message</button>`;
    if (user.friendStatus === "pending_received") return `<button class="personAction accept" data-user-action="accept" data-request-id="${user.requestId}" data-user-id="${user.id}" type="button">Accept</button>`;
    if (user.friendStatus === "pending_sent") return `<button class="personAction decline" data-user-action="cancel" data-request-id="${user.requestId}" data-user-id="${user.id}" type="button">${compact ? "Sent" : "Cancel"}</button>`;
    return `<button class="personAction${compact ? "" : " accept"}" data-user-action="add" data-user-id="${user.id}" type="button">${compact ? "+" : "Add friend"}</button>`;
  }

  function renderHomeDiscover() {
    const host = $("homeDiscover");
    if (!host) return;
    const people = state.users.filter((user) => user.friendStatus === "none" && !user.blocked).slice(0, 4);
    host.innerHTML = people.length ? people.map((user) => `
      <div class="discoverMini">${avatarHtml(user, 34, user.online)}<div><b>${escapeHtml(user.display_name || user.username)}</b><small>@${escapeHtml(user.username)}</small></div><button class="addMiniBtn" data-user-action="add" data-user-id="${user.id}" title="Add friend" type="button">＋</button></div>
    `).join("") : `<p style="color:var(--muted);font-size:11px">Everyone here is already in your circle.</p>`;
  }

  function renderDiscover() {
    const host = $("discoverResults");
    if (!host) return;
    const query = $("peopleSearch")?.value.trim().toLowerCase() || "";
    let people = state.users.filter((user) => !user.blocked || query);
    if (query) people = people.filter((user) => `${user.display_name} ${user.username}`.toLowerCase().includes(query));
    else people = people.filter((user) => user.friendStatus !== "friend").slice(0, 8);
    if (!people.length) {
      host.innerHTML = query ? emptyState("⌕", "No people found", "Try another username or display name.") : "";
      return;
    }
    host.innerHTML = people.map((user) => `
      <div class="personCard">${avatarHtml(user, 48, user.online)}<div class="personInfo"><b>${escapeHtml(user.display_name || user.username)}</b><small>@${escapeHtml(user.username)}${user.bio ? ` • ${escapeHtml(truncate(user.bio, 25))}` : ""}</small></div>${userActionButton(user)}</div>
    `).join("");
  }

  function renderRequests() {
    const host = $("requestList");
    if (!host) return;
    const list = Array.isArray(state.requests?.[state.requestTab]) ? state.requests[state.requestTab] : [];
    document.querySelectorAll("[data-request-tab]").forEach((button) => button.classList.toggle("active", button.dataset.requestTab === state.requestTab));
    if (!list.length) {
      host.innerHTML = emptyState("♧", state.requestTab === "received" ? "No pending requests" : "Nothing sent", state.requestTab === "received" ? "New requests will appear here." : "Search above to find someone new.");
      return;
    }
    host.innerHTML = list.map((request) => `
      <div class="requestRow">
        ${avatarHtml(request, 51, false)}
        <div class="personInfo"><b>${escapeHtml(request.display_name || request.username)}</b><small>@${escapeHtml(request.username)} • ${state.requestTab === "received" ? "wants to be your friend" : "request sent"} ${relativeTime(request.created_at)}</small></div>
        <div class="requestActions">${state.requestTab === "received" ? `
          <button class="personAction accept" data-user-action="accept" data-request-id="${request.id}" type="button">Accept</button>
          <button class="personAction decline" data-user-action="decline" data-request-id="${request.id}" type="button">Decline</button>` : `
          <button class="personAction decline" data-user-action="cancel" data-request-id="${request.id}" type="button">Cancel</button>`}</div>
      </div>`).join("");
  }

  async function handleUserAction(button) {
    const action = button.dataset.userAction;
    const userId = Number(button.dataset.userId);
    const requestId = Number(button.dataset.requestId);
    button.disabled = true;
    try {
      if (action === "add") {
        await api("/api/friend-requests", { method: "POST", body: JSON.stringify({ receiver_id: userId }) });
        toast("Friend request sent", "success");
      } else if (action === "accept") {
        await api(`/api/friend-requests/${requestId}/accept`, { method: "POST" });
        toast("Friend request accepted", "success");
      } else if (action === "decline") {
        await api(`/api/friend-requests/${requestId}/decline`, { method: "POST" });
      } else if (action === "cancel") {
        await api(`/api/friend-requests/${requestId}`, { method: "DELETE" });
      } else if (action === "unblock") {
        await api(`/api/block/${userId}`, { method: "DELETE" });
        toast("User unblocked", "success");
      } else if (action === "message") {
        const user = state.users.find((item) => item.id === userId);
        if (user) { navigate("chats"); openChat(user); }
        return;
      }
      await Promise.all([loadUsers(), loadRequests(), loadStories()]);
    } catch (error) {
      toast(error.message, "error");
    } finally {
      button.disabled = false;
    }
  }

  // ----------------------- Direct messages -----------------------
  function closeConversation() {
    if (state.activeChat) emitTyping(false);
    state.activeChat = null;
    state.chatM
