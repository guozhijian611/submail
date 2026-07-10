# Submail 部署、MCP 与运维

## 一键启动

服务器需要 Docker Engine 和 `docker compose`。在项目根目录执行：

```bash
./deploy.sh
```

脚本会：

1. 从 `.env.example` 创建权限为 `600` 的 `.env`。
2. 首次自动生成随机 `SUBMAIL_SECRET`。
3. 选择 SQLite、Compose 内置 MySQL 或外部 MySQL。
4. 校验 Compose 配置，启动持久化 Redis，构建镜像并后台启动服务。
5. 等待 API、Redis、MCP、Web，以及可选 MySQL 的健康检查。
6. 打印本机地址和数据库模式。

API 和 MCP 只在 Compose 内部网络开放。宿主机默认只有 `127.0.0.1:8080` 网关：

- Web：`https://mail.example.com/`
- API：`https://mail.example.com/api/...`
- 健康检查：`https://mail.example.com/health`
- Streamable HTTP MCP：`https://mail.example.com/mcp`

将 HTTPS 反向代理指向 `http://127.0.0.1:8080`。不要直接把初始化页面、管理员会话或 MCP / API Key 暴露在公网明文 HTTP 上。若必须修改 `SUBMAIL_BIND_ADDRESS=0.0.0.0`，应先确保外层 TLS 和访问控制已经生效。

## 数据库与队列模式

首次运行 `./deploy.sh` 时可选择：

- `sqlite`：数据库位于 `submail_data` 卷，适合绝大多数单人部署。
- `mysql`：启用 Compose 的 `mysql` profile，数据位于 `submail_mysql` 卷；脚本自动生成数据库用户密码和 root 密码。
- `external_mysql`：不启动内置 MySQL，在 `.env` 填写 `SUBMAIL_MYSQL_URL`，或填写 `SUBMAIL_MYSQL_HOST/PORT/DATABASE/USER/PASSWORD`；需要 TLS 时设置 `SUBMAIL_MYSQL_SSL=true`。

选择结果写入权限为 `600` 的 `.env`。已有业务数据后不要直接修改 `SUBMAIL_DB_MODE`；当前不会自动在 SQLite 与 MySQL 之间搬迁数据。

所有 Docker 模式都会启动 Redis，并将同步、手动同步和 API/MCP 发信任务交给 BullMQ。Redis AOF 位于 `submail_redis` 卷。SMTP 任务故意不自动重试，因为“服务器已接收但最终响应丢失”时重试会造成重复邮件；同步任务允许有限重试，同时保留原有数据库同步运行记录。

## 首次管理员初始化

留空 `SUBMAIL_ADMIN_EMAIL` 和 `SUBMAIL_ADMIN_PASSWORD` 时，首次打开 Web 会显示初始化页面。填写管理员名称、邮箱和至少 8 位密码即可；也可以点击“随机生成”创建更强的密码。首个管理员创建成功后，初始化接口会自动关闭。

也可以在服务器本机调用：

```bash
curl --fail-with-body \
  --request POST \
  --header 'content-type: application/json' \
  --data '{
    "name": "管理员",
    "email": "admin@example.com",
    "password": "请替换为至少8位的密码"
  }' \
  http://127.0.0.1:8080/api/setup/admin
```

也可提前在 `.env` 配置安全的 `SUBMAIL_ADMIN_EMAIL` 和 `SUBMAIL_ADMIN_PASSWORD`，由空数据库首次启动时自动创建管理员。

`SUBMAIL_SECRET` 必须长期保留，丢失或错误更换都会导致已保存的邮箱、AI 和翻译凭据无法解密。初始化前不要把服务直接暴露到公网；默认回环绑定可以避免他人抢先创建首个管理员。

## AI 与翻译

登录 Web 后进入“设置”：

- AI：填写 OpenAI-compatible `chat/completions` 地址、API Key、实际模型名、温度和可选偏好提示词，然后先点击连接测试。
- 翻译：默认 Google 免 Key；也可切换 LibreTranslate 或自定义接口。

第三方返回的 401、429、超时等会被转换为不含上游敏感响应体的可读错误。系统提示词内置邮件内容不可信规则，管理员提示词只作为偏好，不能取消该安全边界。

默认 Google 翻译端点是非正式公共服务。机密邮件、合规场景或需要稳定 SLA 时，应配置自建 LibreTranslate 或受信任的商业服务。

## 创建 MCP / API Key

在 Web 设置的 MCP / API Key 管理中创建 Key，可配置：

- scope：账号读取、邮件读取、邮件发送、AI、翻译、调用日志。
- 可访问的邮箱账号，或显式授权全部当前及未来账号。
- 过期时间。
- 每日发信上限；`0` 表示禁止发信。

Key 只显示一次。远程客户端对每个请求使用：

```http
Authorization: Bearer sk_submail_xxx
```

也支持 `x-submail-api-key`。客户端示例：

```json
{
  "url": "https://mail.example.com/mcp",
  "headers": {
    "Authorization": "Bearer sk_submail_xxx"
  }
}
```

HTTP MCP 是无状态 Streamable HTTP。请求体默认最多 40 MiB，`SUBMAIL_MCP_MAX_BODY_BYTES` 的硬上限为 64 MiB。无需配置 Origin 白名单；Nginx 同源反向代理会传递 Host，MCP 对浏览器请求自动校验 Origin 与 Host 一致。

可用工具：

- `list_accounts`
- `search_mail`
- `read_mail`
- `send_mail`
- `summarize_mail`
- `draft_reply`
- `compose_mail`
- `translate_mail`

审计日志只记录邮件 ID、长度、数量和语言等元数据，不记录邮件正文、AI prompt、推荐回信、邮箱地址、附件 Base64 或幂等键。

本地 stdio MCP：

```bash
SUBMAIL_API_URL=http://127.0.0.1:8787 \
SUBMAIL_MCP_API_KEY=sk_submail_xxx \
npm run dev:mcp
```

## HTTP 发信 API

发信接口与 MCP 共用后台生成的 Key。Key 必须具有“邮件发送”权限，并被授权访问请求中的 `accountId`：

```bash
curl --fail-with-body 'https://mail.example.com/api/send' \
  --header 'Authorization: Bearer sk_submail_xxx' \
  --header 'Content-Type: application/json' \
  --header 'Idempotency-Key: business-20260710-0001' \
  --data '{
    "accountId": "邮箱账号ID",
    "to": ["receiver@example.com"],
    "cc": [],
    "bcc": [],
    "subject": "测试邮件",
    "text": "由 Submail API 发送"
  }'
```

认证头也可以使用 `x-submail-api-key`。建议业务方始终传入 8 至 200 字符的 `Idempotency-Key`，同一个业务动作重试时保持不变；相同 Key 和相同请求会返回原投递结果，内容冲突则拒绝发送。接口还支持 `html`、`replyTo`、`inReplyTo`、`references`、已验证的 `fromAliasId` 和 Base64 附件。别名只复用所属真实邮箱的 SMTP 登录；若上游服务商不允许该地址 Send As，接口会返回上游拒绝，Submail 不会绕过服务商的身份策略。

## 备份与恢复

SQLite 模式使用：

- `submail_data`：SQLite 主库、WAL 和 SHM。
- `submail_storage`：备份及后续文件存储。

在线备份使用 SQLite Backup API，包含已提交的 WAL 数据，并生成 SHA-256 manifest：

```bash
docker compose exec -T api \
  node dist/backup.js /storage/backups/submail.sqlite
```

备份文件和 manifest 权限为 `600`。必须另外安全保存创建备份时的 `SUBMAIL_SECRET`。

恢复会替换主库。先停止会访问 API 的服务，再用一次性容器恢复：

```bash
docker compose stop web mcp api
docker compose run --rm \
  -e SUBMAIL_CONFIRM_RESTORE=YES \
  api node dist/restore.js /storage/backups/submail.sqlite
docker compose up -d
```

恢复与 API 使用同一把原子排他运行锁；双 API 进程和在线恢复都会被拒绝。恢复流程会校验源库、保存一致的恢复前回滚副本、校验临时文件并原子替换主库；如果现库已经损坏，则原样保全 main/WAL/SHM 取证工件后继续从有效备份恢复。

只有在人工确认 API/restore 进程已经异常退出后，才可设置 `SUBMAIL_BREAK_STALE_RUNTIME_LOCK=YES` 接管陈旧锁。系统即使看到该开关，也不会删除本机仍存活 PID 的锁；被接管的旧锁会保留为审计工件。

本机源码模式可使用：

```bash
npm run build
npm --workspace apps/api run backup -- /安全路径/submail.sqlite
SUBMAIL_CONFIRM_RESTORE=YES \
  npm --workspace apps/api run restore -- /安全路径/submail.sqlite
```

内置 MySQL 使用官方工具备份（重定向文件在宿主机创建）：

```bash
docker compose --profile mysql exec -T mysql \
  sh -c 'exec mysqldump -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" --single-transaction "$MYSQL_DATABASE"' \
  > submail-mysql.sql
```

恢复前停止 API 写入，然后执行：

```bash
docker compose stop api mcp
docker compose --profile mysql exec -T mysql \
  sh -c 'exec mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"' \
  < submail-mysql.sql
docker compose --profile mysql up -d
```

外部 MySQL 使用云厂商快照/PITR 或对应版本的 `mysqldump`。项目内 `backup`/`restore` 命令在 MySQL 模式会明确拒绝执行，避免把 SQLite 文件备份误当成 MySQL 备份。

## 更新、日志与数据保留

```bash
./deploy.sh
docker compose ps
docker compose logs -f api mcp web
```

从 schema v2 首次升级时，系统会撤销旧版中“空账号列表/全部账号”语义无法区分的全局 MCP / API Key。请在后台按最小权限重新签发；这是一次有意的安全收紧。

停止但保留数据：

```bash
docker compose down
```

除非确定要删除全部数据，不要执行 `docker compose down -v`。默认审计日志保留 30 天；同步运行记录默认保留 30 天，可在“同步任务”页面调整并手动清理。附件默认永久保留，也可在“附件管理”页面设置自动删除天数。

## 当前数据库边界

SQLite 使用 FTS5 排序搜索；MySQL 为保证外部实例兼容性，当前使用普通字段和附件文件名 `LIKE` 搜索，尚未创建供应商特定 FULLTEXT 索引。两种驱动共享异步仓储与事务接口，但备份工具各自独立，也没有内置跨数据库迁移命令。
