INSERT INTO users (id, username, display, role, pwd_salt, pwd_hash, iterations, active, created_at, updated_at)
VALUES ('u_lkv1oPMq39q3EvJ-', 'admin', 'admin', 'admin', 'ECVroGd4OMF07plVublGmQ==', 'nn8imCgeq2dFQlb/5V4r2fLVXZLZhUxOOys6dpxu/Bo=', 100000, 1, 1791617150861, 1791617150861)
ON CONFLICT(username) DO UPDATE SET
  display = excluded.display,
  role = excluded.role,
  pwd_salt = excluded.pwd_salt,
  pwd_hash = excluded.pwd_hash,
  iterations = excluded.iterations,
  active = 1,
  updated_at = excluded.updated_at;
