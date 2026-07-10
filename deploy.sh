#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
ENV_EXAMPLE="${ROOT_DIR}/.env.example"

cd "${ROOT_DIR}"

if ! command -v docker >/dev/null 2>&1; then
  printf '错误：未找到 docker，请先安装 Docker Engine 与 Compose 插件。\n' >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  printf '错误：当前 docker 不支持 docker compose。\n' >&2
  exit 1
fi

umask 077
if [[ ! -f "${ENV_FILE}" ]]; then
  cp "${ENV_EXAMPLE}" "${ENV_FILE}"
fi
chmod 600 "${ENV_FILE}"

random_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
    return
  fi
  od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
}

get_env() {
  local key="$1"
  awk -v key="${key}" 'index($0, key "=") == 1 { value=substr($0, length(key) + 2); gsub(/\r$/, "", value); print value; exit }' "${ENV_FILE}"
}

set_env() {
  local key="$1"
  local value="$2"
  local temp_file
  temp_file="$(mktemp "${ENV_FILE}.tmp.XXXXXX")"
  awk -v key="${key}" -v value="${value}" '
    BEGIN { found=0 }
    index($0, key "=") == 1 {
      if (!found) print key "=" value
      found=1
      next
    }
    { print }
    END { if (!found) print key "=" value }
  ' "${ENV_FILE}" > "${temp_file}"
  chmod 600 "${temp_file}"
  mv "${temp_file}" "${ENV_FILE}"
}

ensure_secret() {
  local key="$1"
  local minimum_length="$2"
  local current lower
  current="$(get_env "${key}")"
  lower="$(printf '%s' "${current}" | tr '[:upper:]' '[:lower:]')"

  if [[ -z "${current}" || "${lower}" == *change-me* || "${lower}" == *example* ]]; then
    current="$(random_hex)"
    set_env "${key}" "${current}"
  elif (( ${#current} < minimum_length )); then
    printf '错误：%s 已存在但长度不足 %s。为避免破坏已有数据，脚本不会自动替换，请人工处理。\n' "${key}" "${minimum_length}" >&2
    exit 1
  fi
  printf '%s' "${current}"
}

ensure_secret SUBMAIL_SECRET 32 >/dev/null
DB_MODE="$(get_env SUBMAIL_DB_MODE)"
if [[ -z "${DB_MODE}" ]]; then
  if [[ -t 0 ]]; then
    printf '请选择数据库：\n  1) SQLite（默认，单机最省心）\n  2) Docker Compose 内置 MySQL\n  3) 外部 MySQL\n'
    read -r -p '输入 1/2/3 [1]: ' DB_CHOICE
    case "${DB_CHOICE:-1}" in
      1) DB_MODE=sqlite ;;
      2) DB_MODE=mysql ;;
      3) DB_MODE=external_mysql ;;
      *) printf '错误：数据库选项无效。\n' >&2; exit 1 ;;
    esac
  else
    DB_MODE=sqlite
  fi
  set_env SUBMAIL_DB_MODE "${DB_MODE}"
fi

case "${DB_MODE}" in
  sqlite)
    set_env SUBMAIL_DB_DRIVER sqlite
    ;;
  mysql)
    set_env SUBMAIL_DB_DRIVER mysql
    set_env SUBMAIL_MYSQL_HOST mysql
    ensure_secret SUBMAIL_MYSQL_PASSWORD 12 >/dev/null
    ensure_secret SUBMAIL_MYSQL_ROOT_PASSWORD 12 >/dev/null
    ;;
  external_mysql)
    set_env SUBMAIL_DB_DRIVER mysql
    MYSQL_URL="$(get_env SUBMAIL_MYSQL_URL)"
    MYSQL_HOST="$(get_env SUBMAIL_MYSQL_HOST)"
    MYSQL_PASSWORD="$(get_env SUBMAIL_MYSQL_PASSWORD)"
    if [[ -z "${MYSQL_URL}" && -z "${MYSQL_PASSWORD}" && -t 0 ]]; then
      read -r -p '外部 MySQL URL（留空则逐项填写）: ' MYSQL_URL
      if [[ -n "${MYSQL_URL}" ]]; then
        set_env SUBMAIL_MYSQL_URL "${MYSQL_URL}"
      else
        [[ "${MYSQL_HOST}" == "mysql" ]] && MYSQL_HOST=""
        read -r -p "MySQL 主机 [${MYSQL_HOST:-127.0.0.1}]: " MYSQL_HOST_INPUT
        MYSQL_HOST="${MYSQL_HOST_INPUT:-${MYSQL_HOST:-127.0.0.1}}"
        MYSQL_PORT="$(get_env SUBMAIL_MYSQL_PORT)"
        read -r -p "MySQL 端口 [${MYSQL_PORT:-3306}]: " MYSQL_PORT_INPUT
        MYSQL_PORT="${MYSQL_PORT_INPUT:-${MYSQL_PORT:-3306}}"
        MYSQL_DATABASE="$(get_env SUBMAIL_MYSQL_DATABASE)"
        read -r -p "数据库名 [${MYSQL_DATABASE:-submail}]: " MYSQL_DATABASE_INPUT
        MYSQL_DATABASE="${MYSQL_DATABASE_INPUT:-${MYSQL_DATABASE:-submail}}"
        MYSQL_USER="$(get_env SUBMAIL_MYSQL_USER)"
        read -r -p "数据库用户 [${MYSQL_USER:-submail}]: " MYSQL_USER_INPUT
        MYSQL_USER="${MYSQL_USER_INPUT:-${MYSQL_USER:-submail}}"
        read -r -s -p '数据库密码: ' MYSQL_PASSWORD
        printf '\n'
        set_env SUBMAIL_MYSQL_HOST "${MYSQL_HOST}"
        set_env SUBMAIL_MYSQL_PORT "${MYSQL_PORT}"
        set_env SUBMAIL_MYSQL_DATABASE "${MYSQL_DATABASE}"
        set_env SUBMAIL_MYSQL_USER "${MYSQL_USER}"
        set_env SUBMAIL_MYSQL_PASSWORD "${MYSQL_PASSWORD}"
      fi
    fi
    if [[ -z "${MYSQL_URL}" && ( -z "${MYSQL_HOST}" || -z "${MYSQL_PASSWORD}" ) ]]; then
      printf '错误：外部 MySQL 需在 .env 设置 SUBMAIL_MYSQL_URL，或同时设置 HOST/PORT/DATABASE/USER/PASSWORD。\n' >&2
      exit 1
    fi
    if [[ -z "${MYSQL_URL}" && ${#MYSQL_PASSWORD} -lt 12 ]]; then
      printf '错误：外部 MySQL 密码至少需要 12 个字符。\n' >&2
      exit 1
    fi
    ;;
  *)
    printf '错误：SUBMAIL_DB_MODE 仅支持 sqlite、mysql、external_mysql。\n' >&2
    exit 1
    ;;
esac
HTTP_PORT="$(get_env SUBMAIL_HTTP_PORT)"
HTTP_PORT="${HTTP_PORT:-8080}"
BIND_ADDRESS="$(get_env SUBMAIL_BIND_ADDRESS)"
BIND_ADDRESS="${BIND_ADDRESS:-127.0.0.1}"
compose_with_profiles() {
  if [[ "${DB_MODE}" == "mysql" ]]; then
    docker compose --profile mysql "$@"
  else
    docker compose "$@"
  fi
}

compose_with_profiles config --quiet
compose_with_profiles up -d --build --remove-orphans

ready=false
for _attempt in $(seq 1 60); do
  if docker compose exec -T web wget -q -O /dev/null http://127.0.0.1:8080/health >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 2
done

if [[ "${ready}" != "true" ]]; then
  printf '\n部署已启动，但健康检查在 120 秒内未通过。\n' >&2
  docker compose ps >&2
  compose_with_profiles logs --tail=100 api redis mysql mcp web >&2 || true
  exit 1
fi

printf '\nSubmail 已启动。\n'
printf '本机网关：http://%s:%s\n' "${BIND_ADDRESS}" "${HTTP_PORT}"
if [[ "${BIND_ADDRESS}" == "127.0.0.1" || "${BIND_ADDRESS}" == "localhost" ]]; then
  printf '安全默认已启用：网关仅监听服务器回环地址，请通过 HTTPS 反向代理或 SSH 隧道访问。\n'
else
  printf '警告：网关正在监听非回环地址；初始化前请确认外层已启用 HTTPS 和访问控制。\n' >&2
fi
printf '数据库模式：%s\n' "${DB_MODE}"
printf '敏感配置已保存在权限为 600 的 .env 中，请勿公开或提交。\n'
printf '初始化接口示例请查看 docs/deployment.md。\n'
