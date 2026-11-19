# 本地开发配置

在仓库根目录操作。安装 Node.js 24（具体版本见 [.nvmrc](../.nvmrc)）和 PostgreSQL 18，将 PostgreSQL 的命令行工具加入 PATH。选择自己的系统配置数据库，再完成下方的工程初始化。

## macOS

安装 pnpm 并创建专用开发库。按提示设置数据库密码。已有工作副本若通过 `.local/env.sh` 配置工具路径，每次打开终端时先执行 `source .local/env.sh`。

```sh
npm install --global pnpm@10.32.1
mkdir -p .local
initdb -D .local/pgdata -U volunteer_dev -A scram-sha-256 --locale=C -E UTF8 -W
pg_ctl -D .local/pgdata -l .local/postgres.log -o "-h 127.0.0.1 -p 55432" -w start
createdb -h 127.0.0.1 -p 55432 -U volunteer_dev volunteer_dev
cp -n apps/api/.env.example apps/api/.env
```

在 `apps/api/.env` 的 `DATABASE_URL` 中填入刚设置的密码，保留端口 `55432`。以后手动启动数据库只需运行上面的 `pg_ctl` 命令，停止时运行 `pg_ctl -D .local/pgdata -m fast -w stop`。接下来完成[工程初始化](#工程初始化)。

## Windows

启动 PostgreSQL 的 Windows 服务，在 PowerShell 中运行以下命令。示例使用默认端口 `5432`，通过安装时的 `postgres` 管理账号创建开发角色，并赋予回归测试所需的建库权限。

```powershell
npm.cmd install --global pnpm@10.32.1
createuser -h 127.0.0.1 -p 5432 -U postgres --createdb -P volunteer_dev
createdb -h 127.0.0.1 -p 5432 -U postgres -O volunteer_dev volunteer_dev
if (!(Test-Path apps/api/.env)) { Copy-Item apps/api/.env.example apps/api/.env }
notepad apps/api/.env
```

将 `DATABASE_URL` 设为 `postgresql://volunteer_dev:你的密码@127.0.0.1:5432/volunteer_dev`，替换为开发角色的密码。两种系统的连接地址都需要对密码中的特殊字符做百分号编码。

## 工程初始化

两种系统使用相同的命令。Windows PowerShell 可将每行开头的 `pnpm` 换为 `pnpm.cmd`。如果已有专用开发库，也可以将 `DATABASE_URL` 指向该库，从此步开始。

```sh
pnpm install --frozen-lockfile
pnpm contracts:generate
pnpm db:generate
pnpm db:migrate
pnpm build
```

**手动体验**需要先创建账号。设置至少 12 个字符的审核员密码，再在同一终端运行种子命令。自动回归会自行创建账号，可直接进入[运行测试](../README.md#运行测试)。

| macOS 默认终端（zsh） | Windows PowerShell |
| --- | --- |
| `read -rs 'DEMO_STAFF_PASSWORD?请输入审核员密码：'` 后执行 `export DEMO_STAFF_PASSWORD` | `$env:DEMO_STAFF_PASSWORD = (Get-Credential -UserName demo.teacher -Message '设置审核员密码').GetNetworkCredential().Password` |

```sh
pnpm --filter @hongyan/api db:seed
```

首次运行 `demo:open` 时沿用这个终端或在 `.local/demo.env` 中设置相同的密码。需要技术管理员 `demo.admin` 时，再设置单独的 `DEMO_ADMIN_PASSWORD`（至少 12 个字符），重新运行种子命令并重启身份选择页。

| 体验身份 | 账号 | 首次登录 |
| --- | --- | --- |
| 学生、负责人、协作者 | `0000000001` 为学生，末位 2、3 为负责人，末位 4 为协作者 | 初始密码为学号后六位，首登改为至少八位、含英文字母和数字的密码 |
| 审核员、兼任协作者的审核员 | `demo.teacher`、`demo.dual` | 使用初始化时设置的审核员密码 |

身份选择页会自动处理学生首次改密。如果手动改过体验账号密码，将新密码同步到本机的 `.local/demo-logins.json`。完成后按[本地启动](../README.md#本地启动)打开服务。

## 浏览器设置

页面回归和身份选择页依次尝试 Playwright Chromium、本机 Edge、本机 Chrome、Playwright Firefox。要安装配套引擎，在工程根目录运行 `pnpm exec playwright-core install firefox`，也可将 `firefox` 换为 `chromium` 或 `webkit`。

需要指定浏览器时，设置 `HY_BROWSER` 为 `chromium`、`msedge`、`chrome`、`firefox` 或 `webkit`。例如，macOS 使用 `HY_BROWSER=msedge pnpm test:pages`。PowerShell 先执行 `$env:HY_BROWSER = 'msedge'`，再执行 `pnpm.cmd test:pages`，用 `Remove-Item Env:HY_BROWSER` 恢复自动选择。

**Safari 或 WebKit 本机登录需要 HTTPS。** 在启动两个前端和身份选择页的每个终端，macOS 执行 `export HY_LOCAL_HTTPS=1`，PowerShell 执行 `$env:HY_LOCAL_HTTPS = '1'`。重启对应服务后，通过 HTTPS 打开[学生与负责人端](https://localhost:5173/)或[审核后台](https://localhost:5174/)。首次访问时核对地址为 `localhost` 后允许使用本地自签名证书。[身份选择页](http://127.0.0.1:5180/)仍使用 HTTP。

页面回归会自动启用 HTTPS。显式选择 WebKit 后，macOS 上已验证登录和刷新后的会话保持。完整页面回归仍有自动点击坐标偏移的问题。
