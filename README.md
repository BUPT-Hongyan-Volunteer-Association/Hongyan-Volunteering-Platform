# 鸿雁志愿服务平台

学生查看获批活动，负责人创建、修改、送审或撤回单次活动，老师核对差异后批准或驳回。批次 02 已补齐三端页面。项目正在继续开发。

接口定义与导入格式随工程维护。[OpenAPI v1.2.4](packages/contracts/openapi_v1.2.4.yaml) · [学生建档模板 v1.3](packages/contracts/templates/学生建档导入模板_v1.3.xlsx) · [志愿时长模板 v1.5](packages/contracts/templates/志愿时长录入模板_v1.5.xlsx)

## 启动本地开发

使用 Node.js 24（版本见 `.nvmrc`）、pnpm 10.32.1 和 PostgreSQL 18。在本机已配置的工作副本中，每个新终端先从工程根目录执行 `source .local/env.sh`。首次使用时克隆组织仓库，在仓库根目录运行下列命令。请先安装上述工具，并确保 `initdb`、`pg_ctl`、`createdb` 在 PATH 中。

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

## 本地免手输登录测试入口

先启动上表三个服务，并安装 Google Chrome。在工程根目录另开终端运行 `pnpm demo:open`，打开 [本地测试入口](http://127.0.0.1:5180/)，点选身份即可进入相应系统。每次选择都会打开独立浏览器会话，可同时验证多个角色。

新副本先按上文创建体验账号。首次启动入口时使用与种子相同的 `DEMO_STAFF_PASSWORD`，如已创建技术管理员也提供 `DEMO_ADMIN_PASSWORD`。可通过环境变量或本机 `.local/demo.env` 提供。启动器将体验凭证保存到被 Git 忽略的 `.local/demo-logins.json`，原有配置优先。学生首次使用时会自动走首登改密流程，已手动改密的体验账号需在该本地文件填入现有密码。入口只监听本机，关闭启动器用 Ctrl+C。

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

回归命令需要有建库权限的本地数据库角色，会创建并清理独立测试库，验证发布与修订、授权、幂等重试、并发冲突和审核历史分页。目录及归档规则见 [AGENTS.md](AGENTS.md)，界面约定见 [DESIGN.md](DESIGN.md)。

后台布局取自 Vue Vben Admin v5.7.0 的 Element Plus 入口与布局组件，上游提交为 `63a38dce49ba109f61607994e21ba921d8e970e9`。[MIT 许可](apps/admin/src/layouts/vben/LICENSE)

学生从「我的报名」查看报名及退出恢复进度，从「通知」查看回执状态，从「我的」打开时长、本人记录与反馈、账号设置。个人业务样例位于 `apps/web/src/personal/`，标有示例数据。账号信息来自当前真实会话。

负责人工作区以 `/managed/:id` 为入口，成员与版本读取、保存和送审沿用真实服务。通知回执按待跟进与已确认分列，现场记录按服务日期查找。退出恢复、七列时长预览、漏记、修复组及异常报告使用合成记录，成员管理预览仅主负责人可见。

后台首页单独统计真实活动待审，其他队列均注明示例来源。后台样例在 `apps/admin/src/management/`。验证老师与技术管理员差异时，另设 `DEMO_ADMIN_PASSWORD`（至少 12 字符，须区别于 `DEMO_STAFF_PASSWORD`）并运行种子命令，将建立合成技术管理员 `demo.admin`。学生档案启停由老师或技术管理员办理，独立后台账号启停仅技术管理员可见。

## 三端页面回归

安装本机 Google Chrome 后，在已配置开发数据库的仓库根目录运行 `pnpm test:pages`。该命令构建三个应用，新建专用 PostgreSQL 测试库，以独立端口启动 API 和两个前端的生产构建，并在独立浏览器会话中验证手机与桌面导航、真实地点修订、示例操作、成员切换及失权。进程结束后清理测试库。类型与服务回归分别运行 `pnpm typecheck` 和 `pnpm --filter @hongyan/api test:flow`。
