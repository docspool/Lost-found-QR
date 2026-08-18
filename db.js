const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'data', 'qrlf.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS objects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  message TEXT DEFAULT '',
  contact_info TEXT DEFAULT '',
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  object_id INTEGER NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  finder_name TEXT,
  finder_contact TEXT,
  finder_message TEXT,
  latitude REAL,
  longitude REAL,
  accuracy REAL,
  user_agent TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  object_id INTEGER NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  latitude REAL,
  longitude REAL,
  accuracy REAL,
  user_agent TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

module.exports = db;
