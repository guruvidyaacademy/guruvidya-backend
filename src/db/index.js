const Database = require("better-sqlite3");
const path = require("path");
const db = new Database(path.join(__dirname, "guruvidya.sqlite"));

db.exec(`
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT, mobile TEXT, course TEXT,
  status TEXT DEFAULT 'new',
  owner TEXT DEFAULT '',
  note TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS admissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT, mobile TEXT, email TEXT, course TEXT, note TEXT,
  status TEXT DEFAULT 'new',
  owner TEXT DEFAULT '',
  admin_note TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT, mobile TEXT, course TEXT, datetime TEXT,
  status TEXT DEFAULT 'requested',
  owner TEXT DEFAULT '',
  note TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS support (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT, mobile TEXT, issue TEXT, description TEXT,
  status TEXT DEFAULT 'new',
  owner TEXT DEFAULT '',
  note TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS faculty (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT, mobile TEXT, course TEXT, mode TEXT, note TEXT,
  status TEXT DEFAULT 'new',
  owner TEXT DEFAULT '',
  admin_note TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`);

module.exports = db;
