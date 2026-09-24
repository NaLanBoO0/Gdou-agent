<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import AppIcon from "../icons/AppIcon.vue";
import type { ExpertSummary } from "../../services/gdou-runtime";

const { t } = useI18n({ useScope: "global" });

const props = defineProps<{ experts: ExpertSummary[] }>();
const emit = defineEmits<{ useExpert: [id: string] }>();

const query = ref("");
const normalized = computed(() => query.value.trim().toLocaleLowerCase());
const visible = computed(() => props.experts.filter(
  (expert) => !normalized.value || `${expert.name} ${expert.description}`.toLocaleLowerCase().includes(normalized.value),
));

function useExpert(id: string): void {
  emit("useExpert", id);
}
</script>

<template>
  <section class="experts-center" :aria-label="t('app.expertsSectionAria')">
    <header class="page-heading">
      <h1>{{ t("app.expertsTitle") }}</h1>
      <p>{{ t("app.expertsSubtitle") }}</p>
    </header>

    <label class="experts-search">
      <AppIcon name="Search" :size="18" />
      <input v-model="query" :placeholder="t('app.expertsSearch')" />
    </label>

    <p v-if="!props.experts.length" class="experts-empty">{{ t("app.expertsEmpty") }}</p>

    <div v-else-if="visible.length" class="experts-grid">
      <article v-for="expert in visible" :key="expert.id" v-memo="[expert.id, expert.name, expert.description]" class="expert-card">
        <i class="expert-art" aria-hidden="true"><AppIcon name="Brain" :size="20" /></i>
        <span class="expert-info">
          <b>{{ expert.name }}</b>
          <span class="expert-desc">{{ expert.description }}</span>
        </span>
        <button type="button" class="expert-use" :title="t('app.expertsUseHint')" :aria-label="t('app.expertsUseHint')" @click="useExpert(expert.id)">
          <AppIcon name="MessageCircle" :size="14" />
          <span>{{ t("app.expertsUse") }}</span>
        </button>
      </article>
    </div>
    <p v-else class="experts-empty">{{ t("app.expertsNoMatch") }}</p>
  </section>
</template>

<style scoped>
.experts-center { box-sizing: border-box; height: 100%; min-height: 0; overflow: auto; padding: 42px clamp(24px, 5vw, 72px) 64px; color: var(--text, #202124); background: var(--surface, #fff); }
.page-heading h1 { margin: 0; font-size: 22px; font-weight: 700; color: var(--text, #202124); }
.page-heading p { margin: 6px 0 0; font-size: 13px; color: var(--text-muted, #888); }
.experts-search { display: flex; height: 38px; margin-top: 20px; padding: 0 12px; align-items: center; gap: 8px; color: var(--text-faint, #999); background: color-mix(in srgb, var(--surface-soft, #f8f9fa) 62%, var(--surface, #fff)); border: 1px solid color-mix(in srgb, var(--border, #eef0f2) 80%, transparent); border-radius: 10px; }
.experts-search:focus-within { border-color: var(--accent, #26282b); }
.experts-search input { flex: 1; min-width: 0; height: 100%; color: var(--text, #2c2e31); background: transparent; border: 0; outline: 0; font-size: 13px; }
.experts-search input::placeholder { color: var(--text-faint, #adb0b5); }
.experts-grid { display: grid; min-width: 0; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 18px; padding: 0; }
.expert-card { display: flex; align-items: center; gap: 12px; width: 100%; min-width: 0; min-height: 72px; padding: 10px 12px; overflow: hidden; color: var(--text, #2c2e31); background: color-mix(in srgb, var(--surface-soft, #f8f9fa) 62%, var(--surface, #fff)); border: 0; border-radius: 14px; text-align: left; transition: background-color .15s ease, transform .15s ease, box-shadow .15s ease; }
.expert-card:hover { background: var(--surface-soft, #f5f7f9); transform: translateY(-1px); box-shadow: 0 5px 16px #00000008; }
.expert-art { display: grid; flex: none; width: 42px; height: 42px; place-items: center; color: var(--accent-contrast, #fff); background: linear-gradient(135deg, #7c5cff, #a351ff); border-radius: 12px; font-style: normal; }
.expert-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.expert-info b { font-size: 14px; font-weight: 600; color: var(--text, #2c2e31); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.expert-desc { font-size: 11px; line-height: 1.45; color: var(--text-muted, #8f9297); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.expert-use { display: inline-flex; flex: none; align-items: center; gap: 4px; height: 30px; padding: 0 11px; color: var(--accent-contrast, #fff); background: var(--accent, #26282b); border: 0; border-radius: 8px; font-size: 12px; font-weight: 500; cursor: pointer; }
.expert-use:hover { background: color-mix(in srgb, var(--accent, #26282b) 88%, #fff); }
.experts-empty { margin-top: 40px; color: var(--text-faint, #999); font-size: 13px; text-align: center; }
.experts-center button:focus { outline: 0; }
.experts-center button:focus-visible { box-shadow: inset 0 0 0 1px #8e9297; }
@media (max-width: 768px) { .experts-grid { grid-template-columns: 1fr; } }
</style>