# 鸿雁志愿服务平台

| 角色 | 常用入口 |
| --- | --- |
| 学生 | 在「活动」查看日程、报名，在「我的报名」查结果、办理退出与恢复。在「通知」确认回执，在「我的时长」查账，在「本人记录与反馈」提交漏记或错账。 |
| 活动负责人 | 从「我的管理活动」编辑活动并送审，在报名名单跨页选择最多 100 条记录统一作出决定，审批退出与恢复。按服务日期登记现场异常，向指定名单发布通知并跟进回执，在「时长批次」导入工作簿、核对预览、修正重传或送审。 |
| 审核员 | 审批活动、修订和时长批次，处理错账修复及申诉。从「建档导入」批量建档，在「学生档案」查人，按授权范围导出记录、查询审计。 |

[产品需求（PRD v1.3.4）](docs/志愿服务平台_PRD_v1.3.4_20261118.docx) · [活动日程与验收用例](docs/timeline.md) · [三端界面规范](DESIGN.md) · [页面截图](docs/ui-samples/README.md) · [工程协作约定](AGENTS.md) · [OpenAPI 契约](packages/contracts/openapi_v1.2.5.yaml) · [导入模板](packages/contracts/templates/)

## 本地运行

1. 准备 Node.js 24、pnpm 10.32.1 和 PostgreSQL 18。启动数据库并创建开发库，将 [环境变量示例](apps/api/.env.example) 复制为 `apps/api/.env`，填写 `DATABASE_URL`。
2. 在仓库根目录依次运行以下命令。Windows PowerShell 可使用 `pnpm.cmd`。

   ```sh
   pnpm install --frozen-lockfile
   pnpm contracts:generate
   pnpm db:generate
   pnpm db:migrate
   pnpm build
   ```

3. 首次体验时，在终端分别设置 `DEMO_STAFF_PASSWORD` 和 `DEMO_ADMIN_PASSWORD`，两者均至少 12 个字符且互不相同，运行 `pnpm --filter @hongyan/api db:seed` 创建示例账号和活动。学生 `0000000001`、负责人 `0000000002` 首登使用学号后六位，审核员 `demo.teacher` 和长期技术管理员 `demo.admin` 分别使用各自的密码。已有账号的凭证不会被建种覆盖。
4. 在三个终端分别启动服务。

   | 服务 | 命令 | 本机地址 |
   | --- | --- | --- |
   | API | `pnpm dev:api` | `127.0.0.1:3000` |
   | 学生与负责人端 | `pnpm dev:web` | `http://localhost:5173` |
   | 审核后台 | `pnpm dev:admin` | `http://localhost:5174` |

可直接用浏览器访问前端。Safari 手动登录时，启动前为两个前端设置 `HY_LOCAL_HTTPS=1`，通过 HTTPS 访问。多角色体验可运行 `pnpm demo:open` 并打开 `http://127.0.0.1:5180`。身份选择页会为各账号打开独立窗口，Chromium、Chrome 和 Edge 会最大化并保留标签栏和地址栏，Firefox 与 WebKit 可手动调整。

macOS 完成首次配置后，可在 `.local/demo.env` 写入建种时的 `DEMO_STAFF_PASSWORD` 和 `DEMO_ADMIN_PASSWORD`，双击 [一键启动.command](一键启动.command)。脚本复用已就绪的服务，每次新启动 API 前重新生成接口和 Prisma 客户端，并向开发库应用待执行的迁移。

## 开发检查

在仓库根目录运行 `pnpm typecheck` 检查类型，运行 `pnpm test:pages` 构建并执行浏览器回归。页面回归和身份选择页均可使用已安装的 Chrome 或 Edge。[页面回归入口](apps/api/test/pages.test.mjs) · [时长办理用例](apps/api/test/hour-ledger-pages.mjs) · [建档页面用例](apps/api/test/student-import-pages-fixture.mjs)

API 测试使用 `pnpm --filter @hongyan/api <脚本名>`。页面回归和下表的数据库回归会创建独立测试库，数据库账号须有建库权限。

| 检查内容 | 脚本名 |
| --- | --- |
| 本地离线检查 | `test:accounts`（体验账号）、`test:hour-workbook`（工作簿解析）、`test:hour-preview`（逐行预览） |
| 活动与人员流程 | `test:flow`（活动、招募、现场异常）、`test:timeline`（日程）、`test:notice`（通知与回执） |
| 建档、时长与导出 | `test:students`（建档导入）、`test:hour-ledger`（时长审批与入账）、`test:exports`（业务导出与审计） |
