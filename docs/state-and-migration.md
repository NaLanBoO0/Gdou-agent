# 状态文件与迁移

这份文档回答两件事：**运行时写下了哪些文件**，以及**换一台机器时该带走什么**。

## 状态在哪

所有状态都在**用户目录下**，不在仓库里。仓库是代码，状态是数据，两者刻意分开——
`git clean` 不该删掉你的对话。

| 路径 | 内容 | 该不该带走 |
| --- | --- | --- |
| `~/.gdou-agent/sessions/*.json` | **对话记录**，一段对话一个文件 | ✅ 要 |
| `~/.gdou-agent/settings.json` | 默认模式 / 专家 / 模型 / 工作目录 / 权限档位 | ✅ 要 |
| `~/.gdou-agent/notes.json` | `save_note` 工具存的事实 | ✅ 要 |
| `~/.gdou-agent/experts/` | 你自己写的专家（markdown） | ✅ 要 |
| `~/.pi/agent/auth.json` | **API key**（pi 自己的位置，不是我们的） | ⚠️ 见下 |
| `~/.gdou-agent/agent/bin/` | 托管下载的 `rg` / `fd` 二进制（约 9 MB） | ❌ 不要，会自动重下 |

`~/.gdou-agent` 可以用环境变量 `GDOU_AGENT_HOME` 改到别处。

### 两个容易踩的点

**凭据不在我们的目录里。** API key 存在 `~/.pi/agent/auth.json`，因为那个位置由 pi
决定，我们只是没覆盖它。这意味着**这个文件和 pi 自己共用**——如果你同时用 pi，
删掉它会同时影响两边。

**`auth.json` 是明文。** 权限门禁止工具读写它，但它本身没有加密。
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

**专家的项目级覆盖不会走。** 三级加载是
`<工作目录>/.gdou-agent/experts/` > `~/.gdou-agent/experts/` > 内置。
只拷 `~/.gdou-agent` 带走的是用户级和内置的；项目级那些在各自的仓库里，
跟着代码走。

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
