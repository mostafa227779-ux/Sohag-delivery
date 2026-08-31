const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'data', 'store.json');
const SEED_FILE = path.join(__dirname, 'data', 'seed.json');

function ensureDb() {
  if (!fs.existsSync(DB_FILE)) {
    const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf-8'));
    const initial = {
      categories: seed.categories,
      stores: seed.stores,
      products: seed.products,
      users: [],
      orders: []
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
  }
}

function readDb() {
  ensureDb();
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
}

function writeDb(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function genId(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

module.exports = { readDb, writeDb, genId };
