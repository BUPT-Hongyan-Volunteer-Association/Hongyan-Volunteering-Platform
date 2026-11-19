# 鸿雁志愿服务平台

负责人创建活动并提交审核，老师核对后批准或驳回。学生可从已发布的活动详情申请报名，负责人在「报名名单 → 查看 → 录取此人」处理。学生从「我的报名」查看结果，录取后打开活动详情即可查看入群方式。

## 首次配置

安装 Node.js 24 和 PostgreSQL 18，将 PostgreSQL 命令行工具加入 PATH。以下命令都在仓库根目录运行。Windows PowerShell 中请用 `pnpm.cmd` 执行文中的 `pnpm` 命令。

<details>
<summary>macOS · 安装 pnpm 并创建开发库</summary>

```sh
npm install --global pnpm@10.32.1
mkdir -p .local
initdb -D .local/pgdata -U volunteer_dev -A scram-sha-256 --locale=C -E UTF8 -W
pg_ctl -D .local/pgdata -l .local/postgres.log -o "-h 127.0.0.1 -p 55432" -w start
createdb -h 127.0.0.1 -p 55432 -U volunteer_dev volunteer_dev
cp -n apps/api/.env.example apps/api/.env
```

在 `apps/api/.env` 的 `DATABASE_URL` 中填入刚设置的密码，保留端口 `55432`。以后手动启动数据库只需执行上面的 `pg_ctl` 命令。若此工作副本通过 `.local/env.sh` 设置工具路径，新开终端后先执行 `source .local/env.sh`。

</details>

<details>
<summary>Windows · 安装 pnpm 并创建开发库</summary>

先启动 PostgreSQL 的 Windows 服务，再在 PowerShell 中执行以下命令。

```powershell
npm.cmd install --global pnpm@10.32.1
createuser -h 127.0.0.1 -p 5432 -U postgres --createdb -P volunteer_dev
createdb -h 127.0.0.1 -p 5432 -U postgres -O volunteer_dev volunteer_dev
if (!(Test-Path apps/api/.env)) { Copy-Item apps/api/.env.example apps/api/.env }
```

在 `apps/api/.env` 的 `DATABASE_URL` 中填入开发角色的密码，并将端口改为 `5432`（或本机 PostgreSQL 的实际端口）。

</details>

配置好数据库后，依次安装依赖、生成代码并应用迁移。已有开发库也可直接填写 `DATABASE_URL`，密码中的特殊字符需做百分号编码。

```sh
pnpm install --frozen-lockfile
pnpm contracts:generate
pnpm db:generate
pnpm db:migrate
pnpm build
```

需要登录体验时，先设置环境变量 `DEMO_STAFF_PASSWORD`（至少 12 个字符），再运行 `pnpm --filter @hongyan/api db:seed` 创建账号。学生 `0000000001` 和负责人 `0000000002` 的初始密码为学号后六位，审核员 `demo.teacher` 使用刚设置的密码。自动测试会自行创建账号。

## 日常启动

配置好的 Mac 可双击仓库中的 `一键启动.command`。手动启动时，先启动 PostgreSQL，再打开三个终端，各运行一行。服务就绪后可在浏览器中输入对应的前端地址。

| 服务 | 启动命令 | 本机地址 |
| --- | --- | --- |
| API | `pnpm dev:api` | `127.0.0.1:3000` |
| 学生与负责人端 | `pnpm dev:web` | `http://localhost:5173` |
| 审核后台 | `pnpm dev:admin` | `http://localhost:5174` |

要切换角色，另开终端运行 `pnpm demo:open`，再访问 `http://127.0.0.1:5180`。首次启动身份选择页时，需在该终端或 `.local/demo.env` 中提供创建账号时的 `DEMO_STAFF_PASSWORD`。

## 运行测试

| 检查内容 | 命令 |
| --- | --- |
| 类型检查 | `pnpm typecheck` |
| 体验账号配置 | `pnpm --filter @hongyan/api test:accounts` |
| 服务端活动发布、报名与录取 | `pnpm --filter @hongyan/api test:flow` |
| 报名突发负载（12,000 次） | `pnpm --filter @hongyan/api test:registration-burst` |
| 学生端、负责人端和审核后台页面 | `pnpm test:pages` |

服务端与页面回归需要运行中的 PostgreSQL 和有建库权限的角色，测试会自行启动服务并清理测试库。页面回归和身份选择页会自动选择可用浏览器，已有 Edge 或 Chrome 即可运行，也可用 `pnpm exec playwright-core install firefox` 安装配套的 Firefox。

<details>
<summary>指定测试浏览器或使用 Safari 登录</summary>

设置 `HY_BROWSER` 可选择 `chromium`、`msedge`、`chrome`、`firefox` 或 `webkit`。例如，macOS 执行 `HY_BROWSER=msedge pnpm test:pages`，PowerShell 先执行 `$env:HY_BROWSER = 'msedge'`，再执行 `pnpm.cmd test:pages`。Playwright 配套引擎可用 `pnpm exec playwright-core install 引擎名` 安装。

Safari 或 WebKit 本机登录需要 HTTPS。启动两个前端和身份选择页前，在各终端执行 `export HY_LOCAL_HTTPS=1`（macOS）或 `$env:HY_LOCAL_HTTPS = '1'`（PowerShell），再用 HTTPS 访问前端端口。身份选择页仍使用 HTTP。页面回归会自动启用 HTTPS。WebKit 在 macOS 上已验证登录与会话保持，完整回归仍有自动点击偏移的问题。

</details>

## 项目资料

[界面设计规范](DESIGN.md) · [PRD 对照图与复验](docs/ui-samples/README.md) · [工程协作约定](AGENTS.md) · [接口定义](packages/contracts/openapi_v1.2.4.yaml) · [学生建档模板](packages/contracts/templates/学生建档导入模板_v1.3.xlsx) · [志愿时长模板](packages/contracts/templates/志愿时长录入模板_v1.5.xlsx) · [后台布局许可](apps/admin/src/layouts/vben/LICENSE)
