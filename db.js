// db.js - Database utility functions using MySQL

require('dotenv').config();
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const { isBillablePurchaseStatus } = require('./billing-status');

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
                metadata JSON NULL,
                ip VARCHAR(64),
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

        await ensureColumn(connection, 'test_servers', 'status', "VARCHAR(50) NOT NULL DEFAULT 'active'");
        await ensureColumn(connection, 'test_servers', 'updated_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');
        await ensureColumn(connection, 'test_servers', 'error_code', 'VARCHAR(128) NULL');
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS system_alerts (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                severity VARCHAR(32) NOT NULL DEFAULT 'warning',
                code VARCHAR(128) NOT NULL,
                title VARCHAR(255) NOT NULL,
                message TEXT NULL,
                entity_type VARCHAR(64) NULL,
                entity_id VARCHAR(255) NULL,
                datacenter VARCHAR(64) NULL,
                dedupe_key VARCHAR(255) NOT NULL,
                status VARCHAR(32) NOT NULL DEFAULT 'open',
                metadata JSON NULL,
                first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                acknowledged_at DATETIME NULL,
                acknowledged_by VARCHAR(128) NULL,
                resolved_at DATETIME NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_system_alert_dedupe (dedupe_key)
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

async function hasUsedFreeTestServer(telegramId, datacenter) {
    const conn = await pool.getConnection();
    try {
        const sql = "SELECT * FROM test_servers WHERE telegram_id = ? AND datacenter = ? AND server_id IS NOT NULL AND COALESCE(status,'active') IN ('active','created')";
        const [rows] = await conn.execute(sql, [String(telegramId), datacenter]);
        return rows.length > 0;
    } finally {
        conn.release();
    }
}

async function recordTestServer(telegramId, datacenter, serverId, bootVolumeId) {
    const conn = await pool.getConnection();
    try {
        const sql = "INSERT INTO test_servers (telegram_id, datacenter, server_id, boot_volume_id, used_at, status, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, 'active', CURRENT_TIMESTAMP) ON DUPLICATE KEY UPDATE server_id=VALUES(server_id), boot_volume_id=VALUES(boot_volume_id), used_at=VALUES(used_at), status='active', error_code=NULL, updated_at=CURRENT_TIMESTAMP";
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
        const [rows] = await conn.execute("SELECT * FROM purchases WHERE COALESCE(status,'') != 'deleted'");
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
        await conn.execute('INSERT INTO admin_audit_logs (actor, action, target_type, target_id, metadata, ip) VALUES (?, ?, ?, ?, ?, ?)', [String(actor || 'admin'), String(action), String(target.type || target.target_type || 'unknown'), String(target.id || target.target_id || ''), JSON.stringify(safeMeta), ip]);
    } finally { conn.release(); }
}

async function pingDatabase() { const conn = await pool.getConnection(); try { await conn.query('SELECT 1'); return true; } finally { conn.release(); } }


async function getAdminOverviewStats() {
    const conn = await pool.getConnection();
    try {
        const [[users]] = await conn.query(`SELECT COUNT(*) totalUsers, COALESCE(SUM(shahkar_verified = 1),0) shahkarVerifiedUsers, COALESCE(SUM(wallet),0) totalWalletBalance FROM users`);
        const [[servers]] = await conn.query(`SELECT COALESCE(SUM(status='active'),0) activeServers, COALESCE(SUM(status IN ('suspended','stopped')),0) suspendedServers,
            COALESCE(SUM(status='deleted'),0) deletedServers, COUNT(*) totalPurchases,
            COALESCE(SUM(datacenter='afracloud'),0) afraServers, COALESCE(SUM(datacenter='hetzner'),0) hetznerServers,
            COALESCE(SUM(datacenter LIKE '%openstack%'),0) openstackServers, COALESCE(SUM(datacenter='tebyan'),0) tebyanServers,
            COALESCE(SUM(CASE WHEN status='active' THEN amount ELSE 0 END),0) estimatedMonthlyRevenue FROM purchases`);
        const [[purchases]] = await conn.query(`SELECT COALESCE(SUM(DATE(created_at)=CURDATE()),0) purchasesToday, COALESCE(SUM(created_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')),0) purchasesThisMonth FROM purchases`);
        const [[revenue]] = await conn.query(`SELECT COALESCE(SUM(CASE WHEN type IN ('credit','deposit','payment','topup','admin_credit') AND amount > 0 AND DATE(timestamp)=CURDATE() THEN amount ELSE 0 END),0) revenueToday,
            COALESCE(SUM(CASE WHEN type IN ('credit','deposit','payment','topup','admin_credit') AND amount > 0 AND timestamp >= DATE_FORMAT(CURDATE(), '%Y-%m-01') THEN amount ELSE 0 END),0) revenueThisMonth FROM wallet_logs`);
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

async function listAdminUsers(filters = {}) {
    const limit = toLimit(filters.limit); const offset = pageOffset(filters.page, limit); const where=[]; const params=[];
    if (filters.search) { where.push('(u.telegram_id LIKE ? OR u.phone LIKE ? OR u.national_code LIKE ?)'); params.push(...Array(3).fill('%'+filters.search+'%')); }
    if (filters.shahkar === '1' || filters.shahkar === '0') { where.push('u.shahkar_verified = ?'); params.push(Number(filters.shahkar)); }
    if (filters.minBalance) { where.push('u.wallet >= ?'); params.push(Number(filters.minBalance)); }
    const having = filters.hasServers ? ' HAVING active_servers > 0' : '';
    const whereSql = where.length ? 'WHERE '+where.join(' AND ') : '';
    const conn=await pool.getConnection(); try {
        const [rows]=await conn.query(`SELECT u.telegram_id,u.phone,u.national_code,u.shahkar_verified,u.wallet,u.created_at,u.updated_at,COUNT(p.server_id) purchases_count,SUM(p.status='active') active_servers FROM users u LEFT JOIN purchases p ON p.telegram_id=u.telegram_id ${whereSql} GROUP BY u.telegram_id ${having} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
        rows.forEach(r=>{r.national_code_masked=maskLast4(r.national_code); r.phone_masked=maskLast4(r.phone); delete r.national_code;});
        const [[count]]=await conn.query(`SELECT COUNT(*) total FROM users u ${whereSql}`, params);
        return { rows, page:Number(filters.page)||1, limit, total:count.total };
    } finally {conn.release();}
}

async function getAdminUserDetail(telegramId) { const conn=await pool.getConnection(); try { const [[user]]=await conn.query('SELECT telegram_id,phone,wallet,step,national_code,shahkar_verified,shahkar_verified_at,created_at,updated_at FROM users WHERE telegram_id=?',[String(telegramId)]); if(!user)return null; user.national_code_masked=maskLast4(user.national_code); delete user.national_code; const [wallet_logs]=await conn.query('SELECT * FROM wallet_logs WHERE telegram_id=? ORDER BY timestamp DESC LIMIT 100',[String(telegramId)]); const [purchases]=await conn.query('SELECT * FROM purchases WHERE telegram_id=? ORDER BY created_at DESC LIMIT 100',[String(telegramId)]); return { user, wallet_logs, purchases, servers:purchases, active_purchases:purchases.filter(p=>p.status!=='deleted') }; } finally {conn.release();} }
async function listAdminServers(filters={}) { const limit=toLimit(filters.limit); const offset=pageOffset(filters.page,limit); const where=[]; const params=[]; if(filters.search){where.push('(p.server_id LIKE ? OR p.server_name LIKE ? OR p.telegram_id LIKE ? OR u.phone LIKE ?)');params.push(...Array(4).fill('%'+filters.search+'%'));} ['datacenter','status'].forEach(k=>{if(filters[k]){where.push('p.'+k+'=?');params.push(filters[k]);}}); if(filters.provider){where.push('p.datacenter=?');params.push(filters.provider);} if(filters.hasPassword==='yes')where.push("EXISTS(SELECT 1 FROM server_secrets ss WHERE ss.server_id=p.server_id AND ss.secret_type='root_password')"); if(filters.hasPassword==='no')where.push("NOT EXISTS(SELECT 1 FROM server_secrets ss WHERE ss.server_id=p.server_id AND ss.secret_type='root_password')"); if(filters.userId){where.push('p.telegram_id=?');params.push(String(filters.userId));} const whereSql=where.length?'WHERE '+where.join(' AND '):''; const conn=await pool.getConnection(); try{const [rows]=await conn.query(`SELECT p.*, u.phone, EXISTS(SELECT 1 FROM server_secrets ss WHERE ss.server_id=p.server_id AND ss.secret_type='root_password') password_stored FROM purchases p LEFT JOIN users u ON u.telegram_id=p.telegram_id ${whereSql} ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,[...params,limit,offset]); const [[count]]=await conn.query(`SELECT COUNT(*) total FROM purchases p ${whereSql}`,params); return {rows,page:Number(filters.page)||1,limit,total:count.total};}finally{conn.release();}}
async function getAdminServerDetail(serverId){ const conn=await pool.getConnection(); try{const [[purchase]]=await conn.query("SELECT p.*,u.phone,u.wallet, EXISTS(SELECT 1 FROM server_secrets ss WHERE ss.server_id=p.server_id AND ss.secret_type='root_password') password_stored FROM purchases p LEFT JOIN users u ON u.telegram_id=p.telegram_id WHERE p.server_id=?",[String(serverId)]); if(!purchase)return null; const [wallet_logs]=await conn.query('SELECT * FROM wallet_logs WHERE telegram_id=? AND description LIKE ? ORDER BY timestamp DESC LIMIT 50',[String(purchase.telegram_id),'%'+serverId+'%']); return {purchase,user:{telegram_id:purchase.telegram_id,phone:purchase.phone,wallet:purchase.wallet},wallet_logs,password_stored:!!purchase.password_stored};}finally{conn.release();}}
async function listAdminPurchases(filters={}){return listAdminServers(filters);}
async function listAdminWalletLogs(filters={}){const limit=toLimit(filters.limit); const offset=pageOffset(filters.page,limit); const where=[]; const params=[]; if(filters.search){where.push('(w.telegram_id LIKE ? OR w.description LIKE ?)');params.push('%'+filters.search+'%','%'+filters.search+'%');} if(filters.type){where.push('w.type=?');params.push(filters.type);} if(filters.from){where.push('w.timestamp>=?');params.push(filters.from);} if(filters.to){where.push('w.timestamp<=?');params.push(filters.to);} const whereSql=where.length?'WHERE '+where.join(' AND '):''; const conn=await pool.getConnection(); try{const [rows]=await conn.query(`SELECT w.*,u.wallet current_balance FROM wallet_logs w LEFT JOIN users u ON u.telegram_id=w.telegram_id ${whereSql} ORDER BY w.timestamp DESC LIMIT ? OFFSET ?`,[...params,limit,offset]); const [[count]]=await conn.query(`SELECT COUNT(*) total FROM wallet_logs w ${whereSql}`,params); return {rows,page:Number(filters.page)||1,limit,total:count.total};}finally{conn.release();}}
async function adminCreditUser(telegramId, amount, description='شارژ کیف پول توسط ادمین'){ await creditUser(telegramId, Number(amount)); await recordWalletLog(telegramId, Number(amount), description, 'admin_credit'); return getUserWallet(telegramId); }
async function adminDebitUser(telegramId, amount, description='کسر کیف پول توسط ادمین'){ const ok=await debitUser(telegramId, Number(amount)); if(!ok) throw new Error('INSUFFICIENT_BALANCE'); await recordWalletLog(telegramId, -Math.abs(Number(amount)), description, 'admin_debit'); return getUserWallet(telegramId); }
async function adminUpdatePurchaseStatus(idOrServerId,status){ await updatePurchaseStatus(idOrServerId,status); return getPurchaseByServerId(idOrServerId); }

async function createSystemAlert({ severity = 'warning', code, title, message = '', entityType = null, entityId = null, datacenter = null, dedupeKey, metadata = {} }) {
    const conn = await pool.getConnection();
    try {
        await conn.execute(`INSERT INTO system_alerts (severity, code, title, message, entity_type, entity_id, datacenter, dedupe_key, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE severity=VALUES(severity), title=VALUES(title), message=VALUES(message), status=IF(status='resolved','open',status), metadata=VALUES(metadata), last_seen_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP`,
            [severity, code, title, message, entityType, entityId, datacenter, dedupeKey || `${code}:${entityId || datacenter || 'global'}`, JSON.stringify(metadata || {})]);
    } finally { conn.release(); }
}

async function listSystemAlerts({ status = 'open', limit = 100 } = {}) {
    const conn = await pool.getConnection();
    try { const [rows] = await conn.execute("SELECT * FROM system_alerts WHERE (? = 'all' OR status = ?) ORDER BY last_seen_at DESC LIMIT ?", [status, status, Math.min(Number(limit)||100, 500)]); return rows; }
    finally { conn.release(); }
}

async function updateSystemAlertStatus(id, status, actor) {
    const conn = await pool.getConnection();
    try { await conn.execute(`UPDATE system_alerts SET status=?, acknowledged_at=IF(?='acknowledged',CURRENT_TIMESTAMP,acknowledged_at), acknowledged_by=IF(?='acknowledged',?,acknowledged_by), resolved_at=IF(?='resolved',CURRENT_TIMESTAMP,resolved_at), updated_at=CURRENT_TIMESTAMP WHERE id=?`, [status,status,status,String(actor||'admin'),status,id]); }
    finally { conn.release(); }
}

async function listAdminAuditLogs(limit=200){await ensureAdminAuditLogsTable(); const conn=await pool.getConnection(); try{const [rows]=await conn.query('SELECT * FROM admin_audit_logs ORDER BY created_at DESC LIMIT ?',[toLimit(limit,200,500)]); return rows;}finally{conn.release();}}

module.exports = {
    pool,
    isBillablePurchaseStatus,
    createSystemAlert,
    listSystemAlerts,
    updateSystemAlertStatus,
    pingDatabase,
    ensureAdminAuditLogsTable,
    getAdminOverviewStats,
    getAdminRevenueStats,
    getAdminPurchaseStats,
    getAdminDatacenterStats,
    getAdminWalletFlowStats,
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
    initializeDatabase,
    upsertUser,
    getUser,
    getUserWallet,
    debitUser,
    creditUser,
    recordPurchase,
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
};

