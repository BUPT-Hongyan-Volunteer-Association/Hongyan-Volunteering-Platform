# 鸿雁志愿服务平台

工程包含学生与负责人共用的 Web 入口、独立审核后台和 NestJS 服务。当前两个入口都会建立匿名会话，显示真实服务的连接状态。

## 本地环境

在包含本版本的工程克隆根目录执行下面的命令。使用 Node.js 24（`.nvmrc` 固定 24.22.3）、pnpm 10.32.1 和 PostgreSQL 18。用 `node -v`、`pnpm -v`、`postgres --version` 核对版本。使用 nvm 时可运行 `nvm install` 和 `nvm use`，然后用 `npm install --global pnpm@10.32.1` 安装指定包管理器。PostgreSQL 的 `initdb`、`pg_ctl` 需要在 PATH 中。macOS 上用 Homebrew 安装的 postgresql@18，其 bin 目录在该 formula 的安装前缀下。

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
cp apps/api/.env.example apps/api/.env
```

把 `apps/api/.env` 中的 `CHANGE_ME` 换成刚设置的密码。密码中的 URI 特殊字符需百分号编码。自动化验收可把 `initdb` 的 `-W` 换为 `--pwfile=文件路径`，从限本机用户读取的文件传入同一个密码。使用已有 PostgreSQL 18 时，可直接将 `DATABASE_URL` 指向专用的空开发库。

```sh
pnpm db:migrate
pnpm typecheck
pnpm build
```

迁移会在实例中建立 `volunteer_dev` 数据库（若尚未创建，须有建库权限）并建立匿名会话表。第二次运行只应用待执行迁移。`.env`、本地数据库及生成物均由 Git 忽略。

### 3. 启动与复验

在三个终端中分别从工程根目录执行一条命令。API 使用刚才配置的数据库，两个 Vite 入口均将同源 `/api/v1` 代理至 `127.0.0.1:3000`。

| 命令 | 打开的位置 |
| --- | --- |
| `pnpm dev:api` | 服务监听 `127.0.0.1:3000`，启动时执行数据库连接检查。 |
| `pnpm dev:web` | 学生与负责人入口 `http://localhost:5173/` |
| `pnpm dev:admin` | 审核后台 `http://localhost:5174/` |

1. 用浏览器打开两个入口，分别看到“服务已连接”和匿名会话有效时间。开发者工具的网络面板中，两端各有一个同源 `GET /api/v1/auth/csrf`，状态 200。响应包含 `data.csrf_token`、`data.expires_at`、`request_id`。
2. 首次请求设置 `volunteer_session` Cookie，属性为 HttpOnly、Secure、SameSite=Lax，路径为 `/api/v1`。请使用上述 localhost 地址。重复请求使用浏览器会话，令牌只在请求层内存中保存。
3. 保持两个前端运行，在 API 终端按 Ctrl+C。刷新两个页面，均应显示“连接失败”，点击“重试”仍应失败。重新运行 `pnpm dev:api`，待启动完成后在两个页面点击“重试”，各自再次得到 200 并恢复“服务已连接”。
4. 结束时在三个应用终端按 Ctrl+C。仅在使用上述专用数据库实例时，用 `pg_ctl -D .local/pgdata -m fast -w stop` 停止它，后续可以沿用该数据目录。

## 实现入口

| 位置 | 用途 |
| --- | --- |
| `packages/contracts/src/index.ts` | 两端共享的请求配置和匿名会话入口。调用生成 SDK 的 `getCsrf`，保留服务端错误及定位编号。 |
| `packages/ui/src/SessionStatus.vue` | 请求加载、成功、失败与重试。真实请求失败时直接反馈。 |
| `apps/api/src/auth/` | CSRF 接口与数据库会话。会话标识的摘要、独立 CSRF 值和到期时间存入 PostgreSQL，匿名会话有效期 30 分钟。 |
| `apps/admin/src/layouts/` | Vben Admin v5.7.0 的 Element Plus 入口与精简侧栏布局，保留路由内容区、顶栏及折叠导航。上游源码版本为 `63a38dce49ba109f61607994e21ba921d8e970e9`，来源为 `vbenjs/vue-vben-admin` 的 `apps/web-ele` 与 `packages/@core/ui-kit/layout-ui`。原版顶栏和布局的 MIT 许可随 `vben/LICENSE` 保留。 |
