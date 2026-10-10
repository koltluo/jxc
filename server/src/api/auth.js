// ============================================================
//  api/auth.js —— 登录 / 登出 / 当前用户 / 我
// ============================================================

import {
  verifyPassword, createSession, destroySession, purgeExpired,
  resolveSession, touchSession, canWrite, isAdmin, hashPassword, newSalt, ROLES,
} from '../auth.js';
import { json, err, uid, safeBody } from '../util.js';

/** POST /api/auth/login */
export async function login(req, env, ctx) {
  const body = await safeBody(req);
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!username || !password) return err('请输入用户名和密码', 400, 'BAD_INPUT');

  const user = await ctx.db.prepare(
    'SELECT * FROM users WHERE username = ?'
  ).bind(username).first();

  // 统一错误信息，不泄露账号是否存在
  if (!user || !user.active) {
    await ctx.audit('login_fail', null, null, `unknown:${username}`);
    return err('用户名或密码错误', 401, 'BAD_CREDENTIALS');
  }

  const ok = await verifyPassword(password, user);
  if (!ok) {
    await ctx.audit('login_fail', null, null, username);
    return err('用户名或密码错误', 401, 'BAD_CREDENTIALS');
  }

  const ua = req.headers.get('User-Agent') || '';
  const { token, expiresAt } = await createSession(ctx.db, user.id, env, ua);
  if (ctx.ctx && ctx.ctx.waitUntil) ctx.ctx.waitUntil(purgeExpired(ctx.db));

  await ctx.audit('login', null, null, username);

  return json({
    token,
    expiresAt,
    user: {
      id: user.id, username: user.username,
      display: user.display || user.username, role: user.role,
    },
  });
}

/** POST /api/auth/logout */
export async function logout(req, env, ctx) {
  const s = ctx.session;
  if (s) {
    await destroySession(ctx.db, s.token);
    await ctx.audit('logout', null, null, s.user.username);
  }
  return json({ ok: true });
}

/** GET /api/auth/me */
export async function me(req, env, ctx) {
  const s = ctx.session;
  if (!s) return err('未登录', 401, 'UNAUTHORIZED');
  await touchSession(ctx.db, s.token);
  return json({
    user: s.user,
    expiresAt: s.expiresAt,
    canWrite: canWrite(s.user),
    isAdmin: isAdmin(s.user),
  });
}

/** GET /api/users —— 用户列表（仅 admin） */
export async function listUsers(req, env, ctx) {
  if (!isAdmin(ctx.session.user)) return err('需要管理员权限', 403, 'FORBIDDEN');
  const { results } = await ctx.db.prepare(
    'SELECT id, username, display, role, active, created_at FROM users ORDER BY username'
  ).all();
  // 一并返回当前登录人，前端可直接标出「我」、禁用自我降级等按钮
  return json({ users: (results || []).map(normalizeUser), me: ctx.session.user });
}

function normalizeUser(u) {
  return {
    id: u.id, username: u.username,
    display: u.display || u.username,
    role: u.role,
    active: !!u.active,
    createdAt: u.created_at || null,
  };
}

/** POST /api/users —— 新增用户（仅 admin） */
export async function createUser(req, env, ctx) {
  if (!isAdmin(ctx.session.user)) return err('需要管理员权限', 403, 'FORBIDDEN');
  const b = await safeBody(req);
  const username = String(b.username || '').trim();
  const password = String(b.password || '');
  const role = ROLES.includes(b.role) ? b.role : 'staff';
  if (!username || username.length < 2) return err('用户名至少 2 个字符', 400, 'BAD_INPUT');
  if (!password || password.length < 6) return err('密码至少 6 位', 400, 'BAD_INPUT');

  const dup = await ctx.db.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
  if (dup) return err('用户名已存在', 409, 'DUP_USERNAME');

  const salt = newSalt();
  const hash = await hashPassword(password, salt);
  const now = Date.now();
  const id = uid('u_');
  await ctx.db.prepare(
    `INSERT INTO users (id, username, display, role, pwd_salt, pwd_hash, iterations, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 100000, 1, ?, ?)`
  ).bind(id, username, String(b.display || username), role, salt, hash, now, now).run();

  await ctx.audit('user_create', null, null, username);
  return json({ ok: true, user: { id, username, display: b.display || username, role, active: 1 } });
}

/** PUT /api/users/:id —— 改角色/显示名/重置密码/停用（仅 admin） */
export async function updateUser(req, env, ctx) {
  if (!isAdmin(ctx.session.user)) return err('需要管理员权限', 403, 'FORBIDDEN');
  const id = ctx.params.id;
  const b = await safeBody(req);

  const target = await ctx.db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  if (!target) return err('用户不存在', 404, 'NOT_FOUND');

  const sets = [];
  const vals = [];
  const now = Date.now();

  if (b.display != null) { sets.push('display = ?'); vals.push(String(b.display)); }
  if (b.role != null && ROLES.includes(b.role)) {
    // 不允许把自己降级，避免锁死管理入口
    if (id === ctx.session.user.id && b.role !== 'admin') {
      return err('不能修改自己的管理员角色', 400, 'SELF_DEMOTE');
    }
    sets.push('role = ?'); vals.push(b.role);
  }
  if (b.active != null) {
    if (id === ctx.session.user.id && !b.active) {
      return err('不能停用自己', 400, 'SELF_DISABLE');
    }
    sets.push('active = ?'); vals.push(b.active ? 1 : 0);
  }
  if (b.password) {
    if (String(b.password).length < 6) return err('密码至少 6 位', 400, 'BAD_INPUT');
    const salt = newSalt();
    const hash = await hashPassword(String(b.password), salt);
    sets.push('pwd_salt = ?', 'pwd_hash = ?');
    vals.push(salt, hash);
    // 改密码后吊销该用户所有会话
    await ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id).run();
  }

  if (!sets.length) return err('没有需要更新的字段', 400, 'NO_CHANGE');

  sets.push('updated_at = ?'); vals.push(now);
  await ctx.db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...vals, id).run();

  await ctx.audit('user_update', null, null, target.username);
  return json({ ok: true });
}

/** DELETE /api/users/:id —— 删除用户（仅 admin） */
export async function deleteUser(req, env, ctx) {
  if (!isAdmin(ctx.session.user)) return err('需要管理员权限', 403, 'FORBIDDEN');
  const id = ctx.params.id;
  if (id === ctx.session.user.id) return err('不能删除自己', 400, 'SELF_DELETE');

  const target = await ctx.db.prepare('SELECT username FROM users WHERE id = ?').bind(id).first();
  if (!target) return err('用户不存在', 404, 'NOT_FOUND');

  await ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id).run();
  await ctx.db.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  await ctx.audit('user_delete', null, null, target.username);
  return json({ ok: true });
}

/** POST /api/auth/password —— 修改自己的密码 */
export async function changeOwnPassword(req, env, ctx) {
  const s = ctx.session;
  const b = await safeBody(req);
  const oldPwd = String(b.oldPassword || '');
  const newPwd = String(b.newPassword || '');
  if (!oldPwd || !newPwd) return err('请填写原密码和新密码', 400, 'BAD_INPUT');
  if (newPwd.length < 6) return err('新密码至少 6 位', 400, 'BAD_INPUT');

  const user = await ctx.db.prepare('SELECT * FROM users WHERE id = ?').bind(s.user.id).first();
  const ok = await verifyPassword(oldPwd, user);
  if (!ok) return err('原密码错误', 401, 'BAD_CREDENTIALS');

  const salt = newSalt();
  const hash = await hashPassword(newPwd, salt);
  await ctx.db.prepare(
    'UPDATE users SET pwd_salt = ?, pwd_hash = ?, updated_at = ? WHERE id = ?'
  ).bind(salt, hash, Date.now(), user.id).run();

  // 改密码后吊销其他会话，保留当前
  await ctx.db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?')
    .bind(user.id, s.token).run();

  await ctx.audit('password_change', null, null, user.username);
  return json({ ok: true });
}