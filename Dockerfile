# 刻意不写 `# syntax=docker/dockerfile:1`：BuildKit 内置 frontend 已够用，
# 写了会让构建机必须能访问 docker.io，连不上时构建直接失败。
# Node 24 原生执行 TypeScript（类型剥离），因此无需构建步骤。
# 类型检查是独立的门禁：npm run typecheck（tsc --noEmit），不在镜像构建里做。

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY config ./config
USER node
# 说明：实际端口绑定由 compose 决定（本机回环），此处仅作文档
EXPOSE 3010 3011 3012
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3011/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.ts"]
