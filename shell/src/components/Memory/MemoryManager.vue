<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import AppIcon from "../icons/AppIcon.vue";
import {
  deleteMemoryEntry, getMemoryEntries, updateMemoryEntry,
  type MemoryCategory, type MemoryEntry,
} from "../../services/gdou-runtime";

const props = defineProps<{ connected: boolean }>();
const { t, locale } = useI18n({ useScope: "global" });
const entries = ref<MemoryEntry[]>([]);
const loading = ref(false);
const error = ref("");
const notice = ref("");
const editing = ref<{ key: string; value: string; category: MemoryCategory } | null>(null);
const newKey = ref("");
const newValue = ref("");
const newCategory = ref<MemoryCategory>("fact");
const filter = ref<"all" | MemoryCategory>("all");

const categories: MemoryCategory[] = ["profile", "preference", "project", "fact"];

function categoryLabel(category: MemoryCategory): string {
  return t(`memory.category.${category}`);
}

function fmtDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale.value, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

const visible = computed(() => filter.value === "all" ? entries.value : entries.value.filter((e) => e.category === filter.value));
const total = computed(() => entries.value.length);

async function load() {
  if (!props.connected) { entries.value = []; error.value = t("memory.notConnected"); return; }
  loading.value = true; error.value = "";
  try { entries.value = await getMemoryEntries(); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { loading.value = false; }
}

function beginEdit(entry: MemoryEntry) {
  editing.value = { key: entry.key, value: entry.value, category: entry.category };
}

async function saveEdit() {
  if (!editing.value || !editing.value.key.trim() || !editing.value.value.trim() || !props.connected) return;
  loading.value = true; error.value = "";
  try {
    await updateMemoryEntry(editing.value.key.trim(), editing.value.value.trim(), editing.value.category);
    notice.value = t("memory.updated");
    editing.value = null;
    await load();
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { loading.value = false; }
}

async function addEntry() {
  if (!newKey.value.trim() || !newValue.value.trim() || !props.connected) return;
  loading.value = true; error.value = "";
  try {
    await updateMemoryEntry(newKey.value.trim(), newValue.value.trim(), newCategory.value);
    notice.value = t("memory.added");
    newKey.value = ""; newValue.value = ""; newCategory.value = "fact";
    await load();
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { loading.value = false; }
}

async function remove(entry: MemoryEntry) {
  if (!window.confirm(t("memory.deleteConfirm", { key: entry.key }))) return;
  error.value = "";
  try { await deleteMemoryEntry(entry.key); notice.value = t("memory.deleted"); await load(); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
}

onMounted(load);
watch(() => props.connected, load);
</script>

<template>
  <section class="chat-memory" aria-labelledby="memory-title">
    <header class="memory-header">
      <div><span class="memory-kicker">USER MEMORY</span><h1 id="memory-title">{{ t("memory.title") }}</h1><p>{{ t("memory.desc") }}</p></div>
      <button type="button" class="memory-icon-button" :aria-label="t('app.refresh')" :disabled="loading" @click="load"><AppIcon name="RefreshCw" :size="16" :class="{ spin: loading }" /></button>
    </header>

    <p v-if="notice" class="memory-notice" role="status"><AppIcon name="CheckCircle2" :size="15" />{{ notice }}</p>
    <p v-if="error" class="memory-error" role="alert"><AppIcon name="AlertCircle" :size="15" />{{ error }}</p>

    <div class="memory-toolbar"><span>{{ t("memory.count", { n: total }) }}</span><nav><button v-for="item in (['all','profile','preference','project','fact'] as const)" :key="item" :class="{ active: filter === item }" @click="filter = item">{{ item === 'all' ? t('memory.filterAll') : categoryLabel(item) }}</button></nav></div>

    <div v-if="visible.length" class="memory-list">
      <article v-for="entry in visible" :key="entry.key" class="memory-card">
        <div class="memory-card-top">
          <span class="memory-category" :class="entry.category"><i />{{ categoryLabel(entry.category) }}</span>
          <span class="memory-meta">{{ t(entry.source === "manual" ? "memory.sourceManual" : "memory.sourceSummary") }} · {{ fmtDate(entry.updatedAt) }}</span>
        </div>
        <template v-if="editing && editing.key === entry.key">
          <label>{{ t("memory.keyLabel") }}<input v-model="editing.key" disabled /></label>
          <label>{{ t("memory.valueLabel") }}<textarea v-model="editing.value" rows="3" /></label>
          <label>{{ t("memory.categoryLabel") }}<select v-model="editing.category"><option v-for="c in categories" :key="c" :value="c">{{ categoryLabel(c) }}</option></select></label>
          <footer class="memory-card-actions">
            <button @click="editing = null">{{ t("chat.cancel") }}</button>
            <button class="memory-primary" :disabled="loading" @click="saveEdit"><AppIcon name="Check" :size="14" />{{ t("memory.save") }}</button>
          </footer>
        </template>
        <template v-else>
          <h2><code>{{ entry.key }}</code></h2>
          <p>{{ entry.value }}</p>
          <footer class="memory-card-actions">
            <button :title="t('chat.edit')" @click="beginEdit(entry)"><AppIcon name="Pencil" :size="14" /></button>
            <button :title="t('chat.remove')" @click="remove(entry)"><AppIcon name="Trash2" :size="14" /></button>
          </footer>
        </template>
      </article>
    </div>

    <div v-else-if="!error && !loading" class="memory-empty">
      <span><AppIcon name="Brain" :size="28" /></span>
      <h2>{{ t("memory.empty") }}</h2>
      <p>{{ t("memory.emptyHint") }}</p>
    </div>

    <form v-if="props.connected" class="memory-form" @submit.prevent="addEntry">
      <h3><AppIcon name="Plus" :size="15" />{{ t("memory.manualAdd") }}</h3>
      <div class="memory-form-grid">
        <label>{{ t("memory.keyLabel") }}<input v-model="newKey" :placeholder="t('memory.keyPlaceholder')" /></label>
        <label>{{ t("memory.categoryLabel") }}<select v-model="newCategory"><option v-for="c in categories" :key="c" :value="c">{{ categoryLabel(c) }}</option></select></label>
      </div>
      <label>{{ t("memory.valueLabel") }}<textarea v-model="newValue" rows="3" :placeholder="t('memory.valuePlaceholder')" /></label>
      <button type="submit" class="memory-primary" :disabled="loading || !newKey.trim() || !newValue.trim()"><AppIcon name="Check" :size="14" />{{ t("memory.add") }}</button>
    </form>
  </section>
</template>

<style scoped>
.chat-memory{height:100%;overflow:auto;padding:42px clamp(24px,5vw,72px) 64px;color:var(--text);background:var(--surface)}
.memory-header{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;max-width:1120px;margin:0 auto 24px}.memory-header h1{margin:5px 0 6px;font-size:32px;letter-spacing:-.04em}.memory-header p{margin:0;color:var(--text-muted)}.memory-kicker{font:700 10px/1.2 ui-monospace,monospace;letter-spacing:.16em;color:#26845e}.memory-icon-button{display:inline-flex;align-items:center;justify-content:center;width:38px;height:38px;border:0;border-radius:9px;color:var(--text);background:var(--surface-soft);cursor:pointer}
.memory-notice,.memory-error{display:flex;align-items:center;gap:8px;max-width:1120px;margin:0 auto 14px;padding:10px 13px;border-radius:9px;font-size:13px}.memory-notice{color:#237454;background:#edf8f2}.memory-error{color:#a94343;background:#fff0ef}
.memory-toolbar{display:flex;align-items:center;justify-content:space-between;max-width:1120px;margin:0 auto 14px}.memory-toolbar>span{color:var(--text-muted);font-size:12px}.memory-toolbar nav{display:flex;gap:3px;padding:3px;background:var(--surface-soft);border-radius:9px}.memory-toolbar button{border:0;cursor:pointer;color:var(--text-muted);background:transparent;border-radius:7px;padding:7px 12px}.memory-toolbar button.active{color:var(--text);background:var(--surface)}
.memory-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:13px;max-width:1120px;margin:0 auto}.memory-card{display:grid;gap:12px;min-width:0;padding:18px;border:1px solid var(--border);border-radius:14px;background:var(--surface-elevated)}
.memory-card-top,.memory-card-top>*{display:flex;align-items:center;justify-content:space-between;gap:6px}.memory-category{display:inline-flex;align-items:center;gap:7px;color:#277454;font-size:11px;font-weight:650}.memory-category i{width:7px;height:7px;border-radius:50%;background:#43a77d;box-shadow:0 0 0 4px rgb(67 167 125/12%)}.memory-category.preference{color:#7a5bc0}.memory-category.preference i{background:#8f6fd3;box-shadow:0 0 0 4px rgb(143 111 211/12%)}.memory-category.project{color:#b06932}.memory-category.project i{background:#d68b45;box-shadow:0 0 0 4px rgb(214 139 69/12%)}.memory-category.fact{color:#3c6e9a}.memory-category.fact i{background:#5a8fb8;box-shadow:0 0 0 4px rgb(90 143 184/12%)}.memory-meta{color:var(--text-muted);font-size:10px}.memory-card h2{margin:0;font-size:14px}.memory-card h2 code{color:var(--accent)}.memory-card>p{margin:0;color:var(--text);font-size:13px;line-height:1.55;white-space:pre-wrap}.memory-card label{display:grid;gap:6px;color:var(--text-muted);font-size:12px;font-weight:600}.memory-card input,.memory-card textarea,.memory-card select,.memory-form input,.memory-form textarea,.memory-form select{width:100%;box-sizing:border-box;padding:9px 11px;color:var(--text);background:var(--surface);border:1px solid var(--border);border-radius:9px;font:inherit;outline:none}.memory-card textarea,.memory-form textarea{resize:vertical}.memory-card-actions{display:flex;justify-content:flex-end;gap:6px}.memory-card-actions button{display:grid;width:29px;height:29px;place-items:center;border:0;border-radius:7px;color:var(--text-muted);background:transparent;cursor:pointer}.memory-card-actions button:hover{color:var(--text);background:var(--surface-soft)}.memory-card-actions button:not(:first-child):not(.memory-primary){font:inherit;padding:0 12px;width:auto}
.memory-primary{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:34px;padding:0 14px;border:0;border-radius:9px;color:#fff;background:#202825;font-weight:650;cursor:pointer}.memory-primary:hover{background:#101613}.memory-primary:disabled{opacity:.45;cursor:not-allowed}
.memory-empty{display:grid;justify-items:center;max-width:520px;margin:70px auto 0;text-align:center}.memory-empty>span{display:grid;width:58px;height:58px;place-items:center;border-radius:18px;color:#348463;background:#eaf6f0}.memory-empty h2{margin:18px 0 7px}.memory-empty p{margin:0 0 20px;color:var(--text-muted)}
.memory-form{display:grid;gap:12px;max-width:1120px;margin:26px auto 0;padding:20px;border:1px solid var(--border);border-radius:14px;background:var(--surface-elevated)}.memory-form h3{display:flex;align-items:center;gap:7px;margin:0;font-size:13px}.memory-form-grid{display:grid;grid-template-columns:1fr 220px;gap:10px}.memory-form label{display:grid;gap:6px;color:var(--text-muted);font-size:12px;font-weight:600}.memory-form .memory-primary{justify-self:end}
.spin{animation:memory-spin 1s linear infinite}@keyframes memory-spin{to{transform:rotate(360deg)}}
@media(max-width:760px){.chat-memory{padding:28px 18px 48px}.memory-form-grid{grid-template-columns:1fr}}
:global([data-app-theme="dark"]) .memory-empty>span,:global([data-app-theme="dark"]) .memory-category i{box-shadow:none}:global([data-app-theme="dark"]) .memory-primary{color:#17231e;background:#8fcfb0}
</style>