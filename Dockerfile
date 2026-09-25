# 论文复现避坑助手 · 后端 + 前端一体镜像
# ------------------------------------------------------------------
# 为什么要打包成镜像：模型密钥只能放在服务端，而当前静态托管没有后端。
# 这个镜像里同时包含前端产物（dist/）和后端服务（server/），启动后一个端口全搞定。
#
# 构建： docker build -t paper-repro-guard .
# 运行： docker run -p 8787:8787 \
#          -e LLM_BASE_URL=https://api.deepseek.com/anthropic \
#          -e LLM_API_KEY=sk-xxxx \
#          paper-repro-guard
# 访问： http://127.0.0.1:8787/
#
# 适用平台：Cloud Run / Railway / Render / Fly.io / 腾讯云 CloudBase 云托管 / 任意支持容器的托管

# ---------- 构建阶段：装依赖 + 打包前端 ----------
FROM node:22-alpine AS build
WORKDIR /app

# 先只拷贝依赖清单，利用层缓存
COPY package.json package-lock.json* ./
RUN npm ci || npm install

# 拷贝源码并构建（build 会顺带把 pdfjs 的 cmaps / standard_fonts 复制进 public/）
COPY . .
RUN npm run build

# ---------- 运行阶段：只带产物，体积最小 ----------
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787

# server/ 零第三方依赖，只用 Node 内置模块，所以运行阶段不需要 node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/package.json ./package.json

# 以非 root 用户运行
USER node

EXPOSE 8787

# 健康检查：确认后端与模型密钥就绪
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.mjs"]
