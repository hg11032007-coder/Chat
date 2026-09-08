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
    return date ? date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true }) : "";
  }

  function formatDateTime(value) {
    const date = serverDate(value);
    return date ? date.toLocaleString("en-US", {
      month: "short", day: "numeric", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: true
    }) : "";
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

  function sameId(first, second) {
    return Number(first) === Number(second);
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

  function aiWelcomeHtml() {
    return `<div class="aiWelcome"><span class="novaOrb huge">✦</span><h2>How can I help?</h2><p>Ask me anything in English, Hindi, or Hinglish.</p><div class="suggestionGrid"><button data-ai-prompt="Help me write a professional message">✎ Write a message</button><button data-ai-prompt="Give me three creative post ideas">✦ Post ideas</button><button data-ai-prompt="Explain something difficult in simple words">◎ Explain simply</button></div></div>`;
  }

  function resetUserScopedState() {
    if (state.socket) state.socket.disconnect();
    state.socket = null;
    clearTimeout(state.storyTimer);
    clearTimeout(state.typingTimer);
    state.users = [];
    state.requests = { received: [], sent: [] };
    state.posts = [];
    state.stories = [];
    state.profile = null;
    state.profileViewing = null;
    state.activeChat = null;
    state.chatMessages = [];
    state.replyTo = null;
    state.currentCommentPost = null;
    state.storyIndex = -1;
    state.aiLoaded = false;
    state.aiBusy = false;
    state.lastTypingState = false;
    const aiHost = $("aiMessages");
    if (aiHost) aiHost.innerHTML = aiWelcomeHtml();
    if ($("aiInput")) $("aiInput").value = "";
    if ($("messageList")) $("messageList").innerHTML = "";
    if ($("conversationActive")) $("conversationActive").classList.add("hidden");
    if ($("conversationEmpty")) $("conversationEmpty").classList.remove("hidden");
    if ($("chatLayout")) $("chatLayout").classList.remove("conversationOpen");
  }

  function storeSession(data) {
    // Always clear the previous account's in-memory/DOM data before accepting a
    // new token. This prevents AI/chat content remaining visible after account switching.
    resetUserScopedState();
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
    stopRecording(true);
    resetUserScopedState();
    localStorage.removeItem("sandeep_token");
    localStorage.removeItem("sandeep_me");
    localStorage.removeItem("token");
    localStorage.removeItem("me");
    state.token = "";
    state.me = null;
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
  async function removeFriend(user) {
    if (!user) return;
    const userId = Number(user.id);
    const name = user.display_name || user.username || "this user";
    if (!confirm(`Remove ${name} from your friends? Your old messages will stay saved.`)) return;
    try {
      await api(`/api/friends/${userId}`, { method: "DELETE" });
      if (sameId(state.activeChat?.id, userId)) closeConversation();
      await Promise.all([loadUsers(), loadRequests(), loadStories(), loadPosts()]);
      if (state.view === "profile" && sameId(state.profileViewing, userId)) renderProfile();
      toast(`${name} removed from friends`, "success");
    } catch (error) {
      toast(error.message, "error");
    }
  }

  function closeConversation() {
    if (state.activeChat) emitTyping(false);
    state.activeChat = null;
    state.chatMessages = [];
    state.replyTo = null;
    state.lastTypingState = false;
    clearTimeout(state.typingTimer);
    $("typingBar").classList.add("hidden");
    $("chatMenu").classList.add("hidden");
    $("conversationActive").classList.add("hidden");
    $("conversationEmpty").classList.remove("hidden");
    $("chatLayout").classList.remove("conversationOpen");
    $("messageList").innerHTML = "";
    renderReplyPreview();
    renderChatList();
  }

  function conversationIsVisible(userId) {
    if (state.view !== "chats" || state.activeChat?.id !== Number(userId)) return false;
    if (document.hidden || !document.hasFocus()) return false;
    if ($("conversationActive").classList.contains("hidden")) return false;
    // On mobile the chat list can cover a previously selected conversation.
    if (window.matchMedia("(max-width: 820px)").matches && !$("chatLayout").classList.contains("conversationOpen")) return false;
    return true;
  }

  async function markVisibleConversationRead() {
    if (!state.activeChat || !conversationIsVisible(state.activeChat.id)) return;
    const userId = state.activeChat.id;
    try {
      await api(`/api/messages/read/${userId}`, { method: "POST" });
      if (state.activeChat?.id === userId) state.activeChat.unread_count = 0;
      loadUsers().catch(() => {});
    } catch (_error) { /* it will be retried when the chat is opened again */ }
  }

  async function openChat(user) {
    if (!user || user.friendStatus !== "friend") return;
    state.activeChat = user;
    state.replyTo = null;
    renderReplyPreview();
    $("conversationEmpty").classList.add("hidden");
    $("conversationActive").classList.remove("hidden");
    $("chatLayout").classList.add("conversationOpen");
    renderChatList();
    updateActiveChatHeader();
    $("messageList").innerHTML = emptyState("◌", "Loading messages", "Please wait a moment…");
    try {
      const history = await api(`/api/messages/${user.id}`);
      state.chatMessages = Array.isArray(history) ? history : [];
    } catch (error) {
      $("messageList").innerHTML = emptyState("!", "Could not open chat", error.message);
      return;
    }
    // Rendering chat history must not depend on requests or badge data being loaded.
    user.unread_count = 0;
    renderMessages();
    renderBadges();
    loadUsers().catch(() => {});
  }

  function updateActiveChatHeader() {
    if (!state.activeChat || !$("activeChatName")) return;
    const user = state.users.find((item) => item.id === state.activeChat.id) || state.activeChat;
    state.activeChat = user;
    $("activeChatName").textContent = user.display_name || user.username;
    $("activeChatAvatar").innerHTML = avatarHtml(user, 42, user.online);
    const status = $("activeChatStatus");
    status.textContent = user.online ? "Online" : user.last_seen ? `Last seen ${relativeTime(user.last_seen)}` : "Offline";
    status.classList.toggle("onlineText", Boolean(user.online));
  }

  function messageStatus(message) {
    if (message.seen_at) {
      const seenDate = serverDate(message.seen_at);
      const seenLabel = seenDate ? `Seen at ${formatDateTime(message.seen_at)}` : "Seen";
      return `<span class="tick seen" title="${escapeHtml(seenLabel)}" aria-label="${escapeHtml(seenLabel)}">✓✓</span>`;
    }
    if (message.delivered_at) {
      const deliveredDate = serverDate(message.delivered_at);
      const deliveredLabel = deliveredDate ? `Delivered at ${formatDateTime(message.delivered_at)}` : "Delivered";
      return `<span class="tick" title="${escapeHtml(deliveredLabel)}" aria-label="${escapeHtml(deliveredLabel)}">✓✓</span>`;
    }
    return `<span class="tick" title="Sent" aria-label="Sent">✓</span>`;
  }

  function messageContent(message) {
    let html = "";
    if (message.reply_to) {
      const replyText = message.reply_text || message.reply_file_name || "Message unavailable";
      html += `<div class="replyQuote"><b>${escapeHtml(message.reply_sender_name || "Reply")}</b><span>${escapeHtml(truncate(replyText, 70))}</span></div>`;
    }
    if (message.text) html += `<p class="messageText">${escapeHtml(message.text)}</p>`;
    if (message.file_url) {
      const url = safeUrl(message.file_url);
      const type = String(message.file_type || "");
      if (type.startsWith("image/")) html += `<a href="${url}" target="_blank" rel="noopener"><img class="messageMedia" src="${url}" alt="${escapeHtml(message.file_name || "Shared image")}"></a>`;
      else if (type.startsWith("video/")) html += `<video class="messageMedia" src="${url}" controls preload="metadata"></video>`;
      else if (type.startsWith("audio/")) html += `<audio src="${url}" controls preload="metadata"></audio>`;
      else html += `<a class="fileAttachment" href="${url}" target="_blank" rel="noopener"><i>▤</i><span>${escapeHtml(message.file_name || "Download file")}</span></a>`;
    }
    return html;
  }

  function renderMessages(keepPosition = false) {
    const host = $("messageList");
    const oldBottomGap = host.scrollHeight - host.scrollTop;
    if (!state.chatMessages.length) {
      host.innerHTML = emptyState("👋", "Say hello", "Send the first message in this conversation.");
      return;
    }
    host.innerHTML = "";
    let previous = null;
    state.chatMessages.forEach((message) => {
      if (!previous || !isSameDay(previous.created_at, message.created_at)) {
        const divider = document.createElement("div");
        divider.className = "dayDivider";
        const date = serverDate(message.created_at);
        divider.textContent = date && date.toDateString() === new Date().toDateString() ? "Today" : formatDate(message.created_at);
        host.appendChild(divider);
      }
      previous = message;
      if (message.system) {
        const system = document.createElement("div");
        system.className = "systemMessage";
        system.dataset.messageId = message.id;
        system.textContent = message.text || "";
        host.appendChild(system);
        return;
      }
      const mine = sameId(message.sender_id, state.me.id);
      const wrap = document.createElement("div");
      wrap.className = `messageWrap${mine ? " mine" : ""}`;
      wrap.dataset.messageId = message.id;
      const sender = mine ? state.me : (state.activeChat || { username: message.sender_name });
      const avatar = document.createElement("span");
      avatar.className = "messageAvatar";
      avatar.innerHTML = avatarHtml(sender, 32, mine ? true : Boolean(state.activeChat?.online));
      const bubble = document.createElement("div");
      bubble.className = "messageBubble";
      bubble.innerHTML = `${messageContent(message)}<div class="messageMeta">${message.edited_at ? '<span class="editMark">edited</span>' : ""}<time>${formatTime(message.created_at)}</time>${mine ? messageStatus(message) : ""}</div>`;
      bubble.addEventListener("click", (event) => {
        if (!window.matchMedia("(hover: none)").matches || event.target.closest("a,audio,video,button")) return;
        event.stopPropagation();
        host.querySelectorAll(".messageWrap.actionsOpen").forEach((item) => { if (item !== wrap) item.classList.remove("actionsOpen"); });
        wrap.classList.toggle("actionsOpen");
      });
      const actions = document.createElement("div");
      actions.className = "messageActions";
      actions.innerHTML = `<button data-message-action="reply" title="Reply" type="button">↩</button><button data-message-action="copy" title="Copy" type="button">▣</button>${mine && message.text ? '<button data-message-action="edit" title="Edit" type="button">✎</button>' : ""}${mine ? '<button data-message-action="delete" title="Delete" type="button">×</button>' : ""}`;
      wrap.append(avatar, bubble, actions);
      host.appendChild(wrap);
    });
    if (keepPosition) host.scrollTop = Math.max(0, host.scrollHeight - oldBottomGap);
    else host.scrollTop = host.scrollHeight;
  }

  function appendOrUpdateMessage(message) {
    const index = state.chatMessages.findIndex((item) => item.id === message.id);
    if (index >= 0) state.chatMessages[index] = message;
    else state.chatMessages.push(message);
    renderMessages();
  }

  function renderReplyPreview() {
    const preview = $("replyPreview");
    if (!state.replyTo) return preview.classList.add("hidden");
    $("replyToName").textContent = state.replyTo.sender_id === state.me.id ? "yourself" : (state.replyTo.sender_name || state.activeChat?.display_name || state.activeChat?.username);
    $("replyToText").textContent = state.replyTo.text || state.replyTo.file_name || "Attachment";
    preview.classList.remove("hidden");
    $("messageInput").focus();
  }

  async function handleMessageAction(button) {
    const wrap = button.closest(".messageWrap");
    const id = Number(wrap?.dataset.messageId);
    const message = state.chatMessages.find((item) => item.id === id);
    if (!message) return;
    const action = button.dataset.messageAction;
    if (action === "reply") {
      state.replyTo = message;
      renderReplyPreview();
    } else if (action === "copy") {
      try { await navigator.clipboard.writeText(message.text || message.file_name || ""); toast("Copied", "success"); } catch (_error) { toast("Copy is not available", "error"); }
    } else if (action === "edit") {
      const text = prompt("Edit your message:", message.text || "");
      if (!text || text.trim() === message.text) return;
      try {
        const updated = await api(`/api/messages/${id}`, { method: "PATCH", body: JSON.stringify({ text }) });
        appendOrUpdateMessage(updated);
      } catch (error) { toast(error.message, "error"); }
    } else if (action === "delete") {
      if (!confirm("Delete this message for everyone?")) return;
      try {
        await api(`/api/messages/${id}`, { method: "DELETE" });
        state.chatMessages = state.chatMessages.filter((item) => item.id !== id);
        renderMessages();
      } catch (error) { toast(error.message, "error"); }
    }
  }

  function emitTyping(typing) {
    if (!state.socket || !state.activeChat || state.lastTypingState === typing) return;
    state.lastTypingState = typing;
    state.socket.emit("typing", { receiver_id: state.activeChat.id, typing });
  }

  async function sendCurrentMessage(event) {
    event.preventDefault();
    if (!state.activeChat || !state.socket) return;
    const input = $("messageInput");
    const text = input.value.trim();
    if (!text) return;
    state.socket.emit("send_message", { receiver_id: state.activeChat.id, text, reply_to: state.replyTo?.id || null });
    input.value = "";
    input.style.height = "auto";
    state.replyTo = null;
    renderReplyPreview();
    clearTimeout(state.typingTimer);
    emitTyping(false);
  }

  async function uploadChatFile(file, fileName = file.name) {
    if (!file || !state.activeChat) return;
    const form = new FormData();
    form.append("file", file, fileName || "attachment");
    form.append("receiver_id", state.activeChat.id);
    if (state.replyTo) form.append("reply_to", state.replyTo.id);
    toast("Uploading attachment…");
    try {
      const message = await api("/api/upload", { method: "POST", body: form });
      appendOrUpdateMessage(message);
      state.replyTo = null;
      renderReplyPreview();
      loadUsers();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast("Voice recording is not supported in this browser", "error");
    try {
      state.recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const preferred = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
      state.recordingChunks = [];
      state.recorder = new MediaRecorder(state.recordingStream, preferred ? { mimeType: preferred } : undefined);
      state.recorder.ondataavailable = (event) => { if (event.data.size) state.recordingChunks.push(event.data); };
      state.recorder.onstop = async () => {
        const type = state.recorder?.mimeType || "audio/webm";
        const blob = new Blob(state.recordingChunks, { type });
        state.recordingStream?.getTracks().forEach((track) => track.stop());
        state.recordingStream = null;
        state.recorder = null;
        state.recordingChunks = [];
        $("recordVoiceBtn").classList.remove("recording");
        $("recordingTime").classList.add("hidden");
        clearInterval(state.recordingClock);
        if (blob.size > 1000) await uploadChatFile(blob, `voice-${Date.now()}.webm`);
      };
      state.recorder.start();
      state.recordingStarted = Date.now();
      $("recordVoiceBtn").classList.add("recording");
      $("recordingTime").classList.remove("hidden");
      const updateClock = () => {
        const elapsed = Math.floor((Date.now() - state.recordingStarted) / 1000);
        $("recordingTime").textContent = `● ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")} • tap red button to send`;
        if (elapsed >= 120) stopRecording();
      };
      updateClock();
      state.recordingClock = setInterval(updateClock, 500);
    } catch (_error) {
      toast("Microphone permission was not granted", "error");
    }
  }

  function stopRecording(cancel = false) {
    if (state.recorder && state.recorder.state !== "inactive") {
      if (cancel) state.recordingChunks = [];
      state.recorder.stop();
    }
    if (cancel && state.recordingStream) state.recordingStream.getTracks().forEach((track) => track.stop());
    clearInterval(state.recordingClock);
  }

  function connectSocket() {
    if (state.socket) state.socket.disconnect();
    state.socket = io({ auth: { token: state.token } });
    state.socket.on("connect_error", (error) => toast(error.message === "Unauthorized" ? "Your session expired" : "Real-time connection failed", "error"));
    state.socket.on("message", async (message) => {
      const relevant = state.activeChat && (message.sender_id === state.activeChat.id || message.receiver_id === state.activeChat.id);
      const incoming = message.receiver_id === state.me.id && !message.system;
      const visiblyReading = incoming && conversationIsVisible(message.sender_id);

      if (relevant) appendOrUpdateMessage(message);

      // Mark as seen only while this exact conversation is open, the browser tab is
      // visible, and the window has focus. A hidden/closed chat remains unread.
      if (visiblyReading) {
        api(`/api/messages/read/${message.sender_id}`, { method: "POST" }).catch(() => {});
      } else if (incoming) {
        toast(`${message.sender_name || "Someone"}: ${truncate(message.text || message.file_name || "Attachment", 55)}`);
      }
      loadUsers().catch(() => {});
    });
    state.socket.on("message_deleted", ({ id }) => {
      state.chatMessages = state.chatMessages.filter((message) => message.id !== Number(id));
      if (state.activeChat) renderMessages();
      loadUsers().catch(() => {});
    });
    state.socket.on("message_edited", (message) => {
      if (state.activeChat && (message.sender_id === state.activeChat.id || message.receiver_id === state.activeChat.id)) appendOrUpdateMessage(message);
    });
    state.socket.on("messages_seen", ({ by }) => {
      if (state.activeChat?.id === Number(by)) {
        state.chatMessages.forEach((message) => { if (message.sender_id === state.me.id) message.seen_at = new Date().toISOString(); });
        renderMessages();
      }
    });
    state.socket.on("messages_delivered", ({ to }) => {
      if (state.activeChat?.id === Number(to)) {
        state.chatMessages.forEach((message) => { if (message.sender_id === state.me.id && !message.delivered_at) message.delivered_at = new Date().toISOString(); });
        renderMessages();
      }
    });
    state.socket.on("typing", ({ user_id: userId, typing }) => {
      if (state.activeChat?.id !== Number(userId)) return;
      $("typingBar").classList.toggle("hidden", !typing);
    });
    state.socket.on("presence", ({ user_id: userId, online, last_seen: lastSeen }) => {
      const user = state.users.find((item) => item.id === Number(userId));
      if (user) { user.online = online; user.last_seen = lastSeen; }
      renderChatList();
      renderDiscover();
      updateActiveChatHeader();
    });
    state.socket.on("friend_request_update", () => Promise.all([loadUsers(), loadRequests(), loadStories()]).catch(() => {}));
    state.socket.on("feed_update", () => { if (state.view === "home") loadPosts(); });
    state.socket.on("story_update", () => loadStories());
    state.socket.on("message_error", ({ error }) => toast(error || "Message could not be sent", "error"));
  }

  // ----------------------- Posts and comments -----------------------
  async function loadPosts() {
    if (!state.token) return;
    state.posts = await api("/api/posts");
    renderPosts();
  }

  function postMediaHtml(post) {
    const url = safeUrl(post.image_url);
    if (!url) return "";
    return String(post.media_type || "").startsWith("video/")
      ? `<video class="postMedia" src="${url}" controls preload="metadata"></video>`
      : `<img class="postMedia" src="${url}" alt="Post by ${escapeHtml(post.display_name || post.username)}">`;
  }

  function renderPosts() {
    const host = $("feedList");
    if (!host) return;
    if (!state.posts.length) {
      host.innerHTML = emptyState("▦", "Your feed is quiet", "Create the first post or add friends to see their updates.");
      return;
    }
    host.innerHTML = state.posts.map((post) => `
      <article class="postCard" data-post-id="${post.id}">
        <header class="postHeader">${avatarHtml(post, 42, state.users.find((u) => sameId(u.id, post.user_id))?.online || sameId(post.user_id, state.me.id))}<div class="postWho"><b>${escapeHtml(post.display_name || post.username)}</b><small>@${escapeHtml(post.username)} • ${relativeTime(post.created_at)}</small></div>${sameId(post.user_id, state.me.id) ? '<button class="postMenu" data-post-action="delete" title="Delete post" type="button">⋮</button>' : ""}</header>
        ${post.text ? `<p class="postText">${escapeHtml(post.text)}</p>` : ""}
        ${postMediaHtml(post)}
        <footer class="postActions"><button class="${post.liked_by_me ? "liked" : ""}" data-post-action="like" type="button">${post.liked_by_me ? "♥" : "♡"} <span>${post.like_count || 0}</span></button><button data-post-action="comments" type="button">◌ ${post.comment_count || 0} comments</button>${sameId(post.user_id, state.me.id) ? '<button class="deletePostBtn" data-post-action="delete" type="button">🗑 Delete</button>' : ""}<button class="sharePostBtn" data-post-action="share" type="button">↗ Share</button></footer>
      </article>`).join("");
  }

  async function handlePostAction(button) {
    const card = button.closest("[data-post-id]");
    const postId = Number(card?.dataset.postId);
    const post = state.posts.find((item) => item.id === postId);
    if (!post) return;
    const action = button.dataset.postAction;
    if (action === "like") {
      try {
        const data = await api(`/api/posts/${postId}/like`, { method: "POST" });
        post.liked_by_me = data.liked ? 1 : 0;
        post.like_count = data.like_count;
        renderPosts();
      } catch (error) { toast(error.message, "error"); }
    } else if (action === "comments") {
      openComments(postId);
    } else if (action === "share") {
      const shareText = `${post.display_name || post.username} on Sandeep Chat: ${post.text || "Shared a post"}`;
      if (navigator.share) navigator.share({ title: "Sandeep Chat", text: shareText }).catch(() => {});
      else navigator.clipboard?.writeText(shareText).then(() => toast("Post text copied", "success")).catch(() => toast("Sharing is not available", "error"));
    } else if (action === "delete") {
      if (!confirm("Delete this post?")) return;
      try {
        await api(`/api/posts/${postId}`, { method: "DELETE" });
        state.posts = state.posts.filter((item) => item.id !== postId);
        renderPosts();
        toast("Post deleted", "success");
      } catch (error) { toast(error.message, "error"); }
    }
  }

  function openModal(id) {
    $(id)?.classList.remove("hidden");
    document.body.dataset.modalOpen = "true";
  }

  function closeModal(id) {
    $(id)?.classList.add("hidden");
    delete document.body.dataset.modalOpen;
  }

  function openPostComposer(openFile = false) {
    $("postText").value = "";
    $("postMediaInput").value = "";
    clearPostPreview();
    openModal("postModal");
    setTimeout(() => openFile ? $("postMediaInput").click() : $("postText").focus(), 80);
  }

  function clearPostPreview() {
    if (state.postPreviewUrl) URL.revokeObjectURL(state.postPreviewUrl);
    state.postPreviewUrl = "";
    $("postMediaPreview").innerHTML = "";
    $("postMediaPreview").classList.add("hidden");
  }

  function previewPostMedia(file) {
    clearPostPreview();
    if (!file) return;
    state.postPreviewUrl = URL.createObjectURL(file);
    $("postMediaPreview").innerHTML = file.type.startsWith("video/") ? `<video src="${state.postPreviewUrl}" controls></video>` : `<img src="${state.postPreviewUrl}" alt="Post preview">`;
    $("postMediaPreview").classList.remove("hidden");
  }

  async function publishPost() {
    const text = $("postText").value.trim();
    const file = $("postMediaInput").files[0];
    if (!text && !file) return toast("Write something or choose a photo/video", "error");
    const button = $("publishPostBtn");
    setButtonLoading(button, true, "Sharing…");
    const form = new FormData();
    form.append("text", text);
    if (file) form.append("media", file);
    try {
      const post = await api("/api/posts", { method: "POST", body: form });
      state.posts.unshift(post);
      renderPosts();
      closeModal("postModal");
      clearPostPreview();
      toast("Post shared", "success");
      if (state.view !== "home") navigate("home");
    } catch (error) { toast(error.message, "error"); }
    finally { setButtonLoading(button, false); }
  }

  async function openComments(postId) {
    state.currentCommentPost = postId;
    $("commentsList").innerHTML = emptyState("◌", "Loading comments", "Please wait…");
    openModal("commentsModal");
    try {
      const comments = await api(`/api/posts/${postId}/comments`);
      renderComments(comments);
    } catch (error) { $("commentsList").innerHTML = emptyState("!", "Could not load comments", error.message); }
  }

  function renderComments(comments) {
    $("commentsList").innerHTML = comments.length ? comments.map((comment) => `
      <div class="commentRow">${avatarHtml(comment, 33)}<div><b>${escapeHtml(comment.display_name || comment.username)}</b><p>${escapeHtml(comment.text)}</p><time>${relativeTime(comment.created_at)}</time></div></div>
    `).join("") : emptyState("◌", "No comments yet", "Be the first to say something.");
  }

  async function submitComment(event) {
    event.preventDefault();
    const text = $("commentInput").value.trim();
    if (!text || !state.currentCommentPost) return;
    try {
      await api(`/api/posts/${state.currentCommentPost}/comments`, { method: "POST", body: JSON.stringify({ text }) });
      $("commentInput").value = "";
      const comments = await api(`/api/posts/${state.currentCommentPost}/comments`);
      renderComments(comments);
      const post = state.posts.find((item) => item.id === state.currentCommentPost);
      if (post) { post.comment_count = comments.length; renderPosts(); }
    } catch (error) { toast(error.message, "error"); }
  }

  // ----------------------- Stories -----------------------
  async function loadStories() {
    if (!state.token) return;
    state.stories = await api("/api/stories");
    renderHomeStories();
    renderStoryGrid();
  }

  function renderHomeStories() {
    const host = $("homeStories");
    if (!host || !state.me) return;
    host.classList.remove("skeletonRail");
    const unique = [];
    const seen = new Set();
    state.stories.forEach((story) => {
      if (seen.has(story.user_id)) return;
      seen.add(story.user_id);
      unique.push(story);
    });
    host.innerHTML = `<button class="storyBubble addStory" data-create="story" type="button"><span class="storyRing">${avatarHtml(state.me, 56)}</span><small>Your story</small></button>` + unique.map((story) => {
      const thumb = safeUrl(story.media_url) && String(story.media_type).startsWith("image/") ? `<img class="storyThumb" src="${safeUrl(story.media_url)}" alt="">` : avatarHtml(story, 56);
      return `<button class="storyBubble" data-story-id="${story.id}" type="button"><span class="storyRing${story.viewed_by_me ? " viewed" : ""}">${thumb}</span><small>${sameId(story.user_id, state.me.id) ? "Your story" : escapeHtml(story.display_name || story.username)}</small></button>`;
    }).join("");
  }

  function storyMediaHtml(story) {
    const url = safeUrl(story.media_url);
    if (!url) return "";
    return String(story.media_type).startsWith("video/") ? `<video src="${url}" muted playsinline preload="metadata"></video>` : `<img src="${url}" alt="Story">`;
  }

  function renderStoryGrid() {
    const host = $("storyGrid");
    if (!host) return;
    if (!state.stories.length) {
      host.innerHTML = emptyState("◉", "No stories right now", "Create a story to share a moment for the next 24 hours.");
      return;
    }
    host.innerHTML = state.stories.map((story) => `
      <article class="storyTile bg-${escapeHtml(story.background || "aurora")}" data-story-id="${story.id}">
        ${storyMediaHtml(story)}
        <div class="storyTileHead">${avatarHtml(story, 34)}<b>${escapeHtml(story.display_name || story.username)}</b></div>
        <div class="storyTileCaption">${escapeHtml(story.caption || (story.media_type.startsWith("video/") ? "Video story" : "Photo story"))}</div>
      </article>`).join("");
  }

  function openStoryComposer() {
    $("storyCaption").value = "";
    $("storyMediaInput").value = "";
    clearStoryPreview();
    setStoryBackground("aurora");
    openModal("storyModal");
  }

  function clearStoryPreview() {
    if (state.storyPreviewUrl) URL.revokeObjectURL(state.storyPreviewUrl);
    state.storyPreviewUrl = "";
    $("storyMediaPreview").innerHTML = "";
  }

  function previewStoryMedia(file) {
    clearStoryPreview();
    if (!file) return;
    state.storyPreviewUrl = URL.createObjectURL(file);
    $("storyMediaPreview").innerHTML = file.type.startsWith("video/") ? `<video src="${state.storyPreviewUrl}" autoplay muted loop></video>` : `<img src="${state.storyPreviewUrl}" alt="Story preview">`;
  }

  function setStoryBackground(background) {
    state.storyBackground = background;
    $("storyDraft").className = `storyDraft bg-${background}`;
    document.querySelectorAll("[data-background]").forEach((button) => button.classList.toggle("active", button.dataset.background === background));
  }

  async function publishStory() {
    const caption = $("storyCaption").value.trim();
    const file = $("storyMediaInput").files[0];
    if (!caption && !file) return toast("Add text, a photo, or a video", "error");
    const button = $("publishStoryBtn");
    setButtonLoading(button, true, "Sharing…");
    const form = new FormData();
    form.append("caption", caption);
    form.append("background", state.storyBackground);
    if (file) form.append("media", file);
    try {
      const story = await api("/api/stories", { method: "POST", body: form });
      state.stories.unshift(story);
      renderHomeStories();
      renderStoryGrid();
      closeModal("storyModal");
      clearStoryPreview();
      toast("Story shared for 24 hours", "success");
    } catch (error) { toast(error.message, "error"); }
    finally { setButtonLoading(button, false); }
  }

  function openStoryById(id) {
    const index = state.stories.findIndex((story) => story.id === Number(id));
    if (index < 0) return;
    state.storyIndex = index;
    $("storyViewer").classList.remove("hidden");
    showCurrentStory();
  }

  function showCurrentStory() {
    clearTimeout(state.storyTimer);
    const story = state.stories[state.storyIndex];
    if (!story) return closeStoryViewer();
    const ownStory = sameId(story.user_id, state.me.id);
    $("storyViewerAvatar").innerHTML = avatarHtml(story, 38);
    $("storyViewerName").textContent = story.display_name || story.username;
    $("storyViewerTime").textContent = `${relativeTime(story.created_at)}${ownStory ? ` • ${story.view_count || 0} views` : ""}`;
    $("deleteStoryBtn").classList.toggle("hidden", !ownStory);
    $("deleteStoryBtn").dataset.storyId = ownStory ? story.id : "";
    const content = $("storyViewerContent");
    content.className = `storyViewerContent bg-${story.background || "aurora"}${story.media_url ? " hasMedia" : ""}`;
    const media = storyMediaHtml(story).replace(" muted playsinline preload=\"metadata\"", " autoplay playsinline controls");
    content.innerHTML = `${media}${story.caption ? `<p>${escapeHtml(story.caption)}</p>` : ""}`;
    const progress = $("storyProgressBar");
    progress.style.transition = "none";
    progress.style.width = "0";
    requestAnimationFrame(() => requestAnimationFrame(() => {
      progress.style.transition = "width 7s linear";
      progress.style.width = "100%";
    }));
    if (!ownStory && !story.viewed_by_me) {
      story.viewed_by_me = 1;
      api(`/api/stories/${story.id}/view`, { method: "POST" }).catch(() => {});
      renderHomeStories();
    }
    state.storyTimer = setTimeout(() => changeStory(1), 7000);
  }

  async function deleteCurrentStory() {
    const story = state.stories[state.storyIndex];
    if (!story || !sameId(story.user_id, state.me.id)) return;
    if (!confirm("Delete this story permanently?")) return;
    const button = $("deleteStoryBtn");
    button.disabled = true;
    try {
      await api(`/api/stories/${story.id}`, { method: "DELETE" });
      state.stories = state.stories.filter((item) => !sameId(item.id, story.id));
      renderHomeStories();
      renderStoryGrid();
      closeStoryViewer();
      toast("Story deleted", "success");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      button.disabled = false;
    }
  }

  function changeStory(direction) {
    const next = state.storyIndex + direction;
    if (next < 0 || next >= state.stories.length) return closeStoryViewer();
    state.storyIndex = next;
    showCurrentStory();
  }

  function closeStoryViewer() {
    clearTimeout(state.storyTimer);
    $("storyViewer").classList.add("hidden");
    $("storyViewerContent").innerHTML = "";
    state.storyIndex = -1;
  }

  // ----------------------- Nova AI -----------------------
  async function loadAiHistory() {
    if (state.aiLoaded) return;
    try {
      const messages = await api("/api/ai/history");
      state.aiLoaded = true;
      renderAiMessages(messages);
    } catch (error) { toast(error.message, "error"); }
  }

  function renderAiMessages(messages) {
    const host = $("aiMessages");
    if (!messages.length) return;
    host.innerHTML = messages.map((message) => aiMessageHtml(message.text, message.role === "user", message.created_at)).join("");
    host.scrollTop = host.scrollHeight;
  }

  function aiMessageHtml(text, mine, time = new Date().toISOString()) {
    return `<div class="aiMsg${mine ? " mine" : ""}">${mine ? avatarHtml(state.me, 31) : '<span class="novaOrb">✦</span>'}<div class="aiMsgBubble">${escapeHtml(text)}<small class="aiMsgMeta">${formatTime(time)}</small></div></div>`;
  }

  async function sendAiMessage(event) {
    event.preventDefault();
    if (state.aiBusy) return;
    const input = $("aiInput");
    const text = input.value.trim();
    if (!text) return;
    state.aiBusy = true;
    input.value = "";
    input.style.height = "auto";
    const host = $("aiMessages");
    host.querySelector(".aiWelcome")?.remove();
    host.insertAdjacentHTML("beforeend", aiMessageHtml(text, true));
    const typing = document.createElement("div");
    typing.className = "aiMsg aiTyping";
    typing.innerHTML = '<span class="novaOrb">✦</span><div class="aiMsgBubble"><span class="typingOrb"><i></i><i></i><i></i></span></div>';
    host.appendChild(typing);
    host.scrollTop = host.scrollHeight;
    try {
      const data = await api("/api/ai", { method: "POST", body: JSON.stringify({ text }) });
      typing.remove();
      host.insertAdjacentHTML("beforeend", aiMessageHtml(data.reply, false));
    } catch (error) {
      typing.remove();
      host.insertAdjacentHTML("beforeend", aiMessageHtml(`Error: ${error.message}`, false));
    } finally {
      state.aiBusy = false;
      host.scrollTop = host.scrollHeight;
    }
  }

  // ----------------------- Profile -----------------------
  async function loadProfile(userId) {
    state.profileViewing = Number(userId);
    try {
      state.profile = await api(state.profileViewing === state.me.id ? "/api/profile" : `/api/profile/${state.profileViewing}`);
      renderProfile();
    } catch (error) { toast(error.message, "error"); }
  }

  function renderProfile() {
    if (!state.profile) return;
    const { user, stats, posts } = state.profile;
    const own = sameId(user.id, state.me.id);
    const relation = own ? null : state.users.find((item) => sameId(item.id, user.id));
    $("profileAvatar").innerHTML = avatarHtml(user, 112, user.online);
    $("profileName").textContent = user.display_name || user.username;
    $("profileHandle").textContent = `@${user.username}`;
    $("profileBio").textContent = user.bio || (own ? "Tell your friends something about yourself." : "Sandeep Chat member");
    $("profilePostCount").textContent = stats.posts;
    $("profileFriendCount").textContent = stats.friends;
    $("profileStoryCount").textContent = stats.stories;
    const action = $("editProfileBtn");
    action.textContent = own ? "Edit profile" : "Message";
    action.dataset.profileAction = own ? "edit" : "message";
    $("removeFriendProfileBtn").classList.toggle("hidden", own || relation?.friendStatus !== "friend");
    $("profileMenuBtn").classList.toggle("hidden", !own);
    $("profilePostGrid").innerHTML = posts.length ? posts.map((post) => {
      const media = safeUrl(post.image_url);
      let inside = escapeHtml(truncate(post.text, 80));
      let cls = "profileGridItem textOnly";
      if (media) {
        cls = "profileGridItem";
        inside = String(post.media_type).startsWith("video/") ? `<video src="${media}" muted></video>` : `<img src="${media}" alt="Post">`;
      }
      return `<button class="${cls}" data-likes="${post.like_count || 0}" type="button">${inside}</button>`;
    }).join("") : emptyState("▦", "No posts yet", own ? "Share something from the Home tab." : "This profile has not posted anything.");
  }

  function openProfileEditor() {
    $("editDisplayName").value = state.me.display_name || state.me.username;
    $("editBio").value = state.me.bio || "";
    $("bioCount").textContent = $("editBio").value.length;
    $("editAvatarPreview").innerHTML = `${avatarHtml(state.me, 70, true)}<input id="avatarInput" type="file" accept="image/*" hidden><span class="cameraBadge">▣</span>`;
    openModal("profileEditModal");
  }

  async function saveProfile() {
    const displayName = $("editDisplayName").value.trim();
    const bio = $("editBio").value.trim();
    const button = $("saveProfileBtn");
    setButtonLoading(button, true, "Saving…");
    try {
      state.me = await api("/api/profile", { method: "PATCH", body: JSON.stringify({ display_name: displayName, bio }) });
      localStorage.setItem("sandeep_me", JSON.stringify(state.me));
      renderIdentity();
      await loadProfile(state.me.id);
      closeModal("profileEditModal");
      toast("Profile updated", "success");
    } catch (error) { toast(error.message, "error"); }
    finally { setButtonLoading(button, false); }
  }

  async function uploadAvatar(file) {
    if (!file) return;
    const form = new FormData();
    form.append("avatar", file);
    try {
      const data = await api("/api/profile/avatar", { method: "POST", body: form });
      state.me.avatar = data.avatar;
      localStorage.setItem("sandeep_me", JSON.stringify(state.me));
      renderIdentity();
      openProfileEditor();
      await Promise.all([loadUsers(), loadProfile(state.me.id)]);
      toast("Profile photo updated", "success");
    } catch (error) { toast(error.message, "error"); }
  }

  function openDrawer() { $("settingsDrawer").classList.remove("hidden"); }
  function closeDrawer() { $("settingsDrawer").classList.add("hidden"); }

  // ----------------------- Events -----------------------
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".messageWrap")) document.querySelectorAll(".messageWrap.actionsOpen").forEach((item) => item.classList.remove("actionsOpen"));
    const aiPrompt = event.target.closest("[data-ai-prompt]");
    if (aiPrompt) {
      $("aiInput").value = aiPrompt.dataset.aiPrompt;
      $("aiInput").focus();
      return;
    }
    const viewButton = event.target.closest("[data-view]");
    if (viewButton) {
      event.preventDefault();
      navigate(viewButton.dataset.view);
      return;
    }
    const link = event.target.closest("[data-view-link]");
    if (link) { event.preventDefault(); navigate(link.dataset.viewLink); return; }
    const closeButton = event.target.closest("[data-close]");
    if (closeButton) {
      const id = closeButton.dataset.close;
      if (id === "settingsDrawer") closeDrawer(); else closeModal(id);
      return;
    }
    const createButton = event.target.closest("[data-create]");
    if (createButton) {
      $("createMenu").classList.add("hidden");
      if (createButton.dataset.create === "post") openPostComposer();
      else openStoryComposer();
      return;
    }
    const userAction = event.target.closest("[data-user-action]");
    if (userAction) { handleUserAction(userAction); return; }
    const chatButton = event.target.closest("[data-open-chat]");
    if (chatButton) {
      const user = state.users.find((item) => item.id === Number(chatButton.dataset.openChat));
      if (user) openChat(user);
      return;
    }
    const storyButton = event.target.closest("[data-story-id]");
    if (storyButton) { openStoryById(storyButton.dataset.storyId); return; }
    const postAction = event.target.closest("[data-post-action]");
    if (postAction) { handlePostAction(postAction); return; }
    const messageAction = event.target.closest("[data-message-action]");
    if (messageAction) { handleMessageAction(messageAction); return; }
  });

  $("loginBtn").addEventListener("click", login);
  $("registerBtn").addEventListener("click", register);
  $("showRegisterBtn").addEventListener("click", () => {
    $("authLoginPanel").classList.add("hidden");
    $("authRegisterPanel").classList.remove("hidden");
    setAuthMessage("");
    $("registerUsername").focus();
  });
  $("backToLoginBtn").addEventListener("click", () => {
    $("authRegisterPanel").classList.add("hidden");
    $("authLoginPanel").classList.remove("hidden");
    setAuthMessage("");
  });
  $("peekPassword").addEventListener("click", () => { $("authPassword").type = $("authPassword").type === "password" ? "text" : "password"; });
  [$("authUsername"), $("authPassword")].forEach((input) => input.addEventListener("keydown", (event) => { if (event.key === "Enter") login(); }));
  [$("registerUsername"), $("registerPassword"), $("registerConfirm")].forEach((input) => input.addEventListener("keydown", (event) => { if (event.key === "Enter") register(); }));

  $("themeQuickBtn").addEventListener("click", toggleTheme);
  $("themeSwitch").addEventListener("change", toggleTheme);
  $("mobileMoreBtn").addEventListener("click", openDrawer);
  $("openSettingsBtn").addEventListener("click", openDrawer);
  $("profileMenuBtn").addEventListener("click", openDrawer);
  $("logoutBtn").addEventListener("click", () => logout());
  $("mobileCreateBtn").addEventListener("click", () => $("createMenu").classList.toggle("hidden"));

  $("chatSearch").addEventListener("input", renderChatList);
  $("peopleSearch").addEventListener("input", renderDiscover);
  $("newChatBtn").addEventListener("click", () => navigate("requests"));
  $("emptyFindPeople").addEventListener("click", () => navigate("requests"));
  $("chatBackBtn").addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    closeConversation();
  });
  $("messageComposer").addEventListener("submit", sendCurrentMessage);
  $("messageInput").addEventListener("input", (event) => {
    event.target.style.height = "auto";
    event.target.style.height = `${Math.min(event.target.scrollHeight, 115)}px`;
    emitTyping(true);
    clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(() => emitTyping(false), 900);
  });
  $("messageInput").addEventListener("blur", () => emitTyping(false));
  $("cancelReply").addEventListener("click", () => { state.replyTo = null; renderReplyPreview(); });
  $("chatFileInput").addEventListener("change", (event) => { const file = event.target.files[0]; if (file) uploadChatFile(file); event.target.value = ""; });
  $("recordVoiceBtn").addEventListener("click", () => state.recorder?.state === "recording" ? stopRecording() : startRecording());
  $("voiceCallBtn").addEventListener("click", () => toast("Voice calling is planned for the next phase."));
  $("chatMenuBtn").addEventListener("click", () => $("chatMenu").classList.toggle("hidden"));
  $("chatMenu").addEventListener("click", async (event) => {
    const action = event.target.dataset.chatAction;
    if (!action || !state.activeChat) return;
    $("chatMenu").classList.add("hidden");
    if (action === "profile") navigate("profile", state.activeChat.id);
    if (action === "hide") {
      try { await api("/api/hidden-chats", { method: "POST", body: JSON.stringify({ user_id: state.activeChat.id }) }); state.activeChat = null; $("conversationActive").classList.add("hidden"); $("conversationEmpty").classList.remove("hidden"); $("chatLayout").classList.remove("conversationOpen"); await loadUsers(); toast("Chat hidden", "success"); } catch (error) { toast(error.message, "error"); }
    }
    if (action === "remove-friend") await removeFriend(state.activeChat);
    if (action === "block") {
      if (!confirm(`Block ${state.activeChat.display_name || state.activeChat.username}?`)) return;
      try { await api("/api/block", { method: "POST", body: JSON.stringify({ user_id: state.activeChat.id }) }); state.activeChat = null; $("conversationActive").classList.add("hidden"); $("conversationEmpty").classList.remove("hidden"); $("chatLayout").classList.remove("conversationOpen"); await Promise.all([loadUsers(), loadRequests()]); toast("User blocked", "success"); } catch (error) { toast(error.message, "error"); }
    }
  });

  document.querySelectorAll("[data-request-tab]").forEach((button) => button.addEventListener("click", () => { state.requestTab = button.dataset.requestTab; renderRequests(); }));

  $("openPostComposer").addEventListener("click", () => openPostComposer());
  $("quickPhotoBtn").addEventListener("click", () => openPostComposer(true));
  $("refreshFeedBtn").addEventListener("click", () => loadPosts().catch((error) => toast(error.message, "error")));
  $("postMediaInput").addEventListener("change", (event) => previewPostMedia(event.target.files[0]));
  $("publishPostBtn").addEventListener("click", publishPost);
  $("commentForm").addEventListener("submit", submitComment);

  $("openStoryComposer").addEventListener("click", openStoryComposer);
  $("storyMediaInput").addEventListener("change", (event) => previewStoryMedia(event.target.files[0]));
  document.querySelectorAll("[data-background]").forEach((button) => button.addEventListener("click", () => setStoryBackground(button.dataset.background)));
  $("publishStoryBtn").addEventListener("click", publishStory);
  $("closeStoryViewer").addEventListener("click", closeStoryViewer);
  $("deleteStoryBtn").addEventListener("click", deleteCurrentStory);
  $("prevStory").addEventListener("click", () => changeStory(-1));
  $("nextStory").addEventListener("click", () => changeStory(1));

  $("aiComposer").addEventListener("submit", sendAiMessage);

  $("editProfileBtn").addEventListener("click", () => {
    if ($("editProfileBtn").dataset.profileAction === "edit") openProfileEditor();
    else {
      const user = state.users.find((item) => sameId(item.id, state.profileViewing));
      if (user?.friendStatus === "friend") { navigate("chats"); openChat(user); }
      else toast("You need to be friends before messaging", "error");
    }
  });
  $("removeFriendProfileBtn").addEventListener("click", () => {
    const user = state.users.find((item) => sameId(item.id, state.profileViewing));
    if (user?.friendStatus === "friend") removeFriend(user);
  });
  $("saveProfileBtn").addEventListener("click", saveProfile);
  $("editBio").addEventListener("input", () => { $("bioCount").textContent = $("editBio").value.length; });
  $("editAvatarPreview").addEventListener("change", (event) => { if (event.target.matches("input[type=file]")) uploadAvatar(event.target.files[0]); });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    document.querySelectorAll(".modal:not(.hidden)").forEach((modal) => closeModal(modal.id));
    if (!$("storyViewer").classList.contains("hidden")) closeStoryViewer();
    closeDrawer();
    $("createMenu").classList.add("hidden");
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) markVisibleConversationRead();
  });
  window.addEventListener("focus", markVisibleConversationRead);
  window.addEventListener("beforeunload", () => emitTyping(false));
  window.addEventListener("storage", (event) => {
    if (event.key === "sandeep_token" && event.newValue !== state.token) window.location.reload();
  });

  // ----------------------- Start -----------------------
  applyTheme();
  if (state.token) {
    api("/api/me").then((user) => {
      state.me = user;
      localStorage.setItem("sandeep_me", JSON.stringify(user));
      bootApp();
    }).catch(() => {
      state.token = "";
      localStorage.removeItem("sandeep_token");
      showAuth();
    });
  } else showAuth();
})();
