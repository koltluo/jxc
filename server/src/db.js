// ============================================================
//  db.js —— D1 数据访问薄封装
//  所有业务表共用 records 表，这里提供 upsert / 墓碑 / 批量 / 查询
// ============================================================

/**
 * 单条 upsert
 * @param {D1Database} db
 * @param {string} store
 * @param {string} key
 * @param {object} data      业务对象
 * @param {number|null} baseRev  乐观锁基准版本；null 表示无条件覆盖（LWW）
 * @returns {Promise<{ok:boolean, rev?:number, conflict?:object}>}
 */
export async function putRecord(db, store, key, data, baseRev = null) {
  const now = Date.now();
  const payload = JSON.stringify(data == null ? {} : data);

  if (baseRev === null || baseRev === undefined) {
    // LWW：无条件覆盖，rev+1
    await db.prepare(
      `INSERT INTO records (store, key, data, rev, deleted, updated_at)
       VALUES (?, ?, ?, 1, 0, ?)
       ON CONFLICT(store, key) DO UPDATE SET
         data = excluded.data,
         rev = records.rev + 1,
         deleted = 0,
         updated_at = excluded.updated_at`
    ).bind(store, key, payload, now).run();

    const row = await db.prepare(
      'SELECT rev FROM records WHERE store = ? AND key = ?'
    ).bind(store, key).first();
    return { ok: true, rev: row ? row.rev : 1 };
  }

  // 乐观锁：仅当 rev 匹配才更新
  const res = await db.prepare(
    `UPDATE records SET data = ?, rev = rev + 1, deleted = 0, updated_at = ?
     WHERE store = ? AND key = ? AND rev = ?`
  ).bind(payload, now, store, key, baseRev).run();

  if (res.meta && res.meta.changes === 0) {
    const cur = await db.prepare(
      'SELECT data, rev, deleted FROM records WHERE store = ? AND key = ?'
    ).bind(store, key).first();
    return {
      ok: false,
      conflict: cur
        ? { rev: cur.rev, data: safeParse(cur.data), deleted: !!cur.deleted }
        : null,
    };
  }
  const row = await db.prepare(
    'SELECT rev FROM records WHERE store = ? AND key = ?'
  ).bind(store, key).first();
  return { ok: true, rev: row ? row.rev : baseRev + 1 };
}

/** 写墓碑（不物理删除，保证增量同步可见） */
export async function tombstone(db, store, key) {
  const now = Date.now();
  await db.prepare(
    `INSERT INTO records (store, key, data, rev, deleted, updated_at)
     VALUES (?, ?, '{}', 1, 1, ?)
     ON CONFLICT(store, key) DO UPDATE SET
       deleted = 1,
       rev = records.rev + 1,
       updated_at = excluded.updated_at`
  ).bind(store, key, now).run();
  return { ok: true };
}

/** 批量 upsert + 删除（单次 batch，保证原子性） */
export async function batchRecords(db, store, upserts = [], deletes = []) {
  const now = Date.now();
  const stmts = [];

  for (const it of upserts) {
    stmts.push(db.prepare(
      `INSERT INTO records (store, key, data, rev, deleted, updated_at)
       VALUES (?, ?, ?, 1, 0, ?)
       ON CONFLICT(store, key) DO UPDATE SET
         data = excluded.data,
         rev = records.rev + 1,
         deleted = 0,
         updated_at = excluded.updated_at`
    ).bind(store, String(it.key), JSON.stringify(it.data ?? {}), now));
  }

  for (const k of deletes) {
    stmts.push(db.prepare(
      `INSERT INTO records (store, key, data, rev, deleted, updated_at)
       VALUES (?, ?, '{}', 1, 1, ?)
       ON CONFLICT(store, key) DO UPDATE SET
         deleted = 1,
         rev = records.rev + 1,
         updated_at = excluded.updated_at`
    ).bind(store, String(k), now));
  }

  if (!stmts.length) return { ok: true, count: 0 };
  await db.batch(stmts);
  return { ok: true, count: stmts.length };
}

/** 全量拉取（不含墓碑） */
export async function fetchAll(db) {
  const out = {};
  const { results } = await db.prepare(
    'SELECT store, key, data, rev, updated_at FROM records WHERE deleted = 0'
  ).all();
  for (const r of results || []) {
    if (!out[r.store]) out[r.store] = [];
    const obj = safeParse(r.data);
    if (obj && typeof obj === 'object') out[r.store].push(obj);
  }
  const maxRow = await db.prepare(
    'SELECT MAX(updated_at) AS m FROM records'
  ).first();
  return { stores: out, rev: (maxRow && maxRow.m) || 0 };
}

/** 增量拉取（含墓碑），游标为 updated_at */
export async function fetchChanges(db, since, limit = 5000) {
  const now = Date.now();
  const { results } = await db.prepare(
    `SELECT store, key, data, rev, deleted, updated_at FROM records
     WHERE updated_at > ? ORDER BY updated_at ASC LIMIT ?`
  ).bind(since, limit).all();
  const changes = (results || []).map(r => ({
    store: r.store,
    key: r.key,
    data: r.deleted ? null : safeParse(r.data),
    rev: r.rev,
    deleted: !!r.deleted,
    updatedAt: r.updated_at,
  }));
  return { now, changes };
}

/** 整表覆盖（导入用） */
export async function replaceStore(db, store, items = []) {
  const now = Date.now();
  const insertStmts = [];
  for (const it of items) {
    const kf = keyOf(store, it);
    insertStmts.push(db.prepare(
      `INSERT INTO records (store, key, data, rev, deleted, updated_at)
       VALUES (?, ?, ?, 1, 0, ?)
       ON CONFLICT(store, key) DO UPDATE SET
         data = excluded.data,
         rev = records.rev + 1,
         deleted = 0,
         updated_at = excluded.updated_at`
    ).bind(store, String(kf), JSON.stringify(it), now));
  }
  const deleteStmt = db.prepare('DELETE FROM records WHERE store = ? AND updated_at < ?').bind(store, now);

  // 先写入新数据，再删除旧数据，避免中途失败导致数据丢失
  const CHUNK = 60;
  for (let i = 0; i < insertStmts.length; i += CHUNK) {
    await db.batch(insertStmts.slice(i, i + CHUNK));
  }
  await db.batch([deleteStmt]);
  return { ok: true, count: items.length };
}

/** 清空某表（写墓碑） */
export async function clearStore(db, store) {
  const now = Date.now();
  const res = await db.prepare(
    `UPDATE records SET deleted = 1, rev = rev + 1, updated_at = ?
     WHERE store = ? AND deleted = 0`
  ).bind(now, store).run();
  return { ok: true, count: (res.meta && res.meta.changes) || 0 };
}

export async function countStore(db, store) {
  const row = await db.prepare(
    'SELECT COUNT(*) AS n FROM records WHERE store = ? AND deleted = 0'
  ).bind(store).first();
  return (row && row.n) || 0;
}

/** 物理删除过期墓碑（可挂在定时任务，如每天清理 90 天前的墓碑） */
export async function purgeStaleTombstones(db, maxAgeMs = 90 * 24 * 3600 * 1000) {
  const cutoff = Date.now() - maxAgeMs;
  const res = await db.prepare(
    'DELETE FROM records WHERE deleted = 1 AND updated_at < ?'
  ).bind(cutoff).run();
  return { ok: true, count: (res.meta && res.meta.changes) || 0 };
}

// ---------------- 辅助 ----------------
function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

const KEY_FIELD = {
  goods: 'code', customers: 'code', suppliers: 'code', accounts: 'code',
  staff: 'code', chartOfAccounts: 'code', equity: 'item', meta: 'key',
};
export function keyOf(store, obj) {
  const f = KEY_FIELD[store] || 'id';
  return obj[f] != null ? obj[f] : obj.id;
}