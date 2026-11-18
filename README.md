# 鸿雁志愿服务平台

学生查看获批活动，负责人创建、修改、送审或撤回单次活动，老师核对差异后批准或驳回。报名名单与时长审核页标有“示例数据”。

## 启动本地开发

使用 Node.js 24（版本见 `.nvmrc`）、pnpm 10.32.1 和 PostgreSQL 18。在本机已配置的工作副本中，每个新终端先从工程根目录执行 `source .local/env.sh`。首次克隆请先安装上述工具，并确保 `initdb`、`pg_ctl`、`createdb` 在 PATH 中。

```sh
pnpm install --frozen-lockfile
pnpm contracts:generate
pnpm db:generate
```

首次使用专用本地数据库时，执行下列命令。按提示为 `volunteer_dev` 设置密码，并将同一密码写入 `apps/api/.env` 的连接地址，特殊字符需百分号编码。已有 PostgreSQL 实例可直接配置空开发库的连接地址。

```sh
mkdir -p .local
initdb -D .local/pgdata -U volunteer_dev -A scram-sha-256 --locale=C -E UTF8 -W
pg_ctl -D .local/pgdata -l .local/postgres.log -o "-h 127.0.0.1 -p 55432" -w start
createdb -h 127.0.0.1 -p 55432 -U volunteer_dev volunteer_dev
cp apps/api/.env.example apps/api/.env
```

配置连接后执行 `pnpm db:migrate` 和 `pnpm build`。需要合成账号时，设置环境变量 `DEMO_STAFF_PASSWORD`（至少 12 个字符），再运行 `pnpm --filter @hongyan/api db:seed`。重复运行会保留已有账号、密码及活动。

| 在三个终端分别运行 | 本机入口 |
| --- | --- |
| `pnpm dev:api` | NestJS 服务 `127.0.0.1:3000` |
| `pnpm dev:web` | [学生与负责人](http://localhost:5173/) |
| `pnpm dev:admin` | [审核后台](http://localhost:5174/) |

已有数据库下次启动只需运行上面的 `pg_ctl … start` 命令。结束应用用 Ctrl+C，停止专用数据库用 `pg_ctl -D .local/pgdata -m fast -w stop`。

## 体验与验证

| 账号 | 合成身份 |
| --- | --- |
| `0000000001` | 学生 |
| `0000000002`、`0000000003` | 活动甲、乙的负责人 |
| `0000000004` | 活动甲协作者 |
| `demo.teacher`、`demo.dual` | 审核员、兼任甲活动协作者的审核员 |

学生初始密码为学号后六位，首登须改为至少八位且含英文字母和数字的新密码。后台使用初始化时设置的凭证。跨角色走查使用不同浏览器配置文件，避免共用 Cookie。

从“我的 → 活动管理”送审，再从后台“活动审核”核对冻结版本。公开地点从 A 修订为 B 时，学生在待审和驳回后仍看到 A，批准后才看到 B。

```sh
pnpm typecheck
pnpm --filter @hongyan/api test:flow
```

回归命令需要有建库权限的本地数据库角色，会创建并清理独立测试库，验证发布、修订、越权、并发和幂等。目录及归档规则见 [AGENTS.md](AGENTS.md)，界面约定见 [DESIGN.md](DESIGN.md)。

后台布局取自 Vue Vben Admin v5.7.0 的 Element Plus 入口与布局组件，上游提交为 `63a38dce49ba109f61607994e21ba921d8e970e9`。[MIT 许可](apps/admin/src/layouts/vben/LICENSE)
