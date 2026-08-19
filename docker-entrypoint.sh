#!/bin/sh
set -e

DATA_DIR="$(dirname "${DB_PATH:-/data/jxpan.db}")"
mkdir -p "$DATA_DIR"

# 以 root 起来时（默认情况）：把数据目录归属改成 node 用户后降权再跑。
# NAS 上 ./data 通常是宿主用户创建的，不这么做会写不进 SQLite。
if [ "$(id -u)" = "0" ]; then
    PUID="${PUID:-1000}"
    PGID="${PGID:-1000}"
    if [ "$PUID" != "1000" ] || [ "$PGID" != "1000" ]; then
        deluser node 2>/dev/null || true
        addgroup -g "$PGID" -S jxpan 2>/dev/null || true
        adduser -u "$PUID" -S -G jxpan jxpan 2>/dev/null || true
        RUN_AS="$PUID:$PGID"
    else
        RUN_AS="node:node"
    fi
    chown -R "$RUN_AS" "$DATA_DIR" /app 2>/dev/null || true
    exec su-exec "$RUN_AS" "$@"
fi

# compose 里显式指定了 user: 时直接跑
exec "$@"
