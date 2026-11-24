# 鸿雁志愿服务平台

学生查看活动、报名和查询结果，负责人创建活动并送审、处理录取，审核员审批活动及修订。负责人从「我的管理活动 → 时长批次」上传工作簿、核对预览并送审。送审时重新核对同一学生当日的跨活动累计。缺少说明时按提示的原表行号补充备注，从批次详情修正重传。工作簿被驳回后也可从原批次重传，保留前后关联。另一位审核人逐行核实后批准，学生从「我的时长」查看有效累计与历史明细。学生可通过「本人记录与反馈」提交漏记或错账，审核后台按已批准的批次或修复组结案。

负责人在活动的「通知与回执」中可发布普通通知，选择全部有效报名人员、已录取人员或指定学生，并决定是否需要确认。活动关键信息修订获批及报名结果仍会自动通知。学生端「通知」角标按未读或待确认的通知条数去重。打开详情即标为已读，需要确认的通知可在列表或详情点击「确认收到」，负责人随后可查看回执。

学生从「我的报名 → 办理与进度」撤回报名或办理整项活动的退出与恢复。负责人从「报名名单」跨页选择最多 100 条报名统一作出决定，在「退出与恢复」审批申请。退出获批时释放名额，恢复获批时重新占用名额。

负责人可在「现场人员记录」按服务日期批量登记迟到、缺席、请假或自定义情况，并查询和更正已登记的异常。正常签到无需在这里录入。

审核员可从「建档导入」下载 v1.5 学生名单模板，填写后上传，按原表行号核对并确认，再到「学生档案」查询建档结果。

学生按日期窗口查看活动日程，负责人从「管理日程」进入本人管理的活动，审核员在「全院日程」按负责人和审核状态查看。日程按小时、日、周、月绘制真实服务时段，学生日程以服务端时刻标记进行中，页面可见时每 60 秒校准。

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

学生 `0000000001`、负责人 `0000000002` 首登使用学号后六位，审核员 `demo.teacher` 使用上述密码。多角色体验可运行 `pnpm demo:open`，打开 `http://127.0.0.1:5180`。

macOS 可双击 `一键启动.command` 一并启动服务。首次双击前在 `.local/demo.env` 设置同一 `DEMO_STAFF_PASSWORD`。脚本每次新启动 API 前都会重新生成接口和 Prisma 客户端，并向 `apps/api/.env` 配置的开发库应用待执行的迁移。服务已就绪时会直接复用。

选择学生、负责人或审核员后，Chromium、Chrome 和 Edge 会将对应的独立窗口最大化至当前屏幕的可用桌面区域。标签栏和地址栏保持可见，调整窗口大小即可检查其他宽度下的布局。Firefox 和 WebKit 使用普通窗口，可手动调整大小。

## 开发检查

类型检查用 `pnpm typecheck`，服务端回归用 `pnpm --filter @hongyan/api test:flow`（活动、招募及现场异常）、`pnpm --filter @hongyan/api test:timeline`（活动日程）、`pnpm --filter @hongyan/api test:students`（学生名单导入）、`pnpm --filter @hongyan/api test:notice`（通知与回执）和 `pnpm --filter @hongyan/api test:exports`（业务导出与审计），页面回归用 `pnpm test:pages`。服务端与页面回归都会创建独立测试库，数据库账号须有建库权限。页面回归和身份选择页可使用已安装的 Chrome 或 Edge。用 Safari 手动登录时，启动前为两个前端设置 `HY_LOCAL_HTTPS=1`，再通过 HTTPS 访问。

时长工作簿解析测试用 `pnpm --filter @hongyan/api test:hour-workbook`，逐行预览测试用 `pnpm --filter @hongyan/api test:hour-preview`。两者均可在本地离线运行。

正式时长流程用 `pnpm --filter @hongyan/api test:hour-ledger` 在独立库验证。旧库中缺少审批来源的记录保留原 ID 和数值，仅已批准批次或修复组产生的记录进入正式台账。活动台账、本人查账和后台按学生查账共用 `readHourLedger`。导出作业在创建时保存类型和筛选范围，由 `ExportWorker` 以数据库批处理方式认领并异步生成单个 xlsx；查询和下载只允许发起人，并按保存的范围重新核验当前权限，文件在生成完成 24 小时后过期。时长明细与台账共用读取逻辑。活动时长也支持跨页勾选学生，在当前活动和所选日期内按人合计 `current` 记录。教师后台学生档案和负责人报名名单支持跨页勾选导出所选记录，也可按当前筛选导出全部。[导出数据与文件](apps/api/src/exports)

写入事务通过公共审计入口保存 `audit_event`，写入前脱敏凭证、令牌和敏感附件；后台 `GET /admin/audit-events` 按操作者、对象和时间查询，并将 `before`、`after` 序列化为 JSON 字符串。[公共审计入口](apps/api/src/audit.ts) · [审计查询](apps/api/src/audit.controller.ts)

[工程协作约定](AGENTS.md) · [界面规范](DESIGN.md) · [共享 UI 组件](packages/ui/README.md) · [三端运行示例](docs/ui-samples/README.md) · [接口契约与导入模板](packages/contracts/)