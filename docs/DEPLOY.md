# 后端部署指南（让在线版本拥有完整闭环）
# ------------------------------------------------------------------
# 为什么需要：当前公开地址是**纯静态托管**，只能提供前端文件。
# 模型相关的两步（字段抽取、模型问答）必须由服务端调用模型，
# 密钥绝不能放进前端。所以想让线上版本完整可用，就要把 server/ 部署起来。
#
# 三种方式，任选其一。部署完只需要一步收尾：
#   打开前端页面 → 左下角「运行设置」→ 填「后端地址」→ 点「保存并测试连接」。
#   连接成功后开关会变绿，字段抽取与问答立即生效。

## 方式一：Docker（最通用）

仓库里已带 `Dockerfile`（多阶段构建：先打包前端，再只带产物运行，`server/` 零依赖不需要 node_modules）。

```bash
docker build -t paper-repro-guard .
docker run -d --name prg -p 8787:8787 \
  -e LLM_BASE_URL="https://api.deepseek.com/anthropic" \
  -e LLM_API_KEY="sk-xxxx" \
  paper-repro-guard
# 访问 http://127.0.0.1:8787/
```

适用：腾讯云 CloudBase 云托管、Cloud Run、Railway、Fly.io、自建服务器（配合 Nginx + pm2）。
镜像内置 `HEALTHCHECK`，平台会自动探测 `/api/health`。

## 方式二：Render（有现成蓝图，最省事）

仓库里的 `render.yaml` 是 Render Blueprint：

1. 把仓库推到 GitHub；
2. Render 控制台 → New → Blueprint → 选择仓库；
3. 在 Environment 里填 `LLM_BASE_URL` / `LLM_API_KEY`（可选 `LLM_MODEL`）；
4. 部署完成后拿到形如 `https://xxx.onrender.com` 的地址，填进前端的「运行设置」。

## 方式三：任何 Node 托管（不需要 Docker）

```bash
npm install
npm run build          # 产出 dist/（同时复制 pdfjs 的 cmaps 与标准字体）
node server/index.mjs  # 同时托管 dist/ 与 /api/*
```

平台只需要会跑 Node 命令，并把 `dist/` 和 `server/` 一起带上。环境变量同上。

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `LLM_API_KEY` | ✅ | 模型密钥；也兼容平台注入的 `ANTHROPIC_AUTH_TOKEN` |
| `LLM_BASE_URL` | ✅ | Anthropic 风格填 `.../anthropic`；OpenAI 风格填上级地址并设 `LLM_API_STYLE=openai` |
| `LLM_MODEL` | ⭕ | 模型名，缺省用 `ANTHROPIC_MODEL` |
| `LLM_API_STYLE` | ⭕ | `anthropic`（默认）/ `openai` |
| `PORT` | ⭕ | 默认 8787 |
| `API_ACCESS_TOKEN` | ⭕ | 给 `/api/*` 加访问口令，前端「运行设置」填同样的口令 |
| `ALLOW_ORIGIN` | ⭕ | 允许的跨域来源，默认 `*`；上线建议收紧为前端域名 |
| `MAX_PAPER_CHARS` | ⭕ | 单次送入模型的正文上限，默认 90000 字符 |

## 部署后自检

```bash
# 看后端与密钥状态
curl https://你的后端地址/api/health
# 期望：{"ok":true,...,"hasCredentials":true,"capabilities":{"realLlmExtract":true,"realLlmQa":true}}
```

如果 `hasCredentials` 是 `false`，说明环境变量没读到，检查变量名与平台注入方式。
