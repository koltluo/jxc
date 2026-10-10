// ============================================================
//  seq.js —— 原子取号（号段预留）
//
//  背景：前端 nextCode/nextDocNo 是同步函数，不能 await 网络。
//  方案：前端一次性向服务端「预留一个号段」（如 20 个号），
//        在本地池子里同步消耗；用完再异步补一段。
//        服务端用 UPDATE ... RETURNING 保证并发不撞号。
// ============================================================

/**
 * 预留号段
 * @param {D1Database} db
 * @param {string} k       序列键，如 'sales.docNo.XS20261009' 或 'goods.code.SP'
 * @param {number} count   预留数量
 * @returns {Promise<{start:number, end:number, next:number}>}
 *          start..end 为本次可用号段（含端点），next = end + 1
 */
export async function reserve(db, k, count = 20) {
  const n = Math.max(1, Math.min(1000, Math.floor(count) || 20));

  // 懒初始化
  await db.prepare('INSERT OR IGNORE INTO seq (k, v) VALUES (?, 0)').bind(k).run();

  // 原子自增并取回新值
  const row = await db.prepare(
    'UPDATE seq SET v = v + ? WHERE k = ? RETURNING v'
  ).bind(n, k).first();

  const end = (row && row.v) || n;
  const start = end - n + 1;
  return { start, end, next: end + 1 };
}

/**
 * 把序列推进到至少 minNext（某序列被外部消耗过时对齐）
 */
export async function bumpTo(db, k, minNext) {
  await db.prepare('INSERT OR IGNORE INTO seq (k, v) VALUES (?, 0)').bind(k).run();
  await db.prepare('UPDATE seq SET v = MAX(v, ?) WHERE k = ?').bind(minNext, k).run();
}
