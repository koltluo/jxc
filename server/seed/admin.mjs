// ============================================================
//  seed/admin.mjs —— 生成 admin 初始账号的建库脚本
//
//  用法：
//    1) 生成哈希：
//       node server/seed/admin.mjs admin <密码>
//       → 打印一条 INSERT SQL
//    2) 本地执行：
//       npx wrangler d1 execute jxc --local --command "<SQL>"
//    3) 线上执行：
//       npx wrangler d1 execute jxc --remote --command "<SQL>"
//
//  也支持直接输出到文件再 -f 执行：
//       node server/seed/admin.mjs admin 123456 --out server/seed/admin.sql
//
//  注意：脚本用 Node 的 webcrypto 实现 PBKDF2-SHA256(100000)，
//        与 server/src/auth.js 完全同算法，可直接互相校验。
// ============================================================

import { webcrypto as crypto } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ITERATIONS = 100000;

function b64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

async function hashPassword(password, saltB64) {
  const salt = Buffer.from(saltB64, 'base64');
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' }, key, 256);
  return b64(new Uint8Array(bits));
}

function uid(prefix = '') {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return prefix + Buffer.from(b).toString('base64url').slice(0, 16);
}

/** 转义 SQL 字符串字面量 */
function q(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
let outFile = null;
if (outIdx >= 0) { outFile = args[outIdx + 1]; args.splice(outIdx, 2); }

const username = args[0] || 'admin';
const password = args[1] || 'admin123';
const role = args[2] || 'admin';
const display = args[3] || username;

if (!['admin', 'staff', 'viewer'].includes(role)) {
  console.error('角色必须是 admin | staff | viewer');
  process.exit(1);
}

const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
const hash = await hashPassword(password, salt);
const id = uid('u_');
const now = Date.now();

const sql =
`INSERT INTO users (id, username, display, role, pwd_salt, pwd_hash, iterations, active, created_at, updated_at)
VALUES (${q(id)}, ${q(username)}, ${q(display)}, ${q(role)}, ${q(salt)}, ${q(hash)}, ${ITERATIONS}, 1, ${now}, ${now})
ON CONFLICT(username) DO UPDATE SET
  display = excluded.display,
  role = excluded.role,
  pwd_salt = excluded.pwd_salt,
  pwd_hash = excluded.pwd_hash,
  iterations = excluded.iterations,
  active = 1,
  updated_at = excluded.updated_at;`;

if (outFile) {
  const f = path.resolve(outFile);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, sql + '\n', 'utf8');
  console.log('✔ 已写入：' + f);
  console.log('  执行：npx wrangler d1 execute jxc --local -f ' + path.relative(process.cwd(), f));
} else {
  console.log('-- 账号：' + username + ' / ' + password + ' / ' + role);
  console.log('-- 本地执行：npx wrangler d1 execute jxc --local --command "<下方 SQL>"');
  console.log('-- 线上执行：npx wrangler d1 execute jxc --remote --command "<下方 SQL>"');
  console.log('');
  console.log(sql);
}
