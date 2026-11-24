#!/bin/bash
set -eu
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if [[ -f .local/env.sh ]]; then source .local/env.sh; fi
umask 077
mkdir -p .local/start-logs
fail() { echo "$1" >&2; if [[ -t 0 ]]; then read -r -p "按回车关闭。" || true; fi; exit 1; }
command -v pnpm >/dev/null || fail "未找到 pnpm，请按 README 配置本地开发环境。"
[[ -f apps/api/.env ]] || fail "缺少数据库配置 apps/api/.env，请按 README 完成首次初始化。"
if [[ -f .local/pgdata/PG_VERSION ]]; then
  command -v pg_ctl >/dev/null || fail "未找到 pg_ctl。"
  if ! pg_ctl -D .local/pgdata status >/dev/null; then
    pg_ctl -D .local/pgdata -l .local/postgres.log -o "-h 127.0.0.1 -p 55432" -w start || fail "数据库启动失败，请查看 .local/postgres.log。"
  fi
fi
scheme=http
if [[ "${HY_LOCAL_HTTPS:-0}" == 1 ]]; then scheme=https; fi
# Readiness probes only connect to the local development services.
ready() { curl --insecure --noproxy '*' --max-time 2 -fsS "$1" 2>/dev/null | grep -Fq "$2"; }
start() {
  local task="$1" port="$2" url="$3" marker="$4" log=".local/start-logs/${1/:/-}.log"
  if ready "$url" "$marker"; then echo "$task 已就绪"; return; fi
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null; then
    echo "等待端口 $port 上的服务完成启动…"
    for ((i=0;i<20;i++)); do
      if ready "$url" "$marker"; then return; fi
      sleep 1
    done
    fail "端口 $port 上的服务未通过检查，请查看 ${log}。"
  fi
  if [[ "$task" == dev:api ]]; then
    local step
    echo "正在生成接口和数据库客户端，并应用待执行的开发库迁移…"
    for step in contracts:generate db:generate db:migrate; do
      pnpm "$step" </dev/null || fail "${step} 失败，请查看上方输出。"
    done
  fi
  echo "正在启动 $task …"
  nohup pnpm "$task" </dev/null >"$log" 2>&1 &
  local pid=$!
  for ((i=0;i<90;i++)); do
    if ready "$url" "$marker"; then return; fi
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  fail "$task 启动失败，请查看 $PWD/${log}。"
}
start dev:api 3000 http://127.0.0.1:3000/api/v1/auth/csrf csrf_token
start dev:web 5173 "$scheme://localhost:5173/" '/src/main.ts'
start dev:admin 5174 "$scheme://localhost:5174/" '/src/main.ts'
start demo:open 5180 http://127.0.0.1:5180/ 选择测试身份
open http://127.0.0.1:5180/
echo "身份选择页已打开。"
