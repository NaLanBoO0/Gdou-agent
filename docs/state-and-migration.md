# 状态文件与迁移

这份文档回答两件事：**运行时写下了哪些文件**，以及**换一台机器时该带走什么**。

## 状态在哪

所有状态都在**用户目录下**，不在仓库里。仓库是代码，状态是数据，两者刻意分开——
`git clean` 不该删掉你的对话。

| 路径 | 内容 | 该不该带走 |
| --- | --- | --- |
| `~/.gdou-agent/sessions/*.json` | **对话记录**，一段对话一个文件 | ✅ 要 |
| `~/.gdou-agent/settings.json` | 默认模式 / 专家 / 模型 / 备用模型 / 工作目录 / 权限档位 / 重复调用上限 | ✅ 要 |
| `~/.gdou-agent/notes.json` | `save_note` 工具存的事实 | ✅ 要 |
| `~/.gdou-agent/experts/` | 你自己写的专家（markdown） | ✅ 要 |
| `~/.gdou-agent/skills/` | 你自己写的技能（目录 + `SKILL.md` + `references/`） | ✅ 要 |
| `~/.gdou-agent/modes/` | 你自己写的模式（markdown） | ✅ 要 |
| `~/.gdou-agent/auth.json` | **API key**（明文；POSIX 下 0600） | ✅ 要 —— 不带走就得在新机器上重新填一次 |
| `~/.gdou-agent/logs/` | 崩溃报告 / 运行日志 / 堆报告 | ❌ 不要，诊断线索，可随时删 |
| `~/.gdou-agent/agent/bin/` | 托管下载的 `rg` / `fd` 二进制（约 9 MB） | ❌ 不要，会自动重下 |

`~/.gdou-agent` 可以用环境变量 `GDOU_AGENT_HOME` 改到别处。

### 两个容易踩的点

**凭据现在就在我们的目录里，这是刻意改的。** API key 存在 `~/.gdou-agent/auth.json`。
第一版放在 pi 的 `~/.pi/agent/auth.json`（也就是 `getAgentDir()` 的默认值），但那个函数
是从 `homedir()` 推导的、**无视 `GDOU_AGENT_HOME`** —— 于是 `check:gui`（跑在一个临时 home 上，
存在的意义就是不碰真实状态）会去写你**真实的**凭据文件。**自检去改被检查的东西，比没有自检更糟。**
文件的**形状**仍然是 pi 的（`Record<providerId, Credential>`，由 `auth/resolve.ts` 读取），
只有路径换成我们自己的。

**`auth.json` 是明文。** 权限门禁止工具读写它，但它本身没有加密。
POSIX 上以 0600 创建；**Windows 上没有权限位**，`chmod` 只切只读位，回读永远是 0666 ——
那里保护它的是用户目录的 ACL。这一点写在代码注释里，也是一条按平台跳过的断言，
而不是一句做不到的承诺。

键存进去之后**优先于环境变量**（pi 的规则：存储的凭据*拥有*那个 provider）。
所以「我明明设了环境变量却没生效」的原因通常是**界面里存过一把** —— 去「设置」删掉它。
要带走就用安全的方式传，别丢进网盘或者聊天窗口。

## 迁移到另一台机器

### 最省事的做法：整个 `~/.gdou-agent` 拷过去

```bash
# 旧机器
#   打包（排除二进制缓存，它会自动重下）
tar -czf gdou-state.tgz -C ~ --exclude='.gdou-agent/agent' .gdou-agent

# 新机器
tar -xzf gdou-state.tgz -C ~
```

拷过去之后，新机器上的对话会直接出现在「历史」里。

### 只要对话、不要别的

```bash
# 旧机器
cp -r ~/.gdou-agent/sessions /path/to/transfer/
```

`~/.gdou-agent/sessions/` 是自包含的：一个文件就是一段完整对话，
里面带着当时的**模式 + 专家 + 模型 + 工作目录**。单独拷过去放进新机器的同名目录即可。

### 需要注意的

**工作目录不会跟着走。** 会话里记着创建时的工作目录（比如
`C:\Users\Na1aB\Desktop\gdou-agent`）。新机器上如果这个路径不存在，
恢复会话时工具会找不到目录。恢复之后在工作头里点一下目录名改掉即可。

**模型要重新配。** `settings.json` 里记的是 `provider/modelId`，
但 key 在 `auth.json` 里——不带走 key 的话，新机器上启动会报
「No model available」，并列出可用的环境变量。

**模式文件里也能写模型，而那是迁移时的一个坑。** 模式 frontmatter 的
`model:` 是一个**建议**（优先级最低）：

- spec **不存在**：会话启动直接报
  `Mode "x" names a model that does not exist: provider/model`，并点名文件。
  这是硬错误，因为一个模型名字写错的文件本来就该被发现。
- spec **存在但新机器上没配 key**：**不会报错，也不会回落**。
  `resolveDefault` 只查模型目录，不查凭据，所以模式点的那个模型会被用上，
  失败推迟到**第一次请求**才以凭据错误的形式出现。
  实测过：环境里一个 key 都没有时 `deepseek/deepseek-flash` 照样解析成功。
  反过来说，「模式压不过用户的选择」只体现在**优先级**上，不体现在「没 key 就换一个」上——
  这两件事容易混为一谈。

所以带模式文件过去时，要么把 `model:` 那行删掉，要么确认新机器上有对应的 provider。

**备用模型同理，而且它就是为「某个 provider 在今天不好用」准备的。**
`fallbackModel` 写一个**不同的 provider** 会更值：同一个 provider 的两个模型
在它整体过载时会一起挂。注意它只在**产出任何内容之前**的失败上生效——
回复已经开始流式输出之后的失败原样报出来，不会重写。

**专家的项目级覆盖不会走。** 三级加载是
`<工作目录>/.gdou-agent/experts/` > `~/.gdou-agent/experts/` > 内置。
只拷 `~/.gdou-agent` 带走的是用户级和内置的；项目级那些在各自的仓库里，
跟着代码走。

**模式同理**，而且这里更容易踩：模式决定会话**能做什么**。
如果一段对话用的是项目级模式 `<工作目录>/.gdou-agent/modes/reviewer.md`，
只带走 `~/.gdou-agent` 之后，新机器上恢复这段对话会报
`Unknown mode: reviewer` 并列出所有已知模式——
这是**故意的**：用一个工具集不同的模式去恢复，等于让 agent 重演一段它从没做过的对话。
把缺失的那个 `.md` 一起带过去就正常了。

## 文件格式

`sessions/` 下每个文件是 JSON，第一行是摘要、后面是完整记录——
**列表页只读第一行**，所以历史列表不需要把每个文件都读一遍。

```jsonc
// 第 1 行：摘要（列表页只读这 4096 字节）
{"id":"20260923-120822-1lgf","profile":"coding","expert":"security-audit","title":"…","updatedAt":"…","messageCount":12}
// 第 2 行：完整记录
{"version":1,"id":"…","model":"deepseek/deepseek-flash","cwd":"C:\\…","createdAt":"…","messages":[…]}
```

**一行一个 JSON 对象**：摘要行在前，所以历史列表不必把每个文件的正文都读进来。
`SUMMARY_BYTES = 4096` 是读摘要时只读的字节数。

`version` 是格式版本。**加可选字段不升版本**（老文件只是缺这个字段）；
只有不兼容的改动才升，那时会走迁移。

`expert` 就是这样一个可选字段：老会话没有它，恢复时按「无专家」处理，
**而不是回落设置里的默认值**——回落会让一个从未用过专家的会话凭空多出一个人格。

### 一处命名不一致（已知）

摘要里的字段叫 **`profile`**，但配方和设置里叫 **`mode`**。
两者指的是同一个东西（模式 id）。这是改名词汇时漏掉的一处——
存储格式没跟着改，因为改名要带回落读取，当时只处理了 `settings.json`。
不影响使用，但看文件时会觉得别扭。

**同一处不一致还有更大的范围**：代码里到处是 `profile`——
`AgentProfile`、`src/profiles/`、`--profile`、`--list-profiles`、IPC 的 `agent:profiles`、
界面里的 `session.profile`。而界面文案、`settings.mode`、`SessionRecipe.mode`
和「模式」这个说法，指的都是它。

**没有顺手改，是有意的**：模式层刚做完改造（`FEATURES.md` 2.31），
再叠一次跨二十多个文件的重命名会让这次的 diff 无法审查。
存储字段 `profile` 尤其要单独做——它需要带回落的读取路径。
