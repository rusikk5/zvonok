'use strict';
const { createClient } = require('@libsql/client');
const path = require('path');
const fs   = require('fs');

const DATA_DIR = process.env.ZVONOK_DATA || path.join(__dirname, 'data');
let client;

function toObj(columns, row) {
  const obj = {};
  for (let i = 0; i < columns.length; i++) {
    const v = row[i];
    obj[columns[i]] = typeof v === 'bigint' ? Number(v) : v;
  }
  return obj;
}

const db = {
  async run(sql, args = []) {
    const r = await client.execute({ sql, args });
    return { changes: r.rowsAffected };
  },
  async get(sql, args = []) {
    const r = await client.execute({ sql, args });
    if (!r.rows.length) return undefined;
    return toObj(r.columns, r.rows[0]);
  },
  async all(sql, args = []) {
    const r = await client.execute({ sql, args });
    return r.rows.map(row => toObj(r.columns, row));
  },
  async exec(sql) {
    await client.executeMultiple(sql);
  },
};

async function initDb() {
  const url   = process.env.TURSO_URL;
  const token = process.env.TURSO_TOKEN;
  if (url) {
    client = createClient({ url, authToken: token, intMode: 'number' });
  } else {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    client = createClient({ url: `file:${path.join(DATA_DIR, 'zvonok.db')}`, intMode: 'number' });
  }
}

module.exports = { initDb, db };
