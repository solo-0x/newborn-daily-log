# 新生儿日常记录 · Vercel 云端版

手机与电脑自适应，支持喂奶、大小便、异常情况、其他记录、日期筛选、滑动删除、家庭账号及 JSON 备份。

## Vercel 部署

1. 在 Vercel 导入本仓库。
2. 通过 Marketplace 为项目创建并连接 Neon Postgres。
3. 配置 `DATABASE_URL` 和加密变量 `INITIAL_ADMIN_PASSWORD`。
4. 重新部署生产版本，使用 `admin` 和初始密码首次登录。

数据库表会在首次 API 请求时安全创建。账号、会话、登录限流和记录均保存在 Postgres。修改管理员密码后，初始密码不再用于登录。
