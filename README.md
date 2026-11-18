# 鸿雁志愿服务平台

学生查看获批活动，负责人创建、修改、送审或撤回单次活动，老师核对差异后批准或驳回。批次 02 已补齐三端页面。项目正在继续开发。

接口定义与导入格式随工程维护。[OpenAPI v1.2.4](packages/contracts/openapi_v1.2.4.yaml) · [学生建档模板 v1.3](packages/contracts/templates/学生建档导入模板_v1.3.xlsx) · [志愿时长模板 v1.5](packages/contracts/templates/志愿时长录入模板_v1.5.xlsx)

已完成首次配置的 Mac 可在 Finder 中双击 [一键启动.command](一键启动.command)，启动本地服务并打开身份选择页。重复打开会复用运行中的服务。

团队成员可按操作系统查看 [Windows 本地开发与测试](#windows-本地开发与测试) 或 [macOS 本地开发](#macos-本地开发)。

## 界面设计入口

修改跨页组件、角色导航或日程交互时，以三端界面规范为准。五个代表页面的 PRD 原图、浏览器截图、示例状态及复验命令集中在界面对照目录。[三端界面规范](DESIGN.md) · [界面对照与复验](docs/ui-samples/README.md) · [工程协作约定](AGENTS.md)

## 浏览器与访问地址

| 使用方式 | 浏览器要求 |
| --- | --- |
| 手动登录、浏览和调试网页 | 在常用浏览器打开 [学生与负责人端](http://localhost:5173/) 或 [审核后台](http://localhost:5174/)。使用 Safari 时按下方说明启用 HTTPS。 |
| 类型检查、构建、服务端回归、体验账号配置测试 | 直接在终端运行。 |
| 自动页面回归、点选身份自动登录 | 共用 Playwright 启动配置。每次运行选一种浏览器，开始时会打印浏览器名称和版本。 |

默认 `HY_BROWSER=auto`，依次尝试 Playwright Chromium、本机 Microsoft Edge、本机 Google Chrome、Playwright Firefox，启动成功即停止尝试。已有 Edge 或 Chrome 的成员可直接运行。也可在安装项目依赖后执行 `pnpm exec playwright-core install firefox`，将末尾的名称换成 `chromium` 或 `webkit` 即可安装对应引擎。Windows PowerShell 中可使用 `pnpm.cmd`。Firefox 和 WebKit 选项使用 Playwright 配套构建。

要复现某个浏览器的问题，显式指定 `HY_BROWSER` 为 `chromium`、`msedge`、`chrome`、`firefox` 或 `webkit`。指定项启动失败会报错。以下示例使用已安装的 Edge，同一设置也适用于 `demo:open`。

| 环境 | 在仓库根目录执行 |
| --- | --- |
| macOS 终端 | `HY_BROWSER=msedge pnpm test:pages` |
| Windows PowerShell | 先执行 `$env:HY_BROWSER = 'msedge'`，再执行 `pnpm.cmd test:pages`。用 `Remove-Item Env:HY_BROWSER` 恢复自动选择。 |

### 使用 Safari 或 WebKit 在本机登录

页面回归会自动通过 HTTPS 访问临时测试服务。手动使用 Safari 或通过 WebKit 体验身份时，也需要 HTTPS，浏览器才能保存安全会话 Cookie。在启动两个前端和 `demo:open` 的每个终端设置以下变量，再运行各自的启动命令。使用同样的设置也可以在 Edge、Chrome 和 Firefox 中验证 HTTPS。

| macOS 终端 | Windows PowerShell |
| --- | --- |
| `export HY_LOCAL_HTTPS=1` | `$env:HY_LOCAL_HTTPS = '1'` |

如服务已运行，先关闭对应进程再按新设置启动。此时请打开 [学生与负责人端](https://localhost:5173/) 或 [审核后台](https://localhost:5174/)。开发服务会生成本机自签名证书，首次手动访问时请核对地址为 `localhost` 后允许访问。身份选择页仍在 [本机 5180 端口](http://127.0.0.1:5180/)。关闭终端即可恢复默认设置。

WebKit 需显式设置 `HY_BROWSER=webkit`。本次 macOS 验证通过了 WebKit 的 HTTPS 登录及刷新后会话保持，但其自动鼠标点击在此机器上有坐标偏移，完整页面回归尚未通过。日常自动回归可使用 Edge、Chrome 或 Playwright Firefox。

## Windows 本地开发与测试

在 64 位 Windows 电脑上安装 Node.js 24.x（具体版本见 `.nvmrc`）、PostgreSQL 18。页面回归和免手输登录的浏览器配置见上表。使用仓库根目录作为 PowerShell 的工作目录。以下命令使用 Windows 的 `.cmd` 入口。数据库命令需要将 PostgreSQL 的 `bin` 目录加入 PATH。

### 首次配置

首次配置时，启动 PostgreSQL 的 Windows 服务。下例使用本机端口 5432，以安装时的 postgres 管理账号创建专用开发角色和数据库。测试会新建并清理独立数据库，因此开发角色需要建库权限。已有符合条件的角色和数据库可直接使用。

```powershell
npm.cmd install --global pnpm@10.32.1
createuser -h 127.0.0.1 -p 5432 -U postgres --createdb -P volunteer_dev
createdb -h 127.0.0.1 -p 5432 -U postgres -O volunteer_dev volunteer_dev
if (!(Test-Path apps/api/.env)) { Copy-Item apps/api/.env.example apps/api/.env }
notepad apps/api/.env
```

在 `apps/api/.env` 中把 `DATABASE_URL` 设为 `postgresql://volunteer_dev:你的密码@127.0.0.1:5432/volunteer_dev`，替换为实际密码并对特殊字符做百分号编码。示例文件默认使用 55432，填写时以本机服务端口为准。

```powershell
pnpm.cmd install --frozen-lockfile
pnpm.cmd contracts:generate
pnpm.cmd db:generate
pnpm.cmd db:migrate
```

### 自动回归

保持 PostgreSQL 服务运行，在工程根目录执行下列命令。

```powershell
pnpm.cmd typecheck
pnpm.cmd --filter @hongyan/api test:accounts
pnpm.cmd --filter @hongyan/api test:flow
pnpm.cmd test:pages
```

服务和页面回归会自行准备测试账号、建库并启动测试服务。页面回归会先构建工程。运行完整套件需要开发数据库角色具有建库权限。

### 手动体验

在三个 PowerShell 窗口分别运行 `pnpm.cmd dev:api`、`pnpm.cmd dev:web`、`pnpm.cmd dev:admin`。学生与负责人访问 [5173](http://localhost:5173/)，审核后台访问 [5174](http://localhost:5174/)。

首次准备手动体验账号时，另开一个 PowerShell 窗口，先运行 `pnpm.cmd build`，再依次执行以下命令，输入至少 12 个字符的本地体验密码。服务就绪后打开 [身份选择页](http://127.0.0.1:5180/)。

```powershell
$credential = Get-Credential -UserName demo.teacher -Message '设置本地体验审核员密码'
$env:DEMO_STAFF_PASSWORD = $credential.GetNetworkCredential().Password
pnpm.cmd --filter @hongyan/api db:seed
pnpm.cmd demo:open
```

## macOS 本地开发

使用 Node.js 24（版本见 `.nvmrc`）、pnpm 10.32.1 和 PostgreSQL 18。首次使用时安装上述工具，确保 `initdb`、`pg_ctl`、`createdb` 在 PATH 中，再克隆仓库并从仓库根目录运行下列命令。已有工作副本若使用 `.local/env.sh` 配置工具路径，每次打开终端时先执行 `source .local/env.sh`。

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

先启动上表三个服务，并按“浏览器与访问地址”准备一种可用的浏览器。在工程根目录另开终端运行 `pnpm demo:open`，打开 [本地测试入口](http://127.0.0.1:5180/)，点选身份即可进入相应系统。每次选择都会打开独立浏览器会话，可同时验证多个角色。

新副本先按上文创建体验账号。首次启动入口时使用与种子相同的 `DEMO_STAFF_PASSWORD`，如已创建技术管理员也提供 `DEMO_ADMIN_PASSWORD`。可通过环境变量或本机 `.local/demo.env` 提供。启动器将体验凭证保存到被 Git 忽略的 `.local/demo-logins.json`，已有配置中各身份的密码优先。后续创建技术管理员后，设置对应的 `DEMO_ADMIN_PASSWORD` 并重启入口，即可补入缺少的管理员身份。学生首次使用时会自动走首登改密流程，已手动改密的体验账号需在该本地文件填入现有密码。入口只监听本机，关闭启动器用 Ctrl+C。

## 体验与验证

| 账号 | 合成身份 |
| --- | --- |
| `0000000001` | 学生 |
| `0000000002`、`0000000003` | 活动甲、乙的负责人 |
| `0000000004` | 活动甲协作者 |
| `demo.teacher`、`demo.dual` | 审核员、兼任甲活动协作者的审核员 |

学生初始密码为学号后六位，首登须改为至少八位且含英文字母和数字的新密码。后台使用初始化时设置的凭证。跨角色走查使用不同浏览器配置文件，避免共用 Cookie。

负责人从左侧“我的管理活动”（手机底栏“管理”）选择活动并送审，再从后台“活动审核”核对冻结版本。公开地点从 A 修订为 B 时，学生在待审和驳回后仍看到 A，批准后才看到 B。

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

在已配置开发数据库的仓库根目录运行 `pnpm test:pages`。日常手动访问和其他测试的要求见[浏览器与访问地址](#浏览器与访问地址)。该命令构建三个应用，新建专用 PostgreSQL 测试库，以独立端口启动 API 和两个前端的生产构建，并在独立浏览器会话中验证手机与桌面导航、真实地点修订、示例操作、成员切换及失权。进程结束后清理测试库。类型与服务回归分别运行 `pnpm typecheck` 和 `pnpm --filter @hongyan/api test:flow`。
