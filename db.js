// db.js - Database utility functions using MySQL

require('dotenv').config();
const datacenters = require('./datacenters');
const HETZNER_DATACENTER_KEYS = Object.keys(datacenters).filter(key => {
  const dc = datacenters[key] || {};
  const provider = String(dc.provider || '').toLowerCase();
  const apiType = String(dc.apiType || '').toLowerCase();
  return provider === 'hetzner' || apiType === 'hetzner' || key === 'hetzner' || key.startsWith('hetzner-') || !!dc.HETZNER_LOCATION;
});
const hetznerDatacenterSqlList = HETZNER_DATACENTER_KEYS.map(key => `'${key.replace(/'/g, "''")}'`).join(',') || "'hetzner'";
const mysql = require('mysql2/promise');
const crypto = require('crypto');

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'hamooncloud_db',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

console.log('MySQL Pool initialized with host:', process.env.DB_HOST, 'database:', process.env.DB_NAME);
if (!process.env.SERVER_SECRET_KEY) {
    console.warn('[SECURITY] SERVER_SECRET_KEY is not set; secure server password storage is disabled.');
}

async function ensureColumn(connection, tableName, columnName, definition) {
    const [rows] = await connection.execute(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [tableName, columnName]
    );
    if (rows.length === 0) {
        await connection.execute(`ALTER TABLE \`${tableName}\` ADD COLUMN \`${columnName}\` ${definition}`);
    }
}

async function initializeDatabase() {
    let connection = null;
    try {
        connection = await pool.getConnection();
        console.log('Database connection obtained for initialization.');

        // Users table
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS users (
                telegram_id VARCHAR(255) PRIMARY KEY,
                phone VARCHAR(255),
                wallet DECIMAL(10, 2) DEFAULT 0.00,
                step VARCHAR(255) DEFAULT 'READY',
                national_code VARCHAR(10) NULL,
                shahkar_verified TINYINT(1) NOT NULL DEFAULT 0,
                shahkar_verified_at DATETIME NULL,
                shahkar_last_response TEXT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);

        await ensureColumn(connection, 'users', 'national_code', 'VARCHAR(10) NULL');
        await ensureColumn(connection, 'users', 'shahkar_verified', 'TINYINT(1) NOT NULL DEFAULT 0');
        await ensureColumn(connection, 'users', 'shahkar_verified_at', 'DATETIME NULL');
        await ensureColumn(connection, 'users', 'shahkar_last_response', 'TEXT NULL');
        // Purchases table
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS purchases (
                server_id VARCHAR(255) PRIMARY KEY,
                telegram_id VARCHAR(255) NOT NULL,
                datacenter VARCHAR(50) NOT NULL,
                server_name VARCHAR(255) NOT NULL,
                flavor_id VARCHAR(255) NOT NULL,
                amount DECIMAL(14, 6) NOT NULL,
                duration VARCHAR(50) NOT NULL,
                price_per_gb DECIMAL(10, 2) NOT NULL,
                download_only TINYINT(1) NOT NULL,
                boot_volume_id VARCHAR(255) NULL,
                boot_method VARCHAR(50) NOT NULL,
                os_label VARCHAR(255) NULL,
                status VARCHAR(50) NOT NULL,
                auto_renew TINYINT(1) NOT NULL DEFAULT 1,
                auto_renew_disabled_at DATETIME NULL,
                renewal_stopped_at DATETIME NULL,
                suspend_reason VARCHAR(64) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                last_billed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_billed_traffic_gb REAL DEFAULT 0.0,
                free_traffic_hourly_gb REAL DEFAULT 0.0,
                free_traffic_daily_gb REAL DEFAULT 0.0,
                free_traffic_weekly_gb REAL DEFAULT 0.0,
                free_traffic_monthly_gb REAL DEFAULT 0.0,
                ssh_key_id VARCHAR(255) NULL, 
                FOREIGN KEY (telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
            )
        `);

        await connection.execute('ALTER TABLE purchases MODIFY amount DECIMAL(14, 6) NOT NULL').catch(err => {
            console.warn('Could not widen purchases.amount:', err.message);
        });
        await ensureColumn(connection, 'purchases', 'auto_renew', 'TINYINT(1) NOT NULL DEFAULT 1');
        await ensureColumn(connection, 'purchases', 'auto_renew_disabled_at', 'DATETIME NULL');
        await ensureColumn(connection, 'purchases', 'renewal_stopped_at', 'DATETIME NULL');
        await ensureColumn(connection, 'purchases', 'suspend_reason', 'VARCHAR(64) NULL');
        await connection.execute('UPDATE purchases SET auto_renew = 1 WHERE auto_renew IS NULL').catch(err => {
            console.warn('Could not backfill purchases.auto_renew:', err.message);
        });


        await connection.execute(`
            CREATE TABLE IF NOT EXISTS server_secrets (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                telegram_id VARCHAR(64) NOT NULL,
                server_id VARCHAR(128) NOT NULL,
                datacenter VARCHAR(64) NOT NULL,
                secret_type VARCHAR(32) NOT NULL DEFAULT 'root_password',
                secret_value_enc TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_server_secret (server_id, secret_type)
            )
        `);

        // Key Pairs table
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS key_pairs (
                server_id VARCHAR(255) PRIMARY KEY,
                telegram_id VARCHAR(255) NOT NULL,
                key_name VARCHAR(255) NOT NULL,
                private_key TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
            )
        `);

        // Admin Audit Logs table
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS admin_audit_logs (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                actor VARCHAR(128),
                action VARCHAR(128),
                target_type VARCHAR(64),
                target_id VARCHAR(128),
                result VARCHAR(64) NULL,
                metadata JSON NULL,
                ip VARCHAR(64),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await ensureColumn(connection, 'admin_audit_logs', 'result', 'VARCHAR(64) NULL');

        await connection.execute(`
            CREATE TABLE IF NOT EXISTS api_clients (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                telegram_id VARCHAR(64) NOT NULL,
                name VARCHAR(191) NOT NULL,
                notes TEXT NULL,
                is_active TINYINT(1) DEFAULT 1,
                max_servers INT DEFAULT 2,
                max_monthly_spend DECIMAL(18,2) NULL,
                max_hourly_spend DECIMAL(18,2) NULL,
                allowed_datacenters TEXT NULL,
                allowed_plans TEXT NULL,
                allowed_images TEXT NULL,
                allowed_locations TEXT NULL,
                min_wallet_balance DECIMAL(18,2) DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS api_keys (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                client_id BIGINT NOT NULL,
                key_prefix VARCHAR(32) NOT NULL,
                key_hash VARCHAR(128) NOT NULL,
                label VARCHAR(191) NULL,
                scopes TEXT NULL,
                is_active TINYINT(1) DEFAULT 1,
                last_used_at DATETIME NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                revoked_at DATETIME NULL,
                UNIQUE KEY unique_key_hash (key_hash),
                INDEX key_prefix_idx (key_prefix)
            )
        `);
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS api_request_logs (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                client_id BIGINT NULL,
                telegram_id VARCHAR(64) NULL,
                key_prefix VARCHAR(32) NULL,
                method VARCHAR(16),
                path VARCHAR(255),
                status_code INT,
                ip VARCHAR(64),
                user_agent TEXT NULL,
                request_id VARCHAR(64) NULL,
                error_message TEXT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS api_usage_events (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                client_id BIGINT NOT NULL,
                telegram_id VARCHAR(64) NOT NULL,
                event_type VARCHAR(64),
                server_id VARCHAR(191) NULL,
                amount DECIMAL(18,2) DEFAULT 0,
                meta_json JSON NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Wallet Logs table
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS wallet_logs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                telegram_id VARCHAR(255) NOT NULL,
                amount DECIMAL(14, 6) NOT NULL,
                description TEXT NOT NULL,
                type VARCHAR(50) NOT NULL,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
            )
        `);

        // Test Servers table
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS test_servers (
                telegram_id VARCHAR(255) NOT NULL,
                datacenter VARCHAR(50) NOT NULL,
                server_id VARCHAR(255) NULL,
                boot_volume_id VARCHAR(255) NULL,
                used_at TIMESTAMP NULL,
                PRIMARY KEY (telegram_id, datacenter),
                FOREIGN KEY (telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
            )
        `);

        console.log('Database tables checked/created successfully.');
    } catch (error) {
        console.error('Error initializing database:', error.message || error);
        if (error.code === 'ER_BAD_DB_ERROR') {
            console.error(`ERROR: The database '${process.env.DB_NAME || 'hamooncloud_db'}' does not exist. Please create it.`);
        }
        throw error;
    } finally {
        if (connection) connection.release();
    }
}

if (process.env.DB_AUTO_INIT !== 'false') {
    initializeDatabase().catch((error) => {
        console.error('[DB_INIT] Initial database initialization failed; app can retry later:', error.message || error);
    });
}

async function upsertUser(userData) {
    const conn = await pool.getConnection();
    try {
        const [rows] = await conn.execute(
            'SELECT * FROM users WHERE telegram_id = ?',
            [String(userData.telegram_id)]
        );

        if (rows.length > 0) {
            let updateSql = 'UPDATE users SET updated_at = CURRENT_TIMESTAMP';
            const updateValues = [];
            if (userData.phone !== undefined) {
                updateSql += ', phone = ?';
                updateValues.push(userData.phone);
            }
            if (userData.wallet !== undefined) {
                updateSql += ', wallet = ?';
                updateValues.push(userData.wallet);
            }
            if (userData.step !== undefined) {
                updateSql += ', step = ?';
                updateValues.push(userData.step);
            }
            updateSql += ' WHERE telegram_id = ?';
            updateValues.push(String(userData.telegram_id));
            if (updateValues.length > 1) {
                await conn.execute(updateSql, updateValues);
            }
        } else {
            await conn.execute(
                'INSERT INTO users (telegram_id, phone, wallet, step) VALUES (?, ?, ?, ?)',
                [String(userData.telegram_id), userData.phone || null, userData.wallet || 0.00, userData.step || 'READY']
            );
        }
    } catch (error) {
        console.error('Error upserting user:', error);
        throw error;
    } finally {
        conn.release();
    }
}

async function getUser(telegramId) {
    const conn = await pool.getConnection();
    try {
        const [rows] = await conn.execute(
            'SELECT * FROM users WHERE telegram_id = ?',
            [String(telegramId)]
        );
        return rows.length > 0 ? rows[0] : null;
    } finally {
        conn.release();
    }
}


async function updateUserShahkar(telegramId, nationalCode, rawResponse) {
    const conn = await pool.getConnection();
    try {
        await conn.execute(
            `UPDATE users
             SET national_code = ?, shahkar_verified = 1, shahkar_verified_at = NOW(), shahkar_last_response = ?, updated_at = CURRENT_TIMESTAMP
             WHERE telegram_id = ?`,
            [String(nationalCode), JSON.stringify(rawResponse || null), String(telegramId)]
        );
    } finally {
        conn.release();
    }
}

async function getUserWallet(telegramId) {
    const user = await getUser(telegramId);
    return user && user.wallet !== undefined && user.wallet !== null ? parseFloat(user.wallet) : 0;
}

async function debitUser(telegramId, amount) {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const currentBalance = await getUserWallet(telegramId);
        if (currentBalance >= amount) {
            const [result] = await conn.execute(
                'UPDATE users SET wallet = wallet - ? WHERE telegram_id = ?',
                [amount, String(telegramId)]
            );
            if (result.affectedRows > 0) {
                await conn.commit();
                return true;
            }
        }
        await conn.rollback();
        return false;
    } catch (error) {
        await conn.rollback();
        console.error(`debitUser: Error debiting user ${telegramId}:`, error);
        throw error;
    } finally {
        conn.release();
    }
}

async function creditUser(telegramId, amount) {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [result] = await conn.execute(
            'UPDATE users SET wallet = wallet + ? WHERE telegram_id = ?',
            [amount, String(telegramId)]
        );
        if (result.affectedRows === 0) {
            await conn.execute(
                'INSERT INTO users (telegram_id, wallet) VALUES (?, ?)',
                [String(telegramId), amount]
            );
        }
        await conn.commit();
    } catch (error) {
        await conn.rollback();
        console.error(`creditUser: Error crediting user ${telegramId}:`, error);
        throw error;
    } finally {
        conn.release();
    }
}

async function recordWalletLog(telegramId, amount, description, type) {
    const conn = await pool.getConnection();
    try {
        await conn.execute(
            'INSERT INTO wallet_logs (telegram_id, amount, description, type) VALUES (?, ?, ?, ?)',
            [String(telegramId), amount, description, type]
        );
    } finally {
        conn.release();
    }
}

async function getWalletLogs(telegramId, limit) {
    const conn = await pool.getConnection();
    try {
        let query = 'SELECT amount, description, type, timestamp FROM wallet_logs WHERE telegram_id = ? ORDER BY timestamp DESC';
        const params = [String(telegramId)];
        if (limit !== null && limit > 0) {
            query += ` LIMIT ${parseInt(limit, 10)}`;
        }
        const [rows] = await conn.execute(query, params);
        return rows;
    } finally {
        conn.release();
    }
}

async function recordPurchase(telegramId, serverId, datacenter, serverName, flavorId, amount, duration, pricePerGb, downloadOnly, bootVolumeId, bootMethod, osLabel, lastBilledTrafficGb = 0.0, freeTrafficHourlyGb = 0.0, freeTrafficDailyGb = 0.0, freeTrafficWeeklyGb = 0.0, freeTrafficMonthlyGb = 0.0, sshKeyId = null, status = 'active') {
    const conn = await pool.getConnection();
    try {
        const values = [
            serverId, String(telegramId), datacenter, serverName, flavorId, amount, duration,
            pricePerGb, downloadOnly, bootVolumeId, bootMethod, osLabel, status,
            lastBilledTrafficGb, freeTrafficHourlyGb, freeTrafficDailyGb,
            freeTrafficWeeklyGb, freeTrafficMonthlyGb, sshKeyId
        ];


        await conn.execute(
  `INSERT INTO purchases (
     server_id, telegram_id, datacenter, server_name,
     flavor_id, amount, duration, price_per_gb, download_only,
     boot_volume_id, boot_method, os_label, status,
     last_billed_traffic_gb, free_traffic_hourly_gb, free_traffic_daily_gb,
     free_traffic_weekly_gb, free_traffic_monthly_gb, ssh_key_id,
     created_at, last_billed_at
   )
   VALUES (
     ?, ?, ?, ?,
     ?, ?, ?, ?, ?,
     ?, ?, ?, ?,
     ?, ?, ?,
     ?, ?, ?,
     CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
   )
   ON DUPLICATE KEY UPDATE
     telegram_id = VALUES(telegram_id),
     datacenter = VALUES(datacenter),
     server_name = VALUES(server_name),
     flavor_id = VALUES(flavor_id),
     amount = VALUES(amount),
     duration = VALUES(duration),
     price_per_gb = VALUES(price_per_gb),
     download_only = VALUES(download_only),
     boot_volume_id = VALUES(boot_volume_id),
     boot_method = VALUES(boot_method),
     os_label = VALUES(os_label),
     status = VALUES(status),
     last_billed_traffic_gb = VALUES(last_billed_traffic_gb),
     free_traffic_hourly_gb = VALUES(free_traffic_hourly_gb),
     free_traffic_daily_gb = VALUES(free_traffic_daily_gb),
     free_traffic_weekly_gb = VALUES(free_traffic_weekly_gb),
     free_traffic_monthly_gb = VALUES(free_traffic_monthly_gb),
     ssh_key_id = VALUES(ssh_key_id),
     updated_at = CURRENT_TIMESTAMP`,
  values
);

    } finally {
        conn.release();
    }
}

async function setPurchaseAutoRenew(telegramId, serverId, datacenter, enabled) {
  const conn = await pool.getConnection();
  try {
    const sql = enabled
      ? `UPDATE purchases
         SET auto_renew = 1,
             auto_renew_disabled_at = NULL,
             renewal_stopped_at = NULL,
             suspend_reason = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE telegram_id = ? AND server_id = ? AND datacenter = ?`
      : `UPDATE purchases
         SET auto_renew = 0,
             auto_renew_disabled_at = COALESCE(auto_renew_disabled_at, NOW()),
             updated_at = CURRENT_TIMESTAMP
         WHERE telegram_id = ? AND server_id = ? AND datacenter = ?`;
    const [result] = await conn.execute(sql, [String(telegramId), serverId, datacenter]);
    return result.affectedRows > 0;
  } finally {
    conn.release();
  }
}

async function setPurchaseRenewalStopped(serverId, reason = 'auto_renew_disabled') {
  const conn = await pool.getConnection();
  try {
    const [result] = await conn.execute(
      `UPDATE purchases
       SET status = 'suspended',
           renewal_stopped_at = NOW(),
           suspend_reason = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE server_id = ?`,
      [reason, serverId]
    );
    return result.affectedRows > 0;
  } finally {
    conn.release();
  }
}

async function updatePurchaseSuspendReason(serverId, reason) {
  const conn = await pool.getConnection();
  try {
    const [result] = await conn.execute(
      `UPDATE purchases SET suspend_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE server_id = ?`,
      [reason, serverId]
    );
    return result.affectedRows > 0;
  } finally {
    conn.release();
  }
}

async function getPurchaseByServerId(serverId) {
    const conn = await pool.getConnection();
    try {
        const [rows] = await conn.execute('SELECT * FROM purchases WHERE server_id = ?', [serverId]);
        return rows.length > 0 ? rows[0] : null;
    } finally {
        conn.release();
    }
}

async function getUserActivePurchases(telegramId) {
    const conn = await pool.getConnection();
    try {
        const [rows] = await conn.execute(
            `SELECT * FROM purchases
             WHERE telegram_id = ?
               AND (status IS NULL OR status NOT IN ('deleted','cancelled'))
             ORDER BY created_at DESC`,
            [String(telegramId)]
        );
        return rows;
    } finally {
        conn.release();
    }
}

async function getPurchaseForUserServer(telegramId, serverId, datacenter) {
    const conn = await pool.getConnection();
    try {
        const [rows] = await conn.execute(
            'SELECT * FROM purchases WHERE telegram_id = ? AND server_id = ? AND datacenter = ? LIMIT 1',
            [String(telegramId), String(serverId), datacenter]
        );
        return rows.length > 0 ? rows[0] : null;
    } finally {
        conn.release();
    }
}

async function updatePurchasePlan(telegramId, serverId, datacenter, flavorId, amount) {
    const conn = await pool.getConnection();
    try {
        const [res] = await conn.execute(
            `UPDATE purchases
             SET flavor_id = ?, amount = ?, status = 'active', updated_at = CURRENT_TIMESTAMP
             WHERE telegram_id = ? AND server_id = ? AND datacenter = ?`,
            [flavorId, amount, String(telegramId), String(serverId), datacenter]
        );
        return res.affectedRows > 0;
    } finally {
        conn.release();
    }
}

async function setPurchaseStatusForUser(telegramId, serverId, datacenter, status) {
    const conn = await pool.getConnection();
    try {
        const [res] = await conn.execute(
            'UPDATE purchases SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ? AND server_id = ? AND datacenter = ?',
            [status, String(telegramId), String(serverId), datacenter]
        );
        return res.affectedRows > 0;
    } finally {
        conn.release();
    }
}

async function recordServerUpgradeLog(telegramId, serverId, oldFlavor, newFlavor, oldAmount, newAmount) {
    const desc = `Server upgrade ${serverId}: ${oldFlavor} (${oldAmount}) -> ${newFlavor} (${newAmount})`;
    return recordWalletLog(telegramId, 0, desc, 'server_upgrade');
}

async function hasUsedFreeTestServer(telegramId, datacenter) {
    const conn = await pool.getConnection();
    try {
        const sql = 'SELECT * FROM test_servers WHERE telegram_id = ? AND datacenter = ?';
        const [rows] = await conn.execute(sql, [String(telegramId), datacenter]);
        return rows.length > 0;
    } finally {
        conn.release();
    }
}

async function recordTestServer(telegramId, datacenter, serverId, bootVolumeId) {
    const conn = await pool.getConnection();
    try {
        const sql = 'INSERT INTO test_servers (telegram_id, datacenter, server_id, boot_volume_id, used_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP) ON DUPLICATE KEY UPDATE server_id=VALUES(server_id), boot_volume_id=VALUES(boot_volume_id), used_at=VALUES(used_at)';
        await conn.execute(sql, [String(telegramId), datacenter, serverId, bootVolumeId]);
    } catch (error) {
        console.error(`[DB_RECORD_ERROR] Failed to record test server for user ${telegramId}:`, error);
        throw error;
    } finally {
        conn.release();
    }
}

async function deleteTestServer(serverId) {
    const conn = await pool.getConnection();
    try {
        await conn.execute(
            'DELETE FROM test_servers WHERE server_id = ?',
            [serverId]
        );
    } finally {
        conn.release();
    }
}

async function getAllPurchases() {
    const conn = await pool.getConnection();
    try {
        const [rows] = await conn.execute("SELECT * FROM purchases WHERE status != 'deleted'");
        return rows;
    } finally {
        conn.release();
    }
}



async function updatePurchaseStatus(serverId, newStatus, newLastBilledTrafficGb = undefined, newLastBilledAt = undefined) {
  const conn = await pool.getConnection();
  try {
    let sql = 'UPDATE purchases SET status = ?, updated_at = CURRENT_TIMESTAMP';
    const params = [newStatus];

    // فقط وقتی مقدار واقعی داریم ست کن (نه null و نه undefined)
    if (newLastBilledTrafficGb !== undefined && newLastBilledTrafficGb !== null) {
      sql += ', last_billed_traffic_gb = ?';
      params.push(newLastBilledTrafficGb);
    }

    if (newLastBilledAt !== undefined && newLastBilledAt !== null) {
      const formattedDate =
        newLastBilledAt instanceof Date
          ? newLastBilledAt.toISOString().slice(0, 19).replace('T', ' ')
          : newLastBilledAt; // فرض: رشتهٔ 'YYYY-MM-DD hh:mm:ss'
      sql += ', last_billed_at = ?';
      params.push(formattedDate);
    }

    // اگر اصلاً newLastBilledAt پاس داده نشد ولی داریم بیلینگ می‌کنیم،
    // بهتره خودمون NOW() ست کنیم. راه امن: یک فلگ اختیاری از کالِر بگیری،
    // ولی اگر نمی‌گیری، می‌تونی این راه ساده رو بذاری:
    if (
      (newLastBilledAt === undefined || newLastBilledAt === null) &&
      (newLastBilledTrafficGb !== undefined && newLastBilledTrafficGb !== null)
    ) {
      // چون ترافیک/شارژ ثبت می‌شه، زمان بیلینگ هم جلو بره
      sql += ', last_billed_at = NOW()';
      // اینجا پارامتر اضافه نمی‌کنیم
    }

    sql += ' WHERE server_id = ?';
    params.push(serverId);

    // (اختیاری) لاگِ دیباگ دقیق‌تر
    // console.log('updatePurchaseStatus SQL:', sql);
    // console.log('updatePurchaseStatus params:', params);

    await conn.execute(sql, params);
  } finally {
    conn.release();
  }
}


async function updatePurchaseOsLabel(serverId, newOsLabel) {
    const conn = await pool.getConnection();
    try {
        await conn.execute(
            'UPDATE purchases SET os_label = ?, updated_at = CURRENT_TIMESTAMP WHERE server_id = ?',
            [newOsLabel, serverId]
        );
    } catch (error) {
        console.error(`[DB_UPDATE_OS_ERROR] Failed to update OS label for server ${serverId}:`, error);
        throw error;
    } finally {
        conn.release();
    }
}

async function updatePurchaseBilling(serverId, pricePerGb, downloadOnly) {
    const conn = await pool.getConnection();
    try {
        await conn.execute(
            'UPDATE purchases SET price_per_gb = ?, download_only = ? WHERE server_id = ?',
            [pricePerGb, downloadOnly, serverId]
        );
    } finally {
        conn.release();
    }
}

async function updatePurchaseFreeTraffic(serverId, cycle, amountGb) {
    const conn = await pool.getConnection();
    try {
        const fieldName = `free_traffic_${cycle}_gb`;
        await conn.execute(
            'UPDATE purchases SET free_traffic_hourly_gb = 0, free_traffic_daily_gb = 0, free_traffic_weekly_gb = 0, free_traffic_monthly_gb = 0 WHERE server_id = ?',
            [serverId]
        );
        await conn.execute(
            `UPDATE purchases SET ${fieldName} = ? WHERE server_id = ?`,
            [amountGb, serverId]
        );
    } finally {
        conn.release();
    }
}

async function updatePurchaseCycle(serverId, newDuration) {
    const conn = await pool.getConnection();
    try {
        await conn.execute(
            'UPDATE purchases SET duration = ?, last_billed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE server_id = ?',
            [newDuration, serverId]
        );
    } catch (error) {
        console.error(`[DB_UPDATE_CYCLE_ERROR] Failed to update cycle for server ${serverId}:`, error);
        throw error;
    } finally {
        conn.release();
    }
}

async function storeKeyPair(telegramId, serverId, keyName, privateKey) {
    const conn = await pool.getConnection();
    try {
        await conn.execute(
            `INSERT INTO key_pairs (server_id, telegram_id, key_name, private_key) VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE key_name = VALUES(key_name), private_key = VALUES(private_key)`,
            [serverId, String(telegramId), keyName, privateKey]
        );
    } finally {
        conn.release();
    }
}


function getServerSecretKey() {
    if (!process.env.SERVER_SECRET_KEY) {
        const err = new Error('SERVER_SECRET_KEY_MISSING');
        err.code = 'SERVER_SECRET_KEY_MISSING';
        throw err;
    }
    return crypto.createHash('sha256').update(process.env.SERVER_SECRET_KEY).digest();
}

function encryptServerSecret(secretValue) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', getServerSecretKey(), iv);
    const data = Buffer.concat([cipher.update(String(secretValue), 'utf8'), cipher.final()]);
    return JSON.stringify({
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: data.toString('base64')
    });
}

function decryptServerSecret(payload) {
    const parsed = JSON.parse(payload);
    const decipher = crypto.createDecipheriv('aes-256-gcm', getServerSecretKey(), Buffer.from(parsed.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(parsed.data, 'base64')), decipher.final()]).toString('utf8');
}

async function upsertServerSecret({ telegramId, serverId, datacenter, secretType = 'root_password', secretValue }) {
    if (!telegramId || !serverId || !datacenter || !secretValue) throw new Error('INVALID_SERVER_SECRET_INPUT');
    const encrypted = encryptServerSecret(secretValue);
    const conn = await pool.getConnection();
    try {
        await conn.execute(
            `INSERT INTO server_secrets (telegram_id, server_id, datacenter, secret_type, secret_value_enc)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE telegram_id = VALUES(telegram_id), datacenter = VALUES(datacenter), secret_value_enc = VALUES(secret_value_enc)`,
            [String(telegramId), String(serverId), String(datacenter), String(secretType), encrypted]
        );
        return true;
    } finally {
        conn.release();
    }
}

async function getServerSecret(serverId, secretType = 'root_password') {
    if (!serverId) return null;
    const conn = await pool.getConnection();
    try {
        const [rows] = await conn.execute('SELECT secret_value_enc FROM server_secrets WHERE server_id = ? AND secret_type = ? LIMIT 1', [String(serverId), String(secretType)]);
        if (!rows.length) return null;
        return decryptServerSecret(rows[0].secret_value_enc);
    } finally {
        conn.release();
    }
}

async function getKeyPair(serverId) {
    const conn = await pool.getConnection();
    try {
        const [rows] = await conn.execute(
            'SELECT * FROM key_pairs WHERE server_id = ?',
            [serverId]
        );
        return rows.length > 0 ? rows[0] : null;
    } finally {
        conn.release();
    }
}

async function deleteKeyPairFromDb(serverId) {
    const conn = await pool.getConnection();
    try {
        await conn.execute(
            'DELETE FROM key_pairs WHERE server_id = ?',
            [serverId]
        );
    } finally {
        conn.release();
    }
}

function toLimit(value, fallback = 50, max = 200) {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(n, max);
}

function pageOffset(page, limit) {
    const p = Math.max(Number.parseInt(page, 10) || 1, 1);
    return (p - 1) * limit;
}

function maskLast4(value) {
    if (!value) return null;
    const text = String(value);
    if (text.length <= 4) return '****';
    return '*'.repeat(Math.max(4, text.length - 4)) + text.slice(-4);
}

async function ensureAdminAuditLogsTable() {
    const conn = await pool.getConnection();
    try {
        await conn.execute(`CREATE TABLE IF NOT EXISTS admin_audit_logs (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            actor VARCHAR(128),
            action VARCHAR(128),
            target_type VARCHAR(64),
            target_id VARCHAR(128),
            result VARCHAR(64) NULL,
            metadata JSON NULL,
            ip VARCHAR(64),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
    } finally { conn.release(); }
}

async function adminAuditLog(action, actor, target = {}, metadata = {}, ip = null) {
    await ensureAdminAuditLogsTable();
    const safeMeta = { ...(metadata || {}) };
    delete safeMeta.password; delete safeMeta.secret; delete safeMeta.token; delete safeMeta.rootPassword;
    const conn = await pool.getConnection();
    try {
        await conn.execute('INSERT INTO admin_audit_logs (actor, action, target_type, target_id, result, metadata, ip) VALUES (?, ?, ?, ?, ?, ?, ?)', [String(actor || 'admin'), String(action), String(target.type || target.target_type || 'unknown'), String(target.id || target.target_id || ''), String(metadata?.result || 'ok'), JSON.stringify(safeMeta), ip]);
    } finally { conn.release(); }
}


async function tableExists(connection, tableName) {
    const [rows] = await connection.query(
        'SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
        [tableName]
    );
    return rows.length > 0;
}

async function tableColumns(connection, tableName) {
    const [rows] = await connection.query(
        'SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
        [tableName]
    );
    return new Set(rows.map(r => r.COLUMN_NAME));
}

async function adminUserCanonicalSetSql(connection) {
    const sources = [];
    for (const table of ['users','wallet_logs','purchases','test_servers','key_pairs','server_secrets']) {
        if (await tableExists(connection, table)) sources.push(`SELECT CAST(telegram_id AS CHAR) telegram_id FROM ${table} WHERE telegram_id IS NOT NULL AND telegram_id <> ''`);
    }
    return sources.length ? sources.join(' UNION ') : "SELECT '' telegram_id WHERE 1=0";
}

function adminUserSortSql(sort) {
    return ({
        telegram_id: 'cu.telegram_id',
        wallet_balance: 'wallet_balance',
        wallet: 'wallet_balance',
        purchases_count: 'purchases_count',
        active_servers: 'active_servers',
        pending_servers: 'pending_servers',
        deleted_servers: 'deleted_servers',
        created_at: 'u.created_at',
        last_activity_at: 'last_activity_at'
    })[sort] || 'last_activity_at';
}

async function pingDatabase() { const conn = await pool.getConnection(); try { await conn.query('SELECT 1'); return true; } finally { conn.release(); } }


async function getAdminOverviewStats() {
    const conn = await pool.getConnection();
    try {
        const userSetSql = await adminUserCanonicalSetSql(conn);
        const [[users]] = await conn.query(`SELECT COUNT(*) totalUsers FROM (${userSetSql}) cu`);
        const [[walletTotal]] = await conn.query(`SELECT COALESCE(SUM(amount),0) totalWalletBalance FROM wallet_logs`);
        const [[shahkar]] = await conn.query(`SELECT COALESCE(SUM(shahkar_verified = 1),0) shahkarVerifiedUsers FROM users`).catch(async()=>[[{shahkarVerifiedUsers:0}]]);
        users.shahkarVerifiedUsers = shahkar.shahkarVerifiedUsers;
        users.totalWalletBalance = walletTotal.totalWalletBalance;
        const [[servers]] = await conn.query(`SELECT COALESCE(SUM(status='active'),0) activeServers, COALESCE(SUM(status IN ('pending_ssh','pending_ip','provisioning','building','deletion_pending','manual_review','provider_missing','provisioning_failed')),0) suspendedServers,
            COALESCE(SUM(status='deleted'),0) deletedServers, COUNT(*) totalPurchases,
            COALESCE(SUM(datacenter='afracloud'),0) afraServers, COALESCE(SUM(datacenter IN (${hetznerDatacenterSqlList})),0) hetznerServers,
            COALESCE(SUM(datacenter LIKE '%openstack%'),0) openstackServers, COALESCE(SUM(datacenter='tebyan'),0) tebyanServers,
            COALESCE(SUM(CASE WHEN status='active' THEN amount ELSE 0 END),0) estimatedMonthlyRevenue FROM purchases`);
        const [[purchases]] = await conn.query(`SELECT COALESCE(SUM(DATE(created_at)=CURDATE()),0) purchasesToday, COALESCE(SUM(created_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')),0) purchasesThisMonth FROM purchases`);
        const [[revenue]] = await conn.query(`SELECT COALESCE(SUM(CASE WHEN type IN ('credit','deposit','payment','topup','admin_credit') AND amount > 0 AND DATE(timestamp)=CURDATE() THEN amount ELSE 0 END),0) revenueToday,
            COALESCE(SUM(CASE WHEN type IN ('credit','deposit','payment','topup','admin_credit') AND amount > 0 AND timestamp >= DATE_FORMAT(CURDATE(), '%Y-%m-01') THEN amount ELSE 0 END),0) revenueThisMonth,
            COALESCE(SUM(CASE WHEN type IN ('credit','deposit','payment','topup','admin_credit') AND amount > 0 AND timestamp >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN amount ELSE 0 END),0) revenue30d,
            COALESCE(SUM(CASE WHEN type IN ('credit','deposit','payment','topup','admin_credit') AND amount > 0 THEN 1 ELSE 0 END),0) approvedTopups FROM wallet_logs`);
        const [[alerts]] = await conn.query(`SELECT COUNT(*) failedOperationsLast24h FROM admin_audit_logs WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR) AND action LIKE '%failed%'`).catch(async()=>[[{failedOperationsLast24h:0}]]);
        return { ...users, ...servers, ...purchases, ...revenue, ...alerts };
    } finally { conn.release(); }
}

function emptySeries(days) {
    const d = Math.min(Math.max(parseInt(days,10)||30,1),90);
    const out = [];
    const now = new Date();
    for (let i = d - 1; i >= 0; i--) {
        const x = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
        out.push({ day: x.toISOString().slice(0,10), value: 0 });
    }
    return out;
}

async function dailyStats(table, dateField, valueExpr, days = 30) {
    const series = emptySeries(days);
    const conn = await pool.getConnection();
    try {
        const [rows] = await conn.query(`SELECT DATE(${dateField}) day, ${valueExpr} value FROM ${table} WHERE ${dateField} >= DATE_SUB(CURDATE(), INTERVAL ? DAY) GROUP BY DATE(${dateField}) ORDER BY day`, [series.length]);
        const byDay = new Map(rows.map(r => [String(r.day).slice(0,10), Number(r.value) || 0]));
        return series.map(r => ({ ...r, value: byDay.get(r.day) || 0 }));
    } finally { conn.release(); }
}
async function getAdminRevenueStats(days) { return dailyStats('wallet_logs','timestamp',`COALESCE(SUM(CASE WHEN type IN ('credit','deposit','payment','topup','admin_credit') AND amount > 0 THEN amount ELSE 0 END),0)`,days); }
async function getAdminPurchaseStats(days) { return dailyStats('purchases','created_at','COUNT(*)',days); }
async function getAdminDatacenterStats() { const conn=await pool.getConnection(); try { const [rows]=await conn.query('SELECT datacenter, status, COUNT(*) count FROM purchases GROUP BY datacenter,status ORDER BY datacenter,status'); return rows; } finally {conn.release();} }
async function getAdminWalletFlowStats(days) {
    const credits = await dailyStats('wallet_logs','timestamp',`COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END),0)`,days);
    const debits = await dailyStats('wallet_logs','timestamp',`COALESCE(SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END),0)`,days);
    return credits.map((r,i)=>({ day:r.day, credits:r.value, debits:debits[i]?.value || 0 }));
}


const PENDING_SERVER_STATUSES = ['pending_ssh','pending_ip','provisioning','building','deletion_pending','manual_review','provider_missing','provisioning_failed'];
const REVENUE_WALLET_TYPES = ['credit','deposit','payment','topup','admin_credit'];
const APPROVED_TOPUP_TYPES = ['credit','deposit','payment','topup','admin_credit'];

function sqlIn(values) { return values.map(() => '?').join(','); }
function metricDateWhere(metric, field) {
    if (metric.endsWith('_today')) return `${field} >= CURDATE() AND ${field} < DATE_ADD(CURDATE(), INTERVAL 1 DAY)`;
    if (metric.endsWith('_month')) return `${field} >= DATE_FORMAT(CURDATE(), '%Y-%m-01')`;
    if (metric.endsWith('_30d')) return `${field} >= DATE_SUB(NOW(), INTERVAL 30 DAY)`;
    return '1=1';
}
function metricSort(sort, fallback, allow) { return allow[sort] || fallback; }
function withSearch(base, params, q, fields) {
    if (!q) return base;
    const like = `%${q}%`;
    params.push(...fields.map(() => like));
    return `${base} AND (${fields.map(f => `${f} LIKE ?`).join(' OR ')})`;
}

function metricConfig(metric) {
    const purchaseCols = [
        { key:'server_name', label:'نام سرور' }, { key:'server_id', label:'شناسه سرور' }, { key:'telegram_id', label:'کاربر' },
        { key:'datacenter', label:'دیتاسنتر' }, { key:'status', label:'وضعیت' }, { key:'amount', label:'مبلغ' }, { key:'created_at', label:'تاریخ ایجاد' }
    ];
    const walletCols = [
        { key:'telegram_id', label:'کاربر' }, { key:'amount', label:'مبلغ' }, { key:'type', label:'نوع' },
        { key:'description', label:'شرح' }, { key:'timestamp', label:'زمان' }
    ];
    const purchaseSelect = 'p.server_id,p.telegram_id,p.datacenter,p.server_name,p.flavor_id,p.amount,p.duration,p.status,p.created_at,p.updated_at,u.phone';
    const configs = {
        users_total: { title:'کل کاربران', kind:'users', columns:[{key:'telegram_id',label:'تلگرام'},{key:'phone_masked',label:'تلفن'},{key:'wallet',label:'کیف پول'},{key:'purchases_count',label:'خریدها'},{key:'active_servers',label:'سرور فعال'},{key:'created_at',label:'ایجاد'}], where:'1=1' },
        users_with_positive_balance: { title:'کاربران دارای موجودی مثبت', kind:'users', columns:[{key:'telegram_id',label:'تلگرام'},{key:'phone_masked',label:'تلفن'},{key:'wallet',label:'کیف پول'},{key:'created_at',label:'ایجاد'}], where:'u.wallet > 0' },
        total_balance: { title:'موجودی کل کاربران', kind:'users', sumField:'wallet', columns:[{key:'telegram_id',label:'تلگرام'},{key:'phone_masked',label:'تلفن'},{key:'wallet',label:'موجودی'},{key:'updated_at',label:'آخرین تغییر'}], where:'u.wallet <> 0' },
        approved_topups: { title:'شارژهای تأیید شده', kind:'wallet', columns:walletCols, where:`w.amount > 0 AND w.type IN (${sqlIn(APPROVED_TOPUP_TYPES)})`, params:[...APPROVED_TOPUP_TYPES] },
        servers_active: { title:'سرورهای فعال', kind:'purchases', columns:purchaseCols, where:"p.status IN ('active')" },
        servers_pending: { title:'سرورهای معلق/در انتظار', kind:'purchases', columns:purchaseCols, where:`p.status IN (${sqlIn(PENDING_SERVER_STATUSES)})`, params:[...PENDING_SERVER_STATUSES] },
        servers_deleted: { title:'سرورهای حذف‌شده', kind:'purchases', columns:purchaseCols, where:"p.status='deleted'" },
        purchases_total: { title:'کل خریدها', kind:'purchases', columns:purchaseCols, where:'1=1' },
        purchases_today: { title:'خریدهای امروز', kind:'purchases', columns:purchaseCols, where:metricDateWhere('purchases_today','p.created_at') },
        purchases_month: { title:'خریدهای ماه جاری', kind:'purchases', columns:purchaseCols, where:metricDateWhere('purchases_month','p.created_at') },
        revenue_today: { title:'درآمد امروز', kind:'wallet', columns:walletCols, where:`w.amount > 0 AND w.type IN (${sqlIn(REVENUE_WALLET_TYPES)}) AND ${metricDateWhere('revenue_today','w.timestamp')}`, params:[...REVENUE_WALLET_TYPES] },
        revenue_month: { title:'درآمد ماه', kind:'wallet', columns:walletCols, where:`w.amount > 0 AND w.type IN (${sqlIn(REVENUE_WALLET_TYPES)}) AND ${metricDateWhere('revenue_month','w.timestamp')}`, params:[...REVENUE_WALLET_TYPES] },
        revenue_30d: { title:'درآمد ۳۰ روز', kind:'wallet', columns:walletCols, where:`w.amount > 0 AND w.type IN (${sqlIn(REVENUE_WALLET_TYPES)}) AND ${metricDateWhere('revenue_30d','w.timestamp')}`, params:[...REVENUE_WALLET_TYPES] },
        datacenter_tebyan: { title:'سرورهای Tebyan', kind:'purchases', columns:purchaseCols, where:"p.datacenter='tebyan'" },
        datacenter_hetzner: { title:'سرورهای Hetzner', kind:'purchases', columns:purchaseCols, where:`p.datacenter IN (${hetznerDatacenterSqlList})` },
        datacenter_afracloud: { title:'سرورهای AfraCloud', kind:'purchases', columns:purchaseCols, where:"p.datacenter='afracloud'" },
        datacenter_openstack: { title:'سرورهای OpenStack', kind:'purchases', columns:purchaseCols, where:"p.datacenter LIKE '%openstack%'" },
        errors_24h: { title:'خطاهای ۲۴ ساعت', kind:'audit', columns:[{key:'actor',label:'ادمین'},{key:'action',label:'عملیات'},{key:'target_type',label:'نوع'},{key:'target_id',label:'هدف'},{key:'metadata',label:'جزئیات'},{key:'created_at',label:'زمان'}], where:"a.created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR) AND a.action LIKE '%failed%'" }
    };
    const cfg = configs[metric];
    if (cfg && cfg.kind === 'purchases') cfg.select = purchaseSelect;
    return cfg || null;
}

async function getAdminMetricDetails(metric, filters = {}) {
    await ensureAdminAuditLogsTable().catch(() => {});
    const cfg = metricConfig(metric);
    if (!cfg) return null;
    const pageSize = toLimit(filters.pageSize || filters.limit, 50, 200);
    const page = Math.max(parseInt(filters.page, 10) || 1, 1);
    const offset = (page - 1) * pageSize;
    const params = [...(cfg.params || [])];
    let where = cfg.where || '1=1';
    const q = String(filters.q || filters.search || '').trim();
    const dir = String(filters.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const conn = await pool.getConnection();
    try {
        let rows, count, metricTotal;
        if (cfg.kind === 'users') {
            where = withSearch(where, params, q, ['u.telegram_id','u.phone','u.national_code']);
            const sort = metricSort(filters.sort, 'u.created_at', {telegram_id:'u.telegram_id', wallet:'u.wallet', created_at:'u.created_at', updated_at:'u.updated_at'});
            [rows] = await conn.query(`SELECT u.telegram_id,u.phone,u.wallet,u.created_at,u.updated_at,COUNT(p.server_id) purchases_count,COALESCE(SUM(p.status='active'),0) active_servers FROM users u LEFT JOIN purchases p ON p.telegram_id=u.telegram_id WHERE ${where} GROUP BY u.telegram_id ORDER BY ${sort} ${dir} LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
            [[count]] = await conn.query(`SELECT COUNT(*) total FROM users u WHERE ${where}`, params);
            if (metric === 'total_balance') { [[metricTotal]] = await conn.query(`SELECT COALESCE(SUM(u.wallet),0) total FROM users u WHERE ${where}`, params); }
            rows.forEach(r => { r.phone_masked = maskLast4(r.phone); delete r.phone; });
        } else if (cfg.kind === 'wallet') {
            where = withSearch(where, params, q, ['w.telegram_id','w.description','w.type']);
            const sort = metricSort(filters.sort, 'w.timestamp', {telegram_id:'w.telegram_id', amount:'w.amount', type:'w.type', timestamp:'w.timestamp'});
            [rows] = await conn.query(`SELECT w.id,w.telegram_id,w.amount,w.type,w.description,w.timestamp,u.wallet current_balance FROM wallet_logs w LEFT JOIN users u ON u.telegram_id=w.telegram_id WHERE ${where} ORDER BY ${sort} ${dir} LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
            [[count]] = await conn.query(`SELECT COUNT(*) total FROM wallet_logs w WHERE ${where}`, params);
            if (metric.startsWith('revenue_')) { [[metricTotal]] = await conn.query(`SELECT COALESCE(SUM(w.amount),0) total FROM wallet_logs w WHERE ${where}`, params); }
        } else if (cfg.kind === 'audit') {
            where = withSearch(where, params, q, ['a.actor','a.action','a.target_type','a.target_id']);
            const sort = metricSort(filters.sort, 'a.created_at', {actor:'a.actor', action:'a.action', target_id:'a.target_id', created_at:'a.created_at'});
            [rows] = await conn.query(`SELECT a.* FROM admin_audit_logs a WHERE ${where} ORDER BY ${sort} ${dir} LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
            [[count]] = await conn.query(`SELECT COUNT(*) total FROM admin_audit_logs a WHERE ${where}`, params);
        } else {
            where = withSearch(where, params, q, ['p.server_id','p.server_name','p.telegram_id','p.datacenter','p.status','p.flavor_id','u.phone']);
            const sort = metricSort(filters.sort, 'p.created_at', {server_id:'p.server_id', server_name:'p.server_name', telegram_id:'p.telegram_id', datacenter:'p.datacenter', status:'p.status', amount:'p.amount', created_at:'p.created_at'});
            [rows] = await conn.query(`SELECT ${cfg.select} FROM purchases p LEFT JOIN users u ON u.telegram_id=p.telegram_id WHERE ${where} ORDER BY ${sort} ${dir} LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
            [[count]] = await conn.query(`SELECT COUNT(*) total FROM purchases p LEFT JOIN users u ON u.telegram_id=p.telegram_id WHERE ${where}`, params);
        }
        return { ok:true, metric, title:cfg.title, total:Number((metricTotal || count).total)||0, rowTotal:Number(count.total)||0, page, pageSize, columns:cfg.columns, rows };
    } finally { conn.release(); }
}


const ADMIN_TEXT_COLLATE = 'utf8mb4_unicode_ci';
const ADMIN_IP_FIELDS = ['public_ip','ip','server_ip','ipv4','access_ip_v4','accessIPv4','main_ip','ip_address'];
function adminLikeExpr(expr) { return `CONVERT(${expr} USING utf8mb4) COLLATE ${ADMIN_TEXT_COLLATE} LIKE ?`; }
function purchaseIpSql(cols, alias='p') {
    const parts = ADMIN_IP_FIELDS.filter(c => cols.has(c)).map(c => `NULLIF(${alias}.${c}, '')`);
    for (const raw of ['provider_response','provider_raw','raw_response','metadata','extra','details']) {
        if (!cols.has(raw)) continue;
        parts.push(`NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${alias}.${raw}, '$.public_ip')), '')`);
        parts.push(`NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${alias}.${raw}, '$.ip')), '')`);
        parts.push(`NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${alias}.${raw}, '$.server_ip')), '')`);
        parts.push(`NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${alias}.${raw}, '$.ipv4')), '')`);
        parts.push(`NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${alias}.${raw}, '$.access_ip_v4')), '')`);
        parts.push(`NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${alias}.${raw}, '$.accessIPv4')), '')`);
        parts.push(`NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${alias}.${raw}, '$.main_ip')), '')`);
        parts.push(`NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${alias}.${raw}, '$.addresses.*[0].addr')), '')`);
        parts.push(`NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${alias}.${raw}, '$.addresses.*[1].addr')), '')`);
    }
    return parts.length ? `COALESCE(${parts.join(', ')})` : 'NULL';
}
function attachPublicIp(row) { row.public_ip = row.public_ip || row.ip_address || row.ip || null; row.ip_address = row.public_ip; row.ip = row.public_ip; return row; }
async function globalAdminSearch(q, limit = 8) {
    const text = String(q || '').trim();
    if (!text) return { users: [], servers: [], purchases: [] };
    const like = `%${text}%`;
    const lim = toLimit(limit, 8, 20);
    const conn = await pool.getConnection();
    try {
        const userCols = await tableColumns(conn, 'users');
        const purchaseCols = await tableColumns(conn, 'purchases');
        const userSearch = ['telegram_id','phone','national_code','national_id','username','first_name','last_name'].filter(c => userCols.has(c)).map(c => `u.${c}`); if (userCols.has('first_name') && userCols.has('last_name')) userSearch.push("CONCAT_WS(' ', u.first_name, u.last_name)");
        const userClauses = userSearch.map(adminLikeExpr);
        const [users] = await conn.query(`SELECT u.telegram_id, u.phone, u.wallet, u.created_at FROM users u WHERE ${userClauses.join(' OR ')} ORDER BY u.created_at DESC LIMIT ?`, [...Array(userClauses.length).fill(like), lim]);
        users.forEach(r => { r.phone_masked = maskLast4(r.phone); delete r.phone; });
        const ipExpr = purchaseIpSql(purchaseCols, 'p');
        const serverExprs = ['p.server_id','p.server_name','p.telegram_id','p.datacenter','p.status','p.os_label','p.flavor_id', ipExpr];
        const serverClauses = serverExprs.map(adminLikeExpr);
        const [servers] = await conn.query(`SELECT p.server_id, p.telegram_id, p.server_name, p.datacenter, p.status, p.os_label, p.flavor_id, p.created_at, ${ipExpr} public_ip FROM purchases p WHERE status NOT IN ('deleted','deletion_pending','provider_missing','manual_review') AND (${serverClauses.join(' OR ')}) ORDER BY p.created_at DESC LIMIT ?`, [...Array(serverClauses.length).fill(like), lim]);
        servers.forEach(attachPublicIp);
        return { users, servers, purchases: servers };
    } finally { conn.release(); }
}

async function listAdminUsers(filters = {}) {
    const pageSize = toLimit(filters.pageSize || filters.limit, 50, 200);
    const page = Math.max(parseInt(filters.page, 10) || 1, 1);
    const offset = (page - 1) * pageSize;
    const q = String(filters.q || filters.search || '').trim();
    const status = String(filters.status || '').trim();
    const datacenter = String(filters.datacenter || '').trim();
    const dir = String(filters.dir || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const conn = await pool.getConnection();
    try {
        const userCols = await tableColumns(conn, 'users');
        const canonicalSql = await adminUserCanonicalSetSql(conn);
        const searchCandidates = ['phone','phone_number','national_id','national_code','card_number','username','first_name','last_name','name'];
        const searchCols = searchCandidates.filter(c => userCols.has(c));
        const phoneExpr = userCols.has('phone') ? 'u.phone' : (userCols.has('phone_number') ? 'u.phone_number' : 'NULL');
        const nationalExpr = userCols.has('national_id') ? 'u.national_id' : (userCols.has('national_code') ? 'u.national_code' : 'NULL');
        const shahkarExpr = userCols.has('shahkar_verified') ? 'u.shahkar_verified' : 'NULL';
        const createdExpr = userCols.has('created_at') ? 'u.created_at' : 'NULL';
        const updatedExpr = userCols.has('updated_at') ? 'u.updated_at' : 'NULL';
        const where = [];
        const params = [];
        if (q) {
            const like = `%${q}%`;
            const clauses = ['cu.telegram_id = ?', 'cu.telegram_id LIKE ?'];
            params.push(q, like);
            for (const col of searchCols) { clauses.push(adminLikeExpr(`u.${col}`)); params.push(like); }
            clauses.push(`EXISTS (SELECT 1 FROM purchases ps WHERE ps.telegram_id = cu.telegram_id AND (${[adminLikeExpr('ps.server_id'), adminLikeExpr('ps.datacenter'), adminLikeExpr('ps.server_name')].join(' OR ')}))`); params.push(like, like, like);
            where.push(`(${clauses.join(' OR ')})`);
        }
        if (status) { where.push('EXISTS (SELECT 1 FROM purchases ps WHERE ps.telegram_id = cu.telegram_id AND ps.status = ?)'); params.push(status); }
        if (datacenter) { where.push('EXISTS (SELECT 1 FROM purchases pd WHERE pd.telegram_id = cu.telegram_id AND pd.datacenter = ?)'); params.push(datacenter); }
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const pending = PENDING_SERVER_STATUSES;
        const baseFrom = `FROM (${canonicalSql}) cu
            LEFT JOIN users u ON u.telegram_id = cu.telegram_id
            LEFT JOIN (SELECT telegram_id, COALESCE(SUM(amount),0) wallet_balance, MAX(timestamp) last_wallet_log_at FROM wallet_logs GROUP BY telegram_id) wl ON wl.telegram_id = cu.telegram_id
            LEFT JOIN (SELECT telegram_id, COUNT(*) purchases_count,
                    COALESCE(SUM(status='active'),0) active_servers,
                    COALESCE(SUM(status IN (${sqlIn(pending)})),0) pending_servers,
                    COALESCE(SUM(status='deleted'),0) deleted_servers,
                    MAX(created_at) last_purchase_at
                FROM purchases GROUP BY telegram_id) pa ON pa.telegram_id = cu.telegram_id`;
        const sort = adminUserSortSql(filters.sort);
        const select = `SELECT cu.telegram_id, ${phoneExpr} phone, ${nationalExpr} national_id, ${shahkarExpr} shahkar_verified,
                COALESCE(wl.wallet_balance,0) wallet_balance, COALESCE(wl.wallet_balance,0) wallet,
                COALESCE(pa.purchases_count,0) purchases_count, COALESCE(pa.active_servers,0) active_servers,
                COALESCE(pa.pending_servers,0) pending_servers, COALESCE(pa.deleted_servers,0) deleted_servers,
                pa.last_purchase_at, wl.last_wallet_log_at, ${createdExpr} created_at, ${updatedExpr} updated_at,
                GREATEST(COALESCE(pa.last_purchase_at,'1000-01-01'), COALESCE(wl.last_wallet_log_at,'1000-01-01'), COALESCE(${createdExpr},'1000-01-01'), COALESCE(${updatedExpr},'1000-01-01')) last_activity_at`;
        const [rows] = await conn.query(`${select} ${baseFrom} ${whereSql} ORDER BY ${sort} ${dir}, cu.telegram_id ASC LIMIT ? OFFSET ?`, [...pending, ...params, pageSize, offset]);
        const [[count]] = await conn.query(`SELECT COUNT(*) total ${baseFrom} ${whereSql}`, [...pending, ...params]);
        rows.forEach(r => {
            r.phone = maskLast4(r.phone);
            r.phone_masked = r.phone;
            r.national_id = maskLast4(r.national_id);
            r.national_id_masked = r.national_id;
            r.national_code_masked = r.national_id;
            if (String(r.last_activity_at).startsWith('1000-01-01')) r.last_activity_at = null;
        });
        return { ok: true, page, pageSize, total: count.total, rows };
    } finally { conn.release(); }
}

async function getAdminUserDetail(telegramId) { const conn=await pool.getConnection(); try { const [[user]]=await conn.query('SELECT telegram_id,phone,wallet,step,national_code,shahkar_verified,shahkar_verified_at,created_at,updated_at FROM users WHERE telegram_id=?',[String(telegramId)]); if(!user)return null; user.national_code_masked=maskLast4(user.national_code); delete user.national_code; const [wallet_logs]=await conn.query('SELECT * FROM wallet_logs WHERE telegram_id=? ORDER BY timestamp DESC LIMIT 100',[String(telegramId)]); const purchaseCols=await tableColumns(conn,'purchases'); const ipExpr=purchaseIpSql(purchaseCols,'p'); const [purchases]=await conn.query(`SELECT p.*, ${ipExpr} public_ip FROM purchases p WHERE p.telegram_id=? ORDER BY p.created_at DESC LIMIT 100`,[String(telegramId)]); purchases.forEach(attachPublicIp); return { user, wallet_logs, purchases, servers:purchases, active_purchases:purchases.filter(p=>p.status!=='deleted') }; } finally {conn.release();} }
async function listAdminServers(filters={}) {
    const limit=toLimit(filters.pageSize || filters.limit); const offset=pageOffset(filters.page,limit); const where=[]; const params=[]; const q=String(filters.q || filters.search || '').trim();
    const conn=await pool.getConnection();
    try{ const purchaseCols=await tableColumns(conn,'purchases'); const userCols=await tableColumns(conn,'users'); const ipExpr=purchaseIpSql(purchaseCols,'p');
    if(q){ const like='%'+q+'%'; const exprs=['p.server_id','p.server_name','p.telegram_id','p.datacenter','p.status','p.os_label','p.flavor_id','p.duration','p.amount','p.created_at',ipExpr]; if(userCols.has('phone'))exprs.push('u.phone'); if(userCols.has('username'))exprs.push('u.username'); if(userCols.has('first_name'))exprs.push('u.first_name'); if(userCols.has('last_name'))exprs.push('u.last_name'); where.push('('+exprs.map(adminLikeExpr).join(' OR ')+')'); params.push(...Array(exprs.length).fill(like)); }
    ['datacenter','status','duration','flavor_id'].forEach(k=>{if(filters[k]){where.push('p.'+k+'=?');params.push(filters[k]);}});
    if(filters.provider){where.push('p.datacenter=?');params.push(filters.provider);} if(filters.hasPassword==='yes')where.push("EXISTS(SELECT 1 FROM server_secrets ss WHERE ss.server_id=p.server_id AND ss.secret_type='root_password')"); if(filters.hasPassword==='no')where.push("NOT EXISTS(SELECT 1 FROM server_secrets ss WHERE ss.server_id=p.server_id AND ss.secret_type='root_password')"); if(filters.userId){where.push('p.telegram_id=?');params.push(String(filters.userId));}
    const sortAllow={created_at:'p.created_at',server_id:'p.server_id',server_name:'p.server_name',telegram_id:'p.telegram_id',datacenter:'p.datacenter',status:'p.status',duration:'p.duration',amount:'p.amount'}; const sort=sortAllow[filters.sort]||'p.created_at'; const dir=String(filters.dir).toLowerCase()==='asc'?'ASC':'DESC'; const whereSql=where.length?'WHERE '+where.join(' AND '):'';
    const [rows]=await conn.query(`SELECT p.*, ${ipExpr} public_ip, u.phone, EXISTS(SELECT 1 FROM server_secrets ss WHERE ss.server_id=p.server_id AND ss.secret_type='root_password') password_stored FROM purchases p LEFT JOIN users u ON u.telegram_id=p.telegram_id ${whereSql} ORDER BY ${sort} ${dir} LIMIT ? OFFSET ?`,[...params,limit,offset]); const [[count]]=await conn.query(`SELECT COUNT(*) total FROM purchases p LEFT JOIN users u ON u.telegram_id=p.telegram_id ${whereSql}`,params); rows.forEach(attachPublicIp); return {rows,page:Number(filters.page)||1,pageSize:limit,limit,total:count.total};}finally{conn.release();}
}
async function getAdminServerDetail(serverId){ const conn=await pool.getConnection(); try{const purchaseCols=await tableColumns(conn,'purchases'); const ipExpr=purchaseIpSql(purchaseCols,'p'); const [[purchase]]=await conn.query(`SELECT p.*, ${ipExpr} public_ip,u.phone,u.wallet, EXISTS(SELECT 1 FROM server_secrets ss WHERE ss.server_id=p.server_id AND ss.secret_type='root_password') password_stored FROM purchases p LEFT JOIN users u ON u.telegram_id=p.telegram_id WHERE p.server_id=?`,[String(serverId)]); if(!purchase)return null; attachPublicIp(purchase); const [wallet_logs]=await conn.query('SELECT * FROM wallet_logs WHERE telegram_id=? AND description LIKE ? ORDER BY timestamp DESC LIMIT 50',[String(purchase.telegram_id),'%'+serverId+'%']); return {purchase,user:{telegram_id:purchase.telegram_id,phone:purchase.phone,wallet:purchase.wallet},wallet_logs,password_stored:!!purchase.password_stored};}finally{conn.release();}}


async function listAdminPurchases(filters={}){return listAdminServers(filters);}
async function listAdminWalletLogs(filters={}){const limit=toLimit(filters.pageSize || filters.limit); const offset=pageOffset(filters.page,limit); const where=[]; const params=[]; const q=String(filters.q || filters.search || '').trim(); if(q){const like='%'+q+'%'; const exprs=['w.telegram_id','w.description','w.type','w.amount','w.timestamp','u.wallet']; where.push('('+exprs.map(adminLikeExpr).join(' OR ')+')');params.push(...Array(exprs.length).fill(like));} if(filters.type){where.push('w.type=?');params.push(filters.type);} if(filters.from){where.push('w.timestamp>=?');params.push(filters.from);} if(filters.to){where.push('w.timestamp<=?');params.push(filters.to);} const whereSql=where.length?'WHERE '+where.join(' AND '):''; const conn=await pool.getConnection(); try{const [rows]=await conn.query(`SELECT w.*,u.wallet current_balance FROM wallet_logs w LEFT JOIN users u ON u.telegram_id=w.telegram_id ${whereSql} ORDER BY w.timestamp DESC LIMIT ? OFFSET ?`,[...params,limit,offset]); const [[count]]=await conn.query(`SELECT COUNT(*) total FROM wallet_logs w LEFT JOIN users u ON u.telegram_id=w.telegram_id ${whereSql}`,params); return {rows,page:Number(filters.page)||1,pageSize:limit,limit,total:count.total};}finally{conn.release();}}

async function adminCreditUser(telegramId, amount, description='شارژ کیف پول توسط ادمین'){ await creditUser(telegramId, Number(amount)); await recordWalletLog(telegramId, Number(amount), description, 'admin_credit'); return getUserWallet(telegramId); }
async function adminDebitUser(telegramId, amount, description='کسر کیف پول توسط ادمین'){ const ok=await debitUser(telegramId, Number(amount)); if(!ok) throw new Error('INSUFFICIENT_BALANCE'); await recordWalletLog(telegramId, -Math.abs(Number(amount)), description, 'admin_debit'); return getUserWallet(telegramId); }
async function adminUpdatePurchaseStatus(idOrServerId,status){ await updatePurchaseStatus(idOrServerId,status); return getPurchaseByServerId(idOrServerId); }
async function listAdminAuditLogs(limit=200){await ensureAdminAuditLogsTable(); const conn=await pool.getConnection(); try{const [rows]=await conn.query('SELECT * FROM admin_audit_logs ORDER BY created_at DESC LIMIT ?',[toLimit(limit,200,500)]); return rows;}finally{conn.release();}}


async function getUserRestartablePurchases(telegramId) {
  const [rows] = await pool.query(`
    SELECT *
    FROM purchases
    WHERE telegram_id = ?
      AND status IN (
        'suspended',
        'stopped',
        'stop',
        'shutoff',
        'powered_off',
        'poweroff',
        'paused',
        'shelved',
        'shelved_offloaded'
      )
    ORDER BY updated_at DESC, created_at DESC
  `, [telegramId]);

  return rows;
}

function apiKeyHash(rawKey) {
    return crypto.createHash('sha256').update(String(rawKey || '')).digest('hex');
}
function parseCsvText(value) {
    if (Array.isArray(value)) return value.filter(Boolean).join(',');
    return value == null ? null : String(value);
}
async function createApiClient({ telegramId, name, notes = null, maxServers = 2, maxMonthlySpend = null, maxHourlySpend = null, allowedDatacenters = 'hetzner', allowedPlans = null, allowedImages = null, allowedLocations = null, minWalletBalance = 0, isActive = 1 }) {
    await pool.execute(`INSERT IGNORE INTO users (telegram_id, wallet, step) VALUES (?, 0, 'READY')`, [String(telegramId)]);
    const [r] = await pool.execute(`INSERT INTO api_clients (telegram_id,name,notes,is_active,max_servers,max_monthly_spend,max_hourly_spend,allowed_datacenters,allowed_plans,allowed_images,allowed_locations,min_wallet_balance) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [String(telegramId), String(name || telegramId), notes, isActive ? 1 : 0, Number(maxServers || 2), maxMonthlySpend, maxHourlySpend, parseCsvText(allowedDatacenters), parseCsvText(allowedPlans), parseCsvText(allowedImages), parseCsvText(allowedLocations), Number(minWalletBalance || 0)]);
    return getApiClientById(r.insertId);
}
async function listApiClients() {
    const [rows] = await pool.execute(`SELECT c.*, u.wallet, COUNT(DISTINCT CASE WHEN k.is_active=1 THEN k.id END) active_keys, MAX(k.last_used_at) last_used_at, COUNT(DISTINCT CASE WHEN p.status NOT IN ('deleted','deletion_pending','provider_missing') THEN p.server_id END) active_servers FROM api_clients c LEFT JOIN users u ON u.telegram_id COLLATE utf8mb4_unicode_ci = c.telegram_id COLLATE utf8mb4_unicode_ci LEFT JOIN api_keys k ON k.client_id=c.id LEFT JOIN purchases p ON p.telegram_id COLLATE utf8mb4_unicode_ci = c.telegram_id COLLATE utf8mb4_unicode_ci AND p.datacenter IN (${hetznerDatacenterSqlList}) GROUP BY c.id ORDER BY c.created_at DESC`);
    return rows;
}
async function getApiClientById(clientId) {
    const [rows] = await pool.execute(`SELECT c.*, u.wallet FROM api_clients c LEFT JOIN users u ON u.telegram_id COLLATE utf8mb4_unicode_ci = c.telegram_id COLLATE utf8mb4_unicode_ci WHERE c.id=?`, [clientId]);
    return rows[0] || null;
}
async function updateApiClient(clientId, fields = {}) {
    const allowed = { name:'name', notes:'notes', isActive:'is_active', maxServers:'max_servers', maxMonthlySpend:'max_monthly_spend', maxHourlySpend:'max_hourly_spend', allowedDatacenters:'allowed_datacenters', allowedPlans:'allowed_plans', allowedImages:'allowed_images', allowedLocations:'allowed_locations', minWalletBalance:'min_wallet_balance' };
    const sets=[]; const vals=[];
    for (const [k,col] of Object.entries(allowed)) if (fields[k] !== undefined) { sets.push(`${col}=?`); vals.push(k.startsWith('allowed') ? parseCsvText(fields[k]) : fields[k]); }
    if (sets.length) await pool.execute(`UPDATE api_clients SET ${sets.join(', ')} WHERE id=?`, [...vals, clientId]);
    return getApiClientById(clientId);
}
async function createApiKey(clientId, label = null, scopes = null) {
    const rawKey = `hm_live_${crypto.randomBytes(32).toString('base64url')}`;
    const keyPrefix = rawKey.slice(0, 16);
    await pool.execute(`INSERT INTO api_keys (client_id,key_prefix,key_hash,label,scopes) VALUES (?,?,?,?,?)`, [clientId, keyPrefix, apiKeyHash(rawKey), label, parseCsvText(scopes)]);
    return { rawKey, key_prefix: keyPrefix };
}
async function listApiKeys(clientId) { const [rows] = await pool.execute(`SELECT id,client_id,key_prefix,label,scopes,is_active,last_used_at,created_at,revoked_at FROM api_keys WHERE client_id=? ORDER BY created_at DESC`, [clientId]); return rows; }
async function revokeApiKey(keyId) { await pool.execute(`UPDATE api_keys SET is_active=0, revoked_at=COALESCE(revoked_at,NOW()) WHERE id=?`, [keyId]); return true; }
async function authenticateApiKey(rawKey) {
    const prefix = String(rawKey || '').slice(0, 16);
    const [rows] = await pool.execute(`SELECT k.id key_id,k.key_prefix,k.scopes,k.is_active key_active,c.* FROM api_keys k JOIN api_clients c ON c.id=k.client_id WHERE k.key_prefix=? AND k.key_hash=? LIMIT 1`, [prefix, apiKeyHash(rawKey)]);
    const row = rows[0];
    if (!row || !row.key_active || !row.is_active) return null;
    await pool.execute(`UPDATE api_keys SET last_used_at=NOW() WHERE id=?`, [row.key_id]).catch(()=>{});
    return row;
}
async function recordApiRequestLog({ clientId=null, telegramId=null, keyPrefix=null, method='', path='', statusCode=null, ip='', userAgent='', requestId='', errorMessage=null }) { await pool.execute(`INSERT INTO api_request_logs (client_id,telegram_id,key_prefix,method,path,status_code,ip,user_agent,request_id,error_message) VALUES (?,?,?,?,?,?,?,?,?,?)`, [clientId, telegramId, keyPrefix, method, path, statusCode, ip, userAgent, requestId, errorMessage]); }
async function getApiClientActiveServerCount(clientId) { const c=await getApiClientById(clientId); if(!c)return 0; const [r]=await pool.execute(`SELECT COUNT(*) n FROM purchases WHERE telegram_id=? AND datacenter IN (${hetznerDatacenterSqlList}) AND status NOT IN ('deleted','deletion_pending','provider_missing')`, [c.telegram_id]); return Number(r[0]?.n||0); }
async function getApiClientMonthlySpend(clientId) { const c=await getApiClientById(clientId); if(!c)return 0; const [r]=await pool.execute(`SELECT COALESCE(SUM(amount),0) n FROM purchases WHERE telegram_id=? AND datacenter IN (${hetznerDatacenterSqlList}) AND duration='monthly' AND status NOT IN ('deleted','deletion_pending','provider_missing')`, [c.telegram_id]); return Number(r[0]?.n||0); }
async function getApiClientUsageSummary(clientId) { return { active_servers: await getApiClientActiveServerCount(clientId), monthly_spend: await getApiClientMonthlySpend(clientId), client: await getApiClientById(clientId) }; }
async function listApiClientLogs(clientId, limit=100) { const [rows]=await pool.execute(`SELECT * FROM api_request_logs WHERE client_id=? ORDER BY created_at DESC LIMIT ${Math.min(Number(limit)||100,500)}`, [clientId]); return rows; }


module.exports = {
    pool,
    pingDatabase,
    ensureAdminAuditLogsTable,
    getAdminOverviewStats,
    getAdminRevenueStats,
    getAdminPurchaseStats,
    getAdminDatacenterStats,
    getAdminWalletFlowStats,
    getAdminMetricDetails,
    globalAdminSearch,
    listAdminUsers,
    getAdminUserDetail,
    listAdminServers,
    getAdminServerDetail,
    listAdminPurchases,
    listAdminWalletLogs,
    adminCreditUser,
    adminDebitUser,
    adminUpdatePurchaseStatus,
    adminAuditLog,
    listAdminAuditLogs,
    getAllActivePurchases,
    updatePurchaseTrafficBilled,
    adminUpdateBilling,
    initializeDatabase,
    upsertUser,
    getUser,
    getUserWallet,
    debitUser,
    creditUser,
    recordPurchase,
    setPurchaseAutoRenew,
    setPurchaseRenewalStopped,
    updatePurchaseSuspendReason,
    hasUsedFreeTestServer,
    recordTestServer,
    storeKeyPair,
    getKeyPair,
    deleteKeyPairFromDb,
    recordWalletLog,
    getWalletLogs,
    getAllPurchases,
    updatePurchaseStatus,
    updatePurchaseOsLabel,
    updatePurchaseBilling,
    updatePurchaseFreeTraffic,
    updatePurchaseCycle,
    updateUserShahkar,
    getPurchaseByServerId,
    getUserActivePurchases,
    deleteTestServer,
    upsertServerSecret,
    getServerSecret,
    getUserRestartablePurchases,
    getPurchaseForUserServer,
    updatePurchasePlan,
    setPurchaseStatusForUser,
    createApiClient,
    listApiClients,
    getApiClientById,
    updateApiClient,
    createApiKey,
    listApiKeys,
    revokeApiKey,
    authenticateApiKey,
    recordApiRequestLog,
    getApiClientActiveServerCount,
    getApiClientMonthlySpend,
    getApiClientUsageSummary,
    listApiClientLogs,
    recordServerUpgradeLog,
};

