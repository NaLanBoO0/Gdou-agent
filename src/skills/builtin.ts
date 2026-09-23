/**
 * Skills that ship with the agent.
 *
 * Deliberately stored as raw markdown and parsed by the same `parseFrontmatter`
 * that user directories go through, for the same reason the built-in experts
 * are: the file format is the one users actually write, so the built-ins and
 * the format must not be allowed to drift apart. If the parser breaks, the
 * built-ins break with it, which is the point.
 *
 * The ids here are the directory names the equivalent user skill would have.
 *
 * Kept to a handful. The value of a built-in catalog is the *mechanism*, not
 * the breadth — more skills arrive as user files, and the shipped set only
 * needs to prove the mechanism works and to cover a couple of tasks everyone
 * does.
 */

/** Raw markdown, exactly as a user's SKILL.md would be written. */
export const BUILTIN_SKILLS: ReadonlyArray<{ id: string; source: string }> = [
	{
		id: "git-commit",
		source: `---
name: 提交改动
description: 把改动整理成一条清晰的 commit，遵循项目自己的提交节奏
when_to_use: 用户说"提交"、"commit"、"推送"、或要求把一批改动整理成提交
---

目标是**一次提交表达一件事**，而不是把一堆零碎塞进一条。

先弄清楚改动的范围，再决定怎么切分：

1. **读改动**：git status、git diff，搞清楚改了哪些文件、分别是什么性质的改动。
2. **切分**：相互独立的东西分成多条提交。逻辑上属于一个改动的文件放一起。
3. **写提交信息**：一行标题说清"做了什么"（祈使句，现在时），需要时用正文说明
   "为什么"和取舍。正文解释动机，不重复标题。
4. **不要擅自提交**：除非用户明确说"提交吧"，否则整理好、报告改了哪些文件，
   等用户点头再提交推送。边做边 commit 不是这个项目要的节奏。
`,
	},
	{
		id: "write-readme",
		source: `---
name: 写 README
description: 面向"第一次打开的人"写一份能快速上手、不啰嗦的 README
when_to_use: 用户要新建、重写或改进项目的 README / 说明文档
---

README 的读者是"第一次打开这个仓库的人"，不是作者自己。

按这个结构写，按需省略不相关的节：

1. **一句话说清这是什么** —— 一段话，不绕弯子。
2. **快速开始** —— 最少的命令让人跑起来。命令要能直接复制，不要占位符。
3. **它能做什么** —— 能力清单，每条一句话。
4. **怎么配置** —— 用户必须自己填的东西（key、环境变量）要写清楚，且写明
   不填会怎样。
5. **项目结构** —— 目录一眼看懂，不是完整树状图。

原则：

- **给真命令，不给占位符。** 读者真的会照着敲，尖括号和结尾的波浪线都会被带进去。
- **说清"不 X 会怎样"**，不只说"X 是什么"。比如"不填 key 会话起不来"比"需要 key"有用。
- **错了就改，不硬凑长度。** 一句话能说清的写一句。
`,
	},
];
