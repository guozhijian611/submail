# Submail Repository Guide

本文件适用于整个仓库。开始修改前先阅读相关源码、`README.md`、`CONTRIBUTING.md` 和现有测试，不要凭目录名猜测运行行为。

## 项目结构

- `apps/web`：React 19 + Vite 邮件客户端与管理界面。
- `apps/api`：Express API、认证、SQLite/MySQL 存储、邮件同步与发送、队列、AI 与翻译。
- `apps/mcp`：stdio 与 Streamable HTTP MCP 服务。
- `tests`：API、POP3、HTTP MCP、运行锁、备份恢复等集成测试。
- `scripts`：本地安全加固和真实服务商验证脚本。
- `docs`：部署、功能差距和公开项目文档。

生产 Docker 链路为 `Web/Nginx -> API -> SQLite/MySQL + Redis`，MCP 通过内部 API 工作。Web 是默认唯一对外暴露的服务。

## 硬性提交规则

- **每完成一个独立功能或行为修复，必须先完成对应验证并立即创建一个独立 Git commit，再开始下一个功能。**
- 不得把多个用户功能、无关重构或顺手清理塞进同一提交。文档规范、后端同步、前端交互和渲染修复应按可独立回滚的边界拆分。
- 提交信息使用 Conventional Commits，例如 `feat: add mark-all-read action`、`fix: sync imap special folders`、`docs: add repository agent guide`。
- 修改前后都运行 `git status --short`。工作区已有他人改动时必须保留，只提交自己负责的路径；需要时使用 `git commit --only -- <paths>`。
- 禁止使用 `git reset --hard`、`git checkout --` 或其他会覆盖未确认改动的命令。

## PR 合并前置规则

- **开始任何新功能或行为修复前，必须先检查并处理仓库中所有未合并 PR；只有可安全处理的 PR 已合并、主分支已同步后，才能继续开发。**
- 逐个检查 PR 的变更范围、review、合并冲突和 CI。仅合并检查通过且不存在未解决阻塞项的 PR；每次合并后重新同步 `main`，再检查后续 PR 的可合并状态。
- CI 失败、存在冲突、包含破坏性或安全敏感变更、或需要产品决策的 PR 不得强行合并。应先修复或明确报告阻塞原因，不得通过关闭检查、绕过分支保护或 force push 制造可合并状态。
- 开发前至少运行 `gh pr list --state open` 和 `git status --short --branch`，确认没有遗漏 PR，且本地 `main` 与 `origin/main` 一致。

## 本地命令与验收

首次安装使用 Node.js 22+：

```bash
npm ci
npm run secure:local
```

常用开发和 CI 命令：

```bash
npm run dev
npm run typecheck
npm run lint
npm test
npm run build
```

- 行为改动至少运行相关 workspace 的类型检查，并补充或更新测试。
- 提交到主分支前必须通过根目录的 `typecheck`、`test` 和 `build`；这些与 GitHub Actions 一致。
- Web 改动不能只看构建结果，必须在真实渲染页面验证目标交互、控制台和桌面布局；涉及响应式布局时再验证移动端。
- Docker 运行时改动先在本地验证，再执行 `docker compose up -d --build --wait`，并检查 `docker compose ps`、`/health` 和相关服务日志。

## 后端与数据规则

- API 输入在路由层校验，持久化逻辑集中在 repository；不要在前端复制权限或数据真相。
- `apps/api/src/schema.ts` 必须同时兼容 SQLite 与 MySQL。新增字段要提供安全默认值，并验证已有数据库升级路径。
- 邮件同步要区分服务商远端状态和本地状态；修改文件夹、flags、UID/UIDVALIDITY 或游标逻辑时必须覆盖重复同步与幂等性。
- 大邮箱查询禁止排序完整正文或附件；先查询轻量元数据，再按最终 ID 加载正文，避免 SQLite 临时空间耗尽。
- 对真实数据库执行结构性操作、恢复或批量数据修改前先备份，并在完成后验证数据量、关键行和运行日志。

## Web 与邮件内容规则

- 异步请求要避免瀑布和陈旧响应覆盖新状态；独立请求并行执行，跨请求状态更新优先使用函数式 `setState`。
- HTML 邮件必须经过现有净化流程，并在受限 iframe 中渲染。不得为了修布局而放开脚本、表单、顶层导航或不受控远程资源。
- 默认继续阻止外部邮件资源；只有用户设置或单封邮件明确允许时才加载，并保留可见提示。
- 自动翻译必须尊重管理员配置、目标语言和隐私边界；未配置服务、语言相同、纯空正文或翻译失败时应安全回退到原文，不能阻塞打开邮件。
- 用户可见能力变化需要同步检查英文与中文 README、设置说明和截图是否仍准确。截图和测试数据只能使用虚构内容与 `.local` 地址。

## 安全与仓库卫生

- 永远不要提交 `.env`、真实邮箱地址、邮件正文、附件、密码、令牌、API Key、数据库、`storage`、生成的 `dist`、`node_modules` 或浏览器会话数据。
- 不得读取或输出用户浏览器 cookie、localStorage、密码或私密邮件内容来绕过认证。
- 新依赖需要说明必要性，更新 lockfile，并运行 `npm audit`；不要用忽略审计或关闭安全检查来制造绿灯。
- 对外行为、部署或安全模型变化时更新 `README.md`、`README.zh-CN.md`、`SECURITY.md` 或 `docs/` 中对应文档。
