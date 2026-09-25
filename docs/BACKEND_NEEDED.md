# 线上后端：现状、缺什么、以及你必须做的确切操作

> 结论先说：**当前环境没有任何后端部署能力**，所以公开地址仍然是纯静态站点，
> 模型抽取与模型问答在线上不可用 —— 这一点没有达到线上验收标准，我不把它当作已完成。
> 下面第一节是自检证据，第二节是我需要你提供的东西，第三节是你照抄就能用的操作步骤，
> 第四节是「部署完之后你只需要告诉我一个网址」。

## 一、为什么我部署不了（自检结果，不是猜测）

在本机环境里实际检查了两类东西：

**1. 有没有托管平台的凭据**

```
环境变量里与云 / 密钥相关的只有：
  ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL / ANTHROPIC_MODEL ...   （模型网关，可用于后端调用模型）
  TENCENT_DOCS_LOCAL_MCP / TENCENT_DOCS_LOCAL_SERVER / WORKBUDDY_PAC_RPC_TOKEN  （WorkBuddy 内部）
  —— 没有腾讯云 SecretId/SecretKey、没有 GitHub Token、没有 Vercel/Netlify/Render/Railway/Fly 的任何凭据
```

**2. 有没有部署 CLI / 运行时**

| 命令 | 结果 |
| --- | --- |
| `docker` | 无（本机没有 Docker，无法构建/推送镜像） |
| `gh` | 无（没有 GitHub CLI，也没有可用 token，无法推仓库触发平台部署） |
| `vercel` / `netlify` / `wrangler` / `fly` / `railway` | 全部无 |
| `cloudbase` / `tcb` / `gcloud` / `az` / `aws` | 全部无 |
| `git` / `ssh` / `curl` | 有（但 git 无远端凭据，ssh 无可用服务器） |

我这边可用的部署工具只有一个：**静态站点部署**（上传一个目录、起一个静态文件服务器）。
它按设计不支持后端进程，也不支持在沙箱里跑 `node server/index.mjs` 并对外暴露端口。
所以：**在现有授权范围内，我无法完成公网后端部署**——不是"偷懒用静态代替"，而是工具与凭据都不具备。

## 二、我需要你提供的东西（只有两样）

| 需要什么 | 具体是什么 | 为什么必须由你提供 |
| --- | --- | --- |
| ① 一个能跑 Node 容器的托管平台账号 | 推荐：腾讯云 CloudBase 云托管（你在参赛，腾讯云账号大概率已有，有免费额度）；备选：Render（有免费额度，仓库里已带 `render.yaml`）、Railway、Cloud Run、腾讯云轻量应用服务器 | 注册/实名/开通属于你的账号操作，我无法代做 |
| ② 模型密钥 | 与后端同一份即可，形如 `sk-xxxxxxxx`（放在平台上，不要发在任何公开地方） | 密钥是你的资产，只能由你注入平台环境变量 |

**费用**：CloudBase 云托管有免费额度，本项目常态资源占用极低（零依赖 Node + 静态文件，单实例 256MB 内存足够），
比赛演示阶段基本不会产生费用；Render 免费档会在闲置后休眠，首次访问需要等约 30～60 秒冷启动（评委体验会略差，故不作为首选）。

**目前可用的模型配置**（已经在本机实测可用，直接照填）：

```
LLM_BASE_URL = https://api.deepseek.com/anthropic
LLM_API_KEY  = <你的密钥>
LLM_MODEL    = claude-sonnet-4-20250514     # 可选；不填则用平台注入的默认模型名
```

## 三、你要做的操作（完整命令，没有省略号）

### 方案 A（推荐）：腾讯云 CloudBase 云托管部署

```bash
# 1. 在本地项目根目录构建前端产物（同时会复制 pdfjs 的 cmaps 与标准字体）
npm install
npm run build

# 2. 确认三个文件都在（Dockerfile / server/ / dist/）
#    Dockerfile、.dockerignore、render.yaml 仓库里已经写好，不需要你再写 Dockerfile
```

然后进 CloudBase 控制台（不是命令行）：

1. 云托管 → 新建服务 → 部署方式选「本地代码上传 / 代码包」或「Git 仓库」，环境选 Node；
2. 如果走代码包：把整个项目目录打包上传（含 `dist/`、`server/`、`Dockerfile`）；如果走 Git：先把仓库推到你的 GitHub，再在控制台关联；
3. 监听端口填 **8787**（与 `server/index.mjs` 默认端口一致）；
4. 在「环境变量」里加两条：`LLM_BASE_URL`、`LLM_API_KEY`（需要时就加 `LLM_MODEL`）；
5. 部署完成后，控制台会给你一个形如 `https://xxxx.service.tcloudbase.com` 的公网地址 —— **把这一条地址发给我**。

### 方案 B（最省事）：Render 一键部署

```bash
# 1. 把仓库推到你的 GitHub（我没有你的 GitHub 凭据，这一步要由你做）
git remote add origin https://github.com/<你的账号>/<仓库名>.git
git push -u origin main
```

2. 打开 Render 控制台 → New → **Blueprint** → 选择这个仓库（会自动读取仓库里的 `render.yaml`）；
3. 在 Environment 里填 `LLM_BASE_URL` 与 `LLM_API_KEY`；
4. 部署完成后拿到 `https://xxxx.onrender.com` —— **把这一条发给我**。

### 方案 C（你自己有服务器/其他平台）

```bash
# 服务器上（Node 20+）
npm install
npm run build
LLM_BASE_URL="https://api.deepseek.com/anthropic" \
LLM_API_KEY="sk-你的密钥" \
PORT=8787 node server/index.mjs
# 建议用 pm2 常驻：pm2 start server/index.mjs --name prg
```

### 部署后自检（一条命令，确认后端真的活着）

```bash
curl https://你的后端地址/api/health
```

期望输出里包含：

```json
{"ok":true, "hasCredentials":true, "capabilities":{"realPdfExtraction":true,"realLlmQa":true}}
```

如果 `hasCredentials` 是 `false`，说明环境变量没被读到，检查变量名是否写错、是否加在了「运行环境」而不是「构建环境」。

## 四、把地址发我之后，我会做什么（这是让评委"打开就能用"的关键一步）

前端已经支持**构建时绑定后端地址**（`VITE_API_BASE`），所以我会：

```bash
# 用你给的后端地址重新构建前端（把地址烧进产物，页面会默认连它）
VITE_API_BASE="https://你的后端地址" npm run build
```

然后重新部署静态站点。这样：

- 评委打开的就是同一个公开链接，**不需要填写任何后端地址或模型配置**；
- 页面左下角「运行设置」里后端状态会直接显示「后端已连接」，字段抽取与问答立即可用；
- 如果你同时设置了 `API_ACCESS_TOKEN`，把口令告诉我，我会一起烧进构建产物（或改成不启用口令，由你决定）。

> 顺带说明：`VITE_API_BASE` 只是**默认值**。运行时仍然可以在「运行设置」里覆盖它，
> 所以同一份产物既能直连你的后端，也保留了本地调试的灵活性。
