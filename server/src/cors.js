// ============================================================
//  cors.js —— 跨域处理
//  前端在 *.pages.dev，API 在 *.workers.dev，属跨域请求。
//  用 Authorization 头传递凭证（不用 Cookie），因此可精确列白名单。
// ============================================================

/**
 * 根据请求 Origin 与环境配置，计算 CORS 响应头
 * @param {Request} req
 * @param {object} env  env.ALLOWED_ORIGINS 形如 "https://a.pages.dev,http://localhost:8899"
 */
export function corsHeaders(req, env) {
  const origin = req.headers.get('Origin') || '';
  const list = String(env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);

  const isLocalhost = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  let allow = '';
  if (!list.length) {
    // 未配置白名单：仅放行 localhost，防止生产环境误配导致任意 Origin 可访问
    if (origin && isLocalhost) allow = origin;
  } else if (list.includes('*')) {
    allow = origin || '*';
  } else if (list.includes(origin)) {
    allow = origin;
  } else if (isLocalhost) {
    // 已配置白名单时，localhost 仍放行以便本地联调，可通过显式移除此分支收紧
    allow = origin;
  }

  const h = {
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
  if (allow) h['Access-Control-Allow-Origin'] = allow;
  return h;
}

/** 给任意 Response 附加 CORS 头 */
export function withCors(res, req, env) {
  const h = corsHeaders(req, env);
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(h)) out.headers.set(k, v);
  return out;
}

/** OPTIONS 预检响应 */
export function preflight(req, env) {
  return new Response(null, { status: 204, headers: corsHeaders(req, env) });
}