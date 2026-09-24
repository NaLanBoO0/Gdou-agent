import { t as globalTranslate } from "../../i18n";

export type SkillSearchEntry = {
  name: string; description: string; display_name?: string; short_description?: string;
  source?: string; plugin?: string | null; enabled?: boolean;
};
export type SlashMenuItem = SkillSearchEntry & { id: string; group: "command" | "skill" };
export type TranslateFn = (key: string) => string;
export const BUILT_IN_SLASH_COMMANDS = [
  { id: "command-plan", name: "plan" },
  { id: "command-edits", name: "edits" },
  { id: "command-auto", name: "auto" },
];
// 与运行时 `src/skills/builtin.ts` 内置集保持一致：只有这里列出的名字
// 才有真正的技能正文。过多宣告一个没有正文的技能是"界面让它上、内核没实现"，
// 会变成技能中心的空壳项，所以没实现的必须从这份广告清单里去掉。
export const BUILT_IN_SKILLS = [
  "frontend-design", "find-skills", "review-agent", "presentations", "documents", "skill-creator",
  "debug", "testing", "refactor",
].map(name => ({ name }));
export function builtInSlashCommandItems(t: TranslateFn = globalTranslate): SlashMenuItem[] {
  return BUILT_IN_SLASH_COMMANDS.map(command => ({
    ...command, description: t('palette.command.' + command.id), group: "command",
  }));
}
export function builtInSkillItems(t: TranslateFn = globalTranslate) {
  return BUILT_IN_SKILLS.map(skill => ({ name: skill.name, description: t('palette.skill.' + skill.name) }));
}
export function slashMenuItems(query: string, skills: SkillSearchEntry[], t: TranslateFn = globalTranslate): SlashMenuItem[] {
  const normalized = query.trim().toLocaleLowerCase().replace(/^\//, "");
  const words = normalized.split(/\s+/).filter(Boolean);
  const score = (item: SlashMenuItem) => {
    const name = item.name.toLocaleLowerCase();
    const label = (item.display_name ?? "").toLocaleLowerCase();
    const localized = BUILT_IN_SKILLS.some(s => s.name === item.name) ? t('palette.skill.' + item.name) : "";
    const haystack = [name, label, item.description, item.short_description, item.plugin, item.source, localized].join(" ").toLocaleLowerCase();
    if (!words.every(word => haystack.includes(word))) return -1;
    return !normalized ? 0 : name === normalized ? 100 : name.startsWith(normalized) ? 80 : label.startsWith(normalized) ? 70 : name.includes(normalized) ? 60 : 10;
  };
  const filter = (items: SlashMenuItem[]) => items.map(item => ({ item, rank: score(item) }))
    .filter(entry => entry.rank >= 0).sort((a, b) => b.rank - a.rank).map(entry => entry.item);
  const merged = new Map<string, SkillSearchEntry>(builtInSkillItems(t).map(skill => [skill.name.toLocaleLowerCase(), skill]));
  for (const skill of skills) merged.set(skill.name.toLocaleLowerCase(), skill);
  return [
    ...filter(builtInSlashCommandItems(t)),
    ...filter([...merged.values()].filter(skill => skill.enabled !== false).map(skill => ({
      ...skill, id: 'skill-' + skill.name, group: "skill" as const,
    }))),
  ];
}
