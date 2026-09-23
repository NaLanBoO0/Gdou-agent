# 方案 B：新外壳（Vue3） + 接 pi 内核

>。2026-09-23 用户拍板选 B，选「先浏览器 dev 验证桥」（选项1）。
> 一句话：用 该外壳 的 `desktop/`（Tauri2 + Vue3）当外壳，删掉它接自己后端的适配层，
> 换成接我们自己的 pi 内核（TypeScript，跑在 Node/Electron 里）。前端观感 1:1，内核还是自己的。

## 阶段 1 已落地（2026-09-23 深夜）

- **桥服务端** `bridge/server.ts`：`ws` 库在 7438 端口跑 JSON-RPC 2.0，包 pi 内核。
  已实现 `core.ping` / `event.subscribe` / `session.create` / `session.send_message` / `run.cancel`。
  pi 事件 → 该外壳 事件映射：run_start→run.started、text_delta→llm.token、
  thinking_delta→llm.thinking、tool_start→tool.call_started、tool_end→tool.call_finished、
  run_end→run.finished、notice/error→log.line。无 key 时自动走脚本化传输。
  `npm run bridge` 启动。**探针已验证完整闭环**（`scripts/probe-bridge.mjs`）。
- **前端** 移植到 `shell/`：拷 该外壳 `desktop/src` + `index.html` + `vite.config.ts` +
  `tsconfig*` + `packages/protocol/src`（纯类型，2 文件，`protocol.ts` 相对路径 `../../packages/...` 正好命中）。
- **改了两处**：① `shell/src/lib/ipc.ts` —— `IpcClient` 在 `!IS_TAURI` 时走 WebSocket 直连
  `ws://127.0.0.1:7438`（`connectWebSocket` + `request` 里 `socket.send` + `receive` 走 onmessage），
  Tauri 分支原样保留；② `shell/src/services/gdou-runtime.ts` —— `waitForDaemon` 在浏览器模式跳过
  （不 `invoke("daemon_start")`），import 加 `IS_TAURI`。
- **已验证**：`npx vite build` 2273 模块零错误；`npm run dev:shell` 一键起双服务后
  桥 426（WS 就绪）+ vite 200 + `scripts/probe-bridge.mjs` 完整闭环通过。
- **一键启动**：`npm run dev:shell`（`scripts/dev-shell.mjs`）同时起桥（7438）和 vite（5173），
  桥先起、延迟 1.5s 再起 shell，Ctrl+C 同时停。**别再让用户分两个终端跑**——漏起桥的症状是
  前端报 "本地服务未连接"，看不出真正原因。
- **修掉的真 bug**：`session.create` 走脚本化传输时漏传 `options.model = scripted.model`，
  无凭据机器上 `createAgent` 解析不出模型、session 建不起来。

关键结论（别重新踩）：
- 前端对 `packages/` 的依赖**只有 `src/protocol.ts` 一处**（`export * from ../../packages/protocol/src/{index,workflow}`），
  且 protocol 是纯类型、零 import。移植只需拷这两文件。
- 前端启动必经路径只有 `connectRuntime()` → `waitForDaemon()`（已跳过）+ `client.connect(127.0.0.1,7438)`。
  App.vue 里其余的 `invoke(...)`（open_path_with_app、create_persistent_worktree 等）都是
  特定交互才触发，阶段 1 不会点到，属阶段 2/3 适配范围。
- `tauri-shim.ts` 的 `IS_TAURI = "__TAURI_INTERNALS__" in window`，浏览器 dev 下为 false。

## 为什么是 B 而不是 A

- **A（整套改用外部内核）** = 放弃 pi 内核，维护 该外壳 整套 monorepo
  （`packages/` 里 agent-core/ai/server/session/session-fs/protocol/telemetry/cli/client/evaluation）
  + Rust 后端 + `runtime-ts`（@typesafe-ai/sdk + @xenova/transformers 本地推理）+ Python runtime
  + 微信桥 + OCR + 浏览器 MCP。代价是换掉整个 agent 引擎，工作量和风险都最大。
- **B（用其外壳 + 重写适配层）** = 前端 3.6 万行白拿（观感、动效、布局全保留），
  只重写"前端↔后端"这一段适配层。内核还是 pi（我们所有已落地能力都不丢）。

## 已查实的架构事实

1. **协议**：MIT，可自由使用、修改与分发。
2. **该外壳 不是前端项目，是完整 monorepo**：`desktop/` 只是壳，能力在 `packages/`。
3. **前端↔后端的桥很薄**：
   - `desktop/src/lib/ipc.ts`（124 行）：`IpcClient` 发 JSON-RPC 2.0，走 Tauri
     `invoke("ipc_send"/"ipc_connect")` 到 Rust，Rust 再连一个独立本地 runtime 进程（host:port）。
   - 事件走 `gdou:message`，信封是 `{ kind: "event", event: RuntimeEvent }`。
   - `desktop/src/services/gdou-runtime.ts`（646 行）：前端唯一调用后端的地方，封装了
     **57 个 RPC 方法**（下面列出）。
   - `tauri-shim.ts`（117 行）：非 Tauri 环境（纯浏览器 dev）下的空实现，说明前端可以脱离
     Tauri 跑在浏览器里——这对桥接是利好。

## 前端调用的 57 个 RPC 方法（适配层的工作清单）

```
event.subscribe
workspace.{list,open,archive,delete,pin,resume}
session.{list,create,resume,close,archive,delete,pin,rename,fork,compact,
         send_message,set_workspace,steer_message,get_history}
run.{cancel,replay}
file.{read,search}
git.{commit,history}
change.{list,diff,stage,unstage,discard,revert}
provider.{status,model_list,model_save,model_delete,model_select,model_test,
         ccswitch_list,ccswitch_apply}
skill.{list,install,uninstall,set_enabled}
plugin.{list,install,catalog}
schedule.{list,create,update,delete,pause,run}
artifact.list
question.{pending,respond}
permission.respond
settings.{get,update}
operation.list
```

## 我们的 pi 内核现状（要接进去的东西）

- **事件**：`run_start / text_delta / thinking_delta / tool_start / tool_end / tool_update /
  assistant_start / assistant_end / turn_end / run_end / context_status / notice / error / user_message`
- **Session 方法**：`prompt(text)`、`subscribe(listener)`、`abort()`、`contextStatus()`、`dispose()`
- **工具**：read/bash/edit/write/grep/find/ls/present_files/web_search/web_fetch/load_skill/delegate
  + 刚加的 MCP 工具（`mcp__<server>__<tool>`）
- **已落地能力**（都必须在桥接层保住）：权限门、产物交付、变更追踪、专家收窄、技能、MCP、
  备用模型、循环守卫、上下文裁剪、观测、会话持久化。

## 分阶段计划

### 阶段 1：桥接层骨架（先证明"前端能跑，内核能说话"）
- 把 pi 内核包成一个 JSON-RPC 2.0 服务（说 该外壳 那套方法名），先只实现最小闭环：
  `session.create` / `session.send_message` / `event.subscribe` / `run.cancel`。
- 前端 `gdou-runtime.ts` 改指向这个服务（或走浏览器 dev 模式的 shim 直连）。
- **验证**：该外壳 外壳里能发一条消息，pi 内核真的回，流式文本出现在界面。

### 阶段 2：把 57 个方法逐个映射到 pi 能力
**第一批已完成（启动集，2026-09-23）**：`workspace.list`、`session.list`、`settings.get`、
`provider.status`、`question.pending`、`operation.list`。这 6 个是 `App.vue` 的 `refreshIndex()`
用 `Promise.all` 并发调的，任一 reject 整个初始化就崩、界面全空，所以优先级最高。
`scripts/probe-boot.mjs` 6/6 通过，数据全部来自 pi 内核真实状态（会话/skills/model/凭据状态）。
**适配妥协**：前端 `provider` 类型强绑 `"anthropic"|"openai"`，我们报 `"openai"`（代码已注释标明）。

**第二批已完成（会话生命周期）**：`session.get_history` / `session.rename` / `session.delete` /
`session.archive` / `session.pin`。
- `get_history` 用 `blocksToText` 转纯文本并 **过滤 system 消息**（否则界面第一条"对话"是系统提示）。
- `archive`/`pin` **不做**：我们是磁盘扁平列表、无这两个标志，假装支持会让徽章显示一次下轮消失。
  诚实返回空，比伪造更可取。
- 验证探针 `scripts/probe-session.mjs`（用**真实存储会话**验，不用 fixture）：
  4 会话 / 37 条历史消息 / rename 生效 / 原标题还原。

**第三批已完成（文件 + git 只读）**：`workspace.tree` / `file.read` / `file.search` /
`workspace.status` / `change.list` / `change.diff` / `git.history`。
- 文件操作**复用内核工具**（`resolveTool("read"/"ls"/"grep")`），不自己写 fs——否则要重复实现
  二进制检测/截断/ripgrep 集成，漂移的那份会先出事。
  `workspace.tree` 例外：额外 `readdirSync` 拿结构化节点，**不解析 `ls` 的展示文本**
  （解析展示输出等于把 pi 的排版格式变成我们的依赖）。
- git 用 `git` CLI 做**只读**（status/diff/log）。
- **破坏性 git 刻意不做**：`git.commit` / `change.stage` / `change.unstage` / `change.discard` /
  `change.revert`。它们从界面一键改写用户工作树、中间没有审批环节（阶段 2 还没做 I4）；
  前端对 `-32601` 已有友好兜底文案，诚实拒绝优于接一个能丢掉未提交工作的按钮。
- 探针 `scripts/probe-files.mjs` 用真实目录验：19 节点 / package.json 3110 字符 / 分支 main /
  24 个改动文件 / 6 条真实提交 / 三个破坏性方法均被拒。

**第四批已完成（产物 + 技能 + 模型）**：`artifact.list` / `skill.list` / `provider.model_list` /
`provider.model_select`。
- `artifact.list`：从 `present_files` 的 tool_end 结果里捕获真实交付（内存态，重启即失，
  代码注释已标明；没有持久化产物存储前不伪造）。
- **修掉一个真 bug**：桥创建脚本化 session 时给 `scriptedRun` 传的工具名硬编码成
  `["current_time","ls"]`，**不含 `present_files`**，于是脚本化运行永不演示产物交付、
  产物面板永远空。改成从模式真实工具列表取（`getProfile("general").tools()`）。
  修后实测：发消息 → 真实交付 README.md（46759 字节）→ `artifact.list` 捕获到。
- `skill.list` → `loadSkills(cwd)` 真实技能（git-commit、write-readme）。
- `provider.model_list` 只列当前配置的 model（1442 个内置全列进选择器只会变成没法用的长列表）；
  `model_select` 写设置但不重建会话（每次点击重建会打断正在进行的对话）。
- 探针 `scripts/probe-artifacts.mjs`。

**第五批已完成（剩余会话动词 + 设置）**：`settings.update` / `session.close` / `session.resume` /
`session.steer_message` / `session.fork` / `session.compact` / `run.replay` / `workspace.profile`。
- **修掉一个可用性真 bug**：`resume` 原先只返回快照、不把会话放进内存 `sessions` map，
  于是**从历史列表点开的会话（以及 fork 出来的）一律无法继续对话**（"unknown session"）。
  抽出 `buildSession(messages)` 后，resume 会用存储的 transcript 播种并真正建会话。
  **教训：resume 的语义是"让它可对话"，不是"返回它的描述"。**
- `steer_message` 复用 send 路径（pi 无抢占机制，诚实当作普通消息）。
- `fork` 复制 transcript 建新会话（`through_run_id` 被忽略并注明：我们不按 run 索引消息）。
- `compact` 只**报告**上下文状态、不真的压缩（我们是无摘要的运行时裁剪，编造摘要会让界面以为
  transcript 变小了）。
- `workspace.profile` 只读 package.json 的 name/description，不做框架检测（猜出来的结构会变成
  用户当事实读的面板内容）。
- 探针 `scripts/probe-rest.mjs`（fork 后列出、复制 37 条消息、resume、steer、删除还原，不留痕迹）。
- `session.*` → 我们的会话持久化（`kernel/sessions.ts`）
- `file.*` / `git.*` / `change.*` → 我们的工具（read/ls/grep + changes.ts）
- `provider.*` → 我们的模型与凭据（credentials.ts / runtime.ts）
- `skill.*` / `artifact.*` / `permission.*` / `question.*` → 我们的技能/产物/权限门
- `schedule.*` / `plugin.*` / `operation.*` → 我们还没做的，先返回空/占位

**第六批已完成（模型档案 + 技能管理，2026-09-24）**：`provider.model_save` /
`provider.model_delete` / `provider.model_test` / `skill.install` / `skill.uninstall` /
`skill.set_enabled`，并重做 `provider.model_list` / `provider.model_select` / `skill.list`。
- **模型档案 = 命名的 spec**（`{id, name, model: "provider/modelId"}`，存 settings.modelProfiles）。
  编辑器里的 API 地址/采样旋钮描述的是我们没有的运行时，只有 spec 是能存能复用的，
  所以档案就只存 spec。保存即设为当前（`settings.model = spec`）——编辑器的「保存并使用」
  语义就是切换，不切会让保存看起来没反应。`model_select` 按档案 id 查找；`model_list`
  返回档案 + 当前模型（当前不在档案里时合成一行，选择器永远看得到会话将用的模型）。
- **spec 解析规则（specFromInput）**：带 `/` 直接作为 spec；裸 id 全目录唯一 → `provider/id`，
  多 provider 同名 → 拒绝并要求写全（猜错会静默测到另一个服务商），查无 → 点名报错。
- **model_test → `src/kernel/runtime.ts` 的 `testModel(spec, {apiKey})`**：极小请求
  （maxTokens 32）+ 与真实会话同一条传输路径；传了 api_key 用临时 InMemory 存储，
  否则用真实存储/环境。无 key 时**先于网络请求**返回「未配置 API key（DEEPSEEK_API_KEY）」
  ——不去等 provider SDK 把同一事实扔出来。其余失败原样透传 provider 文案（错 key/坏
  模型/网络错误都是用户能行动的真答案）。
- **skill.install = 复制目录**（`src/skills/registry.ts` 的 installSkill，scope 分
  workspace → `<cwd>/.gdou-agent/skills/` / personal → `~/.gdou-agent/skills/`）。
  安装前用现有解析器**先验证再复制**（坏的 SKILL.md 会拒绝而不是装上再报错）；已存在
  同 id 拒绝覆盖（覆盖是丢改动）。uninstall 内置技能拒绝；卸载后把该 id 从 disabled 里清掉。
- **skill.set_enabled → settings.disabledSkills**，内核 `loadSkills(cwd, disabled?)` 过滤
  目录（会话提示词目录和两个列表都过滤），但 `getSkill` 不滤——「停用」= 不再建议，
  不是忘记它存在，显式 load_skill 仍能读。**会话层接线**：`resolveSetup` 把
  disabledSkills 带进 assemble，会话提示词的技能目录同样受控（否则外壳关了、提示词还挂着）。
- **顺手修掉两个桥缺陷**：
  ① `provider.status.api_key_configured` 原先只数环境变量 key，无视凭据存储——用户刚
    保存的 key 界面仍显示「未配置」。改为 `presetsWithCredentials() || credentialStore().storedProviderIds()`。
  ② `useScripted()` 同病：只认 `DEEPSEEK_API_KEY` 环境变量，auth.json 存了 key 仍走
    脚本化假回复（Electron GUI 修过的同 class 的 bug，桥这边漏了）。改为无环境 key
    **且** 存储也为空才算 scripted。重启桥实测 `scripted=false`，真实对话闭环通过。
- 探针 `scripts/probe-models-skills.mjs`（模型方法 + 技能方法，全部带清理还原；
  技能用 workspace scope + tmp 源目录，探针结束 uninstall + 删 tmp 根目录不留痕）。
  回归：boot 6/6、session、files 5/5、rest、artifacts 2 件真实交付、对话闭环
  （真实模型流式回）、smoke 全绿（+8 条新断言）、typecheck 干净。
- **坑**：探针第一版技能 id 取源目录 basename（带 pid 后缀），断言全错位 + 遗留目录/
  settings 脏数据；改源目录为 `tmp/<pid>/probe-skill` 固定 id。`set_enabled` 第一版用
  **过滤后**的目录找刚禁用的技能 → 必然找不到返回 `{}`，改回全目录查行、enabled 由调用方决定。

**补记（2026-09-24，会话持久化 + 自动恢复——「发不出/收不到回复」的真根因）**：
- **根因**：桥的会话是**纯内存**的——`session.create` 和每次对话从不落盘（Electron GUI 有
  `persistSession`，桥没有）。于是：① 桥一重启，shell 里打开的所有会话全部变成
  `unknown session`，「历史对话能发出去但没回复」；② 新建任务创建的会话重启即失，
  「文字消失、不创建新对话」；③ 我的后台桥进程在会话轮次间被回收 + dev:shell 的
  端口复用逻辑让用户**以为**桥在跑其实用的是我的将死进程——多次叠加就是用户看到的现象。
- **修复**：① 新增 `persistLive()`（照 Electron 的 persistSession 形状：model/cwd/
  createdAt/messages 从 `session.agent.state.messages` 取），`session.create` 立即落盘、
  `send_message` 每次跑完落盘；② `handleSendMessage` 遇到内存没有的会话先 `loadSession`
  从磁盘重建——**用当前配置**重建，所以保存 key 后旧会话自动从 scripted 变真实、
  桥重启后旧会话直接可对话；③ LiveSession 记 createdAt，重存不覆盖创建时间。
- **验证**：探针A 建会话→立即在 session.list；发消息→历史 2 条。杀桥重启→**不 resume**
  直接向旧会话 id 发消息→自动恢复 + 真实模型回复（历史 4 条）。探针会话已删、不污染。
- **操作教训**：改完桥必须重启再测（旧进程假失败）；`has_api_key` 判定必须认凭据存储
  （否则编辑框重开显示「请输入 API Key」而不是「留空保持不变」，用户以为 key 丢了）。

### 阶段 3：把我们的独有能力补进前端
- MCP 工具结果、产物交付卡片、专家收窄、变更追踪、上下文指示器等，在 Vue 里补对应 UI。

### 阶段 4：打包 + 收尾
- Tauri 打包（替换掉现在的 electron-builder 链路），迁移数据格式，删掉旧 Electron GUI。

## 关键风险 / 待验证

1. **57 个方法里有几个是"假能力"**：`schedule` / `plugin` / `question` / `operation` / `git`
   我们内核未必有对应实现，需要决定是补能力还是先 stub。
2. **事件粒度不匹配**：该外壳 前端预期的事件（`RuntimeEvent`）和我们的 14 种事件需要映射表。
3. **本地推理**：该外壳 的 runtime 带 @xenova/transformers 本地模型；我们走 provider API。
   provider.* 映射时要决定是否保留本地推理。

## 决策点（开工前要用户定的）

- 阶段 1 的目标环境：先跑在**浏览器 dev 模式**（脱离 Tauri，最快验证桥），还是直接上 Tauri？
  建议先浏览器，桥通了再上 Tauri。
