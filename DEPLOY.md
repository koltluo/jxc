# Cloudflare 部署指南（联机版）

把进销存系统部署到 Cloudflare，得到一个公网网址，手机/电脑都能访问，数据存云端 D1 并自动同步。

**总耗时约 15 分钟。全程只需复制粘贴命令。**

---

## 目录结构

```
部署包/
├── DEPLOY.md              ← 本文件
├── frontend/              ← Cloudflare Pages 用（前端）
│   ├── index.html
│   ├── sw.js
│   ├── manifest.webmanifest
│   ├── icon-192.png
│   ├── icon-512.png
│   ├── _headers
│   └── _redirects
└── server/                ← Cloudflare Workers 用（后端 API）
    ├── wrangler.toml
    ├── migrations/0001_init.sql
    ├── seed/admin.mjs
    └── src/*.js
```

---

## 前置准备

1. 安装 Node.js 18+（[nodejs.org](https://nodejs.org)）
2. 注册 Cloudflare 账号（免费即可，[dash.cloudflare.com](https://dash.cloudflare.com/sign-up)）
3. 打开终端（Windows 用 PowerShell / macOS 用「终端」），进入本部署包目录：

```bash
cd 部署包
```

---

## 第一步：部署后端 API（Workers + D1）

### 1.1 登录 Cloudflare

```bash
cd server
npx wrangler login
```

浏览器会自动打开，点 **Allow** 授权。

### 1.2 创建 D1 数据库

```bash
npx wrangler d1 create jxc
```

命令会输出一段配置，形如：

```
[[d1_databases]]
binding = "DB"
database_name = "jxc"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

**复制那个 `database_id`**，粘贴到 `server/wrangler.toml` 里替换掉
`REPLACE_WITH_YOUR_DATABASE_ID`。

> 也可以不手动改：执行 `npx wrangler d1 create jxc --update-config` 会自动写入。

### 1.3 建表

```bash
npx wrangler d1 execute jxc --remote --file migrations/0001_init.sql
```

看到 `executed successfully` 即可。

### 1.4 创建管理员账号

```bash
node seed/admin.mjs admin 你的密码 --out seed/admin.sql
npx wrangler d1 execute jxc --remote --file seed/admin.sql
```

> **把「你的密码」换成你自己的**，至少 8 位，字母 + 数字。
> 例：`node seed/admin.mjs admin Jxc2026pass --out seed/admin.sql`

### 1.5 部署 Worker

```bash
npx wrangler deploy
```

成功后会输出一个网址，形如：

```
https://jxc-api.你的账号.workers.dev
```

**记下这个地址**，下一步要用。

---

## 第二步：部署前端（Cloudflare Pages）

### 方式 A：网页上传（推荐，不需要装额外工具）

1. 打开 [dash.cloudflare.com](https://dash.cloudflare.com)
2. 左侧菜单 → **Workers & Pages** → **Create** → **Pages** → **Upload assets**
3. 项目名填 `jxc`（或你喜欢的名字）
4. 把 `frontend/` **文件夹里的所有文件**（注意：是里面的文件，不是文件夹本身）拖进去上传
5. 点 **Deploy site**

完成后得到网址，形如：

```
https://jxc.pages.dev
```

### 方式 B：命令行部署

```bash
cd frontend
npx wrangler pages deploy . --project-name jxc
```

---

## 第三步：配置跨域白名单（重要）

回到 `server/wrangler.toml`，把 `ALLOWED_ORIGINS` 改成你的 Pages 域名：

```toml
[vars]
SESSION_TTL_MS = "2592000000"
ALLOWED_ORIGINS = "https://jxc.pages.dev"
```

> 有自定义域名就一并加上，逗号分隔：
> `ALLOWED_ORIGINS = "https://jxc.pages.dev,https://jxc.你的域名.com"`

然后重新部署后端：

```bash
cd server
npx wrangler deploy
```

---

## 第四步：开始使用

1. 打开你的 Pages 网址（如 `https://jxc.pages.dev`）
2. 页面会自动跳到**登录页**
3. 填 API 地址（第一步那个 `https://jxc-api.xxx.workers.dev`）
4. 点 **测试连接** → 显示✓后填账号密码 → 登录

登录成功后数据自动从云端拉取。

---

## 加人一起用

在应用内：**更多 → 用户管理 → 新建**

| 角色 | 权限 |
|---|---|
| **管理员** | 全部权限，可管用户 |
| **业务员** | 可录入单据、档案，不能管用户 |
| **查看者** | 只能看，不能改 |

给同事开「业务员」账号，他们打开同一个网址登录即可，数据实时同步。

---

## 常见问题

**Q：数据存在哪？安全吗？**
存在你自己的 Cloudflare D1 数据库里，只有你的账号能访问。密码经过 PBKDF2-SHA256 加盐哈希（10 万次迭代）存储，服务端不保存明文。

**Q：断网了还能用吗？**
可以。断网时照常开单，数据先存本机，联网后自动补传到云端。

**Q：手机怎么用？**
直接浏览器打开 Pages 网址即可。iPhone 建议 Safari → 分享 → 「添加到主屏幕」，用起来跟 App 一样。

**Q：忘记管理员密码了？**
重新执行第一步的 1.4（换个密码），会覆盖原账号密码：
```bash
node seed/admin.mjs admin 新密码 --out seed/admin.sql
npx wrangler d1 execute jxc --remote --file seed/admin.sql
```

**Q：部署出错怎么排查？**
```bash
npx wrangler tail
```
查看 Worker 实时日志。

**Q：Cloudflare 免费额度够用吗？**
免费版每天 10 万次请求、D1 5GB 存储。日常几十人使用绰绰有余。

**Q：想撤销公开访问？**
在 Pages 项目里删除部署，或设置 Access 策略即可。
