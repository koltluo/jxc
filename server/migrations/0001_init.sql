-- ============================================================
--  0001_init.sql —— 进销存云端版初始结构
--  设计要点：
--   · 业务数据用「通用单表 records」，15 个 store 共用，业务字段存 JSON
--     → 加字段零迁移（改前端 constants.js 即可）
--   · 删除用墓碑（deleted=1），保证增量同步能看到删除事件
--   · updated_at 为服务端毫秒时间戳，既做增量游标也做 LWW 冲突判定
-- ============================================================

-- ① 业务数据：所有 store 共用
CREATE TABLE IF NOT EXISTS records (
  store      TEXT    NOT NULL,              -- 'goods'|'sales'|... (15 个值)
  key        TEXT    NOT NULL,              -- code 或 id 的字符串值
  data       TEXT    NOT NULL,              -- 整条记录 JSON
  rev        INTEGER NOT NULL DEFAULT 1,    -- 乐观锁版本，每次写入 +1
  deleted    INTEGER NOT NULL DEFAULT 0,    -- 墓碑：1 表示已删除
  updated_at INTEGER NOT NULL,              -- 服务端毫秒时间戳
  PRIMARY KEY (store, key)
);
CREATE INDEX IF NOT EXISTS idx_records_store_updated ON records(store, updated_at);
CREATE INDEX IF NOT EXISTS idx_records_updated       ON records(updated_at);

-- ② 账号
CREATE TABLE IF NOT EXISTS users (
  id         TEXT    PRIMARY KEY,
  username   TEXT    NOT NULL UNIQUE,
  display    TEXT,
  role       TEXT    NOT NULL DEFAULT 'staff',   -- admin | staff | viewer
  pwd_salt   TEXT    NOT NULL,
  pwd_hash   TEXT    NOT NULL,
  iterations INTEGER NOT NULL DEFAULT 100000,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ③ 会话（随机 token 存库，可即时吊销）
CREATE TABLE IF NOT EXISTS sessions (
  token     TEXT    PRIMARY KEY,
  user_id   TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  ua        TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- ④ 原子取号
CREATE TABLE IF NOT EXISTS seq (
  k TEXT    PRIMARY KEY,
  v INTEGER NOT NULL DEFAULT 0
);

-- ⑤ 审计日志
CREATE TABLE IF NOT EXISTS audit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,
  user_id TEXT,
  username TEXT,
  action  TEXT NOT NULL,     -- login|logout|put|del|batch|replaceAll|clear|import
  store   TEXT,
  key     TEXT,
  detail  TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);
