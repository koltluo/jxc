// ============================================================
//  auth.js —— 密码哈希（PBKDF2-SHA256）+ 会话管理
//  设计：随机不透明 token 存 D1，可即时吊销（登出/踢人/改密码只需删行）
// ============================================================

import {
  bytesToBase64, base64ToBytes, bytesToBase64Url, timingSafeEqual, uid,
} from './util.js';

const ITERATIONS = 100000;
const TOKEN_BYTES = 32;
const DEFAULT_TTL_MS = 30 * 24 * 3600 * 1000;   // 30 天

// ---------------- 密码 ----------------
export function newSalt() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return bytesToBase64(b);
}

/**
 * PBKDF2-SHA256 派生密码哈希（与 Node 侧 seed 脚本算法一致）
 * @returns {Promise<string>} base64 哈希
 */
export async function hashPassword(password, saltB64, iterations = ITERATIONS) {
  const enc = new TextEncoder();
  const salt = base64ToBytes(saltB64);
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
  return bytesToBase64(new Uint8Array(bits));
}

/** 校验密码（常量时间比较） */
export async function verifyPassword(password, user) {
  if (!password || !user || !user.pwd_hash || !user.pwd_salt) return false;
  try {
    const got = await hashPassword(password, user.pwd_salt, user.iterations || ITERATIONS);
    return timingSafeEqual(got, user.pwd_hash);
  } catch {
    return false;
  }
}

// ---------------- 会话 ----------------
export function newToken() {
  const b = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(b);
  return bytesToBase64Url(b);
}

function ttl(env) {
  const n = Number(env?.SESSION_TTL_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MS;
}

export async function createSession(db, userId, env, ua = '') {
  const token = newToken();
  const now = Date.now();
  await db.prepare(
    `INSERT INTO sessions (token, user_id, created_at, expires_at, last_seen, ua)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(token, userId, now, now + ttl(env), now, ua.slice(0, 200)).run();
  return { token, expiresAt: now + ttl(env) };
}

export async function destroySession(db, token) {
  await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
}

/** 清理过期会话（可挂在定时任务，或每次登录时顺手清） */
export async function purgeExpired(db) {
  await db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(Date.now()).run();
}

/**
 * 从请求解析并校验会话
 * @returns {Promise<{user:object, session:object}|null>}
 */
export async function resolveSession(db, req) {
  const h = req.headers.get('Authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  if (!m) return null;
  const token = m[1].trim();
  if (!token) return null;

  const row = await db.prepare(
    `SELECT s.token, s.user_id, s.expires_at,
            u.id AS uid, u.username, u.display, u.role, u.active
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ?`
  ).bind(token).first();

  if (!row) return null;
  if (row.expires_at < Date.now()) {
    await destroySession(db, token);
    return null;
  }
  if (!row.active) return null;

  return {
    token,
    user: { id: row.uid, username: row.username, display: row.display, role: row.role },
    expiresAt: row.expires_at,
  };
}

/** 刷新 last_seen（低频调用即可，避免每请求都写） */
export async function touchSession(db, token) {
  await db.prepare('UPDATE sessions SET last_seen = ? WHERE token = ?')
    .bind(Date.now(), token).run();
}

// ---------------- 角色 ----------------
export const ROLES = ['admin', 'staff', 'viewer'];

/** 是否可写业务数据 */
export function canWrite(user) {
  return user && (user.role === 'admin' || user.role === 'staff');
}

/** 是否管理员 */
export function isAdmin(user) {
  return user && user.role === 'admin';
}

export function newUserId() {
  return uid('u_');
}