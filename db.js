'use strict';
/**
 * Thin wrapper around sql.js that mimics the better-sqlite3 synchronous API.
 * sql.js uses WebAssembly — no native compilation needed.
 */
const path    = require('path');
const fs      = require('fs');
const initSqlJs = require('sql.js');

const DATA_DIR = process.env.ZVONOK_DATA || path.join(__dirname, 'data');
const DB_PATH  = path.join(DATA_DIR, 'zvonok.db');
let   sqlDb    = null;
let   saveTimer = null;

// Debounced write to disk — coalesces rapid writes into one
function _scheduleSave() {
  if (saveTimer) return;
  saveTimer = setImmediate(() => {
    saveTimer = null;
    if (!sqlDb) return;
    const buf = sqlDb.export();
    fs.writeFileSync(DB_PATH, Buffer.from(buf));
  });
}

// Normalise positional args: (.run(a,b,c)) or (.run([a,b,c]))
function _params(args) {
  if (args.length === 0) return [];
  if (args.length === 1 && Array.isArray(args[0])) return args[0];
  return Array.from(args);
}

class Stmt {
  constructor(sql) { this._sql = sql; }

  run(...args) {
    sqlDb.run(this._sql, _params(args));
    _scheduleSave();
    return { changes: sqlDb.getRowsModified() };
  }

  get(...args) {
    const stmt = sqlDb.prepare(this._sql);
    stmt.bind(_params(args));
    const row = stmt.step() ? stmt.getAsObject() : undefined;
    stmt.free();
    return row;
  }

  all(...args) {
    const stmt = sqlDb.prepare(this._sql);
    stmt.bind(_params(args));
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }
}

// Public db object — mirrors better-sqlite3 Database interface
const db = {
  prepare(sql) { return new Stmt(sql); },

  exec(sql) {
    sqlDb.exec(sql);
    _scheduleSave();
  },

  // no-op: sql.js doesn't need WAL pragma
  pragma() {},
};

// Must be called once before using db
async function initDb() {
  const SQL = await initSqlJs({
    locateFile: file => path.join(__dirname, 'node_modules', 'sql.js', 'dist', file),
  });

  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    sqlDb = new SQL.Database(buf);
  } else {
    sqlDb = new SQL.Database();
  }
}

module.exports = { initDb, db };
