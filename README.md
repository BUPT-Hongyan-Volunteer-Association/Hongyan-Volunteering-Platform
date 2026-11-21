# 鸿雁志愿服务平台

学生查看活动、报名和查询结果，负责人创建活动并送审、处理录取，审核员审批活动及修订。负责人也可在「我的管理活动」选择活动，进入「时长批次」下载模板、上传工作簿并核对预览。预览不计入学生累计时长。

活动地点、时间等关键信息修订获批后，受影响的学生会收到变更通知。被录取的学生会收到报名结果。学生在「通知」中打开详情即标为已读，点击「确认收到」后负责人可在「通知与回执」中查看确认时间。

审核员可从「建档导入」下载 v1.5 学生名单模板，填写后上传，按原表行号核对并确认，再到「学生档案」查询建档结果。

## 本地运行

1. 准备 Node.js 24、pnpm 10.32.1 和 PostgreSQL 18。启动数据库，创建开发库，将 `apps/api/.env.example` 复制为 `apps/api/.env`，按实际账号、端口和库名填写 `DATABASE_URL`。
2. 在仓库根目录依次执行以下命令。Windows PowerShell 可使用 `pnpm.cmd`。

   ```sh
   pnpm install --frozen-lockfile
   pnpm contracts:generate
   pnpm db:generate
   pnpm db:migrate
   pnpm build
   ```

3. 首次体验时，在终端设置 `DEMO_STAFF_PASSWORD`（至少 12 个字符），运行 `pnpm --filter @hongyan/api db:seed` 创建账号和示例活动。
4. 在三个终端各启动一个服务。

   | 服务 | 命令 | 本机地址 |
   | --- | --- | --- |
   | API | `pnpm dev:api` | `127.0.0.1:3000` |
   | 学生与负责人端 | `pnpm dev:web` | `http://localhost:5173` |
   | 审核后台 | `pnpm dev:admin` | `http://localhost:5174` |

学生 `0000000001`、负责人 `0000000002` 首登使用学号后六位，审核员 `demo.teacher` 使用上述密码。多角色体验可运行 `pnpm demo:open`，打开 `http://127.0.0.1:5180`。macOS 可双击 `一键启动.command` 一并启动服务。首次双击前在 `.local/demo.env` 设置同一 `DEMO_STAFF_PASSWORD`。

## 开发检查

类型检查用 `pnpm typecheck`，服务端回归用 `pnpm --filter @hongyan/api test:flow`（活动流程）、`pnpm --filter @hongyan/api test:students`（学生名单导入）和 `pnpm --filter @hongyan/api test:notice`（通知与回执），页面回归用 `pnpm test:pages`。服务端与页面回归都会创建独立测试库，数据库账号须有建库权限。页面回归和身份选择页可使用已安装的 Chrome 或 Edge。用 Safari 手动登录时，启动前为两个前端设置 `HY_LOCAL_HTTPS=1`，再通过 HTTPS 访问。

时长工作簿解析测试用 `pnpm --filter @hongyan/api test:hour-workbook`，逐行预览测试用 `pnpm --filter @hongyan/api test:hour-preview`。两者均可在本地离线运行。

[工程协作约定](AGENTS.md) · [界面规范](DESIGN.md) · [界面复验](docs/ui-samples/README.md) · [接口契约与导入模板](packages/contracts/)
