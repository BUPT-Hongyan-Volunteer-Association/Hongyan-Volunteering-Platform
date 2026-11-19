# 鸿雁志愿服务平台

负责人创建活动并提交审核，老师核对修改后批准或驳回，学生可查看已发布的活动。活动发布与审核已接入真实服务，部分报名、时长和通知页面仍使用示例数据。

## 本地启动

**首次运行**请先安装 Node.js 24、pnpm 10.32.1 和 PostgreSQL 18，按系统完成数据库和体验账号初始化。[macOS 配置](docs/local-development.md#macos) · [Windows 配置](docs/local-development.md#windows)

**日常启动**时，已配置好的 Mac 可双击 [一键启动.command](一键启动.command)，直接进入身份选择页。Windows 或手动启动时，先启动 PostgreSQL，再从仓库根目录打开三个终端，各运行一行。

| 服务 | macOS | Windows PowerShell | 访问地址 |
| --- | --- | --- | --- |
| API | `pnpm dev:api` | `pnpm.cmd dev:api` | `127.0.0.1:3000` |
| 学生与负责人端 | `pnpm dev:web` | `pnpm.cmd dev:web` | [打开活动平台](http://localhost:5173/) |
| 审核后台 | `pnpm dev:admin` | `pnpm.cmd dev:admin` | [打开审核后台](http://localhost:5174/) |

**切换体验身份**时，另开终端运行 `pnpm demo:open`（PowerShell 用 `pnpm.cmd demo:open`），打开身份选择页即可分别以学生、负责人或审核员登录。每个身份使用独立会话。[打开身份选择页](http://127.0.0.1:5180/) · [Safari 本地登录设置](docs/local-development.md#浏览器设置)

## 运行测试

在仓库根目录执行。Windows PowerShell 将命令开头的 `pnpm` 换成 `pnpm.cmd`。

| 检查内容 | 命令 |
| --- | --- |
| 类型检查 | `pnpm typecheck` |
| 生产构建 | `pnpm build` |
| 体验账号配置 | `pnpm --filter @hongyan/api test:accounts` |
| 服务端活动发布与审核流程 | `pnpm --filter @hongyan/api test:flow` |
| 学生端、负责人端和审核后台页面 | `pnpm test:pages` |

服务端和页面回归会自行建库、启动测试服务并在结束后清理测试库，运行前需启动 PostgreSQL。页面回归和身份选择页会自动选择可用浏览器，已安装 Edge 或 Chrome 即可运行，也可选用 Playwright Firefox。[浏览器设置](docs/local-development.md#浏览器设置)

## 开发资料

- [三端界面规范](DESIGN.md) · [PRD 对照图与复验方法](docs/ui-samples/README.md)
- [OpenAPI](packages/contracts/openapi_v1.2.4.yaml) · [学生建档模板](packages/contracts/templates/学生建档导入模板_v1.3.xlsx) · [志愿时长模板](packages/contracts/templates/志愿时长录入模板_v1.5.xlsx)
- [工程协作约定](AGENTS.md) · [后台布局 Vue Vben Admin 的 MIT 许可](apps/admin/src/layouts/vben/LICENSE)
