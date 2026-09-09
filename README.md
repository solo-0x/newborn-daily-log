# 新生儿日常记录 · 文件数据库版

这是一个尽量简单的服务端版本，不需要 MySQL、SQLite、D1，也不需要 `npm install`。

## 项目结构

```text
newborn-filedb/
├─ server.js
├─ public/
│  └─ index.html
└─ data/
   └─ db.json        # 首次启动自动创建
```

## 启动

需要 Node.js 18 或更高版本：

```bash
node server.js
```

浏览器访问：

```text
http://localhost:8787
```

### 指定初始管理员密码

首次启动前可设置：

macOS / Linux：

```bash
ADMIN_PASSWORD='你的密码' node server.js
```

Windows PowerShell：

```powershell
$env:ADMIN_PASSWORD='你的密码'; node server.js
```

用户名固定为 `admin`。如果没有设置 `ADMIN_PASSWORD`，首次启动会随机生成密码并打印在控制台。

## 数据

用户、会话、日常记录都保存在：

```text
data/db.json
```

备份整个 `data` 目录即可。不要把 `data/db.json` 放进可公开下载的静态目录。

## 部署说明

该版本适合普通 VPS、NAS、家庭服务器或任何可以长期运行 Node.js 且项目目录可写的服务器。

**不能直接部署到 Cloudflare Drop 后使用文件数据库。** Cloudflare Drop/Workers 的静态项目目录不是持久可写磁盘。若必须使用 Cloudflare 托管服务端数据，需要改回 D1/KV 等 Cloudflare 存储。

如使用 Nginx/Caddy 反向代理，代理到 `127.0.0.1:8787` 即可。公网使用时建议启用 HTTPS。


## GitHub 项目版说明

沿用原文件数据库版界面和数据结构，支持家庭成员共享、喂奶快捷量、大小便分类、异常备注、日期筛选、滑动删除和备份导入导出。

建议使用 Node.js 22 或更高版本；无第三方依赖。运行 `npm start` 或 `node server.js`。

- 默认只监听 `127.0.0.1:8787`；局域网访问可设置 `HOST=0.0.0.0`。
- 数据目录、密码配置及日志已加入 Git 忽略规则，不要提交真实家庭数据。
- 读写操作按请求串行执行，避免多位家庭成员同时保存时覆盖记录；仅支持单个 Node 进程，不能使用多实例或 cluster 模式共享该文件。
- 密码使用 scrypt 加盐散列；会话通过 HttpOnly Cookie 传递。登录失败达到 5 次会锁定该来源和账号组合 10 分钟，限流状态存于进程内，重启会清空。
- 默认不信任客户端转发的 IP。仅在可信反向代理后设置 `TRUST_PROXY=1`，代理必须覆盖 X-Forwarded-For 和 X-Forwarded-Proto，且后端端口不得暴露公网。
- 停止服务后备份整个 `data` 目录；恢复时停止服务并替换该目录。页面导出的 JSON 只包含记录，不含账号与会话。

项目仓库：https://github.com/solo-0x/newborn-daily-log

项目尚未部署，GitHub 本身不会运行此 Node 服务。
