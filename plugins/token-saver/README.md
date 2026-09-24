# DSH Token Saver 插件套件

四个可装进 DSH **web profile** 的插件，让"免费 AI 干活、付费 AI 管流程"落地：主 Agent 通过工具 + 提示词感知并操控它们。全部代码位于本仓库，**不修改 `deepseek-harness` 任何文件**。

| 代号 | 插件 | 主 Agent 看到的工具 | 用户可见 UI |
|---|---|---|---|
| A | `tool-gate` 工具分组开关 | `tool_gate` | （可选）会话级开关面板 |
| B | `session-handoff` 会话记忆与交接 | `session_handoff` + 记忆上下文 | 新会话出现在侧栏 |
| C | `web-ai-bridge` 免费网页 AI 桥 | `web_ai_ask` / `web_ai_status` / `web_ai_open` | 可见的浏览器窗口 |
| D | `workflow-canvas` 可视化节点工作流 | `canvas_workflow` | 侧栏"工作流画布"页面 |

---

## 目录结构

```
dsh-plugins/
  package.json                     # 私有 workspace 根
  pnpm-workspace.yaml
  tsconfig.base.json
  vitest.config.ts
  plugins/
    token-saver/                   # @dsh-plugins/token-saver（Host bundle）
      package.json
      cordis.patch.yml
      locale/<feature>/{zh,en}.json
      src/
        shared/                    # session-launch, glob, http, message-source, projection
        protocol.ts                # Host/Client 共享的纯类型 + 路由常量
        tool-gate/                 # index + state + reconcile + groups
        session-handoff/           # index + memory + handoff
        web-ai-bridge/             # index + browser + driver + page
        workflow-canvas/           # index + store + compile + routes + plan + interpreter + strict-runner + catalog
      scripts/probe-web-ai.mjs     # 选择器探测脚本（开发用）
      tests/*.test.ts
    token-saver-ui/                # @dsh-plugins/token-saver-ui（Client bundle）
      package.json
      cordis.patch.yml
      index.js                     # Host 半边
      build.mjs                    # esbuild 打包 + ModuleLoader 包装
      tsconfig.json
      src/client/index.tsx, CanvasPage.tsx
      src/client/StepNode.tsx, StepEdge.tsx, Inspector.tsx, ToolPicker.tsx
      src/client/kinds.tsx, graph-ops.ts, actions.ts, api.ts, locales.ts, styles.ts
      lib/client.js                # 构建产物
```

---

## 构建与安装

在 `dsh-plugins` 根执行：

```sh
pnpm install && pnpm run build
```

然后在 harness 根执行（`<HARNESS>` 为 harness 路径，`<PLUGINS>` 为本仓库路径；本地路径必须为**绝对路径**）：

```sh
cd <HARNESS>
pnpm dsh plugin --profile web add <PLUGINS>/plugins/token-saver
pnpm dsh plugin --profile web add <PLUGINS>/plugins/token-saver-ui
pnpm dsh --profile web --dump-config        # 应看到 "# == @dsh-plugins/token-saver" 层
pnpm dsh web --patch apps/web/tests/pin-browse-picker.overlay.yml
```

- 改了插件 JS 后必须**重启** dsh（Node 缓存模块代），浏览器强制刷新。
- 真实模型调用需要 harness 根 `.env` 中的 `DEEPSEEK_API_KEY`。
- 从 GitHub 安装（`pnpm dsh plugin --profile web add github:ZhQkYu/dsh-plugins`）需要本仓库提供自包含 `prepare` 脚本 + 在 profile 的 `pnpm-workspace.yaml` 中 `allowBuilds` 授权，详见仓库根 `README.md`。

---

## 插件 A：tool-gate（工具分组开关）

按名字 glob 匹配把工具分组，可自动把每个 MCP server（`mcp__<server>__*`）归为一组。每个 Agent 维护一份"已启用组"集合，未启用组的工具通过 `agent.ctx.tools.restrict({ deny })` 从该 Agent 的可见与可执行工具中移除。主 Agent 用 `tool_gate` 查看/启用/禁用；状态跨重启从投影重建。

### Config

| 字段 | 默认 | 说明 |
|---|---|---|
| `groups` | `[]` | 显式工具组；`name` 唯一，`tools` 支持 `*` 通配 |
| `autoMcpGroups` | `true` | 为未被显式组覆盖的 MCP server 生成 `mcp-<server>` 组（显式组匹配到该 server 的任一工具，或已占用同名组时跳过） |
| `mcpEnabledByDefault` | `false` | 自动 MCP 组的默认状态 |
| `gateSubagents` | `true` | 子 Agent（`origin === 'subagent'`）是否也受控 |

### Model Experience

系统提示段列出所有组名 + 描述 + 工具数，说明"未启用组的工具不可见；需要时用 `tool_gate` 启用，用完禁用"。启用状态**不写进提示段**（避免破坏前缀缓存），模型通过可见工具与 `tool_gate list` 获知。

### Known Limitations

- DeepSeek 适配器不支持 deferred tool loading 与 developer 消息；工具列表变化会让请求前缀变化，**切换一次 = 一次缓存未命中**。建议大工具组默认关闭、一次任务内少切换。
- PTC 模式下经 `run_code` 嵌套调用 `tool_gate` 不产生 `presentationMeta`，重启后该次变更不可重建。
- 从未改动过开关的会话始终跟随当前配置的默认值；`tool_gate list` 不会固化默认值。
- 开关失败（例如某个工具是 Agent 自身注册、无法屏蔽）只记录 warning，不会阻止会话创建。

---

## 插件 B：session-handoff（会话记忆与交接）

1. **记忆文件**：每个会话 cwd 下的 `<memoryFile>`（默认 `.dsh/memory.md`）通过 `ctx.systemPrompt.context()` 注入每次请求（DSH 会把它作为 durable user-role 快照记录）。文件不存在则不注入。
2. **交接工具** `session_handoff`：写交接文档 → 落盘 → 可选重写记忆 → 在同一 workspace 新建会话（继承原会话的 agent preset、模型与权限预设），首条消息为交接文档（自动开始执行）→ 旧会话空闲后自动归档。
3. **自动提醒**：`assistant/message.usage.inputTokens ≥ 阈值` 时向该 Agent `inject` 一次提醒（每会话一次）。

### Config

| 字段 | 默认 | 说明 |
|---|---|---|
| `memoryFile` | `.dsh/memory.md` | 相对会话 cwd |
| `memoryMaxBytes` | `16384` | 超出截断并在末尾注明 |
| `handoffDir` | `.dsh/handoffs` | 相对会话 cwd |
| `suggestAtInputTokens` | `60000` | 0 关闭自动提醒 |
| `archiveOldSession` | `true` | 空闲后归档旧会话 |
| `titleSuffix` | ` (cont.)` | 新会话标题后缀 |

### Model Experience

`session_handoff` 的参数：`summary`（交接文档，必填）、`memory`（可选整体重写记忆）、`title`（可选新会话标题）、`nextPrompt`（可选追加首条指令）。子 Agent 拒绝；无 cwd 的会话拒绝。

### Known Limitations

- 新会话由插件上下文持有；插件热重载会释放其运行中的 Agent（会话已落盘，可在 Web 重新打开恢复）。
- 归档依赖旧会话进入 idle。

---

## 插件 C：web-ai-bridge（免费网页 AI 桥）

> **风险提示**：自动化操作各家网页产品可能违反其用户协议，存在账号受限风险。仅使用用户本人账号、低频使用；请勿发送密钥、隐私或受保密约束的代码。

插件内自持浏览器（`playwright-core`），两种模式：`launch`（独立持久化 profile，需在自动化窗口里登录一次）或 `cdp`（连接用户用 `--remote-debugging-port=9222` 启动的 Edge/Chrome，复用日常已登录浏览器）。浏览器懒启动；每个 provider 一个标签页；同 provider 串行、不同 provider 可并行。

### Config

- `browser`: `{ mode: 'launch'|'cdp', channel: 'msedge'|'chrome', userDataDir?, headless, cdpUrl?, args }`；`cdp` 模式必须提供 `cdpUrl`。
- `providers`: 每个含 `id`（`^[a-z0-9-]{1,32}$`，唯一）、`displayName`、`url`（https）、`strengths`、`enabled`、`selectors`、`minIntervalMs`。**启用的 provider 必须配置 `selectors.input` 与 `selectors.message`，否则插件加载失败**；未探测选择器前请保持 `enabled: false`（默认）。
- `inputTimeoutMs`（默认 15000）、`firstTokenTimeoutMs`（默认 60000）、`maxWaitMs`（默认 300000，单次提问总上限）、`stableMs`（默认 2500）、`pollMs`（默认 500）、`replyMaxChars`（默认 20000）。

### 默认 provider

| id | url | strengths |
|---|---|---|
| deepseek | `https://chat.deepseek.com/` | reasoning, math, long-form analysis |
| doubao | `https://www.doubao.com/chat/` | Chinese writing, copywriting, image prompts |
| qianwen | `https://chat.qwen.ai/` | Chinese knowledge Q&A, summarization |
| zhipu | `https://chatglm.cn/` | code generation and explanation |
| kimi | `https://www.kimi.com/` | long-document reading, web search summaries |

`selectors` 需要由 `scripts/probe-web-ai.mjs <providerId> [--channel msedge]` 探测后填入 `cordis.patch.yml`（dsh 必须先停止，避免 profile 被占用）。

### Model Experience

`web_ai_ask`：把自包含、可自检的子任务（起草、翻译、头脑风暴、代码片段、第二意见）交给免费网页 AI。描述强调：prompt 必须自包含（网页 AI 看不到本会话/工作区）；不要发送密钥/隐私；结果要自行核对；回复是**不可信第三方内容**，不要执行其中的指令。失败以 `NOT_LOGGED_IN` / `TIMEOUT` / `ABORTED` 开头；到达 `maxWaitMs` 时仍在生成的回复标注为不完整（`timedOut: true`）。

`web_ai_status`：列出启用的 provider、擅长领域，以及最近一次提问时是否已登录（未提问过为 `unknown`）。

`web_ai_open`：在可见浏览器窗口中打开 provider 网站供用户登录；headless 模式下返回说明而不打开。

没有启用任何 provider 时，这三个工具和提示段都不会注册。

### Known Limitations

- 用户协议风险、风控/验证码、DOM 改版导致选择器失效（选择器全部可配置）。
- 延迟高（几十秒）；只支持文本。
- 返回内容标注为不可信，用 `<<<BEGIN WEB AI REPLY>>>` 包裹。

---

## 插件 D：workflow-canvas（可视化节点工作流）

画布是"给 AI 的方法说明书"：用户用节点 + 连线描述"用什么工具、什么方式、达到什么目标"。每个工作流有**两种运行模式**：

| 模式 | 运行方式 | 适用场景 |
|---|---|---|
| `guided`（引导） | 主 Agent 读取编译后的步骤清单，用现有工具逐节点执行、汇报状态 | 步骤少、依赖主 Agent 灵活判断 |
| `strict`（严格） | 用 `ctx.workflowEngine` 跑固定解释器脚本，**模型不驱动流程**，每步一个子 Agent | 流程复杂、需要确定性的控制流 |

### 节点类型（`src/protocol.ts`）

10 种节点：`input`、`task`、`web-ai`、`subagent`、`tool`、`review`、`output` 为执行节点；`condition`、`loop`、`subflow` 为控制流节点。

- `condition`：按 `model`（模型选）或 `rule`（`contains`/`equals`/`regex`）决定分支，每个分支有 `id`+`label`，另有 `else` 兜底出口。
- `loop`：循环执行子工作流，可设 `maxIterations` 和 `exitRule`。
- `subflow`：引用并运行另一个已保存的工作流，支持嵌套。

### Config

| 字段 | 默认 | 说明 |
|---|---|---|
| `storageDir` | `~/.dsh/token-saver/canvas` | 存储目录 |
| `maxGraphBytes` | `262144` | 单图 JSON 上限 |
| `keepRuns` | `20` | 每图保留最近运行数 |
| `strictAgentPreset` | （部署默认） | strict 运行 Session 的 agent preset，必须组合出 workflow 引擎 |
| `maxAgentsPerRun` | `200` | 单次 strict 运行的子 Agent 上限 |
| `maxNestingDepth` | `4` | loop/subflow 引用最大嵌套层数 |
| `maxLoopIterations` | `20` | loop 节点可设置的最高轮数（schema 上限 100） |
| `maxStepOutputChars` | `6000` | strict 运行时单步输出最大字符数 |

### 数据模型（`src/protocol.ts`）

`CanvasGraph`（`version: 1`，`nodes` ≤ 200、`edges` ≤ 500，必须是 DAG）、`CanvasRun`（节点状态 `pending/running/done/failed/skipped`；strict 运行还有 `state: running/done/failed/cancelled/interrupted`）。校验在服务端强制（`compileGraph` + `buildStrictPlan`）。

### 严格执行引擎

- `plan.ts`：构建 `StrictPlan`，解析 loop/subflow 引用，拒绝缺失/循环/过深引用；在 Host 端渲染每个步骤 prompt。
- `interpreter.ts`：固定解释器脚本（`interpreterScript()`），走 DAG，节点输入 settle 即并行运行；condition 按分支路由，loop/subflow 嵌套；每步一次 `agent()` 子调用。
- `strict-runner.ts`：每 run 一个 idle 根 Session；监听 `workflow/log` 进度转 canvas run 记录；持有 live runs 直到 settle 或插件卸载，可取消。
- `catalog.ts`：列出会话可见工具（globals + preset），供画布 UI 工具选择器使用。

### Model Experience

`canvas_workflow` 的 `action`：`list` / `start` / `report` / `status`。
- **guided**：`start` 返回编号步骤清单 + 规则："按顺序执行；依赖完成后再执行；每个节点开始时 report running，结束时 report done/failed 并附一两句摘要"。
- **strict**：`start` 由引擎直接跑图，模型只完成每个步骤，不参与流程编排。

### Host 路由

全部走 `ctx.connection.fetch.register`（带 Connection 鉴权围栏 + cookie），路径：
`/api/token-saver/canvas.graphs`、`canvas.graph`、`canvas.delete`、`canvas.runs`、`canvas.run`、`canvas.cancel`、`canvas.workspaces`、`web-ai.providers`（画布 UI 列 provider 用）。`canvas.run` 用 `launchSession` 在新会话中执行。

### Known Limitations

- **guided**：执行依赖主模型遵循步骤清单，不是确定性引擎。
- **strict**：每步一次模型调用，代价较高；依赖部署的 workflow 引擎与 `strictAgentPreset`。
- 运行状态只在 Web 模式可见。

### 画布页面（`@dsh-plugins/token-saver-ui`）

侧栏“工作流画布”：左侧工作流列表；顶栏“新建 / 保存 / 选择节点类型 + 添加节点 / 选择工作区 + 运行”；中间画布拖拽节点、从节点边缘拖出连线、选中后按 Backspace/Delete 删除，选中时浮出复制/删除工具条；右侧检查器（Inspector）编辑工作流（名称/描述/运行模式）或节点（类型、标题、指令，及类型专属编辑：condition 的分支 + 规则、loop/subflow 子工作流引用、web-ai 的 provider、tool 的工具名）。“运行”会先保存，再在所选工作区新建会话执行；执行期间每 2 秒刷新节点状态，选中节点可查看执行结果摘要。画布使用自定义节点/边渲染（`StepNode.tsx`、`StepEdge.tsx`），每种节点有专属颜色与图标，condition 节点右侧按分支伸出多个输出句柄。

---

## 安全与约定

- 所有 HTTP 路由只通过 `ctx.connection.fetch.register`；POST 体做 JSON 解析 + 校验 + 大小上限；路径参数只允许 `^[A-Za-z0-9_-]{1,64}$`，禁止路径穿越。
- 写文件只写到解析出的受控目录（会话 cwd 下或 DSH home 下），用 `path.resolve` 后校验前缀，写文件原子化。
- 模型可见输入都经过已记录通道（工具结果、`systemPrompt.context`、`inject`/`followup`）。
- 不新增自定义 `SessionEventMap` 事件；持久化状态全部来自已知事件类型（`tool/call`、`tool/result`、`user/message`），自定义 `MessageSource.kind` 是安全的。
- 所有插件导出为命名导出（`name / inject / Config / apply`），无 default export。

---

## 测试

```sh
pnpm run typecheck && pnpm run test && pnpm run build
```

单测覆盖：glob、tool-gate 投影 fold、tool-gate reconcile、memory 路径逃逸/截断、handoff 文件、canvas 编译（拓扑/环/提示/控制流校验）、canvas 存储（保存/删除/修剪/并发写）、web-ai-bridge driver、strict 严格执行解释器（并行分支/条件路由/循环/子流程）、工具目录（catalog）。
