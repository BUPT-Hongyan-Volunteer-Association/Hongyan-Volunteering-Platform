# 鸿雁志愿服务平台

工程包含学生与负责人共用的 Web 入口、独立审核后台和 NestJS 服务。学生查看获批活动，负责人维护单次活动、送审和撤回，老师审批冻结版本。报名名单与时长审核为显式示例页。

## 本地环境

在包含本版本的工程克隆根目录执行下面的命令。使用 Node.js 24（`.nvmrc` 固定 24.22.3）、pnpm 10.32.1 和 PostgreSQL 18。用 `node -v`、`pnpm -v`、`postgres --version` 核对版本。使用 nvm 时可运行 `nvm install` 和 `nvm use`，然后用 `npm install --global pnpm@10.32.1` 安装指定包管理器。PostgreSQL 的 `initdb`、`pg_ctl` 和 `createdb` 需要在 PATH 中。macOS 上用 Homebrew 安装的 postgresql@18，其 bin 目录在该 formula 的安装前缀下。

### 1. 安装并生成

```sh
pnpm install --frozen-lockfile
pnpm contracts:generate
pnpm db:generate
```

两个前端共用 `packages/contracts/openapi_v1.2.4.yaml` 生成的 Fetch SDK 和类型。生成物位于 `packages/contracts/src/generated/`。Prisma Client 由 `apps/api/prisma/schema.prisma` 生成。修改源文件后重新运行对应的生成命令。两份空白导入表位于 `packages/contracts/templates/`。

### 2. 初始化本地数据库

以下命令在当前克隆的 `.local/pgdata` 中建一个独立 PostgreSQL 18 实例，只监听本机。第一次初始化时按提示设置开发角色密码（选择 URI 安全字符最方便）。下次启动同一数据目录，只需执行下方的 `pg_ctl` 命令，继续使用现有 `.env`。

```sh
mkdir -p .local
initdb -D .local/pgdata -U volunteer_dev -A scram-sha-256 --locale=C -E UTF8 -W
pg_ctl -D .local/pgdata -l .local/postgres.log -o "-h 127.0.0.1 -p 55432" -w start
createdb -h 127.0.0.1 -p 55432 -U volunteer_dev volunteer_dev
cp apps/api/.env.example apps/api/.env
```

`createdb` 提示时输入同一密码。也可用数据库客户端连接该实例的 `postgres` 维护库，执行 `CREATE DATABASE volunteer_dev;`。把 `apps/api/.env` 中的 `CHANGE_ME` 换成刚设置的密码。密码中的 URI 特殊字符需百分号编码。自动化验收可把 `initdb` 的 `-W` 换为 `--pwfile=文件路径`，从限本机用户读取的文件传入密码。使用已有 PostgreSQL 18 时，可直接将 `DATABASE_URL` 指向专用的空开发库。

```sh
pnpm db:migrate
pnpm typecheck
pnpm build
```

迁移依次建立账号与会话、角色与成员、活动版本、审核、回放记录和变更事件表。第二次运行只应用待执行迁移。`.env`、本地数据库及生成物均由 Git 忽略。

### 3. 启动与复验

在三个终端中分别从工程根目录执行一条命令。API 使用刚才配置的数据库，两个 Vite 入口均将同源 `/api/v1` 代理至 `127.0.0.1:3000`。

| 命令 | 打开的位置 |
| --- | --- |
| `pnpm dev:api` | 服务监听 `127.0.0.1:3000`，启动时执行数据库连接检查。 |
| `pnpm dev:web` | 学生与负责人入口 `http://localhost:5173/` |
| `pnpm dev:admin` | 审核后台 `http://localhost:5174/` |

1. 两个入口首次建立匿名会话后显示登录。网络面板可见同源 `GET /api/v1/auth/csrf` 返回 200，首次查询本人身份返回 401 后进入登录。会话 Cookie 使用 HttpOnly、Secure、SameSite=Lax 和路径 `/api/v1`。
2. 按下方方式准备合成账号。使用不同浏览器配置文件分别登录学生、负责人和老师。负责人从“我的 → 活动管理”新建单次活动，老师从“活动审核”读取冻结快照并决定。学生在首次批准后看到活动。公开地点 A 改为 B 后，待审或驳回仍显示 A，批准新版本后显示 B。
3. 停止 API 并刷新页面，应显示“连接失败”。恢复 API 后点击“重试”，将重新取得会话并返回登录或已授权入口。
4. 结束时在三个应用终端按 Ctrl+C。仅在使用上述专用数据库实例时，用 `pg_ctl -D .local/pgdata -m fast -w stop` 停止它，后续可以沿用该数据目录。

## 实现入口

| 位置 | 用途 |
| --- | --- |
| `packages/contracts/src/index.ts` | 两端共享的请求配置和匿名会话入口。调用生成 SDK 的 `getCsrf`，保留服务端错误及定位编号。 |
| `packages/ui/src/SessionStatus.vue` | 请求加载、成功、失败与重试。真实请求失败时直接反馈。 |
| `apps/api/src/auth/` | CSRF 接口与数据库会话。会话标识的摘要、独立 CSRF 值和到期时间存入 PostgreSQL，匿名会话有效期 30 分钟。 |
| `apps/admin/src/layouts/` | Vben Admin v5.7.0 的 Element Plus 入口与精简侧栏布局，保留路由内容区、顶栏及折叠导航。上游源码版本为 `63a38dce49ba109f61607994e21ba921d8e970e9`，来源为 `vbenjs/vue-vben-admin` 的 `apps/web-ele` 与 `packages/@core/ui-kit/layout-ui`。原版顶栏和布局的 MIT 许可随 `vben/LICENSE` 保留。 |

## 登录与本地体验账号

从工程根目录运行 `pnpm db:generate`、`pnpm db:migrate`、`pnpm --filter @hongyan/api build`。在专用开发库中需要合成账号时，设置仅本机使用的环境变量 `DEMO_STAFF_PASSWORD`（至少 12 个字符），执行 `pnpm --filter @hongyan/api exec node --env-file=.env scripts/seed.mjs`。重复执行保留已有账号、密码与活动。

| 账号 | 合成身份 |
| --- | --- |
| 0000000001 | 学生 |
| 0000000002、0000000003 | 分别管理活动甲、乙 |
| 0000000004 | 活动甲协作者 |
| demo.teacher、demo.dual | 独立审核员、兼任活动甲协作者的审核员 |

学生初始密码取学号后六位，首次登录后须设置至少八位、同时含英文字母与数字的新密码。后台体验账号使用初始化时设置的独立凭证。登录与修改密码轮换 Cookie，退出后原会话失效。学生和负责人从 5173 进入，后台账号从 5174 进入。两个入口沿用同源 CSRF 客户端。

## 集成回归与报名交接

从工程根目录运行 `pnpm --filter @hongyan/api test:flow`。先生成客户端并配置 API 的 `.env`，开发数据库角色须有建库权限。测试创建随机命名的独立数据库，运行全部迁移、写入合成账号并以随机本机端口启动 NestJS。覆盖首次发布、驳回后修订、审批幂等、越权和旧版本并发。结束时关闭测试服务并删除本次创建的测试库。

报名模块从 `apps/web/src/activities/PublicActivities.vue` 的“申请报名”接起，使用当前获批活动 ID 和报名窗口。`PersonalPage.vue` 已保留“我的报名”入口，`registrations/Roster.vue` 中的本地样例和分页结果可替换为真实名单查询。登录、会话与写请求复用 `@hongyan/contracts`，管理授权及事务沿用 `apps/api/src/activities/read.ts` 和 `workflow.ts`。
