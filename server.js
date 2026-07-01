const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'pushups.db');

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL COLLATE NOCASE,
    daily_target INTEGER DEFAULT 100,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS daily_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    banked INTEGER DEFAULT 0,
    UNIQUE(user_id, date),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function getToday() {
  return new Date().toISOString().split('T')[0];
}

// Get or create user + today's log + history
app.get('/api/user/:name', (req, res) => {
  const name = req.params.name.trim();
  if (!name) return res.status(400).json({ error: 'Name required' });

  let user = db.prepare('SELECT * FROM users WHERE name = ? COLLATE NOCASE').get(name);
  if (!user) {
    db.prepare('INSERT INTO users (name) VALUES (?)').run(name);
    user = db.prepare('SELECT * FROM users WHERE name = ? COLLATE NOCASE').get(name);
  }

  const today = getToday();
  db.prepare(`
    INSERT OR IGNORE INTO daily_logs (user_id, date, banked) VALUES (?, ?, 0)
  `).run(user.id, today);

  const todayLog = db.prepare('SELECT * FROM daily_logs WHERE user_id = ? AND date = ?').get(user.id, today);

  const history = db.prepare(`
    SELECT date, banked FROM daily_logs
    WHERE user_id = ?
    ORDER BY date DESC
    LIMIT 30
  `).all(user.id);

  res.json({
    user: { id: user.id, name: user.name, daily_target: user.daily_target },
    today: { date: today, banked: todayLog.banked },
    history
  });
});

// Bank pushups
app.post('/api/bank', (req, res) => {
  const { name, amount } = req.body;
  if (!name || typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ error: 'Invalid data' });
  }

  const user = db.prepare('SELECT * FROM users WHERE name = ? COLLATE NOCASE').get(name);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const today = getToday();
  db.prepare(`
    INSERT INTO daily_logs (user_id, date, banked) VALUES (?, ?, ?)
    ON CONFLICT(user_id, date) DO UPDATE SET banked = banked + excluded.banked
  `).run(user.id, today, amount);

  const log = db.prepare('SELECT banked FROM daily_logs WHERE user_id = ? AND date = ?').get(user.id, today);
  res.json({ banked: log.banked, target: user.daily_target });
});

// Update daily target
app.put('/api/settings/:name', (req, res) => {
  const { daily_target } = req.body;
  const name = req.params.name;

  if (!daily_target || daily_target < 1 || daily_target > 9999) {
    return res.status(400).json({ error: 'Target must be between 1 and 9999' });
  }

  const result = db.prepare(
    'UPDATE users SET daily_target = ? WHERE name = ? COLLATE NOCASE'
  ).run(daily_target, name);

  if (result.changes === 0) return res.status(404).json({ error: 'User not found' });
  res.json({ daily_target });
});

const GROUP_GOAL = { target: 50000, reward: 'Third Wave' };

// All-time leaderboard
app.get('/api/leaderboard', (req, res) => {
  const rows = db.prepare(`
    SELECT
      u.name,
      COALESCE(SUM(dl.banked), 0)                              AS total,
      COUNT(CASE WHEN dl.banked > 0 THEN 1 END)               AS days_active,
      COALESCE(MAX(dl.banked), 0)                              AS best_day,
      COALESCE(SUM(CASE WHEN dl.date = ? THEN dl.banked END), 0) AS today
    FROM users u
    LEFT JOIN daily_logs dl ON u.id = dl.user_id
    GROUP BY u.id
    HAVING total > 0
    ORDER BY total DESC
  `).all(getToday());

  res.json({ rows, goal: GROUP_GOAL });
});

app.listen(PORT, () => {
  console.log(`Push-up counter running at http://localhost:${PORT}`);
});
