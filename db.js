QLite format 3@         .r
=kX' tablekey_pairskey_pairs
CREATE TABLE key_pairs (
      telegram_id TEXT,
      server_id TEXT PRIMARY KEY,
      key_name TEXT,
      private_key TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )1
Eindexsqlite_autoindex_key_pairs_1key_pairstableteststestCREATE TABLE tests (
      telegram_id TEXT PRIMARY KEY,
      server_id TEXT,
      used_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )=indexsqlite_autoindex_tests_1tests    P++Ytablesqlite_sequencesqlite_sequenceCREATE TABLE sqlite_sequence(name,seq)s5tablepurchasespurchasesCREATE TABLE purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT,
      server_id TEXT,
      amount REAL,
      duration TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )uEtablewalletwalletCREATE TABLE wallet (
      telegram_id TEXT PRIMARY KEY,
      balance REAL DEFAULT 0
    )+?indexsqlite_autoindex_wallet_1walletwMtableusersusersCREATE TABLE users (
      telegram_id TEXT PRIMARY KEY,
      phone TEXT,
      step TEXT
%316244055989383773850READYsers_1users
  316244055
DU331624405564cb93df-e180-4691-8dea-78e6bb4ce3432025-06-17 13:01:20
  316244055
root@hamoon:/opt/hamooncloud/HamoonCloud# cat db.js
/**
 * db.js - Data access layer for HamoonCloud Bot
 * Uses SQLite to store users, wallet balances, purchases, and free test usage.
 */
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

// Database file
const dbPath = path.join(__dirname, 'hamooncloud.db');
const db = new sqlite3.Database(dbPath);

// Initialize tables
db.serialize(() => {
  // Users table
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id TEXT PRIMARY KEY,
      phone TEXT,
      step TEXT
    )
  `);

  // Wallet table
  db.run(`
    CREATE TABLE IF NOT EXISTS wallet (
      telegram_id TEXT PRIMARY KEY,
      balance REAL DEFAULT 0
    )
  `);

  // Purchases table
  db.run(`
    CREATE TABLE IF NOT EXISTS purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT,
      server_id TEXT,
      amount REAL,
      duration TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Free test usage
  db.run(`
    CREATE TABLE IF NOT EXISTS tests (
      telegram_id TEXT PRIMARY KEY,
      server_id TEXT,
      used_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Key pairs table to store generated private keys
  db.run(`
    CREATE TABLE IF NOT EXISTS key_pairs (
      telegram_id TEXT,
      server_id TEXT PRIMARY KEY,
      key_name TEXT,
      private_key TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

// Upsert user record
function upsertUser({ telegram_id, phone, step }) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO users (telegram_id, phone, step)
       VALUES (?, ?, ?)
       ON CONFLICT(telegram_id) DO UPDATE SET phone=excluded.phone, step=excluded.step`,
      [telegram_id, phone, step],
      function (err) {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

// Get wallet balance
function getUserWallet(telegram_id) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT balance FROM wallet WHERE telegram_id = ?`,
      [telegram_id],
      (err, row) => {
        if (err) reject(err);
        else resolve(row ? row.balance : 0);
      }
    );
  });
}

// Debit user wallet
function debitUser(telegram_id, amount) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO wallet (telegram_id, balance)
       VALUES (?, -?)
       ON CONFLICT(telegram_id) DO UPDATE SET balance = balance - excluded.balance`,
      [telegram_id, amount],
      function(err) {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

// Credit user wallet - NEW FUNCTION
function creditUser(telegram_id, amount) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO wallet (telegram_id, balance)
       VALUES (?, ?)
       ON CONFLICT(telegram_id) DO UPDATE SET balance = balance + excluded.balance`,
      [telegram_id, amount],
      function(err) {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

// Record a purchase
function recordPurchase(telegram_id, server_id, amount, duration) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO purchases (telegram_id, server_id, amount, duration)
       VALUES (?, ?, ?, ?)`,
      [telegram_id, server_id, amount, duration],
      function (err) {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

// Check and record free test usage
/**
 * recordTestServer: if serverId provided, marks test used; otherwise checks usage.
 * @param {string} telegram_id
 * @param {string} [server_id]
 * @returns {Promise<boolean>} returns true if already used (when checking), or always resolves after insertion.
 */
function recordTestServer(telegram_id, server_id) {
  if (server_id === undefined) {
    // Check if used
    return new Promise((resolve, reject) => {
      db.get(
        `SELECT 1 FROM tests WHERE telegram_id = ?`,
        [telegram_id],
        (err, row) => {
          if (err) reject(err);
          else resolve(!!row);
        }
      );
    });
  } else {
    // Record usage
    return new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO tests (telegram_id, server_id) VALUES (?, ?)`,
        [telegram_id, server_id],
        function (err) {
          if (err) reject(err);
          else resolve(false);
        }
      );
    });
  }
}

// Store key pair details - NEW FUNCTION
function storeKeyPair(telegram_id, server_id, key_name, private_key) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO key_pairs (telegram_id, server_id, key_name, private_key)
       VALUES (?, ?, ?, ?)`,
      [telegram_id, server_id, key_name, private_key],
      function (err) {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

// Get key pair details for a server - NEW FUNCTION
function getKeyPair(server_id) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT key_name, private_key FROM key_pairs WHERE server_id = ?`,
      [server_id],
      (err, row) => {
        if (err) reject(err);
        else resolve(row);
      }
    );
  });
}

// Delete key pair details for a server - NEW FUNCTION
function deleteKeyPairFromDb(server_id) {
  return new Promise((resolve, reject) => {
    db.run(
      `DELETE FROM key_pairs WHERE server_id = ?`,
      [server_id],
      function (err) {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}


module.exports = {
  upsertUser,
  getUserWallet,
  debitUser,
  creditUser, // Export new function
  recordPurchase,
  recordTestServer,
  storeKeyPair,   // Export new function
  getKeyPair,     // Export new function
  deleteKeyPairFromDb // Export new function
};
