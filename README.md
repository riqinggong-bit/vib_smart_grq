# 液态智能网页

一次提交完整 Query，服务端先提取共同约束和共享事实，再策划七个内容不同的独立网页方案。点击方案后才生成完整页面，返回后可以继续选择其他方案。

结果页支持段落、步骤、卡片、表格、时间轴、选择式比较、可调计算器、条形图和清单。每个模块可以显示引用的共享事实及“用户提供 / 已验证 / 待核实”状态，减少七个页面之间的事实冲突。

## 启动

使用 Node.js 22 或以上版本，无需安装依赖。

1. 在项目 `.env` 中填写 `OPENAI_API_KEY`，不要把密钥写入前端或提交到版本库。
2. `OPENAI_MODEL` 默认保留 `gpt-4.1-mini`，可改为账户有权限且支持结构化输出的模型。
3. 在项目目录运行 `npm start`。
4. 打开 http://localhost:3000 ，输入完整 Query 后策划七个方案，点击一个方案生成完整页面。

更改 `.env` 后重启服务。环境变量优先于 `.env`。不要直接双击 HTML，生成接口需要本地服务。

## 验证

运行 `npm test`：验证七方案与页面协议、共享事实传递、独立页面生成、生成缓存、刷新恢复接口和跨领域评测集。模拟测试不代表真实模型请求已成功。

接口依据：https://developers.openai.com/api/reference/typescript/resources/beta/subresources/responses/methods/create

## Gemini 接入

后端已支持 Google Gemini，根据模型名称自动选择接口。现有 `.env` 的 `OPENAI_API_KEY` 和 `OPENAI_MODEL` 字段也兼容 Gemini；也可以使用 `GEMINI_API_KEY` 和 `GEMINI_MODEL`。当前实测 Google 对新用户停止提供 gemini-2.5-flash，按接口建议改用 gemini-3.6-flash。密钥仅在服务器使用。

## 内容方案流程

POST /api/plan 根据原始 Query 返回共同约束、共享事实和七个动态方案（标题、适合人群、重点、产出、章节、组件、建议布局）。POST /api/page 使用 sessionId 与 variantIndex 按所选方案生成独立网页。GET /api/session/:id 用于刷新恢复。后端会话保存两小时，重启服务会清空；前端用 localStorage 恢复已生成页面和各方案的清单状态。

`evaluation-cases.json` 包含解释、分析、规划、比较、计算和商品决策六类验收 Query，用于检查组件选择及硬约束保留。

## 部署到 Render

项目根目录已包含 `render.yaml`，可以作为 Render Web Service 部署。

1. 将项目提交到 GitHub 仓库；确认 `.env` 没有进入仓库。
2. 在 Render 选择 **New → Blueprint**，连接该仓库并应用 `render.yaml`。
3. 在创建过程中填写密钥环境变量 `GEMINI_API_KEY`。
4. 等待健康检查 `/api/health` 通过，然后访问 Render 提供的 HTTPS 地址。

如果不用 Blueprint，也可手动创建 Web Service：Build Command 填 `npm install`，Start Command 填 `npm start`，Health Check Path 填 `/api/health`。

服务使用平台提供的 `PORT` 并监听 `0.0.0.0`。默认限制单个 IP 每小时调用生成接口 30 次，可通过 `REQUESTS_PER_HOUR` 调整。限流与会话数据当前保存在进程内存中，服务重启会清空；若未来启用多个实例，应迁移到 Redis 等共享存储。
