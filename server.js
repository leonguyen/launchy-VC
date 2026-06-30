const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const RSSParser = require('rss-parser');
const path = require('path');
const fs = require('fs');

const app = express();
const rssParser = new RSSParser({
  customFields: {
    item: [
      ['media:content', 'mediaContent', { keepArray: true }],
      ['media:thumbnail', 'mediaThumbnail', { keepArray: true }],
      ['media:group', 'mediaGroup'],
    ]
  }
});
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

const VALID_WIDGET_TYPES = ['bookmarks', 'rss', 'notes', 'weather', 'clock', 'search', 'embed', 'ai'];

app.use(express.json({ limit: '5mb' }));
app.get('/launchy-extension.xpi', (req, res) => {
  const xpiPath = path.join(__dirname, 'public', 'launchy-extension.xpi');
  if (!fs.existsSync(xpiPath)) return res.status(404).send('Extension not found');
  res.setHeader('Content-Type', 'application/x-xpinstall');
  fs.createReadStream(xpiPath).pipe(res);
});
app.get('/launchy-extension-chromium.zip', (req, res) => {
  const zipPath = path.join(__dirname, 'public', 'launchy-extension-chromium.zip');
  if (!fs.existsSync(zipPath)) return res.status(404).send('Extension not found');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="launchy-extension-chromium.zip"');
  fs.createReadStream(zipPath).pipe(res);
});
app.use(express.static(path.join(__dirname, 'public')));

// ─── Database setup ───────────────────────────────────────────────
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const oldDbPath = path.join(dataDir, 'startme.db');
const newDbPath = path.join(dataDir, 'launchy.db');
if (fs.existsSync(oldDbPath) && !fs.existsSync(newDbPath)) {
  fs.renameSync(oldDbPath, newDbPath);
  for (const ext of ['-wal', '-shm']) {
    const oldF = oldDbPath + ext, newF = newDbPath + ext;
    if (fs.existsSync(oldF)) fs.renameSync(oldF, newF);
  }
}

const db = new Database(path.join(dataDir, 'launchy.db'));
try { db.pragma('journal_mode = WAL'); } catch { /* fallback */ }
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    theme TEXT DEFAULT 'dark',
    background_url TEXT DEFAULT '',
    background_overlay REAL DEFAULT 0.85,
    accent_color TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    is_public INTEGER DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS columns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    width INTEGER DEFAULT 1,
    FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS widgets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    column_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    config TEXT DEFAULT '{}',
    FOREIGN KEY (column_id) REFERENCES columns(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS bookmarks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    widget_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    icon TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    FOREIGN KEY (widget_id) REFERENCES widgets(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS page_shares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id INTEGER NOT NULL,
    shared_with_user_id INTEGER NOT NULL,
    FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE,
    FOREIGN KEY (shared_with_user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(page_id, shared_with_user_id)
  );
`);

// ─── Migrations for existing databases ───────────────────────────
function safeAddColumn(table, column, definition) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`); } catch {}
}
safeAddColumn('users', 'background_url', "TEXT DEFAULT ''");
safeAddColumn('users', 'background_overlay', "REAL DEFAULT 0.85");
safeAddColumn('users', 'accent_color', "TEXT DEFAULT ''");
safeAddColumn('pages', 'is_public', "INTEGER DEFAULT 0");
safeAddColumn('widgets', 'height', "INTEGER DEFAULT 0");
safeAddColumn('users', 'link_target', "TEXT DEFAULT '_blank'");
safeAddColumn('users', 'language', "TEXT DEFAULT 'fr'");

db.exec(`CREATE TABLE IF NOT EXISTS ai_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  widget_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (widget_id) REFERENCES widgets(id) ON DELETE CASCADE
)`);

// Migrate widgets table if it has a CHECK constraint blocking new types
const widgetSchema = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'widgets' AND type = 'table'").get();
if (widgetSchema && widgetSchema.sql && widgetSchema.sql.includes('CHECK')) {
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE widgets_migrated (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      column_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      config TEXT DEFAULT '{}',
      FOREIGN KEY (column_id) REFERENCES columns(id) ON DELETE CASCADE
    );
    INSERT INTO widgets_migrated SELECT * FROM widgets;
    DROP TABLE widgets;
    ALTER TABLE widgets_migrated RENAME TO widgets;
  `);
  db.pragma('foreign_keys = ON');
}

// Create default admin user if none exists
const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
if (userCount.count === 0) {
  const hash = bcrypt.hashSync('admin', 10);
  const result = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run('admin', hash);
  const userId = result.lastInsertRowid;
  const pageResult = db.prepare('INSERT INTO pages (user_id, title, sort_order) VALUES (?, ?, ?)').run(userId, st('fr', 'default.page.home'), 0);
  const pageId = pageResult.lastInsertRowid;
  const colResult = db.prepare('INSERT INTO columns (page_id, title, sort_order) VALUES (?, ?, ?)').run(pageId, st('fr', 'default.column.favorites'), 0);
  db.prepare('INSERT INTO widgets (column_id, type, title, sort_order) VALUES (?, ?, ?, ?)').run(colResult.lastInsertRowid, 'bookmarks', st('fr', 'default.widget.favorites'), 0);
}

// ─── AI message retention cleanup ───────────────────────────────
function cleanupAIMessages() {
  const widgets = db.prepare("SELECT id, config FROM widgets WHERE type = 'ai'").all();
  for (const w of widgets) {
    const cfg = JSON.parse(w.config || '{}');
    const days = cfg.retentionDays || 30;
    db.prepare("DELETE FROM ai_messages WHERE widget_id = ? AND created_at < datetime('now', '-' || ? || ' days')").run(w.id, days);
  }
}
cleanupAIMessages();
setInterval(cleanupAIMessages, 3600000);

// ─── Server-side translations ──────────────────────────────────
const _serverTranslations = {};
function loadServerTranslations() {
  for (const lang of ['fr', 'en']) {
    const filePath = path.join(__dirname, 'public', 'lang', lang + '.json');
    if (fs.existsSync(filePath)) {
      _serverTranslations[lang] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  }
}
loadServerTranslations();

function st(lang, key) {
  return _serverTranslations[lang]?.[key] || _serverTranslations['fr']?.[key] || key;
}

// ─── Auth middleware ──────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'error.notAuthenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'error.invalidToken' });
  }
}

// ─── Auth routes ──────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'error.invalidCredentials' });
  }
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, username: user.username, theme: user.theme, background_url: user.background_url, background_overlay: user.background_overlay, accent_color: user.accent_color, link_target: user.link_target || '_blank', language: user.language || 'fr' } });
});

app.post('/api/auth/register', (req, res) => {
  const { username, password, language } = req.body;
  const lang = ['fr', 'en'].includes(language) ? language : 'fr';
  if (!username || !password) return res.status(400).json({ error: 'error.fieldsRequired' });
  if (password.length < 4) return res.status(400).json({ error: 'error.passwordTooShort' });
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return res.status(409).json({ error: 'error.userExists' });

  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare('INSERT INTO users (username, password, language) VALUES (?, ?, ?)').run(username, hash, lang);
  const userId = result.lastInsertRowid;

  const pageResult = db.prepare('INSERT INTO pages (user_id, title, sort_order) VALUES (?, ?, ?)').run(userId, st(lang, 'default.page.home'), 0);
  const pageId = pageResult.lastInsertRowid;

  const insertCol = db.prepare('INSERT INTO columns (page_id, title, sort_order) VALUES (?, ?, ?)');
  const insertWidget = db.prepare('INSERT INTO widgets (column_id, type, title, sort_order, config) VALUES (?, ?, ?, ?, ?)');
  const insertBookmark = db.prepare('INSERT INTO bookmarks (widget_id, title, url, icon, sort_order) VALUES (?, ?, ?, ?, ?)');

  // Colonne 1 — Actualités (RSS)
  const col1 = insertCol.run(pageId, st(lang, 'default.column.news'), 0).lastInsertRowid;
  insertWidget.run(col1, 'rss', st(lang, 'default.widget.news'), 0, JSON.stringify({
    feeds: [
      { url: 'https://www.francetvinfo.fr/titres.rss', title: 'France Info' },
      { url: 'https://www.lemonde.fr/rss/une.xml', title: 'Le Monde' }
    ],
    articleCount: 10, showSummaries: 'first', showImages: 'large', truncateTitles: true, showTimestamps: true
  }));

  // Colonne 2 — Sites populaires
  const col2 = insertCol.run(pageId, st(lang, 'default.column.popular'), 1).lastInsertRowid;
  const w2 = insertWidget.run(col2, 'bookmarks', st(lang, 'default.widget.popular'), 0, '{}').lastInsertRowid;
  const popularSites = [
    ['Google', 'https://www.google.com', ''],
    ['YouTube', 'https://www.youtube.com', ''],
    ['Gmail', 'https://mail.google.com', ''],
    ['Wikipedia', 'https://fr.wikipedia.org', ''],
    ['Amazon', 'https://www.amazon.fr', ''],
    ['Netflix', 'https://www.netflix.com', ''],
    ['Leboncoin', 'https://www.leboncoin.fr', ''],
    ['Cdiscount', 'https://www.cdiscount.com', ''],
    ['Pages Jaunes', 'https://www.pagesjaunes.fr', ''],
    ['Marmiton', 'https://www.marmiton.org', ''],
  ];
  popularSites.forEach(([title, url, icon], i) => insertBookmark.run(w2, title, url, icon, i));

  // Colonne 3 — Réseaux sociaux
  const col3 = insertCol.run(pageId, st(lang, 'default.column.social'), 2).lastInsertRowid;
  const w3 = insertWidget.run(col3, 'bookmarks', st(lang, 'default.widget.social'), 0, '{}').lastInsertRowid;
  const socialSites = [
    ['Facebook', 'https://www.facebook.com', ''],
    ['X (Twitter)', 'https://x.com', ''],
    ['Instagram', 'https://www.instagram.com', ''],
    ['LinkedIn', 'https://www.linkedin.com', ''],
    ['Reddit', 'https://www.reddit.com', ''],
    ['TikTok', 'https://www.tiktok.com', ''],
    ['Snapchat', 'https://www.snapchat.com', ''],
    ['Pinterest', 'https://www.pinterest.fr', ''],
    ['Twitch', 'https://www.twitch.tv', ''],
    ['Discord', 'https://discord.com', ''],
  ];
  socialSites.forEach(([title, url, icon], i) => insertBookmark.run(w3, title, url, icon, i));

  // Colonne 4 — Outils
  const col4 = insertCol.run(pageId, st(lang, 'default.column.tools'), 3).lastInsertRowid;
  const w4 = insertWidget.run(col4, 'bookmarks', st(lang, 'default.widget.tools'), 0, '{}').lastInsertRowid;
  const toolSites = [
    ['Google Maps', 'https://maps.google.com', ''],
    ['Google Drive', 'https://drive.google.com', ''],
    ['Google Translate', 'https://translate.google.com', ''],
    ['DeepL', 'https://www.deepl.com/translator', ''],
    ['ChatGPT', 'https://chat.openai.com', ''],
    ['Claude', 'https://claude.ai', ''],
    ['Météo France', 'https://meteofrance.com', ''],
    ['Canva', 'https://www.canva.com', ''],
    ['Notion', 'https://www.notion.so', ''],
    ['GitHub', 'https://github.com', ''],
  ];
  toolSites.forEach(([title, url, icon], i) => insertBookmark.run(w4, title, url, icon, i));

  const token = jwt.sign({ id: userId, username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: userId, username, theme: 'dark', background_url: '', background_overlay: 0.85, accent_color: '', link_target: '_blank', language: lang } });
});

app.get('/api/auth/me', auth, (req, res) => {
  const user = db.prepare('SELECT id, username, theme, background_url, background_overlay, accent_color, link_target, language FROM users WHERE id = ?').get(req.user.id);
  res.json({ ...user, link_target: user.link_target || '_blank', language: user.language || 'fr' });
});

app.put('/api/auth/theme', auth, (req, res) => {
  const { theme } = req.body;
  db.prepare('UPDATE users SET theme = ? WHERE id = ?').run(theme, req.user.id);
  res.json({ theme });
});

app.put('/api/auth/password', auth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(currentPassword, user.password)) {
    return res.status(401).json({ error: 'error.wrongCurrentPassword' });
  }
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, req.user.id);
  res.json({ ok: true });
});

app.put('/api/auth/language', auth, (req, res) => {
  const { language } = req.body;
  if (!language || !['fr', 'en'].includes(language)) return res.status(400).json({ error: 'error.fieldsRequired' });
  db.prepare('UPDATE users SET language = ? WHERE id = ?').run(language, req.user.id);
  res.json({ language });
});

app.put('/api/auth/customization', auth, (req, res) => {
  const { background_url, background_overlay, accent_color, link_target } = req.body;
  if (background_url !== undefined) db.prepare('UPDATE users SET background_url = ? WHERE id = ?').run(background_url, req.user.id);
  if (background_overlay !== undefined) db.prepare('UPDATE users SET background_overlay = ? WHERE id = ?').run(background_overlay, req.user.id);
  if (accent_color !== undefined) db.prepare('UPDATE users SET accent_color = ? WHERE id = ?').run(accent_color, req.user.id);
  if (link_target !== undefined) db.prepare('UPDATE users SET link_target = ? WHERE id = ?').run(link_target, req.user.id);
  const user = db.prepare('SELECT id, username, theme, background_url, background_overlay, accent_color, link_target FROM users WHERE id = ?').get(req.user.id);
  res.json({ ...user, link_target: user.link_target || '_blank' });
});

// ─── Pages routes ─────────────────────────────────────────────────
app.put('/api/pages/reorder', auth, (req, res) => {
  const { order } = req.body;
  const stmt = db.prepare('UPDATE pages SET sort_order = ? WHERE id = ? AND user_id = ?');
  db.transaction(() => { order.forEach((id, idx) => stmt.run(idx, id, req.user.id)); })();
  res.json({ ok: true });
});

app.get('/api/pages', auth, (req, res) => {
  const pages = db.prepare('SELECT * FROM pages WHERE user_id = ? ORDER BY sort_order').all(req.user.id);
  res.json(pages);
});

app.post('/api/pages', auth, (req, res) => {
  const { title } = req.body;
  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM pages WHERE user_id = ?').get(req.user.id);
  const result = db.prepare('INSERT INTO pages (user_id, title, sort_order) VALUES (?, ?, ?)').run(req.user.id, title, (maxOrder.m || 0) + 1);
  const page = db.prepare('SELECT * FROM pages WHERE id = ?').get(result.lastInsertRowid);
  res.json(page);
});

app.put('/api/pages/:id', auth, (req, res) => {
  const { title } = req.body;
  const page = db.prepare('SELECT * FROM pages WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!page) return res.status(404).json({ error: 'error.pageNotFound' });
  db.prepare('UPDATE pages SET title = ? WHERE id = ?').run(title, req.params.id);
  res.json({ ...page, title });
});

app.delete('/api/pages/:id', auth, (req, res) => {
  const page = db.prepare('SELECT * FROM pages WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!page) return res.status(404).json({ error: 'error.pageNotFound' });
  const count = db.prepare('SELECT COUNT(*) as c FROM pages WHERE user_id = ?').get(req.user.id);
  if (count.c <= 1) return res.status(400).json({ error: 'error.cannotDeleteLastPage' });
  db.prepare('DELETE FROM pages WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── Page sharing & visibility ────────────────────────────────────
app.put('/api/pages/:id/visibility', auth, (req, res) => {
  const { is_public } = req.body;
  const page = db.prepare('SELECT * FROM pages WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!page) return res.status(404).json({ error: 'error.pageNotFound' });
  db.prepare('UPDATE pages SET is_public = ? WHERE id = ?').run(is_public ? 1 : 0, req.params.id);
  res.json({ ok: true, is_public: !!is_public });
});

app.get('/api/pages/:id/shares', auth, (req, res) => {
  const page = db.prepare('SELECT * FROM pages WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!page) return res.status(404).json({ error: 'error.pageNotFound' });
  const shares = db.prepare(`
    SELECT ps.id, ps.shared_with_user_id, u.username
    FROM page_shares ps JOIN users u ON ps.shared_with_user_id = u.id
    WHERE ps.page_id = ?
  `).all(req.params.id);
  res.json({ shares, is_public: !!page.is_public });
});

app.post('/api/pages/:id/share', auth, (req, res) => {
  const { username } = req.body;
  const page = db.prepare('SELECT * FROM pages WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!page) return res.status(404).json({ error: 'error.pageNotFound' });
  const targetUser = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (!targetUser) return res.status(404).json({ error: 'error.userNotFound' });
  if (targetUser.id === req.user.id) return res.status(400).json({ error: 'error.cannotShareWithSelf' });
  try {
    db.prepare('INSERT INTO page_shares (page_id, shared_with_user_id) VALUES (?, ?)').run(req.params.id, targetUser.id);
  } catch { return res.status(409).json({ error: 'error.alreadyShared' }); }
  res.json({ ok: true });
});

app.delete('/api/pages/:id/share/:userId', auth, (req, res) => {
  const page = db.prepare('SELECT * FROM pages WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!page) return res.status(404).json({ error: 'error.pageNotFound' });
  db.prepare('DELETE FROM page_shares WHERE page_id = ? AND shared_with_user_id = ?').run(req.params.id, req.params.userId);
  res.json({ ok: true });
});

app.get('/api/shared-pages', auth, (req, res) => {
  const sharedPages = db.prepare(`
    SELECT p.*, u.username as owner_name
    FROM page_shares ps
    JOIN pages p ON ps.page_id = p.id
    JOIN users u ON p.user_id = u.id
    WHERE ps.shared_with_user_id = ?
    ORDER BY p.title
  `).all(req.user.id);

  const result = sharedPages.map(page => {
    const columns = db.prepare('SELECT * FROM columns WHERE page_id = ? ORDER BY sort_order').all(page.id);
    return {
      ...page,
      columns: columns.map(col => {
        const widgets = db.prepare('SELECT * FROM widgets WHERE column_id = ? ORDER BY sort_order').all(col.id);
        return {
          ...col,
          widgets: widgets.map(w => {
            const data = { ...w, config: JSON.parse(w.config || '{}') };
            if (w.type === 'bookmarks') {
              data.bookmarks = db.prepare('SELECT * FROM bookmarks WHERE widget_id = ? ORDER BY sort_order').all(w.id);
            }
            return data;
          })
        };
      })
    };
  });
  res.json(result);
});

// ─── Public page (no auth) ───────────────────────────────────────
app.get('/api/public/page/:id', (req, res) => {
  const page = db.prepare('SELECT p.*, u.username as owner_name FROM pages p JOIN users u ON p.user_id = u.id WHERE p.id = ? AND p.is_public = 1').get(req.params.id);
  if (!page) return res.status(404).json({ error: 'error.pageNotFoundOrNotPublic' });

  const columns = db.prepare('SELECT * FROM columns WHERE page_id = ? ORDER BY sort_order').all(page.id);
  const result = {
    ...page,
    columns: columns.map(col => {
      const widgets = db.prepare('SELECT * FROM widgets WHERE column_id = ? ORDER BY sort_order').all(col.id);
      return {
        ...col,
        widgets: widgets.map(w => {
          const data = { ...w, config: JSON.parse(w.config || '{}') };
          if (w.type === 'bookmarks') {
            data.bookmarks = db.prepare('SELECT * FROM bookmarks WHERE widget_id = ? ORDER BY sort_order').all(w.id);
          }
          return data;
        })
      };
    })
  };
  res.json(result);
});

// ─── Users search (for sharing) ──────────────────────────────────
app.get('/api/users/search', auth, (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 1) return res.json([]);
  const users = db.prepare('SELECT id, username FROM users WHERE username LIKE ? AND id != ? LIMIT 10').all(`%${q}%`, req.user.id);
  res.json(users);
});

// ─── Columns routes ───────────────────────────────────────────────
app.get('/api/pages/:pageId/columns', auth, (req, res) => {
  const page = db.prepare('SELECT * FROM pages WHERE id = ? AND user_id = ?').get(req.params.pageId, req.user.id);
  if (!page) return res.status(404).json({ error: 'error.pageNotFound' });
  const columns = db.prepare('SELECT * FROM columns WHERE page_id = ? ORDER BY sort_order').all(req.params.pageId);
  res.json(columns);
});

app.post('/api/pages/:pageId/columns', auth, (req, res) => {
  const page = db.prepare('SELECT * FROM pages WHERE id = ? AND user_id = ?').get(req.params.pageId, req.user.id);
  if (!page) return res.status(404).json({ error: 'error.pageNotFound' });
  const { title } = req.body;
  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM columns WHERE page_id = ?').get(req.params.pageId);
  const result = db.prepare('INSERT INTO columns (page_id, title, sort_order) VALUES (?, ?, ?)').run(req.params.pageId, title || 'New column', (maxOrder.m || 0) + 1);
  const col = db.prepare('SELECT * FROM columns WHERE id = ?').get(result.lastInsertRowid);
  res.json(col);
});

app.put('/api/columns/:id', auth, (req, res) => {
  const { title, width } = req.body;
  const col = db.prepare('SELECT c.* FROM columns c JOIN pages p ON c.page_id = p.id WHERE c.id = ? AND p.user_id = ?').get(req.params.id, req.user.id);
  if (!col) return res.status(404).json({ error: 'error.columnNotFound' });
  if (title !== undefined) db.prepare('UPDATE columns SET title = ? WHERE id = ?').run(title, req.params.id);
  if (width !== undefined) db.prepare('UPDATE columns SET width = ? WHERE id = ?').run(width, req.params.id);
  res.json({ ...col, title: title ?? col.title, width: width ?? col.width });
});

app.delete('/api/columns/:id', auth, (req, res) => {
  const col = db.prepare('SELECT c.* FROM columns c JOIN pages p ON c.page_id = p.id WHERE c.id = ? AND p.user_id = ?').get(req.params.id, req.user.id);
  if (!col) return res.status(404).json({ error: 'error.columnNotFound' });
  db.prepare('DELETE FROM columns WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.put('/api/pages/:pageId/columns/reorder', auth, (req, res) => {
  const { order } = req.body;
  const stmt = db.prepare('UPDATE columns SET sort_order = ? WHERE id = ?');
  db.transaction(() => { order.forEach((id, idx) => stmt.run(idx, id)); })();
  res.json({ ok: true });
});

// ─── Widgets routes ───────────────────────────────────────────────
app.get('/api/columns/:colId/widgets', auth, (req, res) => {
  const widgets = db.prepare('SELECT * FROM widgets WHERE column_id = ? ORDER BY sort_order').all(req.params.colId);
  res.json(widgets.map(w => ({ ...w, config: JSON.parse(w.config || '{}') })));
});

app.post('/api/columns/:colId/widgets', auth, (req, res) => {
  const { type, title, config } = req.body;
  if (!VALID_WIDGET_TYPES.includes(type)) return res.status(400).json({ error: 'error.invalidWidgetType' });
  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM widgets WHERE column_id = ?').get(req.params.colId);
  const result = db.prepare('INSERT INTO widgets (column_id, type, title, sort_order, config) VALUES (?, ?, ?, ?, ?)')
    .run(req.params.colId, type, title, (maxOrder.m || 0) + 1, JSON.stringify(config || {}));
  const widget = db.prepare('SELECT * FROM widgets WHERE id = ?').get(result.lastInsertRowid);
  res.json({ ...widget, config: JSON.parse(widget.config) });
});

app.put('/api/widgets/move', auth, (req, res) => {
  const { widgetId, targetColumnId, order } = req.body;
  db.prepare('UPDATE widgets SET column_id = ? WHERE id = ?').run(targetColumnId, widgetId);
  const stmt = db.prepare('UPDATE widgets SET sort_order = ? WHERE id = ?');
  db.transaction(() => { order.forEach((id, idx) => stmt.run(idx, id)); })();
  res.json({ ok: true });
});

app.put('/api/widgets/:id', auth, (req, res) => {
  const { title, config, column_id, sort_order, height } = req.body;
  if (title !== undefined) db.prepare('UPDATE widgets SET title = ? WHERE id = ?').run(title, req.params.id);
  if (config !== undefined) db.prepare('UPDATE widgets SET config = ? WHERE id = ?').run(JSON.stringify(config), req.params.id);
  if (column_id !== undefined) db.prepare('UPDATE widgets SET column_id = ? WHERE id = ?').run(column_id, req.params.id);
  if (sort_order !== undefined) db.prepare('UPDATE widgets SET sort_order = ? WHERE id = ?').run(sort_order, req.params.id);
  if (height !== undefined) db.prepare('UPDATE widgets SET height = ? WHERE id = ?').run(height, req.params.id);
  const widget = db.prepare('SELECT * FROM widgets WHERE id = ?').get(req.params.id);
  res.json({ ...widget, config: JSON.parse(widget.config) });
});

app.delete('/api/widgets/:id', auth, (req, res) => {
  db.prepare('DELETE FROM widgets WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── Bookmarks routes ─────────────────────────────────────────────
app.get('/api/widgets/:widgetId/bookmarks', auth, (req, res) => {
  const bookmarks = db.prepare('SELECT * FROM bookmarks WHERE widget_id = ? ORDER BY sort_order').all(req.params.widgetId);
  res.json(bookmarks);
});

app.post('/api/widgets/:widgetId/bookmarks', auth, (req, res) => {
  const { title, url, icon } = req.body;
  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM bookmarks WHERE widget_id = ?').get(req.params.widgetId);
  const result = db.prepare('INSERT INTO bookmarks (widget_id, title, url, icon, sort_order) VALUES (?, ?, ?, ?, ?)')
    .run(req.params.widgetId, title, url, icon || '', (maxOrder.m || 0) + 1);
  const bookmark = db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(result.lastInsertRowid);
  res.json(bookmark);
});

app.put('/api/bookmarks/reorder', auth, (req, res) => {
  const { order } = req.body;
  if (!order || !Array.isArray(order) || order.length === 0) return res.json({ ok: true });
  const stmt = db.prepare('UPDATE bookmarks SET sort_order = ? WHERE id = ?');
  db.transaction(() => { order.forEach((id, idx) => stmt.run(idx, id)); })();
  res.json({ ok: true });
});

app.put('/api/bookmarks/move', auth, (req, res) => {
  const { bookmarkId, targetWidgetId, order } = req.body;
  db.prepare('UPDATE bookmarks SET widget_id = ? WHERE id = ?').run(targetWidgetId, bookmarkId);
  const stmt = db.prepare('UPDATE bookmarks SET sort_order = ? WHERE id = ?');
  db.transaction(() => { order.forEach((id, idx) => stmt.run(idx, id)); })();
  res.json({ ok: true });
});

app.put('/api/bookmarks/:id', auth, (req, res) => {
  const { title, url, icon } = req.body;
  if (title !== undefined) db.prepare('UPDATE bookmarks SET title = ? WHERE id = ?').run(title, req.params.id);
  if (url !== undefined) db.prepare('UPDATE bookmarks SET url = ? WHERE id = ?').run(url, req.params.id);
  if (icon !== undefined) db.prepare('UPDATE bookmarks SET icon = ? WHERE id = ?').run(icon, req.params.id);
  const bookmark = db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(req.params.id);
  res.json(bookmark);
});

app.delete('/api/bookmarks/:id', auth, (req, res) => {
  db.prepare('DELETE FROM bookmarks WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── AI Chat ────────────────────────────────────────────────────
app.get('/api/ai/messages/:widgetId', auth, (req, res) => {
  const msgs = db.prepare('SELECT role, content FROM ai_messages WHERE widget_id = ? ORDER BY id').all(req.params.widgetId);
  res.json(msgs);
});

app.delete('/api/ai/messages/:widgetId', auth, (req, res) => {
  db.prepare('DELETE FROM ai_messages WHERE widget_id = ?').run(req.params.widgetId);
  res.json({ ok: true });
});

app.post('/api/ai/chat', auth, async (req, res) => {
  const { widgetId, message } = req.body;
  const widget = db.prepare('SELECT * FROM widgets WHERE id = ?').get(widgetId);
  if (!widget) return res.status(404).json({ error: 'error.widgetNotFound' });
  const config = JSON.parse(widget.config || '{}');
  const provider = config.provider || 'mistral';
  const apiKey = config.apiKey || '';
  const model = config.model || '';
  if (!apiKey) return res.status(400).json({ error: 'error.apiKeyNotConfigured' });

  db.prepare('INSERT INTO ai_messages (widget_id, role, content) VALUES (?, ?, ?)').run(widgetId, 'user', message);
  const history = db.prepare('SELECT role, content FROM ai_messages WHERE widget_id = ? ORDER BY id').all(widgetId);

  const PROVIDERS = {
    mistral: { url: 'https://api.mistral.ai/v1/chat/completions', defaultModel: 'mistral-small-latest' },
    openai: { url: 'https://api.openai.com/v1/chat/completions', defaultModel: 'gpt-4o-mini' },
    anthropic: { url: 'https://api.anthropic.com/v1/messages', defaultModel: 'claude-sonnet-4-20250514' },
  };
  const prov = PROVIDERS[provider];
  if (!prov) return res.status(400).json({ error: 'error.unknownProvider' });

  try {
    let content;
    if (provider === 'anthropic') {
      const r = await fetch(prov.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: model || prov.defaultModel, max_tokens: 2048, messages: history })
      });
      if (!r.ok) { const e = await r.text(); return res.status(r.status).json({ error: e }); }
      const data = await r.json();
      content = data.content?.[0]?.text || '';
    } else {
      const r = await fetch(prov.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
        body: JSON.stringify({ model: model || prov.defaultModel, messages: history, max_tokens: 2048 })
      });
      if (!r.ok) { const e = await r.text(); return res.status(r.status).json({ error: e }); }
      const data = await r.json();
      content = data.choices?.[0]?.message?.content || '';
    }

    db.prepare('INSERT INTO ai_messages (widget_id, role, content) VALUES (?, ?, ?)').run(widgetId, 'assistant', content);
    res.json({ content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Full dashboard load ─────────────────────────────────────────
app.get('/api/dashboard', auth, (req, res) => {
  const pages = db.prepare('SELECT * FROM pages WHERE user_id = ? ORDER BY sort_order').all(req.user.id);
  const result = pages.map(page => {
    const columns = db.prepare('SELECT * FROM columns WHERE page_id = ? ORDER BY sort_order').all(page.id);
    return {
      ...page,
      columns: columns.map(col => {
        const widgets = db.prepare('SELECT * FROM widgets WHERE column_id = ? ORDER BY sort_order').all(col.id);
        return {
          ...col,
          widgets: widgets.map(w => {
            const data = { ...w, config: JSON.parse(w.config || '{}') };
            if (w.type === 'bookmarks') {
              data.bookmarks = db.prepare('SELECT * FROM bookmarks WHERE widget_id = ? ORDER BY sort_order').all(w.id);
            }
            return data;
          })
        };
      })
    };
  });
  res.json(result);
});

// ─── RSS proxy ────────────────────────────────────────────────────
const rssCache = new Map();
const RSS_CACHE_TTL = 5 * 60 * 1000;


function extractImage(item) {
  // 1. enclosure with image type
  if (item.enclosure?.url && (!item.enclosure.type || item.enclosure.type.startsWith('image'))) {
    return item.enclosure.url;
  }
  // 2. media:content
  if (item.mediaContent) {
    const mc = Array.isArray(item.mediaContent) ? item.mediaContent : [item.mediaContent];
    for (const m of mc) {
      const url = m.$?.url || m.url;
      if (url) return url;
    }
  }
  // 3. media:thumbnail
  if (item.mediaThumbnail) {
    const mt = Array.isArray(item.mediaThumbnail) ? item.mediaThumbnail : [item.mediaThumbnail];
    for (const m of mt) {
      const url = m.$?.url || m.url;
      if (url) return url;
    }
  }
  // 4. media:group > media:content
  if (item.mediaGroup?.['media:content']) {
    const mc = item.mediaGroup['media:content'];
    const arr = Array.isArray(mc) ? mc : [mc];
    for (const m of arr) {
      const url = m.$?.url || m.url;
      if (url) return url;
    }
  }
  // 5. Parse content/content:encoded for <img>
  const html = item['content:encoded'] || item.content || '';
  const imgMatch = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (imgMatch) return imgMatch[1];
  // 6. No image found
  return null;
}

app.get('/api/rss', auth, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'error.urlRequired' });
  const cached = rssCache.get(url);
  if (cached && Date.now() - cached.time < RSS_CACHE_TTL) return res.json(cached.data);
  try {
    const feed = await rssParser.parseURL(url);
    const data = {
      title: feed.title, link: feed.link,
      items: (feed.items || []).slice(0, 30).map(item => ({
        title: item.title, link: item.link,
        pubDate: item.pubDate || item.isoDate,
        contentSnippet: (item.contentSnippet || item.summary || '').substring(0, 400),
        image: extractImage(item)
      }))
    };
    rssCache.set(url, { data, time: Date.now() });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'error.rssLoadFailed', details: err.message });
  }
});

// ─── Weather proxy ────────────────────────────────────────────────
const weatherCache = new Map();
const WEATHER_CACHE_TTL = 15 * 60 * 1000;

app.get('/api/weather', auth, async (req, res) => {
  const { city, lang } = req.query;
  if (!city) return res.status(400).json({ error: 'error.cityRequired' });
  const wttrLang = lang || 'fr';
  const cacheKey = city.toLowerCase() + '_' + wttrLang;
  const cached = weatherCache.get(cacheKey);
  if (cached && Date.now() - cached.time < WEATHER_CACHE_TTL) return res.json(cached.data);
  try {
    const response = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1&lang=${wttrLang}`);
    if (!response.ok) throw new Error('error.weatherUnavailable');
    const json = await response.json();
    const cc = json.current_condition[0];
    const langKey = 'lang_' + wttrLang;
    const data = {
      city,
      temp_C: cc.temp_C,
      feels_like_C: cc.FeelsLikeC,
      description: cc[langKey] ? cc[langKey][0].value : cc.weatherDesc[0].value,
      humidity: cc.humidity,
      wind_kmph: cc.windspeedKmph,
      windDirection: cc.winddir16Point,
      uvIndex: cc.uvIndex,
      precipMM: cc.precipMM,
      pressure: cc.pressure,
      visibility: cc.visibility,
      cloudcover: cc.cloudcover,
      weatherCode: cc.weatherCode,
      sunrise: json.weather && json.weather[0] && json.weather[0].astronomy ? json.weather[0].astronomy[0].sunrise : '',
      sunset: json.weather && json.weather[0] && json.weather[0].astronomy ? json.weather[0].astronomy[0].sunset : '',
      hourly: (json.weather || []).slice(0, 2).flatMap((day, dayIdx) =>
        (day.hourly || []).map(h => ({
          time: h.time,
          temp_C: h.tempC,
          weatherCode: h.weatherCode,
          chanceOfRain: h.chanceofrain,
          description: h[langKey] ? h[langKey][0].value : h.weatherDesc[0].value,
          windKmph: h.windspeedKmph,
          windDir: h.winddir16Point,
          dayOffset: dayIdx
        }))
      ),
      forecast: (json.weather || []).slice(0, 5).map(d => ({
        date: d.date,
        maxTemp_C: d.maxtempC,
        minTemp_C: d.mintempC,
        weatherCode: d.hourly && d.hourly[4] ? d.hourly[4].weatherCode : '116',
        chanceOfRain: d.hourly && d.hourly[4] ? d.hourly[4].chanceofrain : '0',
        description: d.hourly && d.hourly[4] ? (d.hourly[4][langKey] ? d.hourly[4][langKey][0].value : d.hourly[4].weatherDesc[0].value) : '',
        sunrise: d.astronomy ? d.astronomy[0].sunrise : '',
        sunset: d.astronomy ? d.astronomy[0].sunset : ''
      }))
    };
    weatherCache.set(cacheKey, { data, time: Date.now() });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'error.weatherLoadFailed', details: err.message });
  }
});

// ─── Favicon proxy ────────────────────────────────────────────────
app.get('/api/favicon', (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'error.urlRequired' });
  try {
    const domain = new URL(url).hostname;
    res.redirect(`https://www.google.com/s2/favicons?domain=${domain}&sz=64`);
  } catch {
    res.status(400).json({ error: 'error.invalidUrl' });
  }
});

// ─── Import / Export ──────────────────────────────────────────────
app.get('/api/export/bookmarks', auth, (req, res) => {
  const pages = db.prepare('SELECT * FROM pages WHERE user_id = ? ORDER BY sort_order').all(req.user.id);
  let html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Launchy Bookmarks</TITLE>
<H1>Launchy Bookmarks</H1>
<DL><p>\n`;
  for (const page of pages) {
    html += `    <DT><H3>${escHtml(page.title)}</H3>\n    <DL><p>\n`;
    const columns = db.prepare('SELECT * FROM columns WHERE page_id = ? ORDER BY sort_order').all(page.id);
    for (const col of columns) {
      const widgets = db.prepare("SELECT * FROM widgets WHERE column_id = ? AND type = 'bookmarks' ORDER BY sort_order").all(col.id);
      for (const w of widgets) {
        html += `        <DT><H3>${escHtml(w.title)}</H3>\n        <DL><p>\n`;
        const bookmarks = db.prepare('SELECT * FROM bookmarks WHERE widget_id = ? ORDER BY sort_order').all(w.id);
        for (const b of bookmarks) {
          html += `            <DT><A HREF="${escHtml(b.url)}">${escHtml(b.title)}</A>\n`;
        }
        html += `        </DL><p>\n`;
      }
    }
    html += `    </DL><p>\n`;
  }
  html += `</DL><p>\n`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="launchy-bookmarks.html"');
  res.send(html);
});

app.post('/api/import/bookmarks', auth, (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'error.contentRequired' });

  const bookmarks = [];
  let currentFolder = 'Import';
  const folderRegex = /<H3[^>]*>(.*?)<\/H3>/gi;
  const linkRegex = /<A[^>]*HREF="([^"]*)"[^>]*>(.*?)<\/A>/gi;
  const lines = content.split('\n');

  for (const line of lines) {
    const folderMatch = /<H3[^>]*>(.*?)<\/H3>/i.exec(line);
    if (folderMatch) currentFolder = folderMatch[1].replace(/<[^>]*>/g, '');
    const linkMatch = /<A[^>]*HREF="([^"]*)"[^>]*>(.*?)<\/A>/i.exec(line);
    if (linkMatch) {
      bookmarks.push({ folder: currentFolder, url: linkMatch[1], title: linkMatch[2].replace(/<[^>]*>/g, '') || linkMatch[1] });
    }
  }

  if (bookmarks.length === 0) return res.status(400).json({ error: 'error.noBookmarksFound' });

  const pageResult = db.prepare('INSERT INTO pages (user_id, title, sort_order) VALUES (?, ?, ?)').run(req.user.id, 'Import', 999);
  const pageId = pageResult.lastInsertRowid;
  const colResult = db.prepare('INSERT INTO columns (page_id, title, sort_order) VALUES (?, ?, ?)').run(pageId, 'Import', 0);
  const colId = colResult.lastInsertRowid;

  const folders = {};
  for (const bm of bookmarks) {
    if (!folders[bm.folder]) {
      const wResult = db.prepare('INSERT INTO widgets (column_id, type, title, sort_order) VALUES (?, ?, ?, ?)').run(colId, 'bookmarks', bm.folder, Object.keys(folders).length);
      folders[bm.folder] = wResult.lastInsertRowid;
    }
    const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM bookmarks WHERE widget_id = ?').get(folders[bm.folder]);
    db.prepare('INSERT INTO bookmarks (widget_id, title, url, sort_order) VALUES (?, ?, ?, ?)').run(folders[bm.folder], bm.title, bm.url, (maxOrder.m || 0) + 1);
  }

  res.json({ ok: true, imported: bookmarks.length, page: 'Import' });
});

app.get('/api/export/opml', auth, (req, res) => {
  const pages = db.prepare('SELECT * FROM pages WHERE user_id = ? ORDER BY sort_order').all(req.user.id);
  let opml = `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n<head><title>Launchy RSS Feeds</title></head>\n<body>\n`;
  for (const page of pages) {
    const columns = db.prepare('SELECT * FROM columns WHERE page_id = ? ORDER BY sort_order').all(page.id);
    for (const col of columns) {
      const widgets = db.prepare("SELECT * FROM widgets WHERE column_id = ? AND type = 'rss' ORDER BY sort_order").all(col.id);
      for (const w of widgets) {
        const config = JSON.parse(w.config || '{}');
        if (config.url) {
          opml += `  <outline text="${escHtml(w.title)}" type="rss" xmlUrl="${escHtml(config.url)}" />\n`;
        }
      }
    }
  }
  opml += `</body>\n</opml>`;
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="launchy-feeds.opml"');
  res.send(opml);
});

app.post('/api/import/opml', auth, (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'error.contentRequired' });

  const feeds = [];
  const outlineRegex = /<outline[^>]*xmlUrl="([^"]*)"[^>]*text="([^"]*)"[^>]*\/?>/gi;
  const outlineRegex2 = /<outline[^>]*text="([^"]*)"[^>]*xmlUrl="([^"]*)"[^>]*\/?>/gi;
  let match;
  while ((match = outlineRegex.exec(content)) !== null) feeds.push({ url: match[1], title: match[2] });
  if (feeds.length === 0) {
    while ((match = outlineRegex2.exec(content)) !== null) feeds.push({ url: match[2], title: match[1] });
  }
  if (feeds.length === 0) return res.status(400).json({ error: 'error.noFeedsFound' });

  const pageResult = db.prepare('INSERT INTO pages (user_id, title, sort_order) VALUES (?, ?, ?)').run(req.user.id, 'Imported feeds', 999);
  const colResult = db.prepare('INSERT INTO columns (page_id, title, sort_order) VALUES (?, ?, ?)').run(pageResult.lastInsertRowid, 'RSS Feeds', 0);

  for (let i = 0; i < feeds.length; i++) {
    db.prepare('INSERT INTO widgets (column_id, type, title, sort_order, config) VALUES (?, ?, ?, ?, ?)').run(
      colResult.lastInsertRowid, 'rss', feeds[i].title, i, JSON.stringify({ url: feeds[i].url })
    );
  }
  res.json({ ok: true, imported: feeds.length });
});

function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── SPA fallback ─────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Launchy running on http://localhost:${PORT}`);
});
