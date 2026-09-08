require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const Database = require("better-sqlite3");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 26 * 1024 * 1024 });
const PORT = Number(process.env.PORT) || 3000;
const SECRET = process.env.JWT_SECRET || "change-me-before-public-deployment";
const ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || "sandeep").toLowerCase();
const uploadDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

if (SECRET.startsWith("change-me")) {
  console.warn("WARNING: Set a strong JWT_SECRET in .env before deploying publicly.");
}

const db = new Database(path.join(__dirname, "chat.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    avatar TEXT DEFAULT '',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER,
    receiver_id INTEGER,
    text TEXT DEFAULT '',
    file_url TEXT DEFAULT '',
    file_name TEXT DEFAULT '',
    file_type TEXT DEFAULT '',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS ai_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    role TEXT,
    text TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS friend_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER NOT NULL,
    receiver_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    blocker_id INTEGER NOT NULL,
    blocked_id INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(blocker_id, blocked_id)
  );
  CREATE TABLE IF NOT EXISTS hidden_chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    other_user_id INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, other_user_id)
  );
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    text TEXT DEFAULT '',
    image_url TEXT DEFAULT '',
    media_type TEXT DEFAULT '',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS post_likes (
    post_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(post_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS post_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS stories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    media_url TEXT DEFAULT '',
    media_type TEXT DEFAULT '',
    caption TEXT DEFAULT '',
    background TEXT DEFAULT 'aurora',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS story_views (
    story_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    viewed_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(story_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(sender_id, receiver_id, id);
  CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_stories_expiry ON stories(expires_at);
`);

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

ensureColumn("users", "is_admin", "INTEGER DEFAULT 0");
ensureColumn("users", "display_name", "TEXT DEFAULT ''");
ensureColumn("users", "bio", "TEXT DEFAULT ''");
ensureColumn("users", "last_seen", "TEXT");
ensureColumn("messages", "deleted", "INTEGER DEFAULT 0");
ensureColumn("messages", "deleted_at", "TEXT");
ensureColumn("messages", "system", "INTEGER DEFAULT 0");
ensureColumn("messages", "reply_to", "INTEGER");
ensureColumn("messages", "edited_at", "TEXT");
ensureColumn("messages", "delivered_at", "TEXT");
ensureColumn("messages", "seen_at", "TEXT");

// If the server was stopped while users were connected, they are offline after restart.
// Recording the restart time prevents a stale NULL last_seen value from looking like “never online”.
db.prepare("UPDATE users SET last_seen=CURRENT_TIMESTAMP WHERE last_seen IS NULL").run();

(function bootstrapAdmin() {
  const hasAdmin = db.prepare("SELECT COUNT(*) AS c FROM users WHERE is_admin=1").get().c;
  if (!hasAdmin) {
    const candidate = db.prepare("SELECT * FROM users WHERE LOWER(username)=?").get(ADMIN_USERNAME);
    if (candidate) db.prepare("UPDATE users SET is_admin=1 WHERE id=?").run(candidate.id);
  }
})();

const allowedExt = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".mp4", ".webm", ".mov",
  ".mp3", ".wav", ".ogg", ".opus", ".m4a", ".pdf", ".txt", ".doc", ".docx",
  ".xls", ".xlsx", ".ppt", ".pptx", ".zip"
]);
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (_req, file, cb) => {
      const originalExt = path.extname(file.originalname || "").toLowerCase();
      const ext = allowedExt.has(originalExt) ? originalExt : "";
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 12)}${ext}`);
    }
  }),
  limits: { fileSize: 25 * 1024 * 1024 }
});

app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(self), geolocation=()");
  next();
});
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use("/uploads", express.static(uploadDir, { fallthrough: false }));
app.use(express.static(path.join(__dirname, "Public")));

function makeToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, SECRET, { expiresIn: "7d" });
}

function auth(req, res, next) {
  try {
    const raw = String(req.headers.authorization || "");
    req.user = jwt.verify(raw.replace(/^Bearer\s+/i, ""), SECRET);
    next();
  } catch (_error) {
    res.status(401).json({ error: "Login required" });
  }
}

function adminOnly(req, res, next) {
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
  if (!user || !user.is_admin) return res.status(403).json({ error: "Admin access required" });
  next();
}

function userPublic(user) {
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name || user.username,
    bio: user.bio || "",
    avatar: user.avatar || "",
    last_seen: user.last_seen || null,
    is_admin: Boolean(user.is_admin)
  };
}

function removeUploaded(file) {
  if (file && file.path) fs.unlink(file.path, () => {});
}

function getFriendRequestBetween(a, b) {
  return db.prepare(`
    SELECT * FROM friend_requests
    WHERE (sender_id=? AND receiver_id=?) OR (sender_id=? AND receiver_id=?)
    ORDER BY id DESC LIMIT 1
  `).get(a, b, b, a);
}

function areFriends(a, b) {
  const request = getFriendRequestBetween(a, b);
  return Boolean(request && request.status === "accepted") && !isBlocked(a, b);
}

function isBlocked(a, b) {
  return Boolean(db.prepare(`
    SELECT 1 FROM blocks
    WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)
  `).get(a, b, b, a));
}

function canSeeSocial(ownerId, viewerId) {
  return ownerId === viewerId || areFriends(ownerId, viewerId);
}

function notifyPair(a, b) {
  io.to(`user:${a}`).to(`user:${b}`).emit("friend_request_update");
}

function messageById(id) {
  return db.prepare(`
    SELECT m.*, sender.username AS sender_name,
           replied.text AS reply_text, replied.file_name AS reply_file_name,
           reply_sender.username AS reply_sender_name
    FROM messages m
    JOIN users sender ON sender.id=m.sender_id
    LEFT JOIN messages replied ON replied.id=m.reply_to
    LEFT JOIN users reply_sender ON reply_sender.id=replied.sender_id
    WHERE m.id=?
  `).get(id);
}

function postById(id, viewerId) {
  return db.prepare(`
    SELECT p.*, u.username, u.display_name, u.avatar,
      (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id=p.id) AS like_count,
      (SELECT COUNT(*) FROM post_comments pc WHERE pc.post_id=p.id) AS comment_count,
      EXISTS(SELECT 1 FROM post_likes mine WHERE mine.post_id=p.id AND mine.user_id=?) AS liked_by_me
    FROM posts p JOIN users u ON u.id=p.user_id WHERE p.id=?
  `).get(viewerId, id);
}

const onlineCounts = new Map();
const isOnline = (id) => onlineCounts.has(Number(id));

// A small in-memory guard against rapid password guessing. It resets when the server restarts.
const authAttempts = new Map();
function authRateLimit(req, res, next) {
  const key = req.ip || "local";
  const now = Date.now();
  const recent = (authAttempts.get(key) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (recent.length >= 30) return res.status(429).json({ error: "Too many attempts. Please wait a few minutes." });
  recent.push(now);
  authAttempts.set(key, recent);
  next();
}

// ------------------------- Authentication & profile -------------------------
app.post("/api/register", authRateLimit, async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  if (!/^[a-zA-Z0-9_.]{3,24}$/.test(username)) {
    return res.status(400).json({ error: "Username must be 3–24 characters (letters, numbers, _ or .)" });
  }
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
  try {
    const hash = await bcrypt.hash(password, 11);
    const isAdmin = username.toLowerCase() === ADMIN_USERNAME ? 1 : 0;
    const info = db.prepare("INSERT INTO users(username,password,display_name,is_admin) VALUES(?,?,?,?)")
      .run(username, hash, username, isAdmin);
    const user = db.prepare("SELECT * FROM users WHERE id=?").get(info.lastInsertRowid);
    res.json({ token: makeToken(user), user: userPublic(user) });
  } catch (_error) {
    res.status(400).json({ error: "Username already exists" });
  }
});

app.post("/api/login", authRateLimit, async (req, res) => {
  const username = String(req.body.username || "").trim();
  const user = db.prepare("SELECT * FROM users WHERE LOWER(username)=LOWER(?)").get(username);
  if (!user || !(await bcrypt.compare(String(req.body.password || ""), user.password))) {
    return res.status(401).json({ error: "Invalid username or password" });
  }
  authAttempts.delete(req.ip || "local");
  res.json({ token: makeToken(user), user: userPublic(user) });
});

app.get("/api/me", auth, (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
  if (!user) return res.status(404).json({ error: "Account not found" });
  res.json(userPublic(user));
});

app.patch("/api/profile", auth, (req, res) => {
  const displayName = String(req.body.display_name || "").trim().slice(0, 40);
  const bio = String(req.body.bio || "").trim().slice(0, 160);
  if (!displayName) return res.status(400).json({ error: "Display name is required" });
  db.prepare("UPDATE users SET display_name=?, bio=? WHERE id=?").run(displayName, bio, req.user.id);
  res.json(userPublic(db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id)));
});

app.post("/api/profile/avatar", auth, upload.single("avatar"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Choose an image first" });
  if (!String(req.file.mimetype || "").startsWith("image/")) {
    removeUploaded(req.file);
    return res.status(400).json({ error: "Profile photo must be an image" });
  }
  const url = `/uploads/${req.file.filename}`;
  db.prepare("UPDATE users SET avatar=? WHERE id=?").run(url, req.user.id);
  res.json({ avatar: url });
});

function buildProfile(userId, viewerId) {
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(userId);
  if (!user) return null;
  const posts = db.prepare(`
    SELECT p.*, u.username, u.display_name, u.avatar,
      (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id=p.id) AS like_count,
      (SELECT COUNT(*) FROM post_comments pc WHERE pc.post_id=p.id) AS comment_count,
      EXISTS(SELECT 1 FROM post_likes mine WHERE mine.post_id=p.id AND mine.user_id=?) AS liked_by_me
    FROM posts p JOIN users u ON u.id=p.user_id
    WHERE p.user_id=? ORDER BY p.id DESC LIMIT 60
  `).all(viewerId, userId);
  const friendCount = db.prepare(`
    SELECT COUNT(*) AS c FROM friend_requests
    WHERE status='accepted' AND (sender_id=? OR receiver_id=?)
  `).get(userId, userId).c;
  const storyCount = db.prepare("SELECT COUNT(*) AS c FROM stories WHERE user_id=?").get(userId).c;
  return { user: { ...userPublic(user), online: isOnline(userId) }, stats: { posts: posts.length, friends: friendCount, stories: storyCount }, posts };
}

app.get("/api/profile", auth, (req, res) => res.json(buildProfile(req.user.id, req.user.id)));
app.get("/api/profile/:id", auth, (req, res) => {
  const profile = buildProfile(Number(req.params.id), req.user.id);
  if (!profile) return res.status(404).json({ error: "User not found" });
  res.json(profile);
});

// ------------------------- People, requests, block & hide -------------------------
app.get("/api/users", auth, (req, res) => {
  const rows = db.prepare("SELECT id,username,display_name,bio,avatar,last_seen FROM users WHERE id<>? ORDER BY username")
    .all(req.user.id);
  const result = rows.map((user) => {
    const request = getFriendRequestBetween(req.user.id, user.id);
    let friendStatus = "none";
    let requestId = null;
    if (request) {
      requestId = request.id;
      if (request.status === "accepted") friendStatus = "friend";
      else if (request.status === "pending") {
        friendStatus = request.sender_id === req.user.id ? "pending_sent" : "pending_received";
      } else requestId = null;
    }
    const blocked = Boolean(db.prepare("SELECT 1 FROM blocks WHERE blocker_id=? AND blocked_id=?")
      .get(req.user.id, user.id));
    const hidden = Boolean(db.prepare("SELECT 1 FROM hidden_chats WHERE user_id=? AND other_user_id=?")
      .get(req.user.id, user.id));
    const lastMessage = db.prepare(`
      SELECT text,file_name,created_at,sender_id FROM messages
      WHERE deleted=0 AND ((sender_id=? AND receiver_id=?) OR (sender_id=? AND receiver_id=?))
      ORDER BY id DESC LIMIT 1
    `).get(req.user.id, user.id, user.id, req.user.id);
    const unreadCount = db.prepare(`
      SELECT COUNT(*) AS c FROM messages
      WHERE deleted=0 AND sender_id=? AND receiver_id=? AND seen_at IS NULL
    `).get(user.id, req.user.id).c;
    return {
      ...user,
      display_name: user.display_name || user.username,
      friendStatus,
      requestId,
      blocked,
      hidden,
      online: isOnline(user.id),
      unread_count: unreadCount,
      last_message: lastMessage || null
    };
  });
  res.json(result);
});

app.get("/api/friend-requests", auth, (req, res) => {
  const received = db.prepare(`
    SELECT fr.*, u.username, u.display_name, u.avatar, u.bio
    FROM friend_requests fr JOIN users u ON u.id=fr.sender_id
    WHERE fr.receiver_id=? AND fr.status='pending' ORDER BY fr.id DESC
  `).all(req.user.id);
  const sent = db.prepare(`
    SELECT fr.*, u.username, u.display_name, u.avatar, u.bio
    FROM friend_requests fr JOIN users u ON u.id=fr.receiver_id
    WHERE fr.sender_id=? AND fr.status='pending' ORDER BY fr.id DESC
  `).all(req.user.id);
  res.json({ received, sent });
});

app.post("/api/friend-requests", auth, (req, res) => {
  const receiverId = Number(req.body.receiver_id);
  if (!receiverId || receiverId === req.user.id) return res.status(400).json({ error: "Invalid user" });
  if (!db.prepare("SELECT id FROM users WHERE id=?").get(receiverId)) return res.status(404).json({ error: "User not found" });
  if (isBlocked(req.user.id, receiverId)) return res.status(403).json({ error: "A blocked account cannot receive this request" });
  const existing = getFriendRequestBetween(req.user.id, receiverId);
  if (existing) {
    if (existing.status === "accepted") return res.status(400).json({ error: "Already friends" });
    if (existing.status === "pending") return res.status(400).json({ error: "Request already pending" });
    db.prepare(`UPDATE friend_requests SET sender_id=?,receiver_id=?,status='pending',created_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(req.user.id, receiverId, existing.id);
  } else {
    db.prepare("INSERT INTO friend_requests(sender_id,receiver_id,status) VALUES(?,?,'pending')")
      .run(req.user.id, receiverId);
  }
  notifyPair(req.user.id, receiverId);
  res.json({ success: true });
});

app.post("/api/friend-requests/:id/accept", auth, (req, res) => {
  const request = db.prepare("SELECT * FROM friend_requests WHERE id=?").get(Number(req.params.id));
  if (!request || request.receiver_id !== req.user.id || request.status !== "pending") {
    return res.status(404).json({ error: "Request not found" });
  }
  db.prepare("UPDATE friend_requests SET status='accepted' WHERE id=?").run(request.id);
  notifyPair(request.sender_id, request.receiver_id);
  res.json({ success: true });
});

app.post("/api/friend-requests/:id/decline", auth, (req, res) => {
  const request = db.prepare("SELECT * FROM friend_requests WHERE id=?").get(Number(req.params.id));
  if (!request || request.receiver_id !== req.user.id || request.status !== "pending") {
    return res.status(404).json({ error: "Request not found" });
  }
  db.prepare("UPDATE friend_requests SET status='declined' WHERE id=?").run(request.id);
  notifyPair(request.sender_id, request.receiver_id);
  res.json({ success: true });
});

app.delete("/api/friend-requests/:id", auth, (req, res) => {
  const request = db.prepare("SELECT * FROM friend_requests WHERE id=?").get(Number(req.params.id));
  if (!request || (request.sender_id !== req.user.id && request.receiver_id !== req.user.id)) {
    return res.status(404).json({ error: "Request not found" });
  }
  db.prepare("DELETE FROM friend_requests WHERE id=?").run(request.id);
  notifyPair(request.sender_id, request.receiver_id);
  res.json({ success: true });
});

app.post("/api/block", auth, (req, res) => {
  const blockedId = Number(req.body.user_id);
  if (!blockedId || blockedId === req.user.id) return res.status(400).json({ error: "Invalid user" });
  if (!db.prepare("SELECT id FROM users WHERE id=?").get(blockedId)) return res.status(404).json({ error: "User not found" });
  db.prepare("INSERT OR IGNORE INTO blocks(blocker_id,blocked_id) VALUES(?,?)").run(req.user.id, blockedId);
  const request = getFriendRequestBetween(req.user.id, blockedId);
  if (request) db.prepare("DELETE FROM friend_requests WHERE id=?").run(request.id);
  const me = db.prepare("SELECT username FROM users WHERE id=?").get(req.user.id);
  const info = db.prepare("INSERT INTO messages(sender_id,receiver_id,text,system) VALUES(?,?,?,1)")
    .run(req.user.id, blockedId, `${me.username} blocked this conversation.`);
  io.to(`user:${req.user.id}`).to(`user:${blockedId}`).emit("message", messageById(info.lastInsertRowid));
  notifyPair(req.user.id, blockedId);
  res.json({ success: true });
});

app.delete("/api/block/:userId", auth, (req, res) => {
  const info = db.prepare("DELETE FROM blocks WHERE blocker_id=? AND blocked_id=?")
    .run(req.user.id, Nu
