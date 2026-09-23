# GDOU agent 功能清单

在 pi 内核之上加了什么，以及每一项是怎么实现的。

规模：`src/` 3704 行 + `electron/` 581 行 + `scripts/` 2178 行 + `renderer/` 1548 行 = 8011 行。
**没有修改 pi 一行代码**（唯一例外是绕开它的一个 bug，见最后一节）。

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
| 11 | **桌面 GUI** | `electron/`、`renderer/` | 内核跑在主进程内；IPC 送探测结果；渲染进程零构建 |
| 12 | **可分发构建 + 安装包** | `scripts/build.mjs`、`electron-builder.yml` | esbuild 把 pi 源码内联成单文件；electron-builder 出 NSIS |
| 13 | GUI 离屏自检 | `scripts/gui-check.mjs` | 从外部启动真应用，用 CDP 把渲染后的 DOM 读回来断言 |
| 14 | 工具链目录隔离 | `package.json` 的 `piConfig`、`kernel/toolchain.ts` | 把 pi 下载 rg/fd 的位置从 `~/.pi` 挪到自己的 home |
| 15 | **随包分发 rg / fd** | `scripts/fetch-tools.mjs`、`kernel/toolchain.ts`、`electron-builder.yml` | 固定版本抓取 + 首启投放到 pi 会先查找的位置，免联网 |
| 16 | 工具级自检 | `scripts/tool-check.ts` | 真跑 grep/find/ls/read 对固定夹具，验证工具离线可用 |
| 17 | **对话界面** | `renderer/` | 事件驱动的消息流；流式文本、可折叠工具块；刻意零构建 |
| 18 | 脚本化运行 | `kernel/demo.ts` | fauxProvider 回放固定脚本，无凭据也能跑完整一轮 |
| 19 | **会话持久化与多会话** | `kernel/sessions.ts`、`kernel/events.ts` 的 `replay()` | 一段对话一个文件，两行 JSON（摘要 + 记录）；重启恢复；历史列表可切换、删除 |
| 20 | 工作目录选择 | `electron/main.ts`、`renderer/` | 系统目录对话框 + 持久化 + 会话重建；界面靠广播同步 |
| 21 | **上下文裁剪** | `kernel/context.ts`、`kernel/agent.ts` | 接 pi 的 `transformContext`，只裁发给模型的，不动记录 |
| 22 | 裁剪告知 | `kernel/events.ts` 的 `notice`、`renderer/` | 跨越预算时发一次提示；克制但看得见，不按错误样式 |
| 23 | 常驻上下文指示器 | `kernel/context.ts`、`kernel/agent.ts`、`renderer/` | 记录上次实际发送的量，仅在裁剪生效时出现在状态行 |
| 24 | 预览入口 | `electron/main.ts`、`renderer/` | 会话启动失败时提供按钮；预览从空白开始且不落盘 |
| 25 | 会话重命名 | `kernel/sessions.ts`、`renderer/` | 行内编辑；重写整个文件（标题在摘要行和记录行都有）；空名被拒绝 |
| 26 | pi 能力接线补全 | `kernel/agent.ts`、`config/settings.ts` | 设置真正生效；重试注入；缓存会话亲和；thinkingBudgets 透传 |
| 27 | **pi 源码 vendoring** | `vendor/pi/`、`scripts/vendor-pi.mjs`、`scripts/check-vendor.mjs` | 按依赖闭包拷入 6 个包（701 文件）+ sha256 清单；只读校验；外部依赖按 pi 的精确版本装进本项目 |
| 28 | **组合模型 + 专家** | `kernel/recipe.ts`、`experts/` | 会话 = 模式 + 专家；专家**只能收窄**工具集；markdown 三级加载；渐进式披露的前置 |
| 29 | **工作台外壳** | `renderer/`（tokens/shell/chat/panels 四个 CSS）、`electron/main.ts` | SztuCode 的设计语言：52px 自绘标题栏 + 240px 侧栏 + 主区；无边框窗口；右侧检查器；深浅两套主题 |
| 30 | **权限门 + 命令检查器** | `kernel/permission.ts`、`kernel/command-guard.ts`、`kernel/agent.ts` | 有序 5 阶段判定链（主轴是路径归属）；凭据禁读也禁写、任何档位不能越过；命令黑名单五类规则；接在 pi 的 `beforeToolCall` 接缝上 |
| 31 | **产物交付** | `tools/present.ts`、`electron/main.ts`（预览通道）、`renderer/` | `present_files` 只收绝对路径且全有或全无；产物渲染成卡片；检查器可预览（HTML 走全沙箱 iframe）；预览通道只放行本会话交付过的路径 |
| 32 | 单实例锁 | `electron/main.ts` | 第二个实例直接退出并把已有窗口拉到前台；两个实例会抢同一批会话文件 |
| 33 | **联网** | `tools/web-fetch.ts`、`tools/web-search.ts`、`tools/net-guard.ts` | `web_fetch` 用 readability + linkedom 抽正文（不执行 JS）；`web_search` 走 Brave / Tavily；SSRF 防护在入站与**每一跳重定向**都校验 |
| 34 | **变更追踪** | `kernel/changes.ts`、`kernel/agent.ts`、`renderer/` | 工具行显示 `+N −M`；`edit` 用 pi 的 diff，`write` 靠调用前快照算真实增减；无法比对时明确标注为近似 |

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

### 2.24 工作台外壳（照 SztuCode 重做界面）

**为什么是"重做"而不是"加个侧栏"**：原来的界面是一个单列对话页，所有东西挤在一列里——模式选择、工作目录、历史、诊断。功能都在，但没有地方安放"专家 / 自动化 / Skills"这三件正交的事，也没有地方显示"这个会话实际能用哪些工具"。外壳先立起来，功能才有位置。

**设计语言照 SztuCode**：配色、字号、间距、圆角、动效都从那边搬过来，所以两个应用看起来像同一个产品。外壳是 `grid-template: 52px minmax(0,1fr) / 240px minmax(0,1fr)`——标题栏横跨两列，侧栏可以收到 0 宽而主区不动。

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

**深浅两套主题**：`[data-app-theme]` 在 `<html>` 上，首次启动跟随系统，手动切换后记在 localStorage。SztuCode 默认浅色，所以浅色是默认；深色是一套真正的主题（自己的 surface/border），不是把颜色反过来。

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

## 3. 刻意不做的事

| 没做 | 原因 |
|---|---|
| 改 pi 源码 | 它是上游，改了就跟不进更新。唯一例外见下节 |
| 重写 pi 的内置工具 | 它们已处理好截断、变更排队、二进制检测、ripgrep 集成 |
| 备用屏 TUI | 会牺牲原生 scrollback / 搜索 / 复制 |
| 自己的 provider 抽象 | pi-ai 的 41 个 provider 已经可用，加一层只是转手 |
| MCP 支持 | pi 本身没有内置 MCP，需要扩展桥接。目前用不到，没做 |
| 会话持久化 | `~/.gdou-agent/sessions/` 已预留路径，未实现 |

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

**已完成并验证**：内核、模式系统、工具、CLI、TUI、离线验证套件、桌面 GUI、可分发构建与安装包、工具链目录隔离、**pi 源码 vendoring**、**组合模型 + 专家**、**工作台外壳**。

- `typecheck` 干净；`check:vendor`、`smoke`、`check:tui`、`check:tools`、`check:gui` 全通过（`npm run check` 一次跑完前四个）
- **项目已自持**：pi 源码在 `vendor/pi`，工具链（`tsx`、`tsgo`）在本项目 `node_modules`，`package.json` 里没有任何路径指回 `../pi-main`。产物里 `pi-main` 出现 0 次、`vendor/pi` 出现 345 次
- `vendor:pi` 重跑幂等：701 文件重拷后 `check:vendor` 仍 701/701，且手写的 `vendor/pi/README.md` 不被删除（脚本只删它自己管的条目）
- `npm run build` 835 ms 出全部产物，零警告
- `npm run smoke` 增加 **25 条上下文断言**：裁剪的不变量（见 2.19，含**预算小于一轮时仍然裁剪**这条回归守卫）、**超预算时发出一次 notice**、notice 措辞正确、**连跑两轮只发一次**、**`the transcript still holds everything`（25 → 28）——证明裁剪没有动记录**、`contextStatus()` 在首次请求前是 undefined、每次运行后跟随更新、最后一次与实际一致
- `npm run smoke` 另外增加 **37 条专家断言**（总数 52 → **89**）：收窄、**不能扩大**、空交集、提示词拼接、装配结果、`thinkingLevel` 优先级、未知 id 报错、以及项目级文件的发现/覆盖/报错/非 markdown 忽略。文件相关的断言跑在临时目录上，不碰用户真实数据
- **组合模型落地**：`SessionRecipe { mode, expert? }`；工具集取**交集**（专家只能做减法，安全属性）；专家三级加载（项目级 > 用户级 > 内置），内置的也走同一套 markdown 解析；`--list-experts` / `--expert` / `--list-tools -e` 可用；doctor 显示解析后的配方；会话记录带上 expert，恢复时按完整配方校验
- `npm run check:tools` 12 项通过：真跑 grep / find / ls / read 对固定夹具，不联网
- `npm run check:gui` **146/146 通过**（含 25 条外壳断言与 12 条专家断言）。修掉 4.10 的 `ELECTRON_RUN_AS_NODE` 泄漏之后，`npm run build && npm run check:gui` 连跑 3 次全通过（修复前这个组合 3/3 必挂）。它从外部启动真实应用（`electron .`），用 CDP 驱动**一轮对话 + 一次重启 + 一次换目录 + 一次多会话往返 + 一次裁剪 + 一次改名 + 一次切换专家 + 一次外壳巡检 + 一次无凭据预览**：发消息 → 等运行结束 → 读回 DOM → 断言落盘（含摘要行独立可用）→ 关掉应用 → 重新启动 → 断言对话完整恢复 → **压低预算再发一轮 → 断言提示出现且措辞正确、常驻指示器出现且数字是真实的分裂、同时界面上仍留着模型看不到的轮次** → 换工作目录 → 断言会话按新目录重建且设置落盘 → 开新对话 → **断言旧对话仍在** → 再跑一轮 → 断言两条都在列表里且标题取自用户消息 → 打开历史菜单 → 切回旧对话 → 断言恢复的是它自己的内容 → 删除一条 → 断言文件与列表同步 → **行内改名 → 断言空名被忽略、菜单显示新名、且新名确实落到了磁盘上的摘要行（通过重新 listSessions 证明，而不是只看菜单重画）、对话内容不受影响** → **第三次启动，故意不带脚本化环境变量 → 断言启动失败被如实报告、预览按钮出现、点进去真能跑一轮、状态行标明脚本化、且预览没有写进历史** → 最后打开诊断面板检查内核状态。它跑在临时 `GDOU_AGENT_HOME` 上，所以绝不会读到或毁掉真实用户的对话
- 打包后的 `GDOU-agent.exe` 实测启动成功：跑完整轮对话、重启恢复、切换工作目录、开新对话且旧对话保留
- 工具链目录已隔离：`~/.gdou-agent/agent/bin`，不再污染 `~/.pi`
- **全新机器场景实测通过**：删掉 `~/.gdou-agent/agent` 再安装启动，应用从 `resources/bin` 自举投放 rg + fd，工具随即可用
- 安装包 `release/GDOU-agent-0.1.0-setup.exe` 118 MB（含两个二进制），PE 头合法
- **完整链路实测通过**：构建 → 打包 → 静默安装 → 启动 → 对话 → 工具执行 → 重启恢复 → 换目录

**未验证**：

1. **系统目录对话框本身**。它是模态的，没有可脚本化的接口，所以只能把逻辑拆出来测（见 2.18）。对话框弹出、选择、取消这三个动作需要你手动点一次。
2. **真实终端里的 TUI 交互**。开发环境没有 TTY，渲染靠录制终端验证，键盘靠模拟按键验证。
3. **GUI 的实际观感**。断言读的是 DOM 文本和布局属性，不是截图。
4. **接真实 provider 的对话**。所有对话验证都跑在脚本化运行上，没有用真实 key 发过一次请求。
5. **非 Windows 平台**。抓取脚本只钉了 win32-x64 的资产，其他平台会明确报错而不是装错二进制。
6. ~~vendoring 之后的重新打包~~ —— **已解决（2026-09-23）**。见 4.7：失败的是校验文件而不是二进制，两个镜像环境变量设上之后 `npm run package:dir` 完整跑通，产物在 `release/win-unpacked`（`app.asar` 94.8 MB，`resources/bin` 带 rg / fd）。

   打包产物**已实测**：用 `--remote-debugging-port` 启动 `release/win-unpacked/GDOU-agent.exe`，读回 DOM 确认 `.sztu-shell`、`.sidebar`、`#inspector`、`.titlebar` 与四个导航视图（chat / experts / automation / skills）都在。这一点必须单独验：`check:gui` 驱动的是源码态的 `electron .`，它证明不了 `app.asar` 里那份 bundle——而桌面快捷方式启动的恰恰是后者。

**下一步**：

1. **接真实 provider 跑一轮**。所有对话验证都跑在脚本化运行上，没有用真实 key 发过一次请求。这一条需要你的 key，我没法自己完成。
2. **skills**（下一个）。渐进式披露是三个功能里唯一真正新的机制：会话开始时上下文里只有每个 skill 的**名字 + 一句话描述**，任务匹配后 agent 才调用 `load_skill` 把正文读进来。不这么做的话，几十个 skill 全文塞进系统提示就是几十万 token——正好把 2.19 的上下文裁剪省下来的预算又花回去。组合模型（2.23）已经把它要挂的位置留好了。按你的决定：**只允许说明和资源文件，不允许可执行脚本**（否则"安装一个 skill"就等于"安装一段可执行代码"）。
3. **自动化**。它本身就是「配方 + 提示词 + 触发时机」，前两样（组合模型、提示词）现在都在了。按你的决定：**只做运行时触发**（关掉程序就不跑，界面要明说），产出**单独一个概念**而不是混进历史。安全上 `allowWrite` 默认 false——无人值守的工具调用就是远程代码执行面，这和「专家只能收窄」是同一条原则。
