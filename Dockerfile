# syntax=docker/dockerfile:1
# Transflux —— 生产镜像
# 特点：sql.js 为纯 WASM，无原生依赖，alpine 即可运行；数据全内存 + 防抖落盘，
#       因此 /app/data 必须挂载持久卷（数据库 + 密钥加密主密钥都在里面）。
FROM node:22-alpine AS base

ENV NODE_ENV=production
WORKDIR /app

# 依赖层（package-lock 未变时命中缓存）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 应用层
COPY src ./src
COPY public ./public

# 非 root 运行：直接使用基础镜像自带的 node 用户（uid/gid 恰好是 1000），
# 挂载目录 chown 1000:1000 即可写；data 目录由挂载卷提供
RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV PORT=3000 DB_PATH=/app/data/usage.sqlite
EXPOSE 3000

# 无 curl/wget 的轻量健康检查（Node 18+ 内置 fetch）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# exec 形式保证 SIGTERM 直达 node，优雅停机 flush 生效
CMD ["node", "src/server.js"]
