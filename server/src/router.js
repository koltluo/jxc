// ============================================================
//  router.js —— 极简路径匹配（支持 :param），零依赖
// ============================================================

/**
 * 用法：
 *   const r = new Router();
 *   r.add('GET', '/api/auth/me', handler);
 *   r.add('PUT', '/api/records/:store/:key', handler);
 *   const m = r.match('PUT', '/api/records/sales/XS001');
 *   // → { handler, params: { store:'sales', key:'XS001' } }
 */
export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const keys = [];
    const src = '^' + pattern
      .replace(/\/:([A-Za-z0-9_]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; })
      .replace(/\*/g, '.*')
      + '$';
    this.routes.push({
      method: method.toUpperCase(),
      re: new RegExp(src),
      keys,
      handler,
      dyn: keys.length,
      spec: pattern.length,
    });
    return this;
  }

  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  put(p, h) { return this.add('PUT', p, h); }
  del(p, h) { return this.add('DELETE', p, h); }

  match(method, path) {
    const M = method.toUpperCase();
    const hits = [];
    for (const r of this.routes) {
      if (r.method !== M) continue;
      const m = r.re.exec(path);
      if (m) hits.push({ r, m });
    }
    if (!hits.length) return null;
    // 静态路由优先于动态路由（/api/records/batch 优于 /api/records/:store）
    hits.sort((a, b) => (a.r.dyn - b.r.dyn) || (b.r.spec - a.r.spec));
    const { r, m } = hits[0];
    const params = {};
    r.keys.forEach((k, i) => {
      try { params[k] = decodeURIComponent(m[i + 1]); }
      catch { params[k] = m[i + 1]; }
    });
    return { handler: r.handler, params };
  }
}