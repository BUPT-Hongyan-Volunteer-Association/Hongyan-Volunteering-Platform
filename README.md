# 鸿雁志愿服务平台

学生查看活动、报名和查询结果，负责人创建活动并送审、处理录取、上传时长工作簿并核对预览，审核员审批活动及修订。

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

类型检查用 `pnpm typecheck`，服务端回归用 `pnpm --filter @hongyan/api test:flow`，页面回归用 `pnpm test:pages`。两套回归均需数据库账号有建库权限。页面回归和身份选择页可使用已安装的 Chrome 或 Edge。用 Safari 手动登录时，启动前为两个前端设置 `HY_LOCAL_HTTPS=1`，再通过 HTTPS 访问。

负责人从「我的管理活动 → 选择活动 → 时长批次」进入上传和预览。工作簿解析和逐行校验可分别运行 `pnpm --filter @hongyan/api test:hour-workbook` 和 `pnpm --filter @hongyan/api test:hour-preview`，两者可离线运行。页面回归覆盖上传、筛选和报告下载，将 `HOUR_EVIDENCE_DIR` 设为本地输出目录可保存合成工作簿、错误报告和截图。

[工程协作约定](AGENTS.md) · [界面规范](DESIGN.md) · [界面复验](docs/ui-samples/README.md) · [接口契约与导入模板](packages/contracts/)
