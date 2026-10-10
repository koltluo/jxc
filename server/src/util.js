// ============================================================
//  util.js —— 通用工具：JSON 响应、base64、ID 生成
// ============================================================

/** 业务允许的 15 个 store（白名单，防止越权写入任意表名） */
export const STORES = [
  'goods', 'customers', 'suppliers', 'accounts', 'staff',
  'purchases', 'sales', 'receipts', 'payments', 'others',
  'chartOfAccounts', 'equity', 'vouchers', 'templates', 'meta',
];

/** 哪些 store 的主键是 id（其余为 code/item/key） */
export const ID_KEYED = ['purchases', 'sales', 'receipts', 'payments', 'others', 'vouchers', 'templates'];

export function isStore(s) {
  return STORES.includes(s);
}

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

export function err(message, status = 400, code = '') {
  return json({ error: { message, code: code || 'ERR_' + status } }, status);
}

// ---------------- base64 / 字节 ----------------
export function bytesToBase64(bytes) {
  let bin = '';
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin);
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

export function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 常量时间字符串比较，避免时序侧信道 */
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 随机 ID */
export function uid(prefix = '') {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return prefix + bytesToBase64Url(b).slice(0, 16);
}

/** 安全 JSON 解析 */
export function parseJSON(text, fallback = null) {
  try { return JSON.parse(text); } catch { return fallback; }
}

/** 安全读取请求体 JSON，失败返回空对象 */
export async function safeBody(req) {
  try { return (await req.json()) || {}; } catch { return {}; }
}