// ============================================================
//  api/data.js —— 数据同步接口
//   · bootstrap / changes ：全量 / 增量拉取
//   · records CRUD        ：单条增删改 + 批量
//   · stores              ：整表覆盖 / 清空
//   · seq/next            ：原子取号
//   · import              ：一次性导入
// ============================================================

import { canWrite, isAdmin } from '../auth.js';
import { json, err, isStore, STORES, safeBody } from '../util.js';
import {
  putRecord, tombstone, batchRecords, fetchAll, fetchChanges,
  replaceStore as dbReplaceStore, clearStore as dbClearStore,
  countStore, keyOf,
} from '../db.js';
import { reserve } from '../seq.js';

// ---------------- 全量拉取 ----------------
export async function bootstrap(req, env, c) {
  const { stores, rev } = await fetchAll(c.db);
  // 补齐空表，前端可据此知道有多少个 store
  const out = {};
  for (const s of STORES) out[s] = stores[s] || [];
  return json({ rev, stores: out, serverTime: Date.now() });
}

// ---------------- 增量拉取 ----------------
export async function changes(req, env, c) {
  const since = Number(c.query.since || 0) || 0;
  const { now, changes } = await fetchChanges(c.db, since);
  return json({ now, since, count: changes.length, changes });
}

// ---------------- 单条写 ----------------
export async function putOne(req, env, c) {
  if (!canWrite(c.session.user)) return err('无写入权限', 403, 'FORBIDDEN');
  const { store, key } = c.params;
  if (!isStore(store)) return err('未知数据表：' + store, 400, 'BAD_STORE');

  const body = await safeBody(req);
  const data = body.data;
  if (data == null || typeof data !== 'object') return err('缺少 data 字段', 400, 'BAD_INPUT');

  const baseRev = body.baseRev == null ? null : Number(body.baseRev);
  const r = await putRecord(c.db, store, key, data, baseRev);

  if (!r.ok) {
    return json({ error: { message: '数据已被他人修改', code: 'CONFLICT' }, current: r.conflict }, 409);
  }
  await c.audit('put', store, key);
  return json({ ok: true, rev: r.rev });
}

// ---------------- 单条删 ----------------
export async function delOne(req, env, c) {
  if (!canWrite(c.session.user)) return err('无写入权限', 403, 'FORBIDDEN');
  const { store, key } = c.params;
  if (!isStore(store)) return err('未知数据表：' + store, 400, 'BAD_STORE');

  await tombstone(c.db, store, key);
  await c.audit('del', store, key);
  return json({ ok: true });
}

// ---------------- 批量（开单多行 / 离线重放） ----------------
export async function batch(req, env, c) {
  if (!canWrite(c.session.user)) return err('无写入权限', 403, 'FORBIDDEN');
  const store = c.params.store;
  if (!isStore(store)) return err('未知数据表：' + store, 400, 'BAD_STORE');

  const body = await safeBody(req);
  const items = Array.isArray(body.items) ? body.items : [];
  const deletes = Array.isArray(body.deletes) ? body.deletes : [];

  if (!items.length && !deletes.length) return json({ ok: true, count: 0, skipped: 0 });

  // 兼容两种 items 格式：
  //   A) 包装式 [{ key, data }]            —— 显式指定主键
  //   B) 裸对象 [{ id, name, ... }]        —— 由 keyOf(store, obj) 推导主键
  // 无法解析的条目不再静默丢弃，而是计入 skipped 返回，避免「假装成功」。
  const prepared = [];
  const skipped = [];
  for (const it of items) {
    if (it == null || typeof it !== 'object') { skipped.push(String(it)); continue; }

    let d, k;
    if (it.data !== undefined) {
      d = typeof it.data === 'object' && it.data !== null ? it.data : it;
      k = it.key != null ? it.key : keyOf(store, d);
    } else {
      d = it;
      k = it.key != null ? it.key : keyOf(store, it);
    }

    if (k == null || k === '') { skipped.push(String(k)); continue; }
    prepared.push({ key: String(k), data: d });
  }

  await batchRecords(c.db, store, prepared, deletes.map(String));
  await c.audit('batch', store, null,
    `upsert=${prepared.length} del=${deletes.length} skipped=${skipped.length}`);
  return json({
    ok: true,
    count: prepared.length + deletes.length,
    upsert: prepared.length,
    deleted: deletes.length,
    skipped: skipped.length,
  });
}

// ---------------- 整表覆盖 ----------------
export async function replaceStore(req, env, c) {
  if (!canWrite(c.session.user)) return err('无写入权限', 403, 'FORBIDDEN');
  const store = c.params.store;
  if (!isStore(store)) return err('未知数据表：' + store, 400, 'BAD_STORE');

  const body = await safeBody(req);
  const items = Array.isArray(body.items) ? body.items : [];
  const r = await dbReplaceStore(c.db, store, items);
  await c.audit('replaceAll', store, null, `count=${r.count}`);
  return json(r);
}

// ---------------- 清空 ----------------
export async function clearStore(req, env, c) {
  if (!canWrite(c.session.user)) return err('无写入权限', 403, 'FORBIDDEN');
  const store = c.params.store;
  if (!isStore(store)) return err('未知数据表：' + store, 400, 'BAD_STORE');

  const r = await dbClearStore(c.db, store);
  await c.audit('clear', store, null, `count=${r.count}`);
  return json(r);
}

// ---------------- 一次性导入 ----------------
export async function importAll(req, env, c) {
  if (!isAdmin(c.session.user)) return err('需要管理员权限', 403, 'FORBIDDEN');
  const body = await safeBody(req);
  const stores = body.stores || {};
  const mode = body.mode || 'overwrite';

  const counts = {};
  for (const [store, items] of Object.entries(stores)) {
    if (!isStore(store)) continue;
    if (!Array.isArray(items)) continue;
    if (mode === 'overwrite') {
      await dbReplaceStore(c.db, store, items);
    } else {
      const prepared = items
        .map(o => ({ key: String(keyOf(store, o) ?? ''), data: o }))
        .filter(x => x.key);
      await batchRecords(c.db, store, prepared, []);
    }
    counts[store] = items.length;
  }
  await c.audit('import', null, null, JSON.stringify(counts));
  return json({ ok: true, counts });
}

// ---------------- 原子取号 ----------------
export async function seqNext(req, env, c) {
  if (!canWrite(c.session.user)) return err('无写入权限', 403, 'FORBIDDEN');
  const body = await safeBody(req);
  const keys = Array.isArray(body.keys) ? body.keys : [];
  const count = Number(body.count) || 20;
  if (!keys.length) return err('缺少 keys', 400, 'BAD_INPUT');

  const out = {};
  for (const it of keys) {
    const k = String(it.k || '').trim();
    if (!k) continue;
    // 序列键带上前缀，防止不同前缀共用计数
    const sk = it.store ? `${it.store}:${k}` : k;
    out[k] = await reserve(c.db, sk, count);
  }
  return json({ ok: true, pool: out });
}

// ---------------- 诊断 ----------------
export async function stats(req, env, c) {
  const out = {};
  for (const s of STORES) out[s] = await countStore(c.db, s);
  return json({ stores: out });
}