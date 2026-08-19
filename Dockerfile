FROM node:24-alpine

# su-exec 用于在 entrypoint 里修好挂载卷权限后降权到 node 用户
RUN apk add --no-cache su-exec

WORKDIR /app

# 零 npm 依赖，不需要 npm install
COPY package.json ./
COPY src ./src
COPY test ./test
COPY _worker.js ./
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data

ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    DB_PATH=/data/jxpan.db \
    TRUST_PROXY=true

EXPOSE 8787
VOLUME ["/data"]

# --spider 发的是 HEAD 请求，不会真的下载首页那 270KB
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider "http://127.0.0.1:${PORT}/" || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/server.mjs"]
