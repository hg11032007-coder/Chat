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

// Railway mounts this project's persistent volume at /app/uploads. Media stays
// at the volume root so all existing /uploads/<filename> URLs keep working.
// SQLite is stored in a hidden subfolder that is explicitly blocked from HTTP.
const volumeMount = String(process.env.RAILWAY_VOLUME_MOUNT_PATH || "").trim();
const uploadDir = volumeMount ? path.resolve(volumeMount) : path.join(__dirname, "uploads");
const databaseDir = volumeMount ? path.join(uploadDir, ".sandeep-data") : __dirname;
const databasePath = path.join(databaseDir, "chat.db");
fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(databaseDir, { recursive: true });

if (SECRET.startsWith("change-me")) {
  console.warn("WARNING: Set a strong JWT_SECRET in .env before deploying publicly.");
}

const db = new Database(databasePath);
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
app.use("/uploads", (req, res, next) => {
  // Never expose the hidden folder containing the SQLite database.
  if (req.path.split("/").some((part) => part.startsWith("."))) return res.status(404).end();
  next();
});
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

app.delete("/api/friends/:userId", auth, (req, res) => {
  const otherId = Number(req.params.userId);
  if (!otherId || otherId === req.user.id) return res.status(400).json({ error: "Invalid user" });
  const request = getFriendRequestBetween(req.user.id, otherId);
  if (!request || request.status !== "accepted") return res.status(404).json({ error: "Friendship not found" });
  db.transaction(() => {
    db.prepare("DELETE FROM friend_requests WHERE id=?").run(request.id);
    db.prepare(`DELETE FROM hidden_chats
      WHERE (user_id=? AND other_user_id=?) OR (user_id=? AND other_user_id=?)`)
      .run(req.user.id, otherId, otherId, req.user.id);
  })();
  notifyPair(req.user.id, otherId);
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
    .run(req.user.id, Number(req.params.userId));
  if (!info.changes) return res.status(404).json({ error: "Block not found" });
  notifyPair(req.user.id, Number(req.params.userId));
  res.json({ success: true });
});

app.post("/api/hidden-chats", auth, (req, res) => {
  const otherId = Number(req.body.user_id);
  if (!otherId || otherId === req.user.id) return res.status(400).json({ error: "Invalid user" });
  db.prepare("INSERT OR IGNORE INTO hidden_chats(user_id,other_user_id) VALUES(?,?)").run(req.user.id, otherId);
  res.json({ success: true });
});

app.delete("/api/hidden-chats/:userId", auth, (req, res) => {
  db.prepare("DELETE FROM hidden_chats WHERE user_id=? AND other_user_id=?")
    .run(req.user.id, Number(req.params.userId));
  res.json({ success: true });
});

// ------------------------- Home feed & posts -------------------------
app.get("/api/posts", auth, (req, res) => {
  const posts = db.prepare(`
    SELECT p.*, u.username, u.display_name, u.avatar,
      (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id=p.id) AS like_count,
      (SELECT COUNT(*) FROM post_comments pc WHERE pc.post_id=p.id) AS comment_count,
      EXISTS(SELECT 1 FROM post_likes mine WHERE mine.post_id=p.id AND mine.user_id=?) AS liked_by_me
    FROM posts p JOIN users u ON u.id=p.user_id
    WHERE p.user_id=? OR EXISTS(
      SELECT 1 FROM friend_requests fr WHERE fr.status='accepted' AND
      ((fr.sender_id=? AND fr.receiver_id=p.user_id) OR (fr.receiver_id=? AND fr.sender_id=p.user_id))
    )
    ORDER BY p.id DESC LIMIT 80
  `).all(req.user.id, req.user.id, req.user.id, req.user.id);
  res.json(posts);
});

app.post("/api/posts", auth, upload.single("media"), (req, res) => {
  const text = String(req.body.text || "").trim().slice(0, 2000);
  if (!text && !req.file) return res.status(400).json({ error: "Write something or choose a photo/video" });
  if (req.file && !/^(image|video)\//.test(req.file.mimetype || "")) {
    removeUploaded(req.file);
    return res.status(400).json({ error: "Posts support photos and videos" });
  }
  const mediaUrl = req.file ? `/uploads/${req.file.filename}` : "";
  const info = db.prepare("INSERT INTO posts(user_id,text,image_url,media_type) VALUES(?,?,?,?)")
    .run(req.user.id, text, mediaUrl, req.file ? req.file.mimetype : "");
  const post = postById(info.lastInsertRowid, req.user.id);
  io.emit("feed_update", { type: "post_created", user_id: req.user.id });
  res.json(post);
});

app.post("/api/posts/:id/like", auth, (req, res) => {
  const id = Number(req.params.id);
  const post = db.prepare("SELECT * FROM posts WHERE id=?").get(id);
  if (!post || !canSeeSocial(post.user_id, req.user.id)) return res.status(404).json({ error: "Post not found" });
  const exists = db.prepare("SELECT 1 FROM post_likes WHERE post_id=? AND user_id=?").get(id, req.user.id);
  if (exists) db.prepare("DELETE FROM post_likes WHERE post_id=? AND user_id=?").run(id, req.user.id);
  else db.prepare("INSERT INTO post_likes(post_id,user_id) VALUES(?,?)").run(id, req.user.id);
  const likeCount = db.prepare("SELECT COUNT(*) AS c FROM post_likes WHERE post_id=?").get(id).c;
  res.json({ liked: !exists, like_count: likeCount });
});

app.get("/api/posts/:id/comments", auth, (req, res) => {
  const post = db.prepare("SELECT * FROM posts WHERE id=?").get(Number(req.params.id));
  if (!post || !canSeeSocial(post.user_id, req.user.id)) return res.status(404).json({ error: "Post not found" });
  const rows = db.prepare(`
    SELECT c.*,u.username,u.display_name,u.avatar FROM post_comments c
    JOIN users u ON u.id=c.user_id WHERE c.post_id=? ORDER BY c.id
  `).all(post.id);
  res.json(rows);
});

app.post("/api/posts/:id/comments", auth, (req, res) => {
  const post = db.prepare("SELECT * FROM posts WHERE id=?").get(Number(req.params.id));
  if (!post || !canSeeSocial(post.user_id, req.user.id)) return res.status(404).json({ error: "Post not found" });
  const text = String(req.body.text || "").trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: "Comment cannot be empty" });
  const info = db.prepare("INSERT INTO post_comments(post_id,user_id,text) VALUES(?,?,?)")
    .run(post.id, req.user.id, text);
  const row = db.prepare(`
    SELECT c.*,u.username,u.display_name,u.avatar FROM post_comments c
    JOIN users u ON u.id=c.user_id WHERE c.id=?
  `).get(info.lastInsertRowid);
  res.json(row);
});

app.delete("/api/posts/:id", auth, (req, res) => {
  const post = db.prepare("SELECT * FROM posts WHERE id=?").get(Number(req.params.id));
  const me = db.prepare("SELECT is_admin FROM users WHERE id=?").get(req.user.id);
  if (!post) return res.status(404).json({ error: "Post not found" });
  if (post.user_id !== req.user.id && !me.is_admin) return res.status(403).json({ error: "Not allowed" });
  db.transaction(() => {
    db.prepare("DELETE FROM post_likes WHERE post_id=?").run(post.id);
    db.prepare("DELETE FROM post_comments WHERE post_id=?").run(post.id);
    db.prepare("DELETE FROM posts WHERE id=?").run(post.id);
  })();
  res.json({ success: true });
});

// ------------------------- 24-hour stories -------------------------
app.get("/api/stories", auth, (req, res) => {
  db.prepare("DELETE FROM stories WHERE expires_at<=CURRENT_TIMESTAMP").run();
  const stories = db.prepare(`
    SELECT s.*,u.username,u.display_name,u.avatar,
      EXISTS(SELECT 1 FROM story_views sv WHERE sv.story_id=s.id AND sv.user_id=?) AS viewed_by_me,
      (SELECT COUNT(*) FROM story_views sv2 WHERE sv2.story_id=s.id) AS view_count
    FROM stories s JOIN users u ON u.id=s.user_id
    WHERE s.expires_at>CURRENT_TIMESTAMP AND (
      s.user_id=? OR EXISTS(
        SELECT 1 FROM friend_requests fr WHERE fr.status='accepted' AND
        ((fr.sender_id=? AND fr.receiver_id=s.user_id) OR (fr.receiver_id=? AND fr.sender_id=s.user_id))
      )
    ) ORDER BY CASE WHEN s.user_id=? THEN 0 ELSE 1 END, s.id DESC
  `).all(req.user.id, req.user.id, req.user.id, req.user.id, req.user.id);
  res.json(stories);
});

app.post("/api/stories", auth, upload.single("media"), (req, res) => {
  const caption = String(req.body.caption || "").trim().slice(0, 500);
  const backgrounds = new Set(["aurora", "sunset", "ocean", "berry", "midnight"]);
  const background = backgrounds.has(req.body.background) ? req.body.background : "aurora";
  if (!caption && !req.file) return res.status(400).json({ error: "Add text, a photo, or a video" });
  if (req.file && !/^(image|video)\//.test(req.file.mimetype || "")) {
    removeUploaded(req.file);
    return res.status(400).json({ error: "Stories support photos and videos" });
  }
  const mediaUrl = req.file ? `/uploads/${req.file.filename}` : "";
  const info = db.prepare(`
    INSERT INTO stories(user_id,media_url,media_type,caption,background,expires_at)
    VALUES(?,?,?,?,?,datetime('now','+24 hours'))
  `).run(req.user.id, mediaUrl, req.file ? req.file.mimetype : "", caption, background);
  const story = db.prepare(`
    SELECT s.*,u.username,u.display_name,u.avatar,0 AS viewed_by_me,0 AS view_count
    FROM stories s JOIN users u ON u.id=s.user_id WHERE s.id=?
  `).get(info.lastInsertRowid);
  io.emit("story_update", { user_id: req.user.id });
  res.json(story);
});

app.post("/api/stories/:id/view", auth, (req, res) => {
  const story = db.prepare("SELECT * FROM stories WHERE id=? AND expires_at>CURRENT_TIMESTAMP")
    .get(Number(req.params.id));
  if (!story || !canSeeSocial(story.user_id, req.user.id)) return res.status(404).json({ error: "Story not found" });
  if (story.user_id !== req.user.id) {
    db.prepare("INSERT OR IGNORE INTO story_views(story_id,user_id) VALUES(?,?)").run(story.id, req.user.id);
  }
  res.json({ success: true });
});

app.delete("/api/stories/:id", auth, (req, res) => {
  const story = db.prepare("SELECT * FROM stories WHERE id=?").get(Number(req.params.id));
  if (!story || story.user_id !== req.user.id) return res.status(404).json({ error: "Story not found" });
  db.prepare("DELETE FROM story_views WHERE story_id=?").run(story.id);
  db.prepare("DELETE FROM stories WHERE id=?").run(story.id);
  res.json({ success: true });
});

// ------------------------- Direct chat -------------------------
function markConversationRead(readerId, senderId) {
  const info = db.prepare(`
    UPDATE messages SET delivered_at=COALESCE(delivered_at,CURRENT_TIMESTAMP),seen_at=CURRENT_TIMESTAMP
    WHERE sender_id=? AND receiver_id=? AND deleted=0 AND seen_at IS NULL
  `).run(senderId, readerId);
  if (info.changes) io.to(`user:${senderId}`).emit("messages_seen", { by: readerId });
  return info.changes;
}

app.get("/api/messages/:id", auth, (req, res) => {
  const otherId = Number(req.params.id);
  if (!areFriends(req.user.id, otherId)) return res.status(403).json({ error: "You must be friends to view this chat" });
  markConversationRead(req.user.id, otherId);
  const messages = db.prepare(`
    SELECT m.*, sender.username AS sender_name,
           replied.text AS reply_text, replied.file_name AS reply_file_name,
           reply_sender.username AS reply_sender_name
    FROM messages m
    JOIN users sender ON sender.id=m.sender_id
    LEFT JOIN messages replied ON replied.id=m.reply_to
    LEFT JOIN users reply_sender ON reply_sender.id=replied.sender_id
    WHERE ((m.sender_id=? AND m.receiver_id=?) OR (m.sender_id=? AND m.receiver_id=?))
      AND m.deleted=0 ORDER BY m.id
  `).all(req.user.id, otherId, otherId, req.user.id);
  res.json(messages);
});

app.post("/api/messages/read/:userId", auth, (req, res) => {
  const senderId = Number(req.params.userId);
  res.json({ changed: markConversationRead(req.user.id, senderId) });
});

app.post("/api/upload", auth, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Choose a file first" });
  const receiverId = Number(req.body.receiver_id);
  if (!areFriends(req.user.id, receiverId)) {
    removeUploaded(req.file);
    return res.status(403).json({ error: "You must be friends to send files" });
  }
  const replyTo = Number(req.body.reply_to) || null;
  if (replyTo) {
    const replied = db.prepare("SELECT * FROM messages WHERE id=? AND deleted=0").get(replyTo);
    if (!replied || ![replied.sender_id, replied.receiver_id].includes(req.user.id) || ![replied.sender_id, replied.receiver_id].includes(receiverId)) {
      removeUploaded(req.file);
      return res.status(400).json({ error: "Reply target is unavailable" });
    }
  }
  db.prepare("DELETE FROM hidden_chats WHERE user_id=? AND other_user_id=?").run(receiverId, req.user.id);
  const deliveredAt = isOnline(receiverId) ? new Date().toISOString() : null;
  const info = db.prepare(`
    INSERT INTO messages(sender_id,receiver_id,file_url,file_name,file_type,reply_to,delivered_at)
    VALUES(?,?,?,?,?,?,?)
  `).run(req.user.id, receiverId, `/uploads/${req.file.filename}`, path.basename(req.file.originalname), req.file.mimetype || "application/octet-stream", replyTo, deliveredAt);
  const message = messageById(info.lastInsertRowid);
  io.to(`user:${receiverId}`).emit("message", message);
  res.json(message);
});

app.patch("/api/messages/:id", auth, (req, res) => {
  const id = Number(req.params.id);
  const message = db.prepare("SELECT * FROM messages WHERE id=? AND deleted=0").get(id);
  if (!message) return res.status(404).json({ error: "Message not found" });
  if (message.sender_id !== req.user.id) return res.status(403).json({ error: "You can edit only your messages" });
  if (!message.text) return res.status(400).json({ error: "This message has no editable text" });
  const text = String(req.body.text || "").trim().slice(0, 5000);
  if (!text) return res.status(400).json({ error: "Message cannot be empty" });
  db.prepare("UPDATE messages SET text=?,edited_at=CURRENT_TIMESTAMP WHERE id=?").run(text, id);
  const updated = messageById(id);
  io.to(`user:${message.sender_id}`).to(`user:${message.receiver_id}`).emit("message_edited", updated);
  res.json(updated);
});

app.delete("/api/messages/:id", auth, (req, res) => {
  const id = Number(req.params.id);
  const message = db.prepare("SELECT * FROM messages WHERE id=? AND deleted=0").get(id);
  if (!message) return res.status(404).json({ error: "Message not found" });
  if (message.sender_id !== req.user.id) return res.status(403).json({ error: "You can delete only your messages" });
  db.prepare("UPDATE messages SET deleted=1,deleted_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
  io.to(`user:${message.sender_id}`).to(`user:${message.receiver_id}`).emit("message_deleted", { id });
  res.json({ success: true });
});

// ------------------------- Nova AI -------------------------
app.get("/api/ai/history", auth, (req, res) => {
  res.json(db.prepare("SELECT * FROM ai_messages WHERE user_id=? ORDER BY id").all(req.user.id));
});

app.post("/api/ai", auth, async (req, res) => {
  const text = String(req.body.text || "").trim().slice(0, 8000);
  if (!text) return res.status(400).json({ error: "Message required" });
  const userInfo = db.prepare("INSERT INTO ai_messages(user_id,role,text) VALUES(?,?,?)")
    .run(req.user.id, "user", text);
  if (!process.env.OPENAI_API_KEY) {
    const reply = "AI is not connected yet. Add OPENAI_API_KEY in .env, restart the server, and try again.";
    const aiInfo = db.prepare("INSERT INTO ai_messages(user_id,role,text) VALUES(?,?,?)")
      .run(req.user.id, "ai", reply);
    return res.json({ reply, userMessageId: userInfo.lastInsertRowid, aiMessageId: aiInfo.lastInsertRowid });
  }
  try {
    const user = db.prepare("SELECT username,display_name FROM users WHERE id=?").get(req.user.id);
    const history = db.prepare("SELECT role,text FROM ai_messages WHERE user_id=? ORDER BY id DESC LIMIT 14")
      .all(req.user.id).reverse().map((m) => ({ role: m.role === "ai" ? "assistant" : "user", content: m.text }));
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "openrouter/free",
        messages: [
          {
            role: "system",
            content: `Your name is Nova, the AI assistant inside Sandeep Chat. Help clearly and safely. Match the user's language (English, Hindi, or Hinglish). The user's name is ${user.display_name || user.username}.`
          },
          ...history
        ]
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || "AI service error");
    const reply = data.choices?.[0]?.message?.content || "Sorry, I could not generate a reply.";
    const aiInfo = db.prepare("INSERT INTO ai_messages(user_id,role,text) VALUES(?,?,?)")
      .run(req.user.id, "ai", reply);
    res.json({ reply, userMessageId: userInfo.lastInsertRowid, aiMessageId: aiInfo.lastInsertRowid });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/ai/:id", auth, (req, res) => {
  const message = db.prepare("SELECT * FROM ai_messages WHERE id=? AND user_id=?")
    .get(Number(req.params.id), req.user.id);
  if (!message) return res.status(404).json({ error: "Message not found" });
  db.prepare("DELETE FROM ai_messages WHERE id=?").run(message.id);
  res.json({ success: true });
});

// ------------------------- Admin -------------------------
app.get("/api/admin/stats", auth, adminOnly, (_req, res) => {
  res.json({
    totalUsers: db.prepare("SELECT COUNT(*) AS c FROM users").get().c,
    onlineUsers: onlineCounts.size,
    totalMessages: db.prepare("SELECT COUNT(*) AS c FROM messages WHERE deleted=0").get().c,
    deletedMessages: db.prepare("SELECT COUNT(*) AS c FROM messages WHERE deleted=1").get().c,
    totalPosts: db.prepare("SELECT COUNT(*) AS c FROM posts").get().c,
    activeStories: db.prepare("SELECT COUNT(*) AS c FROM stories WHERE expires_at>CURRENT_TIMESTAMP").get().c
  });
});

app.get("/api/admin/users", auth, adminOnly, (_req, res) => {
  const users = db.prepare("SELECT id,username,display_name,avatar,is_admin,created_at,last_seen FROM users ORDER BY id").all();
  res.json(users.map((user) => ({
    ...user,
    online: isOnline(user.id),
    // An online account is active now; last_seen is meaningful only after disconnect.
    last_seen: isOnline(user.id) ? null : user.last_seen
  })));
});

app.post("/api/admin/users/:id/reset-password", auth, adminOnly, async (req, res) => {
  const password = String(req.body.password || "");
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
  const hash = await bcrypt.hash(password, 11);
  const info = db.prepare("UPDATE users SET password=? WHERE id=?").run(hash, Number(req.params.id));
  if (!info.changes) return res.status(404).json({ error: "User not found" });
  res.json({ success: true });
});

app.delete("/api/admin/users/:id", auth, adminOnly, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: "You cannot delete your own account" });
  const info = db.transaction(() => {
    const postIds = db.prepare("SELECT id FROM posts WHERE user_id=?").all(id).map((p) => p.id);
    for (const postId of postIds) {
      db.prepare("DELETE FROM post_likes WHERE post_id=?").run(postId);
      db.prepare("DELETE FROM post_comments WHERE post_id=?").run(postId);
    }
    db.prepare("DELETE FROM post_likes WHERE user_id=?").run(id);
    db.prepare("DELETE FROM post_comments WHERE user_id=?").run(id);
    db.prepare("DELETE FROM posts WHERE user_id=?").run(id);
    const storyIds = db.prepare("SELECT id FROM stories WHERE user_id=?").all(id).map((s) => s.id);
    for (const storyId of storyIds) db.prepare("DELETE FROM story_views WHERE story_id=?").run(storyId);
    db.prepare("DELETE FROM story_views WHERE user_id=?").run(id);
    db.prepare("DELETE FROM stories WHERE user_id=?").run(id);
    db.prepare("DELETE FROM messages WHERE sender_id=? OR receiver_id=?").run(id, id);
    db.prepare("DELETE FROM ai_messages WHERE user_id=?").run(id);
    db.prepare("DELETE FROM friend_requests WHERE sender_id=? OR receiver_id=?").run(id, id);
    db.prepare("DELETE FROM blocks WHERE blocker_id=? OR blocked_id=?").run(id, id);
    db.prepare("DELETE FROM hidden_chats WHERE user_id=? OR other_user_id=?").run(id, id);
    return db.prepare("DELETE FROM users WHERE id=?").run(id);
  })();
  if (!info.changes) return res.status(404).json({ error: "User not found" });
  res.json({ success: true });
});

app.get("/api/admin/messages", auth, adminOnly, (req, res) => {
  const requestedLimit = Number(req.query.limit) || 200;
  const limit = Math.min(500, Math.max(1, requestedLimit));
  const rows = db.prepare(`
    SELECT m.*,su.username AS sender_name,ru.username AS receiver_name
    FROM messages m
    JOIN users su ON su.id=m.sender_id
    JOIN users ru ON ru.id=m.receiver_id
    WHERE m.deleted=0
    ORDER BY m.id DESC
    LIMIT ?
  `).all(limit);
  res.json(rows);
});

app.get("/api/admin/deleted-messages", auth, adminOnly, (_req, res) => {
  const rows = db.prepare(`
    SELECT m.*,su.username AS sender_name,ru.username AS receiver_name
    FROM messages m JOIN users su ON su.id=m.sender_id JOIN users ru ON ru.id=m.receiver_id
    WHERE m.deleted=1 ORDER BY m.deleted_at DESC
  `).all();
  res.json(rows);
});

app.post("/api/admin/messages/:id/restore", auth, adminOnly, (req, res) => {
  const info = db.prepare("UPDATE messages SET deleted=0,deleted_at=NULL WHERE id=?").run(Number(req.params.id));
  if (!info.changes) return res.status(404).json({ error: "Message not found" });
  res.json({ success: true });
});

app.delete("/api/admin/messages/:id/purge", auth, adminOnly, (req, res) => {
  const info = db.prepare("DELETE FROM messages WHERE id=?").run(Number(req.params.id));
  if (!info.changes) return res.status(404).json({ error: "Message not found" });
  res.json({ success: true });
});

// ------------------------- Real-time socket events -------------------------
io.use((socket, next) => {
  try {
    socket.user = jwt.verify(socket.handshake.auth.token, SECRET);
    if (!db.prepare("SELECT id FROM users WHERE id=?").get(socket.user.id)) throw new Error("Account missing");
    next();
  } catch (_error) {
    next(new Error("Unauthorized"));
  }
});

io.on("connection", (socket) => {
  const userId = Number(socket.user.id);
  socket.join(`user:${userId}`);
  const wasOffline = !isOnline(userId);
  onlineCounts.set(userId, (onlineCounts.get(userId) || 0) + 1);
  db.prepare("UPDATE users SET last_seen=NULL WHERE id=?").run(userId);

  const pendingSenders = db.prepare(`
    SELECT DISTINCT sender_id FROM messages
    WHERE receiver_id=? AND delivered_at IS NULL AND deleted=0
  `).all(userId);
  db.prepare(`
    UPDATE messages SET delivered_at=CURRENT_TIMESTAMP
    WHERE receiver_id=? AND delivered_at IS NULL AND deleted=0
  `).run(userId);
  pendingSenders.forEach((row) => io.to(`user:${row.sender_id}`).emit("messages_delivered", { to: userId }));
  if (wasOffline) io.emit("presence", { user_id: userId, online: true, last_seen: null });

  socket.on("send_message", (data = {}) => {
    const receiverId = Number(data.receiver_id);
    const text = String(data.text || "").trim().slice(0, 5000);
    if (!receiverId || !text) return;
    if (!areFriends(userId, receiverId)) {
      socket.emit("message_error", { error: "You are not friends with this user yet" });
      return;
    }
    let replyTo = Number(data.reply_to) || null;
    if (replyTo) {
      const replied = db.prepare("SELECT * FROM messages WHERE id=? AND deleted=0").get(replyTo);
      const pair = replied && [replied.sender_id, replied.receiver_id];
      if (!pair || !pair.includes(userId) || !pair.includes(receiverId)) replyTo = null;
    }
    db.prepare("DELETE FROM hidden_chats WHERE user_id=? AND other_user_id=?").run(receiverId, userId);
    const deliveredAt = isOnline(receiverId) ? new Date().toISOString() : null;
    const info = db.prepare(`
      INSERT INTO messages(sender_id,receiver_id,text,reply_to,delivered_at) VALUES(?,?,?,?,?)
    `).run(userId, receiverId, text, replyTo, deliveredAt);
    const message = messageById(info.lastInsertRowid);
    io.to(`user:${userId}`).to(`user:${receiverId}`).emit("message", message);
  });

  socket.on("typing", (data = {}) => {
    const receiverId = Number(data.receiver_id);
    if (receiverId && areFriends(userId, receiverId)) {
      io.to(`user:${receiverId}`).emit("typing", { user_id: userId, typing: Boolean(data.typing) });
    }
  });

  socket.on("disconnect", () => {
    const nextCount = (onlineCounts.get(userId) || 1) - 1;
    if (nextCount <= 0) {
      onlineCounts.delete(userId);
      db.prepare("UPDATE users SET last_seen=CURRENT_TIMESTAMP WHERE id=?").run(userId);
      const lastSeen = db.prepare("SELECT last_seen FROM users WHERE id=?").get(userId)?.last_seen || null;
      io.emit("presence", { user_id: userId, online: false, last_seen: lastSeen });
    } else onlineCounts.set(userId, nextCount);
  });
});

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    return res.status(400).json({ error: error.code === "LIMIT_FILE_SIZE" ? "File is larger than 25 MB" : error.message });
  }
  // A database record can still reference an old upload that disappeared before
  // the persistent volume was attached. Return a quiet 404 instead of flooding logs.
  if (error?.code === "ENOENT" && String(req.originalUrl || "").startsWith("/uploads/")) {
    return res.status(404).end();
  }
  next(error);
});

app.get("/admin", (_req, res) => res.sendFile(path.join(__dirname, "Public", "admin.html")));
app.get("/*splat", (_req, res) => res.sendFile(path.join(__dirname, "Public", "index.html")));

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Sandeep Chat running on port ${PORT}`);
  console.log(`Uploads: ${uploadDir}`);
  console.log(`Database: ${databasePath}`);
});
