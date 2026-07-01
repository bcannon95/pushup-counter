const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is not set.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      daily_target INTEGER DEFAULT 100,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS daily_logs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      date DATE NOT NULL,
      banked INTEGER DEFAULT 0,
      UNIQUE(user_id, date)
    );
  `);
  console.log('Database ready.');
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function getToday() {
  return new Date().toISOString().split('T')[0];
}

// Get or create user + today's log + history
app.get('/api/user/:name', async (req, res) => {
  const name = req.params.name.trim();
  if (!name) return res.status(400).json({ error: 'Name required' });

  try {
    await pool.query(
      'INSERT INTO users (name) VALUES (LOWER($1)) ON CONFLICT (name) DO NOTHING',
      [name]
    );

    const { rows: [user] } = await pool.query(
      'SELECT * FROM users WHERE name = LOWER($1)',
      [name]
    );

    const today = getToday();
    await pool.query(
      'INSERT INTO daily_logs (user_id, date, banked) VALUES ($1, $2, 0) ON CONFLICT (user_id, date) DO NOTHING',
      [user.id, today]
    );

    const { rows: [todayLog] } = await pool.query(
      'SELECT * FROM daily_logs WHERE user_id = $1 AND date = $2',
      [user.id, today]
    );

    const { rows: history } = await pool.query(
      'SELECT date, banked FROM daily_logs WHERE user_id = $1 ORDER BY date DESC LIMIT 30',
      [user.id]
    );

    res.json({
      user: { id: user.id, name: user.name, daily_target: user.daily_target },
      today: { date: today, banked: todayLog.banked },
      history
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Bank pushups
app.post('/api/bank', async (req, res) => {
  const { name, amount } = req.body;
  if (!name || typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ error: 'Invalid data' });
  }

  try {
    const { rows: [user] } = await pool.query(
      'SELECT * FROM users WHERE name = LOWER($1)',
      [name]
    );
    if (!user) return res.status(404).json({ error: 'User not found' });

    const today = getToday();
    await pool.query(
      `INSERT INTO daily_logs (user_id, date, banked) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, date) DO UPDATE SET banked = daily_logs.banked + EXCLUDED.banked`,
      [user.id, today, amount]
    );

    const { rows: [log] } = await pool.query(
      'SELECT banked FROM daily_logs WHERE user_id = $1 AND date = $2',
      [user.id, today]
    );

    res.json({ banked: log.banked, target: user.daily_target });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update daily target
app.put('/api/settings/:name', async (req, res) => {
  const { daily_target } = req.body;
  const name = req.params.name;

  if (!daily_target || daily_target < 1 || daily_target > 9999) {
    return res.status(400).json({ error: 'Target must be between 1 and 9999' });
  }

  try {
    const { rowCount } = await pool.query(
      'UPDATE users SET daily_target = $1 WHERE name = LOWER($2)',
      [daily_target, name]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ daily_target });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

const GROUP_GOAL = { target: 50000, reward: 'Third Wave' };

// All-time leaderboard
app.get('/api/leaderboard', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        u.name,
        COALESCE(SUM(dl.banked), 0)                                          AS total,
        COUNT(CASE WHEN dl.banked > 0 THEN 1 END)                           AS days_active,
        COALESCE(MAX(dl.banked), 0)                                          AS best_day,
        COALESCE(SUM(CASE WHEN dl.date = CURRENT_DATE THEN dl.banked END), 0) AS today
      FROM users u
      LEFT JOIN daily_logs dl ON u.id = dl.user_id
      GROUP BY u.id
      HAVING COALESCE(SUM(dl.banked), 0) > 0
      ORDER BY total DESC
    `);

    res.json({ rows, goal: GROUP_GOAL });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Push-up counter running at http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialise database:', err);
  process.exit(1);
});
