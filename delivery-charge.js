'use strict';

let schemaReadyPromise = null;

async function ensureSchema(pool) {
  if (schemaReadyPromise) return schemaReadyPromise;
  schemaReadyPromise = (async () => {
    const conn = await pool.getConnection();
    try {
      await conn.execute(`
        CREATE TABLE IF NOT EXISTS pending_delivery_charges (
          server_id VARCHAR(255) PRIMARY KEY,
          telegram_id VARCHAR(255) NOT NULL,
          datacenter VARCHAR(64) NOT NULL,
          amount DECIMAL(18,6) NOT NULL,
          log_type VARCHAR(50) NOT NULL DEFAULT 'purchase',
          description TEXT NOT NULL,
          min_wallet_reserve DECIMAL(18,6) NOT NULL DEFAULT 0,
          status VARCHAR(32) NOT NULL DEFAULT 'pending',
          cancel_reason VARCHAR(255) NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          charged_at DATETIME NULL,
          cancelled_at DATETIME NULL,
          INDEX idx_pending_delivery_user_status (telegram_id, status)
        )
      `);
    } finally {
      conn.release();
    }
  })().catch(error => {
    schemaReadyPromise = null;
    throw error;
  });
  return schemaReadyPromise;
}

function normalizeAmount(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || !(n > 0)) return 0;
  return Math.round(n * 1e6) / 1e6;
}

async function pendingTotalForUser(conn, telegramId, excludeServerId = null) {
  const params = [String(telegramId)];
  let exclude = '';
  if (excludeServerId != null) {
    exclude = ' AND server_id <> ?';
    params.push(String(excludeServerId));
  }
  const [rows] = await conn.execute(
    `SELECT COALESCE(SUM(amount),0) total
       FROM pending_delivery_charges
      WHERE telegram_id = ?
        AND status = 'pending'${exclude}`,
    params
  );
  return Number(rows[0]?.total || 0);
}

async function reserve(pool, {
  telegramId,
  serverId,
  datacenter,
  amount,
  logType = 'purchase',
  description,
  minWalletReserve = 0
}) {
  await ensureSchema(pool);
  const charge = normalizeAmount(amount);
  const minimumReserve = Math.max(0, normalizeAmount(minWalletReserve));
  if (!(charge > 0)) return { status: 'invalid_amount', reserved: 0 };

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [existing] = await conn.execute(
      'SELECT * FROM pending_delivery_charges WHERE server_id = ? LIMIT 1 FOR UPDATE',
      [String(serverId)]
    );
    if (existing.length) {
      const row = existing[0];
      if (String(row.status) === 'pending') {
        await conn.commit();
        return { status: 'already_reserved', reserved: Number(row.amount || 0) };
      }
      if (String(row.status) === 'charged') {
        await conn.commit();
        return { status: 'already_charged', reserved: 0, charged: Number(row.amount || 0) };
      }
      await conn.execute(
        `UPDATE pending_delivery_charges
            SET telegram_id=?, datacenter=?, amount=?, log_type=?, description=?,
                min_wallet_reserve=?, status='pending', cancel_reason=NULL,
                cancelled_at=NULL, charged_at=NULL, updated_at=NOW()
          WHERE server_id=?`,
        [
          String(telegramId), String(datacenter), charge, String(logType),
          String(description || ''), minimumReserve, String(serverId)
        ]
      );
    }

    const [users] = await conn.execute(
      'SELECT wallet FROM users WHERE telegram_id = ? LIMIT 1 FOR UPDATE',
      [String(telegramId)]
    );
    if (!users.length) {
      await conn.rollback();
      return { status: 'user_missing', reserved: 0 };
    }
    const wallet = Number(users[0].wallet || 0);
    const pendingOther = await pendingTotalForUser(conn, telegramId, serverId);
    const available = wallet - pendingOther;
    const required = charge + minimumReserve;
    if (available + 1e-9 < required) {
      if (existing.length && String(existing[0].status) !== 'pending') {
        await conn.execute(
          `UPDATE pending_delivery_charges
              SET status='cancelled', cancel_reason='insufficient_at_reservation',
                  cancelled_at=NOW(), updated_at=NOW()
            WHERE server_id=?`,
          [String(serverId)]
        );
      }
      await conn.commit();
      return { status: 'insufficient', reserved: 0, wallet, pendingOther, available, required };
    }

    if (!existing.length) {
      await conn.execute(
        `INSERT INTO pending_delivery_charges
          (server_id,telegram_id,datacenter,amount,log_type,description,min_wallet_reserve,status)
         VALUES (?,?,?,?,?,?,?,'pending')`,
        [
          String(serverId), String(telegramId), String(datacenter), charge,
          String(logType), String(description || ''), minimumReserve
        ]
      );
    }

    await conn.commit();
    return { status: 'reserved', reserved: charge, wallet, pendingOther, availableAfter: available - charge };
  } catch (error) {
    await conn.rollback().catch(() => {});
    throw error;
  } finally {
    conn.release();
  }
}

async function cancel(pool, serverId, reason = 'cancelled_before_delivery') {
  await ensureSchema(pool);
  const [result] = await pool.execute(
    `UPDATE pending_delivery_charges
        SET status='cancelled', cancel_reason=?, cancelled_at=COALESCE(cancelled_at,NOW()), updated_at=NOW()
      WHERE server_id=? AND status='pending'`,
    [String(reason).slice(0,255), String(serverId)]
  );
  return result.affectedRows > 0;
}

async function settlePendingOnDelivery(conn, { telegramId, serverId, datacenter }) {
  const [rows] = await conn.execute(
    'SELECT * FROM pending_delivery_charges WHERE server_id=? LIMIT 1 FOR UPDATE',
    [String(serverId)]
  );
  if (!rows.length) return { status: 'no_reservation', charged: 0 };
  const row = rows[0];
  if (String(row.status) === 'charged') return { status: 'already_charged', charged: 0 };
  if (String(row.status) !== 'pending') return { status: String(row.status), charged: 0 };

  if (
    String(row.telegram_id) !== String(telegramId) ||
    String(row.datacenter) !== String(datacenter)
  ) {
    const error = new Error('DELIVERY_CHARGE_SCOPE_MISMATCH');
    error.code = 'DELIVERY_CHARGE_SCOPE_MISMATCH';
    throw error;
  }

  const charge = normalizeAmount(row.amount);
  const [users] = await conn.execute(
    'SELECT wallet FROM users WHERE telegram_id=? LIMIT 1 FOR UPDATE',
    [String(telegramId)]
  );
  if (!users.length) {
    const error = new Error('DELIVERY_CHARGE_USER_MISSING');
    error.code = 'DELIVERY_CHARGE_USER_MISSING';
    throw error;
  }
  const wallet = Number(users[0].wallet || 0);
  if (wallet + 1e-9 < charge) {
    const error = new Error('DELIVERY_CHARGE_INSUFFICIENT');
    error.code = 'DELIVERY_CHARGE_INSUFFICIENT';
    error.wallet = wallet;
    error.required = charge;
    throw error;
  }

  await conn.execute(
    'UPDATE users SET wallet=wallet-?,updated_at=CURRENT_TIMESTAMP WHERE telegram_id=?',
    [charge, String(telegramId)]
  );
  await conn.execute(
    'INSERT INTO wallet_logs (telegram_id,amount,description,type) VALUES (?,?,?,?)',
    [String(telegramId), -charge, String(row.description || ''), String(row.log_type || 'purchase')]
  );
  await conn.execute(
    `UPDATE pending_delivery_charges
        SET status='charged', charged_at=NOW(), updated_at=NOW()
      WHERE server_id=? AND status='pending'`,
    [String(serverId)]
  );
  return { status: 'charged', charged: charge, newWallet: wallet - charge };
}

async function getPendingTotal(pool, telegramId, excludeServerId = null) {
  await ensureSchema(pool);
  const conn = await pool.getConnection();
  try {
    return await pendingTotalForUser(conn, telegramId, excludeServerId);
  } finally {
    conn.release();
  }
}

module.exports = {
  ensureSchema,
  reserve,
  cancel,
  settlePendingOnDelivery,
  getPendingTotal,
  pendingTotalForUser
};
