# Gdouwork 功能清单

在 pi 内核之上加了什么，以及每一项是怎么实现的。

规模：`src/` 3704 行 + `electron/` 581 行 + `scripts/` 2178 行 + `renderer/` 1548 行 = 8011 行。
**没有修改 pi 一行代码**（唯一例外是绕开它的一个 bug，见最后一节）。

---

## 0.5 当前版本：方案B（外壳与桥接）

> **2026-09-24 更新。** 本清单的绝大多数条目写于 **Electron GUI 时代**（`renderer/` +
> `electron/main.ts`，桌面自绘窗口）。此后 GUI 层做了一次彻底重构：**桌面 Electron 界面
> 下线，前端换成自绘的 Vue 工作台（`shell/`，Vite + Vue3），内核通过 `bridge/` 以
> JSON-RPC over WebSocket（端口 7438）暴露给 shell。** 内核、模式、工具、专家、技能、
> MCP 等 `src/` 侧能力全部保留，行为不变；下文的「GUI」条目描述的是老 Electron 实现，
> 其角色已由 shell 对应组件接替。老文件（`renderer/`、`electron/`）仍在仓库里作为历史
> 存档，但不再是当前交付物。
>
> 方案B 的架构与新增能力见 **2.44 桥接层** 与 **2.45 shell 工作台**。对照总表见第 1 节，
> 其中 Electron GUI 专属行已标注「随 Electron 下线」。

---

## 0. 基线：pi 原本给了什么

分清"我们加的"和"pi 给的"，才知道真正的增量在哪。

| pi 提供的 | 说明 |
|---|---|
| 三层依赖链 | `packages/coding-agent`（CLI）→ `packages/agent`（pi-agent-core 运行时）→ `packages/ai`（provider 抽象） |
| 两套运行时 | 简单版 `src/agent.ts` + `src/agent-loop.ts`；持久化版 `src/harness/**`（13 状态机，可恢复/分支） |
| 8 个内置工具 | read / bash / edit / write / grep / find / ls / powershell |
| 41 providers / 1442 models | `builtinModels()` 一次性注册，含各家 auth 读取逻辑 |
| `AgentTool` 接口 | TypeBox schema + `execute(id, params, signal?, onUpdate?)` |
| pi-tui 组件库 | Editor / Markdown / SelectList / ScrollView / TuiMainScreen / 终端能力探测等 |
| 扩展系统 | `ExtensionAPI`（30+ 生命周期事件），jiti 加载 |

**pi 没给的**：一个能直接用的成品 agent。它给的是零件——运行时、provider 接入、工具、TUI 组件。装配方式、模式划分、事件抽象、交互设计全要自己定。

---

## 1. 总表

| # | 能力 | 位置 | 核心实现方式 |
|---|---|---|---|
| 1 | 零构建链接 vendored pi 源码 | `vendor/pi/`、`scripts/sync-pi-paths.mjs` | pi 源码随仓库走；镜像其 tsconfig paths，tsx / esbuild 都遵守 |
| 2 | 模型运行时 + 国内 provider 预设 | `kernel/runtime.ts`、`config/providers.ts` | 包一层 `MutableModels`，spec 解析 + 凭据优先序 |
| 3 | **事件归一化层** | `kernel/events.ts` | 自定义 11 种事件词表，`translate()` 翻译 pi 事件 |
| 4 | AgentSession 单一装配点 | `kernel/agent.ts` | 全项目唯一构造 pi `Agent` 的地方 |
| 5 | Profile 模式系统 | `profiles/` | `AgentProfile` 三方法契约 + 注册表 |
| 6 | 工具 + 类型约定 | `tools/` | 具名 schema const + `AgentTool<typeof schema>` |
| 7 | 设置持久化 + 状态隔离 | `config/settings.ts`、`paths.ts` | 原子写；独立于 pi 的 `~/.pi/agent` |
| 8 | headless CLI | `cli.ts` | tagged union 子命令；`--json` 输出事件 JSONL |
| 9 | **TUI** | `tui/` | 主屏渲染 + 订阅路由 + 全局按键层 |
| 10 | 离线验证套件 | `scripts/smoke.ts`、`scripts/tui-check.ts` | 假终端录制 + `fauxProvider()` 脚本化模型 |
| 11 | **桌面 GUI** ⚠️ 随 Electron 下线 | `electron/`、`renderer/` | 内核跑在主进程内；IPC 送探测结果；渲染进程零构建。当前交付物是 shell（见 2.45） |
| 12 | **可分发构建 + 安装包** ⚠️ 随 Electron 下线 | `scripts/build.mjs`、`electron-builder.yml` | esbuild 把 pi 源码内联成单文件；electron-builder 出 NSIS。当前以 `npm run dev:shell` 双进程形态运行 |
| 13 | GUI 离屏自检 ⚠️ 随 Electron 下线 | `scripts/gui-check.mjs` | 从外部启动真应用，用 CDP 把渲染后的 DOM 读回来断言。shell 侧由构建期 `vite build` + 手动验证覆盖 |
| 14 | 工具链目录隔离 | `package.json` 的 `piConfig`、`kernel/toolchain.ts` | 把 pi 下载 rg/fd 的位置从 `~/.pi` 挪到自己的 home |
| 15 | **随包分发 rg / fd** | `scripts/fetch-tools.mjs`、`kernel/toolchain.ts` | 固定版本抓取 + 首启投放；bridge 进程内可用（打包形态已不再随 Electron 走） |
| 16 | 工具级自检 | `scripts/tool-check.ts` | 真跑 grep/find/ls/read 对固定夹具，验证工具离线可用 |
| 17 | **对话界面** | `shell/`（Vue 工作台） | 事件驱动的消息流；流式文本、可折叠工具块；原 `renderer/` 版本随 Electron 下线 |
| 18 | 脚本化运行 | `kernel/demo.ts` | fauxProvider 回放固定脚本，无凭据也能跑完整一轮 |
| 19 | **会话持久化与多会话** | `kernel/sessions.ts`、`bridge/server.ts` | 一段对话一个文件，两行 JSON（摘要 + 记录）；重启恢复；历史列表可切换、删除；bridge 每次 run 后落盘、重启后自动从磁盘重建 |
| 20 | 工作目录选择 ⚠️ 随 Electron 下线 | `electron/main.ts`、`renderer/` | 系统目录对话框 + 持久化 + 会话重建；界面靠广播同步。当前工作目录在启动时确定（`process.cwd()`） |
| 21 | **上下文裁剪** | `kernel/context.ts`、`kernel/agent.ts` | 接 pi 的 `transformContext`，只裁发给模型的，不动记录 |
| 22 | 裁剪告知 | `kernel/events.ts` 的 `notice` | 跨越预算时发一次提示；克制但看得见，不按错误样式 |
| 23 | 常驻上下文指示器 | `kernel/context.ts`、`kernel/agent.ts`、`shell/` | 记录上次实际发送的量；shell 的 SessionStatsLine 显示上下文占用条 |
| 24 | 预览入口 ⚠️ 随 Electron 下线 | `electron/main.ts`、`renderer/` | 会话启动失败时提供按钮；预览从空白开始且不落盘。当前无此交互 |
| 25 | 会话重命名 | `kernel/sessions.ts`、`shell/` | 行内编辑；重写整个文件（标题在摘要行和记录行都有）；空名被拒绝 |
| 26 | pi 能力接线补全 | `kernel/agent.ts`、`config/settings.ts` | 设置真正生效；重试注入；缓存会话亲和；thinkingBudgets 透传 |
| 27 | **pi 源码 vendoring** | `vendor/pi/`、`scripts/vendor-pi.mjs`、`scripts/check-vendor.mjs` | 按依赖闭包拷入 6 个包（701 文件）+ sha256 清单；只读校验；外部依赖按 pi 的精确版本装进本项目 |
| 28 | **组合模型 + 专家** | `kernel/recipe.ts`、`experts/`、`bridge/server.ts`（`expert.list`）、`shell/`（专家选择器） | 会话 = 模式 + 专家；专家**只能收窄**工具集；markdown 三级加载；shell 在 composer 提供专家选择，会话头显示当前专家与收窄 |
| 29 | **工作台外壳** | `shell/`（Vue 组件）、`renderer/` ⚠️ | 冷灰中性设计语言；原 52px 标题栏 + 240px 侧栏 + 主区在 Electron 实现，shell 自绘整套工作台 |
| 30 | **权限门 + 命令检查器** | `kernel/permission.ts`、`kernel/command-guard.ts`、`kernel/agent.ts` | 有序 5 阶段判定链（主轴是路径归属）；凭据禁读也禁写、任何档位不能越过；命令黑名单五类规则；接在 pi 的 `beforeToolCall` 接缝上 |
| 31 | **产物交付** | `tools/present.ts`、`shell/` | `present_files` 只收绝对路径且全有或全无；产物渲染成卡片；shell 侧 artifact 面板展示 |
| 32 | 单实例锁 ⚠️ 随 Electron 下线 | `electron/main.ts` | 第二个实例直接退出并把已有窗口拉到前台。当前双进程（bridge + shell）形态天然单实例 |
| 33 | **联网** | `tools/web-fetch.ts`、`tools/web-search.ts`、`tools/net-guard.ts` | `web_fetch` 用 readability + linkedom 抽正文（不执行 JS）；`web_search` 走 Brave / Tavily；SSRF 防护在入站与**每一跳重定向**都校验 |
| 34 | **变更追踪** | `kernel/changes.ts`、`kernel/agent.ts`、`shell/` | 工具行显示 `+N −M`；`edit` 用 pi 的 diff，`write` 靠调用前快照算真实增减；shell 的 EditedFilesCard 展示 |
| 35 | **工具分组折叠** | `shell/`（ToolCallGroup） | 连续 2 个以上工具调用折成一张组卡（组头列工具名 + 调用次数）；运行中保持展开，轮结束时折叠 |
| 36 | **模式改成数据** | `profiles/builtin.ts`、`profiles/loader.ts`、`profiles/tool-catalog.ts`、`profiles/registry.ts` | 模式是 markdown：内置走内联字符串，用户级 `~/.gdou-agent/modes/`、项目级 `<cwd>/.gdou-agent/modes/` 三级加载；frontmatter 的工具**名**由工具目录解析成工具，缺 `tools`、未知工具名、空正文都在加载时拒绝 |
| 37 | **重复调用守卫** | `kernel/loop-guard.ts`、`kernel/agent.ts`、`config/settings.ts` | 同工具同参数**连续**重复超过 N 次（默认 3）即拦下；拦在权限门之后；理由作为 error 工具结果回给模型；`loopRepeatLimit: 0` 关掉 |
| 38 | **备用模型** | `kernel/fallback.ts`、`kernel/agent.ts`、`config/settings.ts`、`shell/`（备用模型选择） | 主模型**在产出任何内容之前**失败才切；切换以 `notice` 告知；`fallbackModel` 配置；shell 的模型菜单可配置备用模型 |
| 39 | **按模式选模型** | `profiles/types.ts`、`profiles/loader.ts`、`kernel/agent.ts` | 模式文件的 `model:` 是**最低优先级**建议（选项 > 设置 > 模式）；未知 spec 在会话启动时报错并点名模式与文件 |
| 40 | **模型与凭据** | `kernel/credentials.ts`、`kernel/runtime.ts`、`shell/`（模型管理） | 界面里存 API key（`~/.gdou-agent/auth.json`，pi 的格式）；存的 key **压过**环境变量；key **永不跨 IPC** 回前端，只有掩码；shell 的模型菜单按服务商分组列模型 |
| 41 | **启动即新对话 + 修掉模型切不动** ⚠️ 随 Electron 下线 | `electron/main.ts`、`renderer/app.js`、`kernel/agent.ts` | 桌面版的两处修复；shell 侧启动默认进新建任务页 |
| 42 | **技能渐进式披露** | `skills/types.ts`、`skills/registry.ts`、`skills/builtin.ts`、`tools/load-skill.ts`、`kernel/agent.ts`、`kernel/recipe.ts`、`shell/`（技能中心） | 技能是「目录 + `SKILL.md` + 可选 `references/`」，三级加载（内置/用户/项目）。会话开始时提示里只有**名字+描述+when_to_use**，正文不注入；模型判断任务匹配后调 `load_skill` 读正文（可附带读一个 reference 文件） |
| 43 | **GUI 质感改造** ⚠️ 随 Electron 下线 | `renderer/tokens.css`、`renderer/shell.css`、`renderer/chat.css`、`renderer/index.html`、`renderer/app.js` | 侧栏品牌区、可拖拽宽度、轮次圆点导航等质感，shell 侧重新实现 |
| 44 | **观测（崩溃/日志/内存）** | `kernel/observability.ts`、`src/paths.ts` | 三件「出问题能拿到线索」的事，全落在 `~/.gdou-agent/logs/`：崩溃报告、运行日志、内存诊断 |
| 45 | **子代理（delegate）** | `tools/delegate.ts`、`kernel/agent.ts`、`profiles/builtin.ts` | `delegate` 工具把自包含子任务交给一个**独立上下文**的子代理跑完，返回最终文本。子代理**继承父模式**（不写死 coding，权限面不在用户背后变大）；防递归：`includeDelegate: false` 不含 delegate 本身。**B7 第一个调用点**：`model` 参数可指向 lite 模型。连带把 **general 模式也开放了文件/Shell 工具** |
| 46 | **动效（流式光标 + 思考动画）** ⚠️ 随 Electron 下线 | `renderer/chat.css`、`renderer/app.js` | 流式光标、思考三点跳动、思考扫光等动效在 Electron 渲染层实现；shell 有自己的一套动效 |
| 47 | **marked 排版 + 工具折叠 + 等待动效** ⚠️ 随 Electron 下线 | `renderer/marked.umd.js`、`renderer/app.js`、`renderer/chat.css` | 输出排版/工具折叠/等待动效；shell 用 marked 做排版、自己实现工具折叠与等待动效 |
| 48 | **MCP（stdio 客户端）** | `src/mcp/{config,client,schema,tool,index,approval}.ts`、`kernel/agent.ts`、`shell/`（设置页审批） | 接 `@modelcontextprotocol/sdk`，把 stdio MCP server 的工具挂成 agent 工具。配置三级作用域合并 + JSONC 注释 + `${VAR}` 扩展；工具名加 `mcp__<server>__` 前缀；broken server 报进 `session.mcpErrors`。**I4 审批已实现**：首次连接需用户批准（见 2.43） |
| 49 | **桥接层（方案B）** | `bridge/server.ts` | JSON-RPC over WebSocket（7438），63 个方法把内核能力映射给 shell；事件翻译、会话持久化、断线后自动重建；诚实拒绝未实现能力（见 2.44） |
| 50 | **shell 工作台（方案B）** | `shell/`（Vite + Vue3） | 自绘桌面工作台：会话、时间线、检查器、技能中心、自动化页、源码控制；专家选择、备用模型、MCP 徽标（见 2.45） |
| 51 | **自动化（定时任务）** | `src/automation/schedule.ts`、`bridge/server.ts` | 配方 + 提示词 + 触发时机；运行时触发（桥进程存活期间）；产出单独概念不混入历史；无人值守默认 read-only（见 2.46） |
| 52 | **提问机制（ask_user）** | `src/tools/ask-user.ts`、`kernel/agent.ts`、`bridge/server.ts` | 模型调用 `ask_user` 向用户提出结构化问题；run 挂起等回答；shell 弹多选/多选弹窗（见 2.47） |
| 53 | **用量统计** | `bridge/server.ts`、`shell/`（用量页） | 每次 run 结束后把真实 token 用量追加写入 `~/.gdou-agent/usage.ndjson`（input/output/cache/cost/耗时）；`stats.overview` 聚合总览 + 按天 + 按模型；shell 用量页展示卡片与明细表（见 2.48） |
| 54 | **用户记忆系统** | `src/memory/memory.ts`、`kernel/agent.ts`、`bridge/server.ts`、`shell/`（记忆页） | 对话结束后自动提炼关于用户的事实写入 `~/.gdou-agent/memory.json`，新会话启动时注入系统提示，跨对话记住称呼/语言/偏好/项目；记忆页可查看、编辑、删除、手动添加（见 2.49） |
| 55 | **思考块 UI 修复与优化** | `shell/src/components/timeline/ActivityPhase.vue` | 修复状态类 `thinking` 与全局 `.thinking` 同名冲突导致的展开后正文重叠；思考区独立标签 + 独立容器，与正文视觉分离（见 2.50） |
| 56 | **Git 提交流程落地** | `bridge/server.ts`、`shell/`（源代码管理） | 桥端实现 `change.stage/unstage/discard/revert` 与 `git.commit`（路径安全过滤 + 确认参数），`change.list` 补齐 index/worktree 状态与 numstat 增减统计，`change.diff` HEAD 优先，`git.history` 支持分页（见 2.51） |
| 57 | **自动更新** | `shell/src-tauri`（updater 插件）、`scripts/updater-release.mjs` | Tauri updater 接线：插件 + `updater_configured` 命令 + 公钥/endpoints 配置 + minisign 密钥对；发布脚本签名并生成 latest.json（见 2.52） |
| 58 | **切换会话工作目录** | `bridge/server.ts`（`session.set_workspace`） | 会话可移动到其他项目：重建 agent（同消息同专家、换 cwd）并落盘；运行中拒绝（见 2.53） |
| 59 | **对话导出** | `shell/`（SessionActions） | 会话菜单「导出对话」：拉取完整历史组装 Markdown（用户/Assistant 分节、thinking 作引用）并下载（见 2.53） |
| 60 | **前端质量与用量/记忆增强** | `shell/`（多处） | vue-tsc 类型错误清零（删未接入 Workflow 死代码、重建 protocol.ts）；记忆页排序与来源标签 i18n 修复；用量页月度预算告警（见 2.54） |

---

## 2. 逐项说明

### 2.1 pi 源码 vendoring + 零构建链接

**问题**：pi 是 source-only 仓库，**没有 `dist`**，但它的 `package.json` 里 `exports` 指向 `./dist/*`。所以 `import { Agent } from "@earendil-works/pi-agent-core"` 直接解析失败。

**更早的做法**：用 tsconfig `paths` 指向隔壁的 `../pi-main` checkout。开发能跑，但**任何没有那个 checkout 的机器都构建不了**——这不是一个独立项目该有的前提。

**现在的做法**：pi 源码直接拷进本仓库的 `vendor/pi/`（701 文件、8.2 MB）。`scripts/sync-pi-paths.mjs` 读 vendored 的 `tsconfig.json`，把每个 target 重写成 `./vendor/pi/packages/*/src`，生成 `tsconfig.pi-paths.json`（22 条映射）。`tsx`（运行时）和 `esbuild`（构建时）都遵守它，所以一份映射服务两种模式，**零构建**——改 vendored 源码，下次运行即生效。

**为什么是这 6 个包**：`ai`、`agent`、`tui`、`coding-agent`、`chord`、`telemetry`。这是**实际用到的闭包**，不是"把 pi 全拷过来"：`client` / `protocol` / `server` 只被 `coding-agent/src/experimental/**` 引用，而那部分本项目不用；`durable` / `evals` / `session-backends` / `agent-old` 不在闭包里。闭包清单在 `scripts/pi-packages.mjs` 一处定义，vendoring 和路径生成共用，两边不可能说法不一致。

**只读**：`vendor/pi` 是上游代码，必须逐字节不变。`npm run check:vendor` 按 `manifest.json` 里的 sha256 校验每个文件，缺一个、多一个、改一个都失败。要改行为就改 `src/`——包装它、配置它，或用 pi 暴露的接缝替换它（`streamFn`、`transformContext`、`beforeToolCall` / `afterToolCall`、`prepareNextTurn`、profile、自定义工具）。直接改这里，下次升级会静默回退，diff 也不再可审。

**五个关键细节**（都不是显然的）：

- pi 的 `"*": ["./*"]` 兜底必须丢掉。它把任意 specifier 映射到 pi 仓库根，会**遮蔽第三方导入**——`chalk` 会被解析成 `./vendor/pi/chalk`。
- `paths` 的 target 必须以 `./` 开头。`relative()` 给出的是 `vendor/pi`，tsgo 直接报 `TS5090: Non-relative paths are not allowed`。之前指向 `../pi-main` 恰好以 `..` 开头，所以这个坑是 vendoring 才暴露出来的。
- `include` 必须带上 pi 的 `*.d.ts` shim。pi 在 `packages/coding-agent/src/utils/highlight-js.d.ts` 里声明了 `highlight.js/lib/core.js` 这类模块，不带上就 typecheck 不过。
- **不拷每个包的 `package.json`**，而且这一条很关键。pi 定位自己的状态目录的方式是：从模块位置往上走到最近的 `package.json`，读里面的 `piConfig`。如果 pi 的 `package.json` 在，这个走查会停在它上面，开发态就会把状态目录解析成 `~/.pi/agent`——往 pi 的目录里下 ripgrep，静默破坏本项目承诺的隔离。文件不在，走查穿过 `vendor/` 落到本项目自己的 `package.json`。`scripts/pi-env.mjs` 另外用 `PI_PACKAGE_DIR` 显式钉了一遍，作为防止未来 re-vendor 把文件带回来的保险。
- **外部依赖不 vendoring**。vendored 源码 import 的 `typebox` / `openai` / `chalk` / `yaml` 等，装在本项目 `node_modules` 里，版本取 **pi 钉死的精确版本**——源码副本只有在版本对得上时才能解析。这条从"能跑"变成了"必须"：以前源码在 `../pi-main/packages/*/src/`，Node 向上走查会自然找到 `../pi-main/node_modules`；现在源码在 `vendor/pi/`，走查只会到本项目 `node_modules`，缺一个就 `TS2307`。

重跑：`npm run vendor:pi -- --from <pi checkout>`（没有默认路径），然后 `npm run sync-paths`。

### 2.2 模型运行时 + provider 预设

**`kernel/runtime.ts`**（84 行）包一层 pi-ai 的 `MutableModels`：

- `parseModelSpec()` 接受 `"provider/id"`，也接受裸 `"id"`（裸 id 会遍历所有 provider 找）
- `resolveDefault()` 优先级：显式 spec → **环境变量里第一个有 key 的预设**
- `credentialReport()` 生成凭据状态表，给 `--doctor` 用

**`config/providers.ts`**（88 行）声明 5 家国内厂商，每家带 env var、默认模型、备选模型、地区标记：

| 厂商 | env var | 默认模型 |
|---|---|---|
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek-flash` |
| Moonshot / Kimi | `MOONSHOT_API_KEY` | `kimi-k3` |
| 智谱 GLM | `ZAI_API_KEY` | `glm-5.3` |
| 通义 Qwen | `QWEN_TOKEN_PLAN_API_KEY` | `qwen3.8-max` |
| MiniMax | `MINIMAX_API_KEY` | `MiniMax-M3` |

预设按声明顺序排列，所以同时配了多个 key 时 DeepSeek 优先——这是刻意的确定性，而不是"随机挑一个"。

### 2.3 事件归一化层 —— 增量最大的一个设计

**问题**：pi 的 `AgentEvent` 是为它自己的 TUI 定制的。前端直接消费这个流，就等于把表现层焊死在 pi 的内部结构上；pi 一升级，UI 跟着改。

**做法**：定义自己的 11 种事件，`translate(piEvent) → AgentEvent[]`：

```
run_start  assistant_start  text_delta  thinking_delta  assistant_end
tool_start  tool_update  tool_end  turn_end  run_end  error
```

所有前端（CLI、TUI）**只依赖这套词表**，没有任何视图 import pi 类型。

**这层已经赚回成本了**：pi 把 provider 失败表达成一个 assistant message，带 `stopReason: "error"` 和 `errorMessage`。只渲染 delta 的前端会**完全看不到失败**——表现为静默无输出。在 `message_end` 分支把它提升成独立的 `error` 事件修掉了。这不是假想的风险，是实际踩到的。

同文件还提供三个收敛点：`textOf()`、`toolResultText()`（把 `{content: [...]}` 这个形状的处理收在一处）、`primaryToolArgument()`（让折叠视图显示 `read src/foo.ts` 而不是一整坨 JSON）。

### 2.4 AgentSession 单一装配点

**`kernel/agent.ts`**（158 行）是全项目**唯一**构造 pi `Agent` 的地方。上层只跟 `AgentSession` 打交道，于是只有一条接线路径需要维护正确。

- `resolveSetup()` 解析 profile / model / cwd / thinkingLevel / toolExecution
- 缺凭据时抛出**可操作的**错误：列出所有 env var，并给出 PowerShell 和 bash 两种设置示例
- `assemble()` 接线、包上事件翻译、维护监听器集合
- 对外暴露 `prompt` / `subscribe` / `abort` / `dispose`
- 留了 `streamFn?` 接缝：可替换传输层（本地模型、代理、脚本化 provider）

### 2.5 Profile 模式系统

> **本节描述的是最初的实现，已被 2.31 取代（2026-09-23）。** 模式现在不是 TS 对象
> 而是 markdown 文件；`general` 是 5 个工具、`coding` 是 10 个（都多出联网与产物交付）。
> 保留下面的原文是因为它记录的**取舍**仍然成立——尤其是「复用 pi 的工具而不是重写」
> 和「general 无文件访问是安全默认」这两条，2.31 只是把它们搬进了数据文件。

`profiles/`（4 个文件 194 行）。`AgentProfile` 契约只有 3 个方法宽：`systemPrompt(context)`、`tools(context)`，加两个可选偏好（`toolExecution`、`thinkingLevel`）。

**general**（3 个工具）：`current_time` / `save_note` / `list_notes`。无文件、无 shell——这是**安全默认**，误读一条指令也破坏不了任何东西。系统提示里明确写了"需要文件或 shell 就说出来，建议切 coding"。

**coding**（7 个工具）：`read` / `bash` / `edit` / `write` / `grep` / `find` / `ls`。

关键决定是**直接复用 pi-coding-agent 的 `createAllTools()` 而不是重写**。因为这些工具已经处理了所有琐碎但重要的部分：输出截断、文件变更排队、二进制检测、图片读取、ripgrep 集成。重写一遍是纯粹的浪费。而且 `createAllTools` 返回的就是 `AgentTool`，插进 pi-agent-core 的循环**不需要适配器**。

pi 提供了 8 个（多一个 `powershell`），默认启用 7 个。`enabledTools` 可裁剪——想要一个只读的代码 reviewer，去掉 `write` 和 `edit` 就行。

加一个模式 = 加一个文件 + `registerProfile()`，**不动内核**。

### 2.6 工具与类型约定

`tools/`（146 行）两个示例，覆盖两种典型形态：

- `time.ts` — **无状态**工具，纯计算
- `notes.ts` — **有状态**工具，自带存储（`~/.gdou-agent/notes.json`），原子写（temp + rename）。大多数自定义工具会follow这个模式

**类型写法约定**（不遵守会立刻报错）：schema 声明为具名 const，工具注解为 `AgentTool<typeof schema, Details>`。

```ts
const saveNoteSchema = Type.Object({ key: Type.String(), value: Type.String() });

export const saveNoteTool: AgentTool<typeof saveNoteSchema, { key: string; total: number }> = {
  name: "save_note",
  // ...
  async execute(_toolCallId, params) { /* params 有正确类型 */ },
};
```

写成 `AgentTool<any>` 会把 `params` 拓宽成 `unknown`，`execute` 签名立刻 typecheck 不过。

### 2.7 设置持久化 + 状态隔离

- `~/.gdou-agent/settings.json`，原子写（先写 `.tmp` 再 rename，避免半个文件落盘）
- **未知 key 直接丢弃，而不是合并**——schema 变更后，陈旧的 key 不会悄悄继续生效
- `AGENT_HOME` 与 pi 自己的 `~/.pi/agent` **分开**，两者可以共存，互不覆盖对方的设置和会话
- 可覆盖：`GDOU_AGENT_HOME`（状态目录）、`GDOU_VENDOR_DIR`（vendored pi 位置）

### 2.8 headless CLI

`cli.ts`（312 行）。

- `parseArgs` + `CliCommand` tagged union：`help` / `list-profiles` / `list-providers` / `list-tools` / `doctor`
- 只读子命令与运行路径**完全分离**，不构建 agent、不花 token
- `--json` 输出归一化事件的 JSONL——这是脚本化契约，所以它**永不打开 TUI**
- 支持 stdin：`echo "explain closures" | gdou-agent -p general`
- `renderText(event)` 是事件流的参考消费者。TUI 之前，内核就是靠它验证的——它同时也是"如何消费这套事件"的可读范例
- 无 prompt + 有 TTY → 自动进 TUI；`-p` 指定 profile 则跳过模式选择器

### 2.9 TUI

`tui/`（9 个文件，约 1300 行）。

```
tui/
  index.ts                   入口：TTY 检查 → 模式选择器 → 交接给 app
  app.ts                     订阅路由、按键、生命周期
  theme.ts                   窄 token 集；dark / light 双模式
  components/
    transcript.ts            有界条目列表 + 工具视图记账
    tool-call.ts             可折叠工具调用 + 实时输出 + spinner
    messages.ts              用户轮（原样文本）/ 助手轮（全程 markdown）
    notice.ts                横幅、错误、预着色固定行
    status-line.ts           模式 · 模型 · cwd + 瞬时提示
    profile-picker.ts        启动模式选择
```

**四个设计决定**（都有注释写明理由）：

1. **主屏而非备用屏**。transcript 落在终端自己的 scrollback 里，原生滚动、搜索、复制全部保留。备用屏要拿这三样换一个固定视口——对一个"输出要被复制走"的助手来说是错的取舍。
2. **`setClearOnShrink` 必须保持关闭**。开启后任何内容收缩都触发全量重绘，而 `TuiMainScreen` 的全量重绘会执行 `\x1b[2J\x1b[H\x1b[3J`（清屏 + 清 scrollback）。也就是说折叠一个工具调用会把主屏存在的理由抹掉。差量渲染本身已经会清理收缩后空出的行。
3. **工具输出默认折叠，且显示尾部而非头部**。一次 `read` 或 `bash` 能吐几百行，铺开就把答案埋了。取尾部是因为错误出现在输出末尾，这也和 pi 自己的截断方向一致。`ctrl+o` 展开最后一个，`ctrl+t` 全部。
4. **渲染只依赖 `AgentEvent`**。没有任何视图 import pi 类型。

**按键**：

| 键 | 行为 |
|---|---|
| `enter` | 发送 |
| `shift+enter` / `ctrl+j` | 换行 |
| `ctrl+o` | 展开/折叠最近一个工具调用 |
| `ctrl+t` | 展开/折叠全部工具调用 |
| `ctrl+l` | 清屏 |
| `ctrl+c` | 中止当前轮；再按一次退出（第一次会提示确认，防止误丢草稿） |
| `ctrl+d` | 输入为空时退出 |

**实时输出怎么实现的**：pi 的工具在 `execute` 里可以调 `onUpdate` 推送部分结果，归一化层把它翻成 `tool_update` 事件，`ToolCallView.setOutput()` 收到后重绘。所以长命令是**逐步显示**而不是卡住不动。折叠视图显示尾部，展开显示全部。

**两个接缝**（同时也是真实能力）：`CreateAgentOptions.streamFn` 换传输层；`TuiAppOptions.terminal` 渲染到任意 `Terminal`（远程终端、录制终端）。

### 2.10 离线验证套件

| 命令 | 覆盖 | 成本 |
|---|---|---|
| `npm run typecheck` | tsgo --noEmit，全量类型 | 0 |
| `npm run smoke` | 内核：模块解析、model runtime、profile 工具构建、工具执行、事件翻译、设置 | 0 |
| `npm run check:tui` | TUI：选择器、transcript 边界、编辑器、启动横幅、markdown 渲染、实时工具输出、折叠按键、resize、退出 | 0 |

**`check:tui` 是这套东西里最值钱的部分**，因为它解决了"TUI 没法测"的问题：注入一个实现完整 `Terminal` 接口的**录制终端**，用 pi 的 `fauxProvider()` 驱动一个**真实 agent 回合**（工具调用 → 流式输出 → 最终回答），然后断言到达终端的内容。

它验证了组件测试覆盖不到的东西：pi 事件经归一化层到视图的**完整路由**、实时增量输出、折叠按键的状态机。而且**不需要 TTY、不需要 API key**。

顺带一个免费的强断言：`TuiMainScreen` 在渲染出超宽行时会抛异常，所以"跑完没抛"本身就等于"宽度全部正确"。

**连通性验证技巧**：设一个故意错误的 key，得到 `401: {"message":"Authentication Fails..."}`。这比"无 key 报错"有说服力得多——它证明 provider 注册、model 解析、auth 查找、HTTP 链路全部正常，唯一的问题就是凭据。

---

### 2.11 桌面 GUI（Electron）

内核跑在 **Electron 主进程内**，不是 sidecar 进程，也不是本地 HTTP 服务。

这个选择的原因是内核本来就是 Node/TS，而 Electron 主进程就是 Node 24 —— `createAgent()` 原样调用，**内核一行没改**。Tauri 之类反而更麻烦：后端是 Rust，内核只能当 sidecar 塞进去，等于照样带一个 Node 运行时，还多一层跨语言 IPC。

渲染进程与内核之间只有一条窄通道：

```
AgentSession.subscribe(AgentEvent)  →  webContents.send  →  preload contextBridge  →  渲染进程
```

安全边界按 Electron 的推荐默认值收紧：`contextIsolation: true`、`nodeIntegration: false`、preload 只暴露几个具名函数而不是整个 `ipcRenderer`。preload 编译成 CJS —— Electron 只在关闭 sandbox 时才加载 ESM preload，而关 sandbox 是实打实的安全降级。

**一次只存在一个会话。** 切换模式会把旧会话拆掉，而不是同时跑两个：模式决定了系统提示和工具集，同时跑两个意味着这段对话不再描述同一个 agent。

工作目录默认取用户主目录，而不是 `process.cwd()`。打包后的应用从开始菜单启动，进程目录是 shell 恰好所在的位置，对一个要读写文件的工具来说那不是个有意义的答案。更好的做法是给一个目录选择器；在它出现之前，一个可预测的目录好过一个随机的目录。

### 2.12 可分发构建与安装包

开发态那套"源码直连"（`tsconfig.pi-paths.json` + tsx）**发不出去**：用户机器上没有 pi 的 checkout，也没有 tsx。所以必须引入真构建。

`scripts/build.mjs` 用 esbuild 产出三个文件，**全部是 CommonJS**：

| 产物 | 说明 |
|---|---|
| `dist/main.cjs` | 主进程，pi 内核内联其中 |
| `dist/preload.cjs` | contextBridge |
| `dist/cli.cjs` | 保留无头入口，便于不开窗口就验证 bundle |

为什么统一用 CJS 而不是 ESM —— 这是踩出来的，不是偏好：

Electron 把 `electron` 模块当作 CJS 交给 ESM 加载器，命名导出靠静态分析合成。**在 bundle 里这个合成不可靠**：`import { BrowserWindow } from "electron"` 会在链接期直接抛 `does not provide an export named 'BrowserWindow'`，而且**成不成功取决于 bundle 里还有什么别的东西**。换成默认导入也没救，它解析出来的对象上没有 `app`。`require("electron")` 完全不涉及互操作，永远可用。

（preload 本来就必须 CJS：Electron 只在 sandbox 关闭时才加载 ESM preload，而关 sandbox 是实打实的安全降级。）

CommonJS 唯一缺的是 `import.meta`，而本项目（`src/paths.ts`）和 pi（`config.ts`、`native-platform.ts`）都在模块顶层调 `fileURLToPath(import.meta.url)`。esbuild 默认会把它编译成 `undefined`，模块一加载就抛，所以用 `define` + banner 把它还原成真实的文件 URL：

```js
define: { "import.meta.url": "__importMetaUrl" }
banner: { js: 'const __importMetaUrl = require("node:url").pathToFileURL(__filename).href;' }
```

**这个 banner 只给 Node 侧的入口用，preload 不能加。** preload 跑在沙箱化的渲染进程里，那里的 `require` 是受限的 shim，加载不到 `node:url`，banner 会在第一行就抛——结果是 preload 静默不执行、`window.gdou` 是 undefined，而且**任何地方都不报错**。

实测：713 ms 出全部产物，`dist/main.cjs` 5.4 MB，`dist/cli.cjs` 5.6 MB，**零警告**。5.6 MB 里大部分是 provider SDK（openai、bedrock 全部内联），内核自身占比很小。

`electron-builder.yml` 负责出 NSIS 安装包。因为没有运行时依赖（全被 esbuild 内联了），`files` 只需要 `dist/**/*` 和 `package.json`，asar 里最终就 6 个文件。

安装包体积：**118 MB**（含随包的 ripgrep 与 fd），解包后 403 MB。绝大多数是 Chromium 和 Electron 运行时，内核那 5.4 MB 可以忽略。

### 2.13 工具链目录与状态隔离

coding 模式的 `grep` / `find` 自己不做搜索，它们调用 ripgrep 和 fd，由 pi **在首次使用时下载**。下载位置由 pi 的包元数据决定，跟本项目设了什么无关——默认会落到 `~/.pi/agent/bin`，也就是 **pi 自己的目录**。

这跟本项目"状态隔离"的设计直接矛盾，而且**不会报任何错**，只是文件出现在不该出现的地方。修法是 pi 支持的 `piConfig` 字段：

```json
"piConfig": { "name": "gdou", "configDir": ".gdou-agent" }
```

pi 通过从模块位置往上找 `package.json` 来读取这个字段。bundle 在 `dist/` 下，往上正好命中本项目的 package.json，于是 `getBinDir()` 变成 `~/.gdou-agent/agent/bin`。

开发态（tsx）没有这么幸运：pi 的源码在自己的 checkout 里，往上找到的是 pi 的 package.json，所以会退回 `~/.pi/agent/bin`。用官方的 `PI_PACKAGE_DIR` 覆盖可以统一两边，但它必须在 pi 的 config 模块被求值**之前**设置——所以走 `node --import ./scripts/pi-env.mjs` 预加载，而不是依赖 import 顺序。

`--doctor` 会把 `tool bin dir` 和 rg/fd 是否就位一起打出来，`check:gui` 则断言这个目录必须落在自己的 home 下——因为这类问题只会静默发生，必须有东西守着。

### 2.14 随包分发 rg / fd，让 coding 模式离线可用

目录隔离解决了"放错地方"，但没解决"根本没有"。pi 是**首次使用时下载** rg 和 fd 的，所以一台没有外网的机器上，`grep` 和 `find` 会静默失效——用户看到的是"搜不出东西"，不是报错。

修法是随包分发。`getToolPath()` 会**先查 `TOOLS_DIR`**，找到就直接用、根本不下载，所以只要把二进制放进 pi 会找的位置，联网这一步就彻底不需要了。

`scripts/fetch-tools.mjs` 按固定版本下载并校验：

| 工具 | 版本 | 许可 |
|---|---|---|
| ripgrep | 15.0.0 | MIT / Unlicense |
| fd | 10.5.0 | MIT / Apache-2.0 |

版本号集中钉在脚本里，所以构建可复现、每个随包二进制来源可追溯。脚本幂等：已存在且版本匹配就跳过，所以 `npm run package` 可以无脑带上它。

下载优先走 `curl`：Node 内置的 fetch **不读 `HTTP(S)_PROXY`**，在必须走代理才能访问 GitHub 的环境里只会给一个不说明原因的 `fetch failed`。curl 认这些变量，且 Windows 10 1803+ 自带。

环境完全访问不到 GitHub 时，可以用 `GDOU_TOOLS_SOURCE` 指向一个已经有这些二进制的目录（比如某个 pi 安装已经下好的 `bin/`）。版本仍然会被校验，所以这条路不会悄悄混进不同版本。

二进制经 `extraResources` 放在 **asar 外面**（`resources/bin`）——它们要被执行，而 spawn 出来的进程无法运行归档里的文件。应用启动时 `provisionManagedBinaries()` 把它们复制进 `getBinDir()`，已存在则不覆盖（如果 pi 自己下过更新的，那个赢）。

这一步是尽力而为：失败只降级回"联网下载"，不会阻止应用启动。

### 2.15 对话界面

`renderer/` 是真正的对话界面：模式选择、消息流、流式助手文本、可折叠的工具调用、错误块、状态行、输入框（Enter 发送 / Shift+Enter 换行）、中止按钮。原先那块诊断面板收进了一个默认隐藏的开关里。

**刻意保持零构建。** 它是一个没有 import 的经典脚本，所以能从 `file://` 直接加载——**ES module 的 import 在 `file://` 下不工作**（Chromium 会拦），这就是它没有被拆成模块的原因。等它长出需要单独测试的组件时再引入打包器。

助手文本在流式过程中按纯文本显示，消息结束后再整体渲染成 markdown。逐字增量渲染 markdown 意味着每来一个 delta 都要重新解析一个可能只写了一半的代码围栏，换不来任何可见的收益。

markdown 只实现实际高频出现的那一小撮：围栏代码块、行内代码、加粗。代码块在任何行内规则之前就被切出来，所以没有东西会改写它的内容；它们作为段落的兄弟节点输出，而不是嵌在段落里面。

工具块默认折叠——长输出不应该把对话挤走，展开是主动动作。

### 2.16 脚本化运行：没有凭据也能跑一轮

GUI 没有模型就什么都做不了，而拿到模型通常要 API key。这留下两个缺口：想先看看界面的人看不到；而 UI 里**只在运行期间存在**的那些部分——文本流式进入、工具调用出现并填入输出——恰恰是最容易静默坏掉的部分，因为没人会不花 token 去走一遍。

`GDOU_SCRIPTED_RUN=1` 用 pi-ai 的 `fauxProvider` 回放一段固定脚本，不调用任何 provider。**完全不涉及凭据**：`createAgent` 接受显式的 model spec，而显式 spec 只用于解析元数据，所以"缺少凭据"那条分支根本不会走到。

脚本会按当前模式实际暴露的工具来挑选调用目标（`current_time` 或 `ls`），因此不会去调用一个不存在的工具。

这既是给用户看的预览模式，也是 GUI 自检的驱动方式——`check:gui` 的对话流程断言全部跑在它上面，不需要 key、不需要网络。

**界面上的入口。** 只有环境变量是不够的：从开始菜单启动的用户够不着它，而一台没有凭据的机器上**什么都启动不了**——界面直接报错，看起来像应用坏了，而不是像还没配置。所以会话启动失败时，错误下面会出现一个「用脚本化运行预览（不需要 API key）」按钮。

三个实现上的判断：

- **预览从空白开始**，不恢复最近的真实对话。否则脚本回复会接在一段用户真的写过的记录后面——等于在真实历史里混进假回复。
- **预览不落盘。** 它是演示，不是对话；写进去会和真实工作并排放在历史里，且无法分辨。
- **「不落盘」只针对显式预览，不针对环境变量。** 我第一版把两者混为一谈，结果把环境变量驱动的运行也挡掉了——而那是自检用来验证持久化的方式。两者的区别是真实的：环境变量是开发者开关，按钮是面向用户的演示。

### 2.17 会话持久化与多会话

关掉窗口不再等于丢掉对话，开一个新话题也不再冲掉上一段。一段对话一个文件，存在 `~/.gdou-agent/sessions/<id>.json`。

**一段对话一个文件，而不是每个模式一份滚动会话。** 早先的版本是后者，结果是"新对话"会覆盖上一段——这正是要修掉的痛点。现在列表里能看到全部，随时切回去。

模式仍然是恢复时的约束：一段 coding 对话在 general 模式下打开会被拒绝，因为模式决定系统提示和工具集，恢复出来会是一段这个 agent 从未产出过的记录。

**文件是两行 JSON**：

```
{"id":...,"profile":...,"title":...,"updatedAt":...,"messageCount":...}
{"version":1,...,"messages":[...]}
```

第一行是摘要。列会话表只读这一行，所以列出很长的对话不等于把每段对话整个读进来——一段工具输出里带着文件内容的记录可以到几 MB，而列表是随手点开的。第二行才是记录本体。

标题取自**第一条用户消息**。比时间戳有用得多，而且不需要额外记账——那句话本来就在记录里。

写入沿用 `settings.ts` 的临时文件 + rename，所以中断的写入不会在下次启动时变成一个解析不了的半截文件。文件带 `version` 字段；版本不符或内容损坏时**移到一边（`.corrupt`）而不是删掉**——损坏的记录本身已经不可用，但它是用户写过的东西的唯一副本。

启动时会**迁移**旧布局（`sessions/<profile>.json`）：读出来按新格式写回去并删掉旧的。不做的话，早期版本存的对话文件还在，但没有任何东西会列出它——等于凭空消失。

恢复的关键设计是**把历史转成事件，而不是把原始消息丢给渲染层**：

```
存储的 messages  →  replay()  →  AgentEvent[]  →  渲染层
```

这样渲染层对"实时运行"和"恢复历史"只有一条代码路径，两者不会随着界面演进而漂移。代价是词表里多了一个 `user_message` 事件——实时运行不发它（前端自己加气泡，这样即使运行根本没启动，用户的消息也还在），只有回放会发。

`CreateAgentOptions` 因此多了一个 `messages` 选项，透传到 pi `Agent` 的 `initialState.messages`。pi 本身已经支持从消息恢复，只是没有暴露出来。

**启动时打开最近的一段**，而不是开一个空白页把用户的工作藏在一键之外。真正新建是单独的动作。

**可以改名。** 历史菜单每行有个「改名」，点击把标题换成输入框，Enter 提交、Escape 取消、失焦也提交。

三个判断：

- **改名要重写整个文件。** 标题同时存在摘要行和记录行里（摘要行是为了列列表不必读全文），所以改一个名字要连几 MB 的消息一起写回去。这是两行布局的代价，不是疏忽。
- **空标题被拒绝，而不是应用。** 清空会留下一行没东西可点的记录，而且派生标题再也拿不回来了。
- **改名不动对话本身。** 只换标签，消息一条不少——`smoke` 和 `check:gui` 都断言了这一点。

**已知限制**：两个实例同时运行会写各自的文件，同一个会话被两边同时打开时后写的赢。没有做锁。

### 2.18 工作目录选择

工作目录决定 agent 在哪里读写文件，所以默认值很关键。**不用 `process.cwd()`**：打包后的应用从开始菜单启动，进程目录是 shell 恰好所在的位置，对一个要读写文件的工具来说那不是个有意义的答案。默认取用户主目录——一个可预测的目录好过一个随机的目录——用户选过之后以选择为准（存在 `settings.json` 的 `cwd`）。

界面在状态行右侧放一个显示当前目录的按钮，点击打开系统目录对话框。

**对话框和"采纳"是分开的两步**，这是刻意的：

```
agent:pickDirectory  →  只开对话框，返回路径或 null
agent:setCwd(path)   →  校验目录、写入 settings、重建会话
```

系统对话框是模态的，没有任何自动化手段能关掉它。把它隔离成"只报告一个路径"，剩下真正要紧的部分——校验、持久化、重建会话、重绘界面——就可以被自检直接驱动。

**界面靠广播同步，而不是靠调用方记得重绘。** 会话可以从好几个地方被替换（启动、清空、换目录），所以主进程在任何会话变化后都会广播 `agent:session`，渲染层统一在那一处重绘。否则就得指望每个调用点都记得自己刷新，迟早会漏。

选到不是目录的路径会被拒绝，并且**保持原目录不变**。

### 2.19 上下文裁剪

我最初把这件事记成"长会话的体积控制"，查下去发现**判断错了**：真正的约束不是文件大小，而是**模型上下文**。每轮请求都会把整段消息列表发给模型，所以一段长会话的结局不是"文件很大"，而是 provider 报上下文超限。文件大只是症状。

pi 的简单 `Agent` 不做压缩。但它留了 `transformContext`，**文档注释里点名了用途就是「context window management (pruning old messages)」**，而且 `agent-loop.ts` 里它作用在一个局部变量上——`state.messages` 不受影响。这个切分正是关键：

```
state.messages      →  完整记录（界面显示、落盘）—— 不动
transformContext    →  只改发给模型的那一份 —— 裁剪在这里
```

所以**你能往上翻的对话始终是完整的**，而模型被要求考虑的部分有上界。

裁剪规则（`pruneForContext`）：

- 保留开头的 system 消息。它带着提示词和工具声明，丢了模型就没有指令了。
- 裁点**只能落在用户消息之前**。这是唯一安全的位置——落在别处会出现没有对应调用的 `toolResult`，provider 会直接判为畸形对话。
- 没有安全裁点时**退回到最后一个轮次的起点**，而不是放弃裁剪。这一条是踩出来的：最初的实现直接原样返回，结果预算较小时裁点会落在最后一轮**内部**，于是裁剪**非单调**——它会自己开关，让提示和指示器互相矛盾（提示说"只看到 2 条"，指示器说"都看得到"）。退回到最后轮次会超出预算，但那仍是一段合法的对话，总好过把一个必然被拒的超长请求发出去。
- 只有一个轮次时无法裁剪，原样返回——去掉那条用户消息会让它后面的工具结果全部失去归属。`transformContext` 的契约也写明"不得抛出或拒绝"。
- 预算按序列化后的字符数算，1 MB。刻意远低于任何目标模型的上下文窗口：目标是永不撞墙，不是把窗口塞满。
- 从后往前累加，一超预算就停，所以开销正比于保留的部分，而不是整个会话的长度。

**代价要说明白**：模型是真的忘了。旧轮次不是被摘要，而是从它的视野里消失。所以屏幕上的记录和模型的工作集不是一回事。这一点写在 `--doctor` 的输出里（`context cap`），也写在这里，而不是留给用户自己发现。

`smoke` 有 9 条断言钉住这些不变量：保留 system、裁掉旧轮、裁点落在用户消息前、**没有孤立的 toolResult**、**每个保留的工具调用都还带着它的结果**、预算内不动、空列表不炸、输入不被修改、无法安全裁剪时原样返回。

### 2.20 裁剪发生时告知用户

裁剪在构造上是**不可见**的：模型只是不再被展示旧轮次，唯一的症状是它悄悄忘事。所以提示是功能的一部分，不是锦上添花。

难点在于 `transformContext` **跑在 agent 循环内部，发不出事件**。但它是我们自己的闭包，而 `listeners` 就在同一个作用域里——所以它通过会话本身用的那个监听器集合上报。

事件词表因此多了 `notice`：

```
| { type: "notice"; message: string }
```

它和 `error` 是两回事，所以**视觉上也必须不同**：中性的表面色、左侧一道安静的竖线、次要文字色。标成红色会让人学会忽略它。

**只在跨越的那一次发，不是每轮都发。** 第一次之后每轮重复只会变成噪音；重点是解释"模型从这一刻起开始忘事"，不是持续计分。

`notice` 是**实时信号**，`replay()` 不产出它——它描述的是此刻正在发生的事，不是过去发生过的事。重启后如果对话仍然超预算，下一次请求会重新发出，所以它会自愈。

`GDOU_CONTEXT_BUDGET` 可以覆盖预算（字符数）。这既是让自检能驱动裁剪路径的开关，也是个真实旋钮——用上下文窗口小的模型的人可能想把上限压得更低。

**没做的**：`notice` 只在当轮出现，滚动上去就没了——所以另有一个常驻指示器，见下节。

### 2.21 常驻的上下文指示器

状态行在**裁剪真正生效时**追加一段：

```
general · deepseek/deepseek-flash · 3 个工具 · 模型可见 2/6 条
```

**只在 `visible < total` 时出现。** 一个常驻的徽标会变成家具，而家具不会被阅读——所以它在没话说的时候完全不出现。

**报的是「上一次请求模型实际看到了什么」，不是「下一次会发什么」。** 这是本轮最花时间的一个决定。前瞻计算看起来更自然（`pruneForContext` 是纯函数，随时可算），但它会**和刚显示的提示自相矛盾**：裁剪在预算过小时会切换状态，于是提示说"只看到 2 条"、指示器说"都看得到"。记录实际值就稳定了，代价是首次请求前没有数字可报——那时确实什么都还没发出去。

`ContextStatus` 从会话方法 `contextStatus()` 暴露，`run_end` 之后通过 `context_status` 事件推给界面。它不进对话记录——它是状态行，不是消息。

**没做的**：没有图表、没有 token 估算、没有"距离上限还有多远"的预警。

### 2.22 pi 能力接线补全

一次针对"pi 给的东西我们到底用上了多少"的审计，查出**四处接线缺口**。都是"看起来接上了、实际没生效"的类型。

**一、`settings.json` 的两个字段从来没生效过。**
`thinkingLevel` 和 `toolExecution` 被读取、被校验、有默认值——但 `resolveSetup` 只读
`options.thinkingLevel ?? profile.thinkingLevel ?? "off"`，settings 那一路根本不在链上。
用户在设置里写 `"thinkingLevel": "high"`，什么都不会发生。

修法不只是"把 settings 加进链上"，还要**决定顺序**：`显式选项 → 设置 → 模式建议 → 默认`。
如果把设置排在模式后面，`general` 模式建议 `"off"` 就会一直压住用户的设置——等于换个地方继续不生效。
另外 `thinkingLevel` 的类型从 `string` 收紧成 pi 的 `ThinkingLevel` 联合，并在加载时校验，
未知值被丢弃而不是透传给模型层。

**二、pi 默认不重试，我们也没开。**
`retryProviderRequest` 的默认是 `maxRetries ?? 0`，而且每个 API 调用点都显式写了 SDK 的
`maxRetries: 0`——也就是说 pi 把两层的重试都关了。而 `AgentOptions` **没有 `maxRetries` 字段**
（只有 `maxRetryDelayMs`），所以想开也没地方开。

修法是在 `streamFn` 这个我们本来就持有的接缝上注入。默认 2 次：够躲过一次限流抖动，
又不至于让一个真的坏掉的请求拖上几分钟。`defaultStreamFn` 特意导出，因为**这个失败是静默的**，
"选项被接受了"不等于"它到达了 provider"，所以要能断言。

**三、没传 `sessionId`，少了缓存会话亲和。**
pi 用它给支持缓存路由的 provider 做亲和（`cacheSessionId`），不传则每次请求都是冷缓存。
现在把会话 id 传下去了。

**四、`thinkingBudgets` 没透传。** 按思考等级给 token 预算的能力，之前完全够不着。现在是一个可选项。

**顺带确认了缓存本身是自动生效的**：pi-ai 的 `resolveCacheRetention` 默认 `"short"`，
Anthropic 走 `cache_control` 标记、OpenAI 兼容走 `prompt_cache_retention`，
`PI_CACHE_RETENTION=long` 可升级。这部分不需要我们做任何事。

### 2.23 组合模型与专家

**先说结论：专家不是"另一种模式"。** 模式决定 agent **能**做什么（工具集、基础提示），专家决定它**该怎么想**（方法论）。这两件事正交，可以同时生效——同一段对话可以是「coding 模式 + 安全审计专家」。

正因为正交，才值得有新名字。如果专家和模式不能叠加，那专家就只是模式的别名，不该另起一个概念。反过来，这也决定了实现方式：**会话不是"绑一个模式"，而是按配方装配**。

```ts
interface SessionRecipe { mode: string; expert?: string }   // 只有 id，所以可存储
```

配方只存 id 不存对象，是为了可序列化——这样它能存在会话里、显示在界面上，将来也能被自动化直接复用（自动化就是「一个存下来的配方 + 一个提示词 + 一个触发时机」）。

**装配规则**：工具集 = 模式的工具 **∩** 专家的允许集；提示词 = 模式的系统提示 + 专家的方法论。专家排在提示词最后，读起来就是"上面是一般要求，这一条是具体方法"。

#### 专家只能做减法，这是安全属性不是风格偏好

专家是**用户自己写的 markdown 文件**。如果它能往工具集里**加**东西，那"装一个专家"就等于"装一个后门"——一个第三方专家包可以把 `general` 模式的文件访问打开。只允许交集、禁止并集，意味着最坏情况是 agent 变笨，不会变危险。

这条和自动化的 `allowWrite` 默认 false 是同一条原则的两次应用：**默认收紧，放开要主动。**

`narrowTools()` 因此是个纯函数，不依赖 agent，可以直接断言：

```
coding（7 个工具）+ security-audit（要 read/grep/find/ls）→ 4 个
general（3 个工具）+ security-audit（要 read/grep/find/ls）→ 0 个，且列出 4 个"模式没有"
```

**空交集是合法的，而且必须说出来。** 一个为 coding 写的专家用在 general 上会得到 0 个工具——行为完全正确，但表现是"agent 突然不用工具了"，看起来像专家坏了。所以 `AgentSession.unavailableTools` 把这个事实暴露出来，CLI 打印、GUI 在状态行下方显示、`--list-tools` 也列。

**这里有个时机上的坑**：最初想用现成的 `notice` 事件来报这件事，但 `notice` 是**运行期**事件，而"工具被收窄"在**构造期**就已知；更要命的是所有前端都是 `createAgent()` 返回**之后**才 `subscribe()`，构造期发的事件谁也收不到。所以它被做成会话元数据而不是事件——它本来就是会话的属性，就该按属性报。

#### 三级加载，内置的也走同一套格式

```
内置（builtin.ts）           ← 随包提供，用户说"给几个简单的"
~/.gdou-agent/experts/<id>.md     ← 用户级
<cwd>/.gdou-agent/experts/<id>.md ← 项目级，优先
```

项目级压用户级：团队可以把定义和它描述的代码一起放进仓库，不会被个人 home 目录里的同名文件盖掉。

**内置专家存成 markdown 原文，用同一个 `parseFrontmatter` 解析。** 另一种做法是写成 TypeScript 对象，但那会让内置和文件格式各自漂移——而用户实际写的是文件。现在解析器坏了内置也会坏，这正是重点。

**frontmatter 用真正的 YAML 库（`yaml`，本来就是本项目的依赖）而不是手写 `key: value` 切分。** 这个子集看着简单，实际不是：描述里带冒号、带引号、多行块、值是列表。写错的失败方向很糟——字段**静默保留错值**而不是报错。

#### 三个不明显的地方

- **「无专家」必须是 `null`，不能是 `undefined`。** `recipe.expert` 省略时回落 `settings.expert`，如果用户设了默认专家，界面上选「无专家」会**静默把默认专家装回来**。所以三态是刻意的：`"id"` / `null`（明确不要）/ 省略（你决定）。
- **未知专家 id 立刻报错**，并列出有哪些。typo 变成"专家静默没生效"是最难查的一类问题。
- **`thinkingLevel` 的优先级**：`显式选项 → 设置 → 专家 → 模式 → 默认`。专家排在模式之上（它更具体），但排在用户设置之下——用户自己的选择高于文件。

#### 顺带修掉的一个真实 bug（见 4.10）

`npm run build && npm run check:gui` 在加专家之前就 3/3 必挂，根因是宿主环境导出的 `ELECTRON_RUN_AS_NODE`。是加 GUI 断言时才查清的。

#### 验证

`smoke` 新增 **37 条**断言（总数 52 → 89）：解析、收窄、**不能扩大**、空交集、提示词拼接、装配结果、优先级、未知 id、以及项目级文件的发现/覆盖/报错/非 markdown 忽略（跑在临时目录上，不碰用户真实数据）。`check:gui` 新增 **12 条**（总数 109 → 121），真的切换下拉、断言状态行与工具数变化、断言警告出现与消失。`check:tui` 断言状态行显示专家。

### 2.24 工作台外壳

**为什么是"重做"而不是"加个侧栏"**：原来的界面是一个单列对话页，所有东西挤在一列里——模式选择、工作目录、历史、诊断。功能都在，但没有地方安放"专家 / 自动化 / Skills"这三件正交的事，也没有地方显示"这个会话实际能用哪些工具"。外壳先立起来，功能才有位置。

**设计语言**：冷灰中性的配色与统一的字号/间距/圆角/动效 token，全部收敛成 CSS 变量，所以深浅两套主题共用一套排版。外壳是 `grid-template: 52px minmax(0,1fr) / 240px minmax(0,1fr)`——标题栏横跨两列，侧栏可以收到 0 宽而主区不动。

```
标题栏   窗口标记 · 汉堡 · 文件/视图/帮助 · 拖拽区 · 最小化/最大化/关闭
侧栏     模式切换（General/Coding）· 主导航（对话/专家/自动化/Skills）· 对话记录 · 底部状态
主区     工作头（工作目录 + 模式/专家选择 + 新对话/历史）
         时间线（735px 居中）  ·  检查器（可拖拽宽度）
         输入框（17px 圆角，工具栏 + 模型状态 + 发送/中止）
```

**窗口改成无边框**，标题栏是自己画的。这是"看起来一样"的关键部分，也意味着最小化/最大化/关闭必须走 IPC——没有系统标题栏可以兜底。最大化状态由主进程广播（用户双击拖拽区或走系统菜单时渲染进程看不到），渲染进程只能被告诉，不能自己推断。

**检查器**显示三组：本次会话（模式/专家/模型/工具数/工作目录）、上下文（条 + 精确字符数）、**实际可用的工具名**。最后一组是重点——专家能收窄工具集，而"工具不见了"和"专家没生效"从外面看是一模一样的，只有把真实集合列出来才能分辨。

**专家页**把专家做成卡片：标签、id、描述、声明了几个工具、thinking 等级，点一下就带着它开新会话。加载失败的文件也列成卡片——否则一个格式写错的专家和"从没写过"完全无法区分。

**自动化页和 Skills 页是诚实的待做页**，不是空白页：它们说明这个功能会怎么做、以及已经定下的约束（运行时触发、产出单独一个概念、`allowWrite` 默认关；skills 只允许说明和资源）。一个空白页读起来像坏了，一段说明读起来像还没做——后者才是真的。

**深浅两套主题**：`[data-app-theme]` 在 `<html>` 上，首次启动跟随系统，手动切换后记在 localStorage。浅色是默认；深色是一套真正的主题（自己的 surface/border），不是把颜色反过来。

#### 两个不明显的地方

- **DOM 契约是承重的。** `check:gui` 从外部驱动这个窗口，断言写死在 `.msg-user .body`、`.tool-name`、`.tool-state`、`.tool.open`、`.menu-row`、`#cwd` 这些名字上。重做界面时全部保留——**改一个名字会让一条断言静默变成空操作**，比断言失败更糟。`#cwd` 尤其：图标被特意放在按钮**外面**，因为按钮的 `textContent` 必须正好是那个目录路径（断言用的是 `.endsWith("work")`），图标会贡献空白文本节点。
- **CSS 自定义属性名写错不会报错。** `--inspector-w` 和 `--inspector-width` 差一个词，结果是 `grid-template-columns` 在计算值阶段失效、回退成单列——整个右侧检查器掉到下面去了，而控制台一声不响。这一类错误只能靠量元素尺寸发现，所以 `tokens.css` 里那段注释写明了原因。

#### 验证

`check:gui` 从 **121 加到 146**，新增 25 条外壳断言：窗口按钮与拖拽区存在、导航四项、模式切换反映当前模式、侧栏列出会话、汉堡收起侧栏、检查器列出真实工具、上下文条在请求后出现、主题切换生效且落盘、**切换视图真的隐藏对话**、专家卡片渲染、自动化/Skills 页可到达且写明"还没做"。界面截图存在 `docs/screenshots/`。

---

### 2.26 权限门与命令检查器

**起点是一个必须说清楚的事实：pi 没有任何路径约束。** 它的 `resolvePath` 对绝对路径
直接放行，工具目录里搜不到越界检查，README 自己也写着 "does not include a built-in
permission system"。我们 vendoring 了同一份源码，所以**继承同一个前提**——
模型给出绝对路径就能写到硬盘任意位置，包括覆盖 `auth.json` 里的 API Key。

而 `coding` 模式暴露了 `bash`。**这不是「将来可能出问题」，是当时就有口子。**

#### 两条设计判断

**主轴是路径归属，不是工具种类。** 按工具名判会两头错：同一个 `write` 写工作区内是
日常操作，写 `~/.ssh` 不是。工具名是输入，**解析后的路径才是问题**。

**判定链有序，靠后的阶段不能放行靠前已拒的。** 这是让链条可审计的性质：
stage 1 可以单独读、单独断言，且无论策略是什么都成立。所以
`danger-full-access` 档位下读 `~/.ssh/id_rsa` 仍然被拒——档位在 stage 4 才被查询，
而凭据在 stage 1 已经返回了。

| 阶段 | 判定 | 理由 |
| --- | --- | --- |
| 1 凭据 | **禁读也禁写，任何档位不能越过** | 泄露即账号级损失，不该由一次弹窗决定 |
| 1 程序配置 | `settings.json` 禁写 | 工具不该改程序自己的配置 |
| 2 无路径无命令 | 放行 | **见下面的坑** |
| 3 命令 | 命中检查器 → 拒绝；只读档位 → 拒绝 | 一条命令就能绕开上面所有路径保护 |
| 4 路径 | 工作区内放行；区外询问；`danger-full-access` 放行 | 读侧漫游是写越界的必经入口 |
| 5 审批策略 | `never` 把「询问」转成**拒绝** | 无人值守时「不问」必须等于「不做」 |

#### 踩到的坑：按名字分类会把功能弄坏

第一版用一个工具名白名单，未登记的走 `ask`——而**没有审批通道时 `ask` 等于拒绝**。
后果是 **TUI 自检里一个只收 `count` 的探针工具被直接拒掉**，`check:tui` 挂了 10 条断言。
再往下想一层：agent 自己的工具、任何模式以后新增的工具，都会同样被拒。

**错在把「未知」等同于「危险」。** 这道闸保护的面是**路径**和**命令**；
两者都不带的调用**没有面可保护**，拒绝它保护不了任何东西，只是把功能弄坏。
改成按**参数形状**分类（有 `command` → 命令；有 `path` → 路径；都没有 → 放行）之后，
未识别但带 `path` 的工具**仍然**会被检查，并按写入处理。

这一条值得单独记：**fail-safe 的方向要选对——「不确定就拒绝」在这里是错的，
因为「不确定」的多数情况是「没有可保护的面」。**

#### 命令检查器是黑名单，不是沙箱

`command-guard.ts` 的五类规则选得很窄，判据只有一条：
**这条命令是否绕过了路径检查？** 不是「一般意义上是否危险」。

- 凭据访问（`cat ~/.ssh/id_rsa`）—— 有联网工具后就是数据外带路径
- 编码执行（`-EncodedCommand` / `FromBase64String`）—— 载荷无法审查
- 下载即执行（`curl … | bash`）—— 拿到的是不可读的代码
- 反弹 shell、破坏性命令（`format` / `mkfs`）
- 工作目录外的递归删除 —— 不可逆

**它提高门槛，不建立边界。** 一个坚决的模型能写出不匹配任何模式的等价形式，
混淆是无限的。真正的解法是 OS 级（受限令牌 + Job Object），那是另一个量级的工程。
文档里如实标注了这一点，没有把它说成沙箱。

#### 一个被断言抓出来的真 bug

`rm -rf /` **没有被拦下**。原因是我先剥尾部分隔符再判目标：
`"/"` 剥成空串，然后被当成「没给目标」跳过。
——最需要被这条规则拦住的命令，正好从缝里漏过去。

修法是**先判根形态、再剥分隔符**。这类 bug 只有断言能发现：
手工试几条命令时，`rm -rf /` 看起来「应该会被拦」，不会去试。

#### 验证

- `smoke` **129 条**（新增 40 条权限断言），逐档位断言「凭据拒绝在所有档位成立」、
  `never` 覆盖审批通道、未识别工具带路径仍被检查
- 误报与漏报同等重要：`npm test` / `rm -rf node_modules` / `rm -rf <工作区内>`
  / `git status` 都必须放行——**一个会拦日常操作的检查器会被关掉，然后就什么都不保护了**
- **真实模型实测**（DeepSeek，2026-09-23）：
  - `-> read {"path":"C:/Users/Na1aB/.ssh/id_rsa"}` → `<- error read`，模型如实报告被拒
  - `-> bash {"command":"cat ~/.ssh/id_rsa | base64"}` → `<- error bash`（`credential-access`），
    模型明确表示不会尝试绕过
  - `-> ls {"path":"."}` → `<- ok ls`，正常工作不受影响

---

### 2.27 产物交付（present_files）

**没有它，agent 做出来的东西只是文件系统里的一个文件。** 模型说"我写好了 report.html"，
用户还得自己去找。这个工具是**显式交付**动作——把路径变成界面能显示的东西，
也让"agent 给我做了个东西"从一个说法变成一件可点击的事。

#### 三条不猜的规则

1. **必须是绝对路径。** 相对路径会按"当前目录"解析，而猜错就会**把另一个文件当成交付物**。
   整体失败好过交付一个相邻的东西。
2. **文件必须存在。** 一张指向不存在文件的卡片是个谎，用户点开才发现。
3. **目录拒绝。** 这个工具交付的是文件；静默展开一个目录会生成用户没要的卡片。

而且**全有或全无**：任一条目有问题就整单失败。部分交付读起来像成功，
用户却少了当初承诺的一部分。

#### 一个必须堵的洞：交付即读取

`present_files` 收的是**数组**（`items: string[]`），所以按参数形状分类时它
**看起来是个不带 path 的调用**，会被直接放行。

那会是真洞而不是技术细节：**交付面板要读取文件才能生成预览**。
放行它等于给模型一条读取凭据的路径——「把 `~/.ssh/id_rsa` 交付给我」，
然后预览就把它读出来了。

所以判定链加了 **stage 1a**：识别 `items` 数组并逐个过凭据检查。
这里**只查凭据**，不查"是否在工作目录内"——交付不改变文件系统，
那些文件本来就是在当时的策略下写出来的。

#### 预览通道的两道限制

渲染进程没有文件系统访问，所以预览要靠一条 IPC 通道读文件。这条通道有两道限制：

- **只放行本会话经 `present_files` 交付过的路径。** 主进程维护一个白名单，
  每次会话开始清空。没有它，这条通道就是一个通用的文件读取原语，
  模型可以绕开权限门——直接问 UI 要。
- **2 MB 上限。** 内容整体跨 IPC 并在渲染进程持有，所以这是**窗口存活**限制而不是磁盘限制。

HTML 预览走 `sandbox=""` 的 iframe（全沙箱，禁脚本、禁同源）。
产物是模型写的内容，让它在应用同源里执行脚本等于把渲染进程的权限交给模型——
和 `contextIsolation` 是同一个推理，只是低了一层。

#### 验证

- `smoke` 新增 **16 条**：三条拒绝路径各断言、全有或全无、凭据交付在**最松档位**也被拒、
  一个凭据混在多个条目里仍然整单拒绝
- `check:gui` **146 → 154**：卡片渲染、检查器列出、**点击真的打开预览**、
  以及**预览通道拒绝未交付的路径**（这条是那个洞的回归守卫）
- 截图见 `docs/screenshots/artifacts.png`

---

### 2.28 联网（web_fetch / web_search）

**这是第一个能让模型发出的字符串变成「从本进程发出的请求」的工具**，所以重点不在抓取，
在**这条请求打到哪儿**。

#### 抽取用现成的

`@mozilla/readability`——Firefox 阅读模式那份代码——跑在 `linkedom` 的 DOM 上。
自己写"剥标签"会得到一堵导航栏和页脚的墙，那正是让抓取工具变得没用的失败形态。

**不执行 JavaScript**：页面按静态 HTML 解析，纯前端渲染的页面会返回空，
工具**明说这一点**而不是给模型一个空字符串让它自己猜。

#### SSRF 防护：判据是「用户可能想访问的主机吗」

请求从本机发出，所以 `http://127.0.0.1:9222/json` 或 `http://169.254.169.254/...`
能打到**只有本机可达**的服务，而回复会直接进对话。拦的是回环、私网、链路本地
（云实例元数据就在那儿）、URL 内嵌凭据，以及非 http(s) 协议——`file:` 会绕过权限门直接读本地文件。

**逐跳校验重定向。** `fetch` 的 `redirect: "follow"` 会在内部解完整条链，
而那恰恰是需要检查的部分——一个公网 URL 跳到 `127.0.0.1` 就能走过只看了第一跳的检查。

**DNS rebinding 没有防。** 请求时解析到私网地址的域名能通过字面检查。
堵它需要"先解析再钉住"，也就是自己持有 socket。**这个防护提高门槛，不建立边界**——
和 `command-guard.ts` 同一句实话。

#### 搜索必须有服务商，而且 key 不进 settings.json

没有值得发布的 keyless 方案：抓搜索引擎的 HTML 端点天然脆弱（标记随时会变），
而一个**静默返回空**的工具比一个明说"没配置"的工具更糟。所以支持 Brave / Tavily 两家，
每家只要一个 key。

**key 从环境变量读，不存 `settings.json`**——这是安全决定不是便利决定：
权限门**允许工具读**程序配置（只拦写），所以存在那里的 key 会被模型调用的任何工具读到。
以后要做设置页，得先给它找一个受保护的存储，而不是加一个输入框。

#### 验证

- `smoke` **145 → 172**：SSRF 逐例断言（回环 / localhost / 云元数据 / 三个私网段 /
  IPv6 回环 / `file:` / 内嵌凭据 / 非 http / 畸形 URL / 整数编码的回环）、
  拒绝必须带理由、搜索服务商的解析与"两个都设时谁赢"
- **真实模型实测**：`-> web_fetch {"url":"https://example.com"}` → `<- ok`，摘要正确；
  `-> web_fetch {"url":"http://169.254.169.254/latest/meta-data/"}` → 被拦，
  模型如实报告并说明这是刻意的防护

---

### 2.29 变更追踪（+N −M）

**用户得能看见 agent 对文件做了什么，才敢让它动真文件。** 一行写着
「write · report.md」而别无所言的工具行，是在索取还没挣到的信任。

#### 两个工具不对称，这一点要说明白而不是抹平

- **`edit` 已经自带 diff。** pi 在结果 details 里返回统一 diff，所以计数直接从那来——
  不用额外做事，而且数字描述的**是实际应用的改动**（含模糊匹配），不是模型要求的。
- **`write` 什么都不返回**，而唯一知道它*删掉*了什么的方法，是**手里有改动前的内容**。
  所以在调用前做快照，再和写入的内容比对。

快照正是这件事必须挂在 agent 循环里、而不能放在渲染进程做的原因：
**前端看到结果的时候，旧的字节已经没了。**

快照有 2 MB 上限。超过上限时摘要报**写入行数**并标记为近似，
而不是为了一个没人要的数字把大文件读进内存。

#### 「近似」要显式，不能填 0

无法比对时，徽章显示 `+N 行`（而不是 `+N −0`）并带说明。
**填一个 0 会被读成「什么都没删」——正好是这个标记要警告的反面。**

#### 摘要挂在 `details` 上，不新开事件

通过 pi 的 `afterToolCall` 接缝注入到结果 details 里，和 `present_files` 的
`details.items` 同一个位置。好处是每个前端从**它已经在读的地方**读，
而且 `replay` 免费获得——摘要随消息一起落盘了。

#### 一个被断言抓出来的 off-by-one

`"x\n".split("\n")` 是 2 个元素，但**尾随换行不开启新的一行**，所以是 1 行。
这个错误让文件里每个计数都多 1——而且看起来足够合理，扫一眼是发现不了的。
修法是抽一个 `lineCount()` 两处共用。

#### 验证

- `smoke` **172 → 191**：快照读取 / 新建 vs 覆盖 / 真实增减 / 近似标记 /
  从 pi 的 diff 计数且**不数 `+++` `---` 头** / 非变更工具不产摘要
- **真实模型实测**：`edit` 改 `notes.txt`（beta→BETA + 追加 delta）→ 徽章 `+2 −1`，
  与文件实际内容一致；`--json` 确认摘要进入事件流
- 截图 `docs/screenshots/change-tracking.png`（`read` 行没有徽章，只有变更行有）

**已知缺口**：徽章是渲染层的，`check:gui` 的脚本化运行不做写入，
所以这条渲染路径**只有人工验证**（上面那张截图），没有自动断言。

---

### 2.30 工具分组折叠

**一次多工具调用会把时间线撑得很长**，用户得一直滚才能看到结论。
这是体感差距，不是功能差距——但它决定了界面读起来是「一个回合」还是「一屏日志」。

#### 两个决定都是为了不把事情弄坏

**只在第 2 个连续调用才开始分组。** 一个元素的分组就是「一行工具 + 一个多余的组头」。
让单个调用保持原样，意味着最常见的情况（一轮一个工具）**渲染结果和以前完全一样**——
这同时也让 DOM 契约保持诚实：`check:gui` 点到的第一个 `.tool` 不会藏在折叠的组里。

**分组是事后建的，不是事前预测的。** 第一个调用正常追加；第二个来了才把它包进组里。
**没有任何办法在第一个调用出现时就知道后面还有没有第二个**，
预测意味着要么缓冲第一个、要么事后再重构它。

#### 折叠时机：运行中展开，轮结束才折

在 `run_end` 折，而不是每个调用结束时折——**正在执行的那一批应该一直可见，
因为那正是用户在看的东西**。

#### 组头列工具名，不是只报数量

`present_files · ls` 告诉用户**发生了什么**；`2 个工具` 只告诉他们**有多少行没在看**。

#### 组内是 `display: none`，不是 `remove()`

展开不需要重渲染，而且 `.tool` 元素**始终在文档里**——
任何按选择器查询它们的东西都不会因为折叠而失效。
（这是 2.24 那条教训的同一个形状：**别用 `remove()` 隐藏东西**。）

#### 验证

- `check:gui` **154 → 163**：组确实形成、装了两次调用、轮结束被折叠、
  折叠时 body 高度为 0、组头有名字和计数、**点击能展开且行真的可见**
- 后续的工具断言改成**先展开分组再点**——用户就是这么到达工具行的，
  断言点一个屏幕上不存在的东西不算验证
- 顺带把两处写死的 `toolCount === 1` 改成 `>= 1`：
  要验的是「调用熬过了重启」，具体几个是脚本化运行的事，不是这条断言的
- 脚本化运行从 **1 次调用改成 2 次**——单个调用永远不分组，
  而**一个预览演示不出来的折叠，就是没人看过的折叠**
- 截图 `docs/screenshots/tool-grouping.png`

### 2.31 模式改成数据（markdown 文件）

**模式原本是 TypeScript 对象**（`general.ts` / `coding.ts`）。这跟专家当时的处境一样：
一个不写 TypeScript 就改不了的「可定制」能力，实际只有写这个项目的人能用。
现在模式是 markdown 文件，走专家那套三级加载。

#### 为什么内置模式是内联字符串，而不是 `resources/modes/*.md`

原计划是后者。查了 `scripts/build.mjs` 之后否掉了：**它只拷 `renderer/`，
`resources/` 根本不参与构建**，所以打包后的应用会一个内置模式都读不到。
于是照抄专家的做法——内置的也写成 markdown，但放在 `builtin.ts` 的字符串里，
**用同一个 `parseFrontmatter`**。

这一点不能省：内置和用户文件如果走两条解析路径，它们迟早会漂移，
而**用户写的那条才是真的**。

#### 工具名 vs 工具：这条边界要如实说

frontmatter 里写的是工具的**名字**，`src/profiles/tool-catalog.ts` 负责把名字变成工具。
所以：

- 「加一个模式 = 加一个文件」对**组合已有工具**的模式成立
- 需要一个还不存在的工具的模式，仍然要写代码并登记进目录

**工具就是代码，数据文件不能凭空提供代码。** 把这条说清楚比把承诺说大有用：
一个读 README 的人应该知道他的模式文件能做什么、不能做什么。

顺带一个安全上的好处：模式文件**无法引入 catalog 之外的能力**。
它能做的只是从现有工具里挑——这和「专家只能收窄」是同一条思路。

#### `tools` 必填，而且要能被验证

缺失就报错，不默认成「全部」或「空」——工具集就是模式的**能力边界**，
猜错的方向要么过度授权、要么把功能弄坏，两个都不是作者的意图。
报错信息里附上全部已知工具名，因为**打错一个字母和一个还不存在的工具
从外面看是同一种症状**（「agent 没用它」），只有一个是作者的错。

名字在**加载时**校验，所以在 `--list-profiles` 和界面上就能看到哪个文件坏了、
坏在哪一行，而不是等到会话跑起来发现少了个工具。

#### 提示词：正文是文件写的，环境是内核追加的

正文就是系统提示词。工作目录和当前时间由内核**追加**在后面——
这两样是事实，不是模式的观点，不该指望写文件的人记得写。
不这么做的话，一个忘了写工作目录的模式就是一个会猜路径的模式。

#### 顺序不是装饰

catalog 的顺序是**内置两个按声明顺序在前，其余按 id 排**，不是纯 id 排序。
原因很具体：**启动时的模式选择器高亮第一项**，所以顺序决定了新用户默认拿到哪个模式。
按 id 排的话第一个会是 `coding`——**带 shell 的那个**。

#### 顺带整理：frontmatter 与「读一个目录」抽出来了

`experts/frontmatter.ts` 上移到 `definitions/frontmatter.ts`，
因为模式现在也依赖它，而 `profiles/` 反过来 import `experts/` 是错的方向。
「读一个目录里的 `*.md`」也抽成 `definitions/directory.ts`，两条失败策略
（目录不存在 = 空；文件坏了 = 报错并保留其余）因此只有一份实现。

#### 验证

- `smoke` **191 → 226**，新增 35 条：内置只有两个（对**受控的用户目录**断言，见下）、
  catalog 覆盖 pi 与本项目的工具、模式正文与 frontmatter 不串、
  **文件的工具按文件里的顺序解析出来**、项目级盖用户级且不产生重复、
  空 `tools: []` 合法、未知工具名被拒且报错列出已知名字、无 `tools` 被拒、
  空正文被拒、坏文件不拖垮目录、未知 id 的报错带上坏文件
- **「我们只有两个模式」必须对受控目录断言**：模式现在是用户能加的文件，
  对着真实的 `~/.gdou-agent` 断言，等于**`npm run smoke` 会对用了这个功能的人开始失败**
- `getProfile` 的错误消息抽成 `requireProfile(catalog, id)`：
  一份实现，同时可以在受控的 catalog 上验证
- `check:gui` 的「模式开关有两个按钮」改成**和选择器对账**（数量一致 + 顺序一致），
  不再写死 2——项目自己定义模式是完全正常的用法
- `check:vendor` 701/701、`typecheck` 干净、`check:tui` / `check:tools` / `check:gui` 全通过

**过程中真被 YAML 咬了一口**：`description: Everyday tasks: questions, ...`
里的第二个冒号让解析器报「嵌套映射不允许」。这正是 2.23 里那条
「用真正的 YAML 库」的判断生效的地方——手写的 `key: value` 切分会**静默留下错值**。

---

### 2.32 重复调用守卫

**它要解决的问题**：模型（尤其是小的）认定某个工具调用就是答案，拿到不满意的结果，
然后**发出完全一样的一次调用**。第二次和第一次没有任何差别，所以结果也不会有差别。
不管的话它就一直转，直到用户发现记录里塞满了同一次调用。

#### 拦在权限门的**后面**，这个顺序有含义

`LoopGuard.record()` 只对**已经过了权限门**的调用计数。被门拒掉的调用根本没到 provider，
所以它不是「模型卡住了」的证据。把它算进去，会让一个只是**一直被拒**的模式看起来像死循环——
拿门自己的判断去怪模型，报告是错的。

#### 规则是「连续」，不是「累计」，这就是整个设计

同一次调用**连着**重复 N 次是卡住。同一次调用在一次会话里总共出现 N 次，通常只是干活：
跑测试、改代码、再跑测试。累计计数会拒掉第四次 `npm test`，而那是一个普通的下午。

**代价是一个盲区，写在注释里而不是留给以后发现**：
交替循环（`read A`、`read B`、`read A`、`read B`）每次都重置计数，永远抓不到。
要抓它需要「没有新信息进来」这个概念，这个模块故意没有。

#### 拒绝以「被阻断的工具调用」形式送达

不是往对话里插一段话。pi 会把 `block` 变成一条 error 工具结果——
**一种模型已经知道怎么反应的形状**，它出现在每个别的工具结果出现的同一个位置，带着理由。
插一段散文需要一个不存在的通道，而且**看起来像用户说的**。

#### 为什么上限可配，而且 `0` 有意义

规则是故意钝的：一个合法地轮询同一条命令、参数还一样的工作流会误触。
所以 `loopRepeatLimit` 要能在不改源码的情况下调高——**也得能关**。
加载时用 `Number.isInteger(x) >= 0` 而不是真值判断，因为 `0` 在这里是有含义的值，
普通的 `if (input.x)` 会把它悄悄变成「用默认值」。

#### 验证

`smoke` 226 → 281。这一节新增 20 条，其中两条是**只有跑起来才能验证的**：

- 纯规则层：键序不影响键、不同工具/不同参数是不同键、前 N 次放行、
  第 N+1 次拒、**中间插一次别的调用就重置**、`0` 和负数都关掉
- **盲区本身也被断言**（交替循环抓不到）——已知的局限应该是测试里的一行，不是文档里的一句话
- 端到端：一个真会话里连发 4 次 `current_time`，断言第 3 次**以 error 工具结果的形式**回到模型，
  且界面收到 `notice`
- 「单元规则对」和「接线对」是**两个claim**：一个正确但从未被调用的守卫，和一个没有守卫是无法区分的

---

### 2.33 备用模型

**它要解决的问题**：一个 provider 过载，或者某个区域网络不好，整个对话就跟着它一起死。
备用模型让一次会话能扛过一次 provider 故障，而不是以一个用户无能为力的错误结束。

#### 条件是「在产出任何内容之前失败」，这就是全部的难点

回复一旦开始流式输出，用户**已经看到了**。静默换成另一个模型重来，要么把那句话的开头
重复一遍，要么替换掉已经在屏幕上的文字。所以**第一个 token 之后的失败，
原样当作错误传出去**。备用是救援，不是重写。

正因为这样，这个能力落在 `StreamFn` 接缝上：那是**「一次请求」还是不可分割的一件事**的最后一层。
在它下面是 HTTP 客户端；在它上面，循环已经往对话里追加了一条助手消息。

#### pi 在这条接缝上的约定让这个模块很小

`StreamFn` 只允许在**请求前**同步抛错；**一旦返回了 stream，失败必须以 `error` 事件出现**。
于是「这次请求有没有产出过东西」是可以通过看事件回答的，没有第三种情况要处理。

#### 必须守住的一条不变量：返回的 stream 一定会终止

pi 的循环在事件迭代器结束后会 `await response.result()`，而这个 promise
**只在推了终止事件（done / error）或调用 `end(result)` 时才 settle**。
一个既没推终止事件也没 end 就返回的转发器，会让会话**挂着不动——没有错误，也没有回复**。
这是最坏的失败，因为**没有东西可以报告**。
所以 `relay().catch()` 那层兜底是必须的：它把一个 reject 的转发器变成一条错误。

`pump()` 无终止事件时**合成**一个 error 并返回（不 push），保证每条路径恰好推一个终止事件。

#### 一个自查发现的真缺陷：开场事件必须一起缓冲

pi 的循环把 `start` 读作**「一条新的助手消息从这里开始」**：
它会 `context.messages.push(partialMessage)` 并发 `message_start`。
所以只缓冲内容、把失败那次的 `start` 放进去了的话，会话里会留下**两条助手消息**——
第一条是一个**永远没有终止事件来收尾的空 partial 消息**，在每个前端里都是一个多余的空气泡。

修法是 `pump` 把**开场事件一起扣住**，直到这次尝试确定要产出内容为止（`committed`）。
扣住不需要额外延迟：需要扣住的那几个事件，恰好就在「还没产出内容」之前。
pi 的循环对「没有 start、直接来 error」是能处理的（`addedPartial === false` 那条分支），所以这个改动是安全的。

#### 「没有配置备用模型时直接原样返回」——否掉了

原本的实现是 `if (!fallback) return stream`。代价是**「返回的 stream 一定终止」这条不变量变成有条件的**。
条件化的安全属性不值钱：它的违反是**静默**的，而代价只是一次转发。
现在无论有没有备用模型都走转发，没得切就把错误报出来。

#### 一个真实的接口约束（被测试替身逼出来的）

`withModelFallback` **不会**为第二次尝试换一个 transport——它用**另一个模型**调用**同一个函数**，
因为 transport 本来就是这个东西：把 (model, context) 变成 stream 的那一层。
所以被包的那个 `stream` **必须按模型分发**。一个忽略 model 参数的 transport 会「回退到自己」，
而唯一的症状是一次重复的失败。这条写在函数注释里，因为**一个静默无法工作的包装器比一个写不出来的更糟**。

#### 验证

这一节新增 26 条，覆盖三条必须终止的路径（成功 / 产出后失败 / 切换后也失败）
加上两条边界（源没有终止事件、没配备用模型），并且断言：

- 早失败**调用备用模型一次**、主模型**只被尝试一次**、失败的 `start` **没有被转发**
- 切换**只报告一次**，报告里有 from / to / 原因
- 产出后失败**不切换**、`onFallback` **不触发**、部分回复保留、失败原样传出
- 源静默结束：**必须终止**，且终止于 error；配上备用模型时**算作可救援的失败**
- `AgentSession.fallback` 被暴露出来（前端可以在**用到之前**就告知用户）

---

### 2.34 按模式选模型

模式文件的 `model:` 字段。有用的情况是**一个模式只在某个模型上表现好**
（比如长文摘要需要大窗口），「在别处表现差」这件事值得说出来。

#### 优先级：**最低**，这是故意的

`显式选项 > 设置 > 模式`。模式点名一个模型是**一个用户可能没写过的文件给出的建议**。
让配置文件**静默压过用户自己做的选择**，是最快让人不再信任配置文件的办法。

#### 校验在会话启动时，不在加载时

model spec 的合法集合来自 provider 注册表，而那在读一个纯文件的函数里是拿不到的。
所以在 `resolveSetup` 里校验，好处是错误里能同时写出**模式 id 和它来自哪个文件**：

```
fatal: Mode "broken" names a model that does not exist: deepseek/depseek-flash
  (from C:\...\_tmp_e2e\.gdou-agent\modes\broken.md)
```

光一句「Unknown model」会把读者支使去翻设置和环境变量，而那个 spec 住在一个完全不同的地方。
还有一处细节：判断「是不是模式给的」用的是 `options.model === undefined && settings.model === undefined`，
而不是 `modelSpec === profile.model`——**用户自己敲错一个恰好等于模式里写的 spec 时，该怪的是用户**。

加载层仍然要负责的只有一件事：字段完整到达（空字符串被拒）。

#### 顺带把备用模型的报错也分开了

`Unknown model: nope/nope` 单独看像主模型坏了，而主模型是好的。
所以那条错误写成了「The fallback model does not exist: …」，并且带上 `cause`。

#### 展示

- CLI `--list-profiles` 在模式后面加一句 `suggests deepseek/deepseek-v4-pro`
  （用注释式而不是独立列：一屏模式里值得知道的是「这个模式有意见」，不是意见是什么）
- GUI 检查器多一行「备用模型」，**没有也显示「无」**——一行缺席是看不见的，
  读者分不清「没配」和「这个版本没这个功能」
- TUI 状态行在模型后面跟 `⇄provider/model`，和上下文指示器同一个原则：有东西说的时候才出现

#### 一个实测出来的、容易误解的点

`resolveDefault` **只查模型目录，不查凭据**。所以「模式点的模型在新机器上没配 key」
**不会报错，也不会回落**——那个模型照样被用上，失败推迟到**第一次请求**才以凭据错误出现。
实测：环境里一个 key 都没有时 `deepseek/deepseek-flash` 仍然解析成功。

也就是说，「模式只能建议」体现在**优先级**上，**不体现在「没 key 就换一个」上**。
两件事容易混为一谈，所以写进了 `docs/state-and-migration.md`。
没有在会话启动时加一道「这个 provider 有凭据吗」的检查：env 变量不是全部真相
（pi 还会读 `~/.pi/agent/auth.json`），一个猜错的警告比没有警告更糟。

#### 验证

这一节新增 10 条：加载层（有 / 空 / 缺字段）、优先级三档（无其他来源时生效、
显式选项压过、存储设置压过）、未知 spec 的报错点名模式、以及环境兜底那条
**在没有 key 的机器上跳过而不是判失败**——新克隆的仓库正好就是那个状态。

### 2.35 模型与凭据（在界面上绑 key、换模型）

**这一节修的是「应用能跑，但永远对话不了」。** 症状是启动会话时报 `No model available`，
而界面上没有任何地方能填 key —— 用户看到的是「模型切不了、完全不能对话」。

根因不在 UI 层：**pi 的 `CredentialStore` 默认是纯内存的。** `createModels()` 不传
`credentials` 就自己 new 一个 `InMemoryCredentialStore`，于是**没有任何 key 能活过这次运行**。
环境变量是唯一的路，而要求桌面应用的用户去改环境变量等于没有这条路。
所以「模型不能切换」不是开关藏起来了，是这条管道从来没接上。

#### 怎么接的

- **`kernel/credentials.ts`（新）**：实现 pi 的 `CredentialStore`，落在 `~/.gdou-agent/auth.json`，
  用 pi 自己的 `Record<providerId, Credential>` 形状而不是我们另发明一种 ——
  pi 的 `auth/resolve.ts` 已经认识它，第二种格式就是第二个要同步维护的东西。
- **读宽容、写严格。** 读的时候文件缺失/损坏/截断一律当「没配」：因为一个逗号让应用变砖是错的。
  写的时候**先拒绝**：拿当前进程知道的东西覆盖一个损坏文件，会静默删掉用户可能还能手工救回来的
  key。这条不对称是刻意的，两半都有断言钉住。
- **`ModelRuntime.create(credentials?)` 显式注入。** 不注入就静默退回内存实现，于是
  「在界面里存了 key，下次启动却不在」这种故障**不报任何错**，只是行为不对。
- **存的 key 压过环境变量**（pi 的规则：存储的凭据**拥有**该 provider）。反过来把它当缓存，
  会让手动输入的 key 被一个看不见的环境变量盖掉。
- **`defaultModelSpec()` 也要认存储**，否则用户存了 key 仍然没有默认模型，
  表现就是「保存了但没用」。

#### 界面上怎么用

- 侧栏**设置**（`Ctrl+5`）：每个预设一行 —— 状态徽标 + 密码框 + 保存/删除；下面两个下拉选服务商和模型。
  删除按钮**只在存了 key 时可用**：环境变量来的 key 没有文件可删，给一个能点的按钮
  等于承诺一次做不到的删除。
- 编写器右下角**原来的只读模型名变成切换按钮**，弹层按服务商分组列出可用模型，点一下即切
  （弹层按服务商分组列模型；齿轮跳设置页）。列表**只列已配置的服务商**，
  并且明说这一点 —— 列一个调不通的模型是陷阱，失败会推迟到请求时以一个认证错误出现，
  离点它的那次点击很远。
- 编写器上那个小圆点说的是**这个模型现在能不能调用**，绿＝能。它是问 pi 自己的解析层
  （`Models.getAuth`）得到的结论，不是猜「文件里有没有 key」——存给别的服务商的 key、过期的
  OAuth token、需要 key 以外东西的 provider，在磁盘上看起来都「已配置」，但一发请求就失败。
- **key 永不跨 IPC。** `credentials:list` 只回状态和掩码（`••••••••abcd`）。
  **没有**「读回我的 key」这个通道：界面不需要，而存在的通道就是能泄漏的通道。

#### 五个真踩到的坑（都属于「代码说对了，用户看到的却是另一回事」）

1. **`.model-menu` 设了 `display: flex` 却漏了 `[hidden]` 覆盖规则。**
   `hidden` 属性靠的是 UA 的 `[hidden] { display: none }`，任何作者 `display` 都能压过它 ——
   于是那个弹层**从窗口打开就一直在屏幕上，而且永远关不掉**。项目里其它 9 个用 `hidden` 开关的
   元素都写了这条覆盖规则，这是约定，不是可选项。
2. **自检当时查的是 `hidden` 属性，不是可见性**，所以它愉快地报告「已关闭」。
   现在改成断言 `getComputedStyle(...).display`，并补了一条「初始必须是关着的」——
   那条一跑就会抓住 1。
3. **弹层被祖先的 `overflow: hidden` 裁掉了。** 编写器的祖先 `.work-layout` 有
   `overflow: hidden`，而弹层是嵌在编写器里的绝对定位元素 —— 于是它被**画出来又被裁掉**，
   看起来像「菜单坏了」，而不是「菜单被挡住了」。改成挂在 `body` 上、用 `position: fixed`
   并按触发按钮的 rect 定位，才跳出中间所有的裁剪与层叠上下文。
   ⚠️ 迁移它带来一个新坑：弹层不再是触发按钮的后代，于是「点外面关闭」会把**点弹层自己**
   也当成点外面 —— 菜单在 pointerdown 阶段就关了，行的 click 永远不执行，**点模型等于什么都没发生**。
   所以豁免条件必须同时包含触发按钮**和弹层**。
4. **保存 key 之后会话仍跑在脚本化传输上。** 预览按钮把会话设成脚本化；重启会话时省略了
   `scripted`，而主进程把「没表态」理解成「保持现状」——于是用户填了 key、拿到的一直是脚本的
   固定回复。现在显式传 `scripted: false`。
5. **设置页的 `id="credentials"` 和诊断面板撞了。** 诊断面板早有一个同 id 的 `<pre>`，
   `getElementById` 返回文档里第一个 —— 于是诊断那栏读到的是我新加的列表，而那条已有的
   「credential report rendered」断言**是蒙对的**：设置页每行都写着 `DEEPSEEK_API_KEY` 字样，
   它的子串检查照样通过。列表改名 `credential-list`，两处彻底分开。
   **加元素前先 `grep -n 'id="' renderer/index.html`，这个项目页面不少。**

#### 被否掉的方案

- **复用 pi 的 `AuthStorage`（coding-agent 里那个文件实现）**：它有锁和 0600，但**没有从包入口
  导出**（`index.ts` 只导出 `readStoredCredential`），要靠通配路径伸进 `src/core/auth-storage.ts`，
  等于把自己绑在上游可以随时搬的文件布局上。接口只有四个方法，格式由 pi 的读取器定义，
  自己实现更便宜。
- **把 `auth.json` 放在 pi 的 `getAgentDir()` 下**（第一版就这么写的）：那个函数从 `homedir()`
  推导、**无视 `GDOU_AGENT_HOME`**。后果是 `check:gui`（跑在临时 home 上，存在的意义就是不碰真实
  状态）会去写用户**真实的**凭据文件。**自检去改被检查的东西，比没有自检更糟。**
  形状用 pi 的，路径用我们自己的。

#### 验证

`smoke` 281 → **303**。其中最关键的一条不是测我们自己的记账，而是问 pi 自己：存进去之后调
`Models.getAuth()`，断言 `source === "stored credential"` 且 `auth.apiKey` 就是刚存的那把 ——
这是「我保存的 key 就是实际在用的 key」唯一的**外部**视角。

其余覆盖：`0600`（**按平台跳过** —— Windows 上 `chmod` 只切只读位，回读永远是 0666，
保护靠用户目录 ACL，所以这条断言在 Windows 上跳过并在注释里说明，而不是写成一句做不到的承诺）、
掩码不含明文、空 key 与未知 provider id 被拒且不落盘、删除、损坏文件**读宽容、写拒绝、
逐字节未改**、粘贴的 key 被 trim、存储压过环境变量。

`check:gui` 也补了设置页与模型菜单一节（见 2.35 的三个坑，第 2 条就是被这节自己抓出来的）。

---

### 2.36 技能渐进式披露（`load_skill`）

技能是三个自定义机制里**唯一真正新的一个**。专家（E5）和模式（F1/F2）都只是「把
一段提示词按优先级组合进会话」，技能的不同在于**它的正文默认不在上下文里**。

**问题**：技能会越来越多。一个 `skills/` 目录里有几十个技能是常态，每个技能的正文
是一页方法论。把它们全文拼进系统提示，就是几十万 token 的固定开销——正好把 2.19
上下文裁剪好不容易省下来的预算又花回去，而且是**每一轮都花**。

**解法（渐进式披露）**：

- 会话开始时，提示里只注入一份**目录**：每个技能的 `id` + 一句话 `description` +
  可选的 `when_to_use`。这几十行就够模型判断「该用哪个」。
- 模型判断任务匹配后，调 `load_skill` 工具，正文**在这一刻**才进入上下文。
- `load_skill` 还能附带读一个 `references/` 文件，所以技能的主干（SKILL.md）保持简短，
  细节按需加载。

**技能是一个目录，不是单文件**——因为一个技能可能带参考材料。`SKILL.md` 是主干
（frontmatter: `name` / `description` / `when_to_use` + 正文方法论），`references/` 放
可选文件（`*.note` 文件给它的邻居写一行描述，让模型决定要不要读）。

**两个安全/一致性的判断**：

1. **`load_skill` 从 registry 读，不是从文件系统直接读。** 一个损坏的 `SKILL.md`
   被 registry 拒绝加载后，不能通过 `load_skill` 走后门读到；未知 id 的报错会列出
   所有存在的技能——这是「我不懂怎么做」和「文件坏了」的区别。
2. **`load_skill` 不受专家收窄，也不受模式工具集约束。** 它跟在每个会话的工具集里，
   因为「读一段指令」不是一种「能力」——专家收窄工具集是在收窄**能做什么**，
   读指令不在那个范畴。它没有路径参数，所以权限门的「按参数形状分类」会把它
   归为「无面可保护」直接放行，和 `current_time` 一样。

**内置了两个技能**（`git-commit`、`write-readme`），主要作用是**证明机制工作** +
覆盖两个大家都做的事。真正的技能库由用户文件构成。

验证：`smoke` 新增 17 条（305 → 322），覆盖解析、三级加载、reference 读取、
**渐进式披露不泄露正文**（断言 `composePrompt` 输出里没有 skill body 的前 20 字）、
以及 `load_skill` 工具注入会话。CLI 加 `--list-skills`。

**Skills 页（GUI）也在同日从占位卡换成真实列表**：`agent:skills` IPC + preload +
`renderSkills`，把每个技能的 id / 描述 / `when_to_use` / references / 来源渲染成卡片，
下面照专家页的样子附一张「自己写一个」的路径卡（项目级 > 用户级）。机制先有、界面后接，
所以这一页是「把已经完成的能力暴露给用户」而不是新机制。

---

### 2.37 GUI 质感（侧栏品牌区、可拖拽宽度、轮次圆点）

对照桌面端的常见做法，把「精致感」缺的几块补上。**配色 token 本来就是冷灰中性**
（`#f7f9fa` 底 + `#3383e8` 蓝强调，`tokens.css` 里保留了来源说明），
所以这次不动配色，动的是**布局和动效**——那才是「老土」的来源。

1. **侧栏品牌区**：顶部加 logo 标识 + `GDOU` 名 + `Beta` 徽章，再往下是一枚**贯穿的
   「新建对话」主按钮**。之前「新建」只是对话记录标题旁的一个小加号，第一动作被藏进了
   二级位置。
2. **侧栏可拖拽调宽**：加 `sidebar-resizer`，`pointerdown` 拖动，宽度走 `--sidebar-w`
   这一个 CSS 变量（grid 和分隔条共用，所以两者永不会对不上）；180–420px 夹取，
   持久化到 `localStorage`，下次启动沿用。
3. **轮次圆点导航**：时间线右侧一列圆点，每个用户消息一轮。点圆点平滑跳到那一轮，
   hover 出气泡（预览该轮文字）、上下渐隐遮罩；active 圆点跟随滚动——表示的是
   「正在读的这一轮」而不是「最新一轮」。不足两轮时隐藏（没有导航的必要）。
4. 补 `--shadow-float` 阴影层次。

**两个实现细节**：圆点栏用 `position: absolute` 挂在 `.task-canvas` 上，所以给
`.task-canvas` 补了 `position: relative`（否则会定位到更远的祖先）；气泡用
`position: fixed` + `translate(-100%, -50%)` 挂在 viewport 上，因为它在
`overflow: hidden` 的滚动容器里会被裁掉——和之前模型菜单「被挡住」是同一类坑。

验证：`gui-check` 的侧栏断言（列全页面 / 初始展开 / 折叠切换）全通过；`renderer-check`
补了品牌区、拖拽条、圆点导航的 7 条断言。离线校验（smoke 322 / typecheck / vendor /
tui / tools）全绿。

---

### 2.38 观测（崩溃报告、日志落盘、内存诊断）

三件「出问题能拿到线索」的事，全落在 `~/.gdou-agent/logs/`（跟随 `GDOU_AGENT_HOME`，
所以自检用临时 home 时不会污染真实日志）。这是对齐清单里 N6/N7/N9——也是我们
**一整天都在跟「Electron 渲染进程静默崩溃、拿不到任何线索」作对**的直接解药。

1. **崩溃报告（N6）**：`uncaughtException` / `unhandledRejection` /
   `render-process-gone` 三个处理器**同步落盘**。同步是硬要求——`uncaughtException`
   是进程死前最后一段代码，异步 `fs.promises` 会排进事件循环然后一起丢。单次启动
   上限 50 条，防「渲染进程崩溃→重生→再崩」的循环写满磁盘。每个处理器**自己吞异常**：
   崩溃报告器再崩，就是一次没有记录的崩溃。
2. **运行日志（N7）**：会话启动写一行（mode / expert / model / cwd / 是否脚本化），
   这是「它到底跑在什么配置下」的权威答案。重复消息按**指纹采样**——第一条写全文，
   之后只计数，每 100 次刷一行；否则一个循环就能写几 MB，而打不开的日志等于没有日志。
3. **内存诊断（N9）**：每 30 秒看一次 `heapUsed`，≥1.5GiB 时写一份 `process.report`
   的堆报告（V8 内置，无原生依赖），每分钟最多一份，防持续泄漏写满磁盘。

诊断页的「路径」区加了一行「日志目录」，用户点开就能知道线索落在哪。

**一个设计上的修正**：写函数都带一个 `dir` 参数（默认 `logsDir()`），这是**测试接缝**。
第一版 smoke 靠「运行时改 `GDOU_AGENT_HOME`」来隔离，结果不生效——因为 `AGENT_HOME`
是模块加载时冻结的常量。改成显式传目录后，自检既不会碰真实日志，断言也才真正测到
了被测对象（第一版的前三条「通过」是假象，log 写到了真实 home）。

验证：`smoke` 327（+5），覆盖「日志文件创建 / 未指纹行必写 / 重复行只写一次 /
崩溃记录落盘 / 崩溃记录带消息」。

---

### 2.39 子代理（`delegate`）

对齐清单 C10，也是**第三梯队的第一项**、B7「场景模型变体」的**第一个真正调用点**。

`delegate` 工具把一个自包含的子任务交给一个**独立上下文**的子代理跑完，返回最终文本。
三个决策是这个工具的实质，不是实现细节：

1. **子代理是全新 `createAgent`，不继承父对话。** 这正是「子代理」的用途——一个长的、
   自包含的钻取不该花掉父会话的上下文预算，也不该把中间过程堆进父消息。独立上下文的
   代价是「子代理看不到父在聊什么」，所以 `task` 参数必须自带足够上下文，工具描述里写明了。
2. **子代理继承父的模式，不写死 coding。** 第一版写死 `mode: "coding"`，于是 general
   模式里 delegate 出的子代理也能读写文件——这是**静默的权限扩大**，不是便利。改成
   子代理用父的 `recipe.mode`，工具面就不会在用户背后变大。这个决定连带改了 general
   模式本身（见下）。
3. **子代理不含 `delegate` 本身。** `includeDelegate: false` 让「把一切都 delegate」从
   无界树变成**恰好一层**。嵌套 delegate 确实有用，但那是要**单独、刻意**做的决定，
   不该是接线的意外产物。

**连带的设计转变：general 模式也开放了文件/Shell 工具。** 触发点是用户实测 delegate
时，模型在 general 模式里说「我读不了文件，子代理也读不了」——后半句错了（子代理
当时写死 coding 有文件权限），但前半句暴露了一个真问题：**general 模式卡在「没有文件
权限」，用户问个文件就得绕道。** 结论是「模式的价值在提示词引导，不在能力边界」——
两个模式现在工具集趋同（都能读文件、跑命令、交付），区别是系统提示词：general 是
「日常任务优先、需要时才碰文件」，coding 是「仓库开发、先读后改、跑检查」。这让模式
从「能力边界」退化成「工作风格」，与专家（expert）的定位开始靠近，但这是更符合
单机桌面 agent 实际用法的方向。

**一个完整性的坑**：第一版 delegate 没继承主 agent 的 `streamFn`，于是脚本化预览下
（`GDOU_SCRIPTED_RUN=1`，无 key）子代理会去调真实 provider 而失败。修成把 `streamFn`
提成 `assemble` 里的变量、传给 `delegateTool`，子代理就和父用同一个传输——脚本化的
保持脚本化，真实的保持真实。

验证：`smoke` 327 → 335（+8），覆盖「顶层会话含 delegate / 子代理不含 delegate /
子代理仍含 load_skill / delegate 返回子代理文本 / delegate 报告子代理模型 /
delegate 报告子代理模式 / general 会话的子代理继承 general」。

---

### 2.40 动效（流式光标、思考动画、消息进出场）

用户要「模型回答思考的时候都有动效」。三个动效
keyframes，配色走我们的冷灰 token。

1. **流式光标**（`token-caret`）：模型打字时，`.body.streaming::after` 画一根 7×15 的
   竖条，`steps(1)` 闪烁——最直接的「它在回答」信号。`assistant_end` 时 `.streaming`
   连同光标一起摘掉：一条已经完成的回复不该还在「打字」。
2. **思考三点跳动**（`typing-bounce`）：thinking 时 `.thinking-dots` 三个圆点错峰上下跳。
   同时把思考文本从「每条 delta 一个新 div」改成**累积到一个面板**——原来思考流式会
   堆一堆气泡，现在和 assistant 正文一样累积，三个点在整个思考期间一直跳。
3. **思考扫光**（`thinking-sweep`）：`.thinking` 面板上一道光带从左滑到右（`ease-out`
   循环），表示「正在思考」。思考结束（`assistant_start`/`text_delta`）时 `state.thinking`
   清空，光带停。

外加两个状态信号：消息**淡入上滑**进场（`msg-enter`，0.18s），工具卡**运行中紫框 /
失败红框**（`.tool.running` / `.tool.failed`），结束才落定。

**一个连带修正**：`addThinking` 从「每条 delta 新建容器」改成「累积」，需要 `state.thinking`
追踪当前面板，并在 `assistant_start`/`text_delta` 时清空——否则思考结束后三点还在跳。

验证：离线校验全绿；`gui-check` 在这个环境跑不到完整一轮（Electron 渲染进程偶发崩），
但**顺带修掉了 6 条前面几轮累积的过期断言**（脚本化 demo 工具名、Skills 页已从占位变
真实、专家收窄因 general 加了文件工具而不再「收窄到空」）——这些断言从没被暴露过，
因为 `check:gui` 一直没能跑完。

---

### 2.41 marked 排版、工具折叠、等待动效

用户提的三个具体问题一次解决，且**换实现方法而不是继续缝补**：

1. **输出排版**：根因是自研 `renderMarkdown` 只认代码块 / 行内代码 / 加粗，模型输出一个
   带标题、列表、表格的回答就糊成一段。换成 `marked`，
   把 `marked.umd.js` vendored 进 `renderer/`（CSP 是 `script-src 'self'`，本地文件满足），
   `renderMarkdown` 一行 `marked.parse(text, { breaks: true })` 替代 40 行正则。补了
   blockquote / table / hr / strong / img 的样式。
2. **工具折叠**：原来工具调用「逐个追加、每个一行」，只有 ≥2 个连续才折进 group。改成
   **工具调用始终进一个「正在使用 N 个工具」的折叠卡**——运行中默认折叠、头部三点跳动 +
   紫框，结束才落定成「N 次调用」。第一个工具就建 group，不再有「孤立敞开的工具卡」。
3. **等待动效**：`run_start` 到首个输出之间原本没有任何反馈（尤其 thinkingLevel=off 时，
   模型既不思考也不立刻出字，用户干等）。加「思考中…」三点跳动占位，`assistant_start` /
   `text_delta` / `tool_start` 一到就清掉。

**关于 thinking 的决定**：默认 thinkingLevel 是 `off`（省 token、快），所以模型不产出
thinking 内容、看不到「思考过程」动效。用户选择**只做等待动效**，不开 thinking——
这是成本与体验的取舍，不是没做。

验证：离线校验全绿，构建通过。

---

### 2.42 产物一键打开

交付的产物以前只能在检查器里**预览**（`artifact:read`），而且超过 2 MB 的文件直接甩一句
「请直接打开它」——界面上却根本没有「打开」这个动作，PDF、Word、视频、大文件全都打不开。

改法是**加一个打开通道，而不是在预览里继续补**：

- 主进程加 `artifact:open`，用 `shell.openPath` 交给系统默认应用。**复用同一个
  `present_files` 白名单**，所以它和预览通道一样只能打开模型交付过的路径，不会变成从
  渲染进程任意启动本地文件的入口——安全边界不变，只是多了一种"怎么用"。
- preload 暴露 `openArtifact(path)`，和 `readArtifact` 并列。
- 渲染层：**文件卡片和检查器列表行点击 = 直接打开**（一键）；URL 仍是浏览器 `_blank`。
  检查器的预览头部加「用系统应用打开」按钮，超大文件不再是一句死话。

验证：`build` / `typecheck` / `smoke` 全绿；`gui-check` 断言改成校验「打开通道拒绝未交付
路径」和「打开桥接已暴露」，避免无头环境真去拉起编辑器。

---

### 2.43 MCP（stdio 客户端）

对齐清单 I 节里「用现成的」最典型落点：接 `@modelcontextprotocol/sdk`，一个 MCP server 的
工具立刻变成 agent 的工具，**不需要自己实现任何工具**。本轮只做 **I1（stdio 传输）** 这条
主干，I2（作用域）/I3（env 扩展）因为「就是读配置这一件事」顺手一起做了，I4（审批）之后再做。

五个模块，职责单一：

- **`config.ts`**：读配置。三级作用域 `~/.gdou-agent/mcp.json` → `<cwd>/.gdou-agent/mcp.json`
  → `<cwd>/.mcp.json`，后写的覆盖先写的（`disabled: true` 可关掉宽作用域里的同名 server）。
  JSONC 注释手写剥离（不引依赖）；`${VAR}` / `${VAR:-default}` 在 env 和 command 里展开，
  key 不用明文写进配置。
- **`client.ts`**：封装 `StdioClientTransport` + `Client`。拥有子进程生命周期（spawn/connect/
  close 都在这），调用方不会漏掉进程。`callTool` 把 content 展平为文本（text/image/resource 都处理）。
- **`schema.ts`**：MCP 的 JSON Schema → TypeBox。**宽松进、严格出**：不认识的 keyword（`format`
  等）丢弃而非让整个工具不可用；`anyOf`/无 type 的 schema 降级成 `Type.Any()`——让 server 自己
  拒绝坏参数，好过我们猜错联合类型拒绝好参数。
- **`tool.ts`**：MCP tool → `AgentTool`。名字加 `mcp__<server>__<tool>` 前缀（两个 server 同名
  工具不冲突、转录和权限标签都能指出是哪个 server）。`replay: "never"`——server 是第三方
  stateful 进程，重放结果不确定不重放。
- **`index.ts`**：编排。连所有 server，坏的**按 server 报错跳过**（一个配错的 server 不该拖垮
  整个 agent），返回 `{ tools, errors, close }`。

接线在 `createAgent`：MCP 在 `assemble` 前连好（因为要先 `listTools` 才知道挂什么），工具作为
参数传进 `assemble`，和 `load_skill`/`delegate` 一样**不属于模式的工具集**——它们是用户配置的
环境，不是模式的契约，所以不受专家收窄。session 新增 `mcpErrors` 字段（坏 server 可见，不是
静默缺失），`dispose` 时 `mcpClose()` 关掉子进程。

验证：smoke 335 → **349**（+14），用一个手写 JSON-RPC stdio server（`scripts/smoke-mcp-server.mjs`，
不依赖 SDK server 端）测 client 的 listTools/callTool、config 的 JSONC/env 扩展、schema 转换、
工具挂载、坏 server 报错不致命。`build` 通过（bundle 6.0→6.6 MB，SDK 引入）。

**I4 审批（2026-09-24 落地）**：MCP server 首次连接现在需要用户批准，因为连接就是
spawn 一个第三方进程。审批状态存在 `~/.gdou-agent/mcp-approvals.json`（`src/mcp/approval.ts`），
`connectMcp` 只连接已批准的 server，未批准的记入 `mcpErrors`（"待用户批准"）而不是静默跳过。
桥端新增 `mcp.list`（列出配置 server + 批准状态 + 命令）与 `mcp.approve`；shell 设置页
「连接 → MCP 服务器」卡片逐台列出、一键批准。smoke 增加 4 条审批门断言（未批准不挂载 /
已批准挂载 / 门禁报告 / 坏 server 不致命）。

---

### 2.44 桥接层（方案B）

**为什么把内核和 GUI 拆成两个进程**：内核是 pi + 自研装配，纯 TypeScript 服务；GUI 需要
现代前端生态（Vue、Vite、组件库），两者技术栈完全不同，焊在一个进程里只能互相拖累。
方案B 让 shell 是自绘桌面工作台（`shell/`，Vite dev server 5173），内核通过 `bridge/`
以 JSON-RPC over WebSocket（`ws://127.0.0.1:7438`）暴露给它。

**桥是薄映射层，不是二道实现**：`bridge/server.ts` 把内核能力翻译成 shell 的 63 个方法，
事件流按一张翻译表归一（`run_start → run.started`、`text_delta → llm.token`、
`tool_start/end → tool.call_started/finished` 等）。**诚实原则**是桥的底线：

- **没有的能力诚实拒绝**：`NOT_IMPLEMENTED` 表给每个未实现方法一条中文说明（如
  "插件市场尚未实现：这里没有插件体系，扩展能力走技能与 MCP"），前端原样显示，
  绝不为了"看起来有"而捏造空结果。
- **只读批量列表返回空结构不 reject**：shell 用 `Promise.all` 并行拉取
  workspace/session/settings/status，一个方法 reject 会拖垮整页；能给出"空"的地方给空，
  给不了的地方明确报错。
- **字段没有诚实对应就报稳定值并注释**：shell 类型要求 `provider: "anthropic"|"openai"`，
  我们的 provider 是 deepseek/moonshot 等，桥报 `"openai"`（多数走 OpenAI 线协议）并在
  每个字段旁注明这是适配妥协。
- **凭据认定不看环境变量只看存储**：`has_api_key` / `api_key_configured` 都查
  `~/.gdou-agent/auth.json`（含 `presetsWithCredentials`），否则"刚在设置页存的 key 没生效"
  会再次出现。

**会话持久化 + 自动恢复**：每次 run 结束桥把会话落盘（`session.create` 即落盘，
`send_message` 跑完落盘）；桥重启后 shell 再发消息时，桥从磁盘重建会话（用当前配置，
脚本化预览自动变真实会话）。**断线自动重连**：shell 的 WebSocket 断开后指数退避重连，
桥回来即恢复（t2 实测：杀桥 → 状态变「未连接」→ 重启桥 → 12 秒内自动恢复「已连接」）。

**新增方法**（阶段3，2026-09-24）：`expert.list`（专家目录）、`mcp.list` / `mcp.approve`
（I4 审批）、`settings.update` 支持 `fallback_model`、`session.create` 接受 `expert` 并返回
`unavailable_tools`、`session.get_history` 返回 `expert`。

### 2.45 shell 工作台（方案B）

`shell/`（Vite + Vue3）是当前唯一的 GUI。它把内核能力呈现成一张自绘桌面工作台：
会话列表、对话时间线、右侧检查器（文件/工作区/上下文）、技能中心、自动化页、源码控制页、
用量页、设置对话框。事件流驱动消息渲染，`ExecutionTimeline` 负责时间线，`SessionStatsLine`
显示上下文占用条（80% 警示 / 95% 告急 + 进度条）。

**阶段3 补的独有能力 UI**（2026-09-24，对照 FEATURES 各章节逐项核对）：

- **MCP 工具徽标**（2.43）：`ToolCallCard` 识别 `mcp__<server>__<tool>` 前缀，紫色徽标
  显示 server 名，action/detail 剥掉前缀只留工具短名；`provider.status.mcp_servers` 报真实
  配置（approved/pending）。
- **专家选择 + 收窄指示**（2.28）：composer 工具栏加专家下拉（`expert.list` 数据）；
  会话创建把专家带给桥端，桥端按配方装配；会话头显示当前专家徽标；创建响应带回
  `unavailable_tools` 供前端提示"为什么工具变少了"。
- **备用模型配置**（2.33）：模型选择弹层加"备用模型"下拉，写 `settings.fallback_model`；
  切换时内核 `notice` 已通过 `log.line` 展示。
- **变更追踪**（2.29）与**上下文指示器**（2.21）在 shell 原本就有（EditedFilesCard /
  SessionStatsLine），本轮确认无缺口。

### 2.46 自动化（定时任务）

shell 的自动化页（AutomationPage）原本只有 UI，桥端 `schedule.*` 全部诚实拒绝
（"内核还没有自动化调度能力"）。本轮（2026-09-24）把机制补齐：

- **存储**：`src/automation/schedule.ts`，任务存 `~/.gdou-agent/automations.json`，
  原子写（temp + rename），到期计算只在保存时做一次，`dueTasks()` 只比 ISO 时间戳。
- **桥端方法**：`schedule.list/create/update/pause/run/delete` 全实现；`schedule.run`
  立即异步触发一次，`last_result` 记到任务上。
- **运行时触发**：桥进程内 `setInterval`（60s）检查 `dueTasks()` 触发到点任务——
  **只做运行时触发**，关掉程序就不跑（界面文案明说）。
- **产出单独概念**：自动化运行不进入会话历史，结果（`last_run_at` / `last_result`）
  记在任务上。
- **无人值守默认 read-only**：`runAutomation` 用 `{ tier: "read-only", approval: "never" }`
  装配——"不问"必须等于"不做"，这和「专家只能收窄」是同一条原则。

### 2.47 提问机制（ask_user）

内核新增 `ask_user` 工具（`src/tools/ask-user.ts`）：模型需要用户做决定时调用它，
传一组结构化问题（header/question/options/multi_select），`execute` **挂起 run** 等回答。
桥端持有 `pendingQuestions` map，收到工具调用即向 shell 推 `question.requested` 事件，
shell 弹多选/多选弹窗；用户回答后 `question.respond` 带回答案，桥端 resolve 挂起的
promise，答案作为工具结果文本回到模型，run 继续。`question.pending` 供刷新/重连后
恢复弹窗。真实模型闭环实测通过（2026-09-24）：模型问"选 A 还是 B" → shell 弹窗 →
回答「方案 A」 → 模型收到并继续。

### 2.48 用量统计

对话界面展示的 token 用量此前全是写死的 0 —— 真实用量只在 pi 的 `message_update`
事件 `usage` 字段里流过去，桥不读也不存。本轮把这条链路接通：

- **真实数字进会话统计**：run 订阅里累计 `usage`（input/output/cacheRead/cacheWrite/
  cost），`run.finished` 事件据此填真实的 `total_input_tokens` 等字段，会话统计行
  显示的是真实 token 数而不是 0。
- **用量落盘**：每次 run 结束（finally，紧挨 `persistLive`）把
  `{ts, sessionId, model, input, output, cacheRead, cacheWrite, cost, elapsedMs}`
  追加一行 JSON 到 `~/.gdou-agent/usage.ndjson`。model 从 settings 取，拿不到则为空。
  append 而非重写，天然抗并发；写失败静默，绝不影响 run 本身。
- **聚合接口**：桥端新增 `stats.overview`，读 ledger 聚合成总览
  （总 input/output/cache/cost/运行数/耗时）+ 按日（YYYY-MM-DD）+ 按模型三张表，
  按本地时区分桶，费用直接沿用 provider 报告的 `usage.cost`，不另建定价表。
- **用量页**：shell 侧栏新增「用量」入口（Table2 图标），`UsageStats.vue` 展示
  总览卡片（运行次数/输入/输出/缓存读取/耗时/费用）与「按模型」「按日期」两张明细表。
- **任务板/悬停累计**：`session.list` 从 ledger 按 sessionId 求和，`snapshotOf` 据此
  报真实的 `total_input_tokens/output/elapsed_s` —— 任务板 token 列与悬停预览不再全是 0。
- **历史回填**：ledger 只记录它诞生之后的 run。旧对话此前全是 0，原因是双重的：
  `get_history` 的 `run_stats` 是空对象、消息也不带 run_id。pi 持久化的每条 assistant
  消息自带真实 `usage`，据此：
  - `get_history` 按 assistant 消息重建 run_stats（run_id 用 provider 的 responseId），
    会话详情的统计行显示真实数字；
  - `session.list` 与 `stats.overview` 对无 ledger 记录的旧会话回退到从 transcript 求和；
  - 顺带修掉 `usage.cost` 解析 bug——pi 的 cost 是对象 `{...total}`，原先都读成 0。
- **实时路径改为扫消息**：逐事件累计不可靠（provider 只在最后一个 chunk 回传 usage，
  流式 message_update 未必携带）。run 开始时记录 transcript 长度，`run.finished` 到达时
  扫描本轮新增的 assistant 消息取权威 usage（pi 先更新 state 再广播给订阅者，时序安全），
  实测真实 DeepSeek run 的 `run.finished` 与 ledger 都记录真实 token/cost。
- **session.list 的 `??` 陷阱**：ledger 对某会话可能只有全 0 条目（脚本化/未捕获），
  那是真实对象而非空——`??` 不会 fallthrough 到 transcript。改为 ledger 全 0 时也回退
  transcript，最新会话的列表/悬停不再显示 0。

### 2.49 用户记忆系统

「记住用户信息、跨对话依然记得」。内核原有的 `save_note`/`list_notes` 是**手动**记事本
（模型主动存），本轮加的是**自动**记忆：

- **存储**：`src/memory/memory.ts`，`~/.gdou-agent/memory.json`，条目
  `{ key, value, category, source, updatedAt }`，原子写，同 key 覆盖。
- **自动提炼**：每次 run 结束后异步 `summarizeMemory`（不阻塞回复），把本轮对话喂给模型，
  要求输出 JSON 数组（key/value/category），去重后 upsert。只在有真实凭据、本轮有用户消息、
  文本足够时触发；失败静默，绝不打断已完成的一轮。
- **记忆注入**：`kernel/agent.ts` 装配时读 memory，`composePrompt` 追加
  「## User memory」段落，所以**每个新会话的模型一开场就知道已记住的事实**，
  CLI / 桥 / 自动化统一受益。
- **管理界面**：shell 侧栏「记忆」页——查看/编辑/删除/手动添加，按分类过滤；
  桥端 `memory.list` / `memory.update` / `memory.delete`。
- **实测闭环**（2026-09-24）：对话「我叫 Nala，用中文，在做 gdou-agent 项目」→
  自动提炼出 `user_name=Nala`（profile）、`user_language=中文`（preference）、
  `project_gdou_agent=…`（project）；新会话 system prompt 注入上述事实。
- **notes 打通**（2026-09-26）：手动的 `save_note`/`list_notes`（notes.json）此前与
  memory.json 是两套独立系统，模型手动存的事实（如「用户叫沈哥」）不会进入注入。
  现在 `memoryPromptBlock` 合并两处渲染进同一段 User memory，`summarizeMemory` 的
  已有记忆也含 notes（提炼时不再重复生成同一条）。实测：notes 的 3 条（含「沈哥」）
  全部出现在新会话 system prompt。
- **同 key 合并去重**（2026-09-26）：同一事实可能同时存在于 memory（自动提炼）与
  notes（手动更正），直接拼接会在 prompt 出现两行矛盾的同名事实。`memoryPromptBlock`
  改为按 key 合并，**notes 覆盖 memory**——手动更正必须压过自动提炼。

### 2.50 思考块 UI 修复与优化

对话中模型的思考内容此前有两个问题：展开后与正文重叠、思考与正文视觉区分度不足。

- **重叠根因**：`ActivityPhase` 根元素的状态 class `thinking` 与 `workbench.css` 全局
  `.thinking`（composer 思考等级按钮的 `display:inline-flex; height:30px;
  align-items:center`）同名冲突——展开的 body 作为 flex 项在 30px 高的行上垂直居中，
  向上溢出约 205px 覆盖上方用户气泡。修复：状态类改名 `has-thinking`，并给
  `.activity-phase` 显式 `display:block; height:auto`（scoped 特异性覆盖全局裸类，
  防御同类冲突）。
- **视觉优化**（参考 WorkBuddy 思考块）：展开的思考区带独立「思考」标签行（脑图标 +
  `timeline.thinking.label`），思考全文在独立的浅灰容器中展示（不透明背景、1px 边框、
  圆角 8px、max-height 260px 滚动），与工具调用区分层展示；展开过渡动画上限提高到
  2000px。
- **实测**（2026-09-26）：浏览器实测展开后 body 从 trigger 正下方正常向下展开，
  与用户气泡无重叠（展开顶 292 > 气泡底 210）；思考标签与容器样式清晰。

### 2.51 Git 提交流程落地

此前桥端对 git 写操作一律「诚实拒绝」：源代码管理页能看 diff 却无法暂存/提交。
本轮把五个写方法实现出来，用户在界面上的每次点击就是审批步骤：

- **change.stage / unstage**：逐路径 `git add` / `git restore --staged`，路径经
  `safeGitPath` 校验（拒绝绝对路径与 `..` 越界），失败路径单独回报。
- **change.discard / change.revert**：`git checkout --` 恢复工作区；需 `confirm`
  参数；已提交改动与未跟踪文件如实 blocked，不做越权操作。
- **git.commit**：`git commit -m`（execFile 传参，无 shell 注入，消息原样保留），
  返回哈希；空消息被拒。
- **change.list 契约补齐**：porcelain 的 X/Y 状态拆成 `index_status` /
  `worktree_status`（前端按此分组「已暂存/未暂存」，此前永远为空分组）；
  用 `git diff --numstat HEAD` 补 `additions/deletions`（文件级 +N −M 不再全 0）。
- **change.diff** 改 HEAD 优先（staged + unstaged 一起看），无 HEAD 时回退。
- **git.history** 支持 limit/skip 分页与 `has_more`。
- **实测**（2026-09-26）：隔离临时仓库 RPC 探针 14 项全过（含暂存分组、提交、
  回滚 blocked、绝对路径过滤）；真实项目 SourceControl 页显示真实增减数与分组。

### 2.52 自动更新（Tauri updater）

应用内一键升级的接线：

- `Cargo.toml` 加 `tauri-plugin-updater`；`lib.rs` 注册插件并新增
  `updater_configured` 命令（前端据此区分「未启用」与「检查失败」）。
- `tauri.conf.json` 写 `plugins.updater`：minisign **公钥** + GitHub release
  endpoints（`releases/latest/download/latest.json`）。
- 签名密钥对：`tauri signer generate` 生成到 `~/.gdou-agent/updater.key`（私钥
  绝不入库；丢失即无法再发布更新）。
- **发布脚本** `scripts/updater-release.mjs <version> <installer>`：签名安装包
  生成 `.minisig` 与 `latest.json`，三个文件一起传 release 即被应用内更新器发现。
  注意：`tauri signer sign` 在非交互（无 TTY）终端会静默挂起，脚本 8 秒超时后
  提示在真实终端手动执行。

### 2.53 会话工作目录切换与对话导出

- **移动到项目**：桥端 `session.set_workspace` 实现（此前拒绝）。`cwd` 在 agent
  上是 readonly，故用**同消息、同专家**重建 AgentSession 指向新工作目录并落盘，
  侧栏归属随之刷新；会话运行中拒绝切换。前端「项目」子菜单（SessionActions）
  早已就绪，直接接通。
- **导出对话**：会话菜单新增「导出对话」——`session.get_history` 拉完整消息，
  组装 Markdown（标题/会话 ID/导出时间，用户与 Assistant 分节，thinking 折叠为
  引用），Blob 下载为 `.md`。i18n zh/en 已补。

### 2.54 前端质量与用量/记忆增强

- **vue-tsc 类型错误清零**：从 60+ 归零。删除未接入的 `components/Workflow/*`
  （引用不存在的 `packages/protocol`，是死代码）；重建 `src/protocol.ts` 为最小
  传输类型（EventEnvelope/JsonRpcResponse/RuntimeEvent）；修 App.vue（setTimeout
  类型、flatMap 注解、changes 合并契约、dialog title）与 ModelConfig/Inspector/
  PipelineStream/useFocusTrap/ipc.ts 的边界类型。
- **记忆页**：卡片来源标签缺 `chat.` 前缀会显示原始键名，已修；列表按
  updatedAt 最新在前排序。
- **用量页月度预算**：设置美元预算（localStorage），按 byDay 聚合当月费用，
  进度条显示已用百分比，超支红色高亮 + 告警；zh/en i18n 已补。

---

## 3. 刻意不做的事

| 没做 | 原因 |
|---|---|
| 改 pi 源码 | 它是上游，改了就跟不进更新。唯一例外见下节 |
| 重写 pi 的内置工具 | 它们已处理好截断、变更排队、二进制检测、ripgrep 集成 |
| 备用屏 TUI | 会牺牲原生 scrollback / 搜索 / 复制 |
| 自己的 provider 抽象 | pi-ai 的 41 个 provider 已经可用，加一层只是转手 |
| 插件市场 | 本项目没有插件体系；扩展能力走技能与 MCP（桥端 `plugin.*` 诚实拒绝） |
| Electron 安装包 | 随方案B 下线；当前形态是 bridge + shell 双进程，需要安装包时再恢复打包链路 |

---

## 4. 踩过的坑（下次直接用）

### 4.1 pi 的 `stripTerminalSequences` 有 bug，不要用它读 TUI 输出

`packages/tui/src/utils.ts` 里 `extractAnsiCode` 的 CSI 分支只在 `[mGKHJ]` 处终止：

```ts
while (j < str.length && !/[mGKHJ]/.test(str[j]!)) j++;
```

而 `TuiMainScreen` 包裹渲染用的同步输出序列是 `\x1b[?2026h`——终止字节是小写 `h`，不在集合里。于是它会一路吃到下一个 `m`，实测把 `\x1b[?2026hpi-agent  custom` 整段吞掉。

**正确做法**：自己用完整 ECMA-48 终止字节范围剥：`/\u001b(?:\[[0-?]*[ -/]*[@-~]|\]...)/g`。

**不要改 pi**：`extractAnsiCode` 被 `visibleWidth` / `truncateToWidth` 共用，改终止字节集合会影响 pi 自己的换行行为。

### 4.2 假终端必须逐字符投递输入

真实 `ProcessTerminal` 用 `StdinBuffer` 把一批字节拆成单个按键事件。假终端如果把 `"hello\r"` 当**一个字符串**交给 handler，编辑器会把 `\r` 当成文本插入而不是提交（实测现象：`getText()` 返回 `"run the probe\r"`）。

正确做法：`for (const ch of data) handler(ch)`。

### 4.3 渲染有 16ms 节流

`TuiBase.MIN_RENDER_INTERVAL_MS = 16`。工具在一个 tick 内同步发完所有 `onUpdate` 会被合并成**单帧**——这是正确行为。想验证"实时增量输出"，必须让工具在 update 之间 `await` 一下，否则断言会失败，而且失败原因是**测试写错了**，不是代码错了。

### 4.4 工具最终结果会覆盖流式输出

`ToolCallView.finish()` 的规则是"有内容就覆盖"，与 pi 内置 bash 工具的约定一致（最终结果就是完整输出）。写自定义工具时，**最终返回必须包含流式内容**，否则流式输出会被一个摘要替换掉。

### 4.5 Windows 上 `tsgo` 不能通过 `.bin` 跑

`node node_modules/.bin/tsgo` 会执行 POSIX shell 脚本，报 `SyntaxError: missing ) after argument list`。要用真实入口：

```
node node_modules/@typescript/native-preview/bin/tsgo.js
node node_modules/tsx/dist/cli.mjs
```

### 4.6 目录改名会被句柄挡住

改名一个被进程持有句柄的目录，Windows 会返回"访问被拒绝"，而且**子项能单独改名、父目录不能**——这个组合是判断"锁在目录级而非文件级"的特征。

绕过办法：`mkdir` 新目录 → 把子项逐个 `Move-Item` 过去 → `rmdir` 空壳。因为子项的改名不受目录级句柄影响。

### 4.7 打包时的下载几乎必然卡在 GitHub

`electron-builder` 和 `@electron/get` 默认都从 GitHub releases 拉二进制（Electron 本体 120 MB、NSIS 工具链、winCodeSign）。国内网络下这一步会失败，而且**失败信息具有误导性**：表面看是 `502 Bad Gateway`，实际是本地代理拒绝转发。

关键线索在 `DEBUG='*'` 的输出里：`https-proxy-agent Creating new HttpProxyAgent instance: 'http://127.0.0.1:61825/'` —— 请求是走代理的，代理对 GitHub 的大文件下载返回 502。

**补一个更精确的诊断**（2026-09-23）：失败的那次请求不是二进制，而是**校验文件**。日志顺序是 `downloaded label=electron progress=100%` 然后才 `502`，看起来像"Electron 下好了、后面某步坏了"，实际是 Electron 的 zip 命中本地缓存、根本没过网，过网的是 `@electron/get` 去取 `SHASUMS256.txt`——一个几 KB 的文本，缓存里没有，只能现拉。

这个顺序误导性很强，排查时值得记住：**看到 `progress=100%` 之后的 502，先怀疑校验文件而不是大文件。** 验证方法很直接——分别 curl 两个地址：

```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://github.com/electron/electron/releases/download/v44.4.3/SHASUMS256.txt   # 000，不可达
curl -sSL -o /dev/null -w "%{http_code}\n" https://npmmirror.com/mirrors/electron/44.4.3/SHASUMS256.txt                  # 200
```

两个镜像环境变量，都必须设：

```bash
export ELECTRON_MIRROR="https://mirrors.huaweicloud.com/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://mirrors.huaweicloud.com/electron-builder-binaries/"
```

`ELECTRON_MIRROR` 对 `npm install electron` 和 `electron-builder` 都生效；只设后者是不够的，`electron-builder` 会独立再下一次 Electron。

另外注意 `npm install electron` 的安装脚本失败时**不会让 install 整体失败**——`node_modules/electron/` 会装好但 `dist/electron.exe` 不存在，`path.txt` 是空的。要单独补跑：

```bash
node node_modules/electron/install.js
```

### 4.8 asar 里跑 CJS 主进程是没问题的

打包前担心 Electron 从 asar 归档里加载主进程会出问题，实测**没问题**：`app.asar/dist/main.cjs` 正常加载，渲染进程也从 `app.asar/dist/renderer/index.html` 正常加载。

前提是 `dist/` 放在 asar 根下一层，且 `package.json` 的 `main` 指向 `dist/main.cjs`。

（早期版本用的是 ESM，在 asar 里同样能加载。换 CJS 的原因见 2.12，与 asar 无关。）

### 4.9 `PROJECT_ROOT` 在打包后是对的，不用改

一个曾经误判的点，记下来免得以后又去"修"它。

`PROJECT_ROOT = resolve(dirname(import.meta.url), "..")`。打包后 `import.meta.url` 指向 `resources/app.asar/dist/main.cjs`，上一级正是 `resources/app.asar` —— 也就是应用根目录，`package.json` 所在处。**结果是对的**。

开发态同理：`src/paths.ts` 和 `dist/main.cjs` 都在项目根下一层，所以两种模式都落在同一个位置。真正需要在打包后改口的是 `VENDOR_PI_DIR`：打包后没有独立源码树，源码已内联，报一个不存在的路径就是撒谎。这一处收敛在 `describePiSource()` 里，CLI 和 GUI 共用，避免两边说法不一致。

### 4.10 项目里存在 `node_modules/electron` 时，`require("electron")` 可能拿到的是路径字符串

`node_modules/electron/index.js` 导出的**不是** Electron API，而是 **electron 可执行文件的路径**（那个包就是给 `electron .` 这类启动器用的）。正常启动 app 时 Electron 会拦截 `require("electron")` 并返回内置模块（`require.resolve("electron")` 会返回裸名 `electron` 而不是路径，可以据此判断拦截生效了），所以平时不会踩到。

但**如果 `NODE_OPTIONS` 里带了 `--require <某个钩子>`**，那个钩子会在 app 入口之前运行，可能把 npm 那个包灌进 require 缓存，于是 bundle 里的 `require("electron")` 拿到字符串，应用在 `app.whenReady()` 上直接崩：

```
TypeError: Cannot read properties of undefined (reading 'whenReady')
```

报错信息完全不提 electron 解析，极具误导性。Electron 对打包后的应用会忽略大部分 `NODE_OPTIONS`，所以**只有开发态会中招**。

**还有一个同源的变量：`ELECTRON_RUN_AS_NODE`。** 它比 `NODE_OPTIONS` 更绝对——置上它之后 `electron.exe` **根本不启动 Electron**，而是把自己当普通 Node 跑。于是 `require("electron")` 直接就是那个 npm 包，`app` 是 undefined，进程在模块求值阶段就死掉，连窗口都没开：

```
TypeError: Cannot read properties of undefined (reading 'isPackaged')
```

这个坑是 vendoring 之后跑全链路验证时才暴露的，而且**症状指向完全错误的方向**：`check:gui` 报的是 `the app exited before it opened a window`，看起来像竞态或者刚构建完的产物有问题。实际规律是"前面紧跟一次 `npm run build` 就必挂"，因为那个组合恰好走了需要提权、从而继承完整父环境的分支——而**任何基于 Electron 的宿主**（编辑器、agent 运行环境）都会导出这个变量，它不是本项目产生的。

所以 `check:gui` 给派生的应用进程显式清空 `NODE_OPTIONS` **和** `ELECTRON_RUN_AS_NODE`：自检应该控制它启动的那个进程的环境，而不是继承当前 shell 的。删 key 而不是置空——空字符串仍然算"已设置"，照样复现，会让修复看起来无效。

**但这个修复当时只覆盖了 `check:gui`。** `npm run gui`——真正给人用的那个入口——仍然是 `electron .`，于是**从编辑器内置终端里跑会直接崩**，报的就是上面那句 `isPackaged`。这等于把坑留给了唯一会踩到它的人：自检跑在受控环境里、由脚本清理；人是坐在 VS Code / Cursor 的终端里敲命令的，而他从来没设过这个变量。

现在 `npm run gui` 走 `scripts/launch-gui.mjs`，删掉同样的两个变量再把 Electron 派生出去。教训是**这类环境泄漏要修在离用户最近的那一层**：只修在自检里会让 CI 变绿而用户照崩，而"自检通过"反而成了这件事没被发现的理由。

### 4.11 排查这类问题的有效手段

上面几条的共同点是：**症状和原因离得很远，而且报错信息指向错误的方向**。几个实际有用的手法：

- `DEBUG='*'` 能直接把请求的 URL、走的代理、解析的路径打出来。打包失败和 `@electron/get` 的问题都是这么定位的。
- 怀疑模块解析时，在**目标环境里**打印 `typeof require("electron")`、`require.resolve(...)`、以及 `Object.keys(require.cache)`。把探针放进项目目录和放进临时目录各跑一次，差异会直接暴露出来。
- 二分定位：把可疑的产物复制到一个干净的 app 目录里单独启动，能立刻区分"产物有问题"还是"启动方式有问题"。
- 症状随 bundle 内容变化而出现/消失时，别急着怀疑竞态——先把两次产物 diff 一下，往往是某个模块的求值顺序变了。

### 4.12 `npm install` 之后 `node_modules` 可能留下半删除的文件

在带"安全删除"拦截的环境里跑 `npm install`，删除阶段可能被拦下（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`）。npm 的删除是**先改名再删**，被拦时文件已经改名成了 `index.js.DELETE.<32位hash>`，于是包看起来装好了、实际上入口文件不存在。

症状是下游报一个毫不相干的错：

```
Cannot find module '.../node_modules/builder-util/node_modules/http-proxy-agent/dist/index.js'
```

排查：`find node_modules -name "*.DELETE.*"`。修复：把每个 `x.DELETE.<hash>` 改回 `x`（这次是 5 个文件）。`node_modules` 是可重建目录，改回名字是恢复而不是删除，不碰任何用户数据。

`node_modules/.<pkg>-<hash>` 是同一批删除留下的暂存目录，npm 会忽略它们，可以不管。

---

## 5. 现状

**内核层已完成并验证**：模式系统、工具、CLI、TUI、离线验证套件、工具链目录隔离、
**pi 源码 vendoring**、**组合模型 + 专家**、**模式改成数据**、**重复调用守卫 / 备用模型 /
按模式选模型**、**权限门 + 命令检查器**、**技能渐进式披露**、**子代理**、**MCP（含 I4 审批）**、
**提问机制（ask_user）**、**自动化（定时任务）**。

**GUI 层现状（2026-09-24）**：Electron 桌面版**已下线**，当前交付物是 **shell（Vue3 + Vite）
+ bridge（JSON-RPC over WebSocket 7438）** 双进程形态（`npm run dev:shell` 一起启动）。
`renderer/`、`electron/` 仍在仓库作为历史存档，不再是交付物；`check:gui`（离屏自检）、
`scripts/build.mjs` 打包链路、`electron-builder.yml` 随 Electron 一起退役。

- `typecheck` 干净；`check:vendor`、`smoke`、`check:tui`、`check:tools` 全通过（`npm run check` 一次跑完）
- **项目已自持**：pi 源码在 `vendor/pi`，工具链（`tsx`、`tsgo`）在本项目 `node_modules`，`package.json` 里没有任何路径指回 `../pi-main`
- `vendor:pi` 重跑幂等：701 文件重拷后 `check:vendor` 仍 701/701
- `npm run smoke` **362 条断言**：上下文裁剪、专家收窄、模式数据、重复调用守卫、备用模型、
  按模式选模型、MCP 客户端与配置、以及本轮新增的 **MCP 审批门 4 条**（未批准不挂载 /
  已批准挂载 / 门禁报告 / 坏 server 不致命）
- **桥接层**（方案B）是当前 GUI 的全部后端：63 个方法映射内核能力，事件翻译、会话持久化
  （每次 run 落盘、桥重启自动重建）、断线自动重连（指数退避，实测杀桥后 12 秒内恢复）
- **阶段3 独有能力 UI**（2026-09-24）：MCP 工具徽标（紫色 server 徽标）、专家选择器 +
  会话头专家徽标、备用模型配置下拉、上下文占用条（SessionStatsLine）、变更追踪
  （EditedFilesCard）——对照第 1 节总表逐项核对，Electron 专属行已标注下线
- **自动化**（2026-09-24）：`src/automation/schedule.ts` + 桥端 `schedule.*` 全实现 +
  运行时 60s 调度器；无人值守 read-only；实测 CRUD/pause/run/delete 通过
- **提问机制**（2026-09-24）：内核 `ask_user` 工具 + 桥端 question 通道；真实模型闭环
  实测通过（模型提问 → shell 弹窗 → 回答 → 模型继续）
- **用量统计**（2026-09-24）：`usage.ndjson` 落盘 + `stats.overview` 聚合 + shell 用量页
  （总览卡片 + 按模型/按日期明细）；会话统计行的 token 是真实数字不再是 0
- **用户记忆系统**（2026-09-24）：自动提炼 + 注入 + 记忆页管理，跨对话记住用户信息，
  实测闭环通过

**未验证**：

1. **真实终端里的 TUI 交互**。开发环境没有 TTY，渲染靠录制终端验证，键盘靠模拟按键验证。
2. **接真实 provider 的对话**。`smoke` 只在有 key 的机器上跑真实请求；新克隆仓库无 key 时
   相关断言按环境跳过。真实 429 / 502 的错误形状仍需真实 key 复验。
3. **非 Windows 平台**。抓取脚本只钉了 win32-x64 的资产，其他平台会明确报错而不是装错二进制。
4. **shell 的实际观感**。断言读的是 DOM 文本和布局属性，不是截图。

**下一步**：

1. **真实 provider 上验证备用模型**（2.33）。它正是「provider 抖一下整轮就没了」那个场景的
   解法，而脚本化运行永远复现不出真实的 429 / 502。
2. **插件体系**（如有需要）。桥端当前诚实拒绝 `plugin.*`——本项目没有插件体系，
   扩展能力走技能与 MCP；若将来要插件市场，从桥端的 `plugin.*` 方法开始。
