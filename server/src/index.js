// ============================================================
//  index.js —— Worker 入口：CORS → 路由 → 鉴权 → 分发
// ============================================================

import { Router } from './router.js';
import { corsHeaders, preflight } from './cors.js';
import { resolveSession, canWrite, isAdmin } from './auth.js';
import { json, err, isStore } from './util.js';
import * as authApi from './api/auth.js';
import * as dataApi from './api/data.js';

const r = new Router();

// ---------------- 公开 ----------------
r.post('/api/auth/login', authApi.login);

// ---------------- 认证 ----------------
r.post('/api/auth/logout', authApi.logout);
r.get('/api/auth/me', authApi.me);
r.post('/api/auth/password', authApi.changeOwnPassword);

// ---------------- 用户管理（仅 admin） ----------------
r.get('/api/users', authApi.listUsers);
r.post('/api/users', authApi.createUser);
r.put('/api/users/:id', authApi.updateUser);
r.del('/api/users/:id', authApi.deleteUser);

// ---------------- 数据同步 ----------------
r.get('/api/bootstrap', dataApi.bootstrap);
r.get('/api/changes', dataApi.changes);
r.post('/api/seq/next', dataApi.seqNext);

// ---------------- 单条 CRUD ----------------
r.put('/api/records/:store/:key', dataApi.putOne);
r.del('/api/records/:store/:key', dataApi.delOne);

// ---------------- 批量 / 整表 ----------------
r.post('/api/records/:store/batch', dataApi.batch);
r.put('/api/stores/:store', dataApi.replaceStore);
r.del('/api/stores/:store', dataApi.clearStore);

// ---------------- 导入 / 诊断 ----------------
r.post('/api/import', dataApi.importAll);
r.get('/api/health', async (req, env, ctx) => {
  const row = await ctx.db.prepare('SELECT COUNT(*) AS n FROM records WHERE deleted = 0').first();
  return json({ ok: true, records: (row && row.n) || 0, now: Date.now() });
});

// ============================================================
export default {
  async fetch(req, env, ctx) {
    if (!env.DB) {
      return new Response(
        JSON.stringify({ error: { message: 'D1 数据库未绑定，请检查 wrangler.toml 中的 database_id 是否已替换', code: 'CONFIG_ERROR' } }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const url = new URL(req.url);
    const path = url.pathname;

    // 预检
    if (req.method === 'OPTIONS') return preflight(req, env);

    const hit = r.match(req.method, path);
    if (!hit) {
      return attach(json({ error: { message: '接口不存在', code: 'NOT_FOUND' } }, 404), req, env);
    }

    // 上下文对象：handler 统一通过它访问依赖
    const c = {
      db: env.DB,
      env,
      ctx,
      url,
      query: Object.fromEntries(url.searchParams),
      params: hit.params,
      session: null,
      req,
      json: (d, s) => json(d, s),
      err: (m, s, code) => err(m, s, code),
      audit: async (action, store, key, detail) => {
        try {
          await env.DB.prepare(
            `INSERT INTO audit_log (at, user_id, username, action, store, key, detail)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            Date.now(),
            c.session ? c.session.user.id : null,
            c.session ? c.session.user.username : null,
            action, store || null, key || null, detail || null
          ).run();
        } catch { /* 审计失败不影响主流程 */ }
      },
    };

    // 除 login 外，全部需要有效会话
    if (path !== '/api/auth/login') {
      const s = await resolveSession(env.DB, req);
      if (!s) return attach(err('登录已过期，请重新登录', 401, 'UNAUTHORIZED'), req, env);
      c.session = s;
    }

    try {
      const res = await hit.handler(req, env, c);
      return attach(res, req, env);
    } catch (e) {
      console.error('handler error', path, e && e.stack || e);
      return attach(err('服务器内部错误：' + (e && e.message || e), 500, 'INTERNAL'), req, env);
    }
  },
};

function attach(res, req, env) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(corsHeaders(req, env))) out.headers.set(k, v);
  return out;
}