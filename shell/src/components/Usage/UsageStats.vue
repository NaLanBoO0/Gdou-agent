<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import AppIcon from "../icons/AppIcon.vue";
import { getUsageOverview, type UsageOverview } from "../../services/gdou-runtime";

const props = defineProps<{ connected: boolean }>();
const { t, locale } = useI18n({ useScope: "global" });
const overview = ref<UsageOverview>();
const loading = ref(false);
const error = ref("");

const emptyOverview: UsageOverview = {
  total: { runs: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, elapsedMs: 0 },
  byDay: [], byModel: [],
};

function fmtInt(n: number): string {
  return new Intl.NumberFormat(locale.value).format(Number.isFinite(n) ? n : 0);
}

function fmtTokens(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(v);
}

function fmtCost(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  if (v <= 0) return "—";
  return `$${v.toFixed(4)}`;
}

function fmtDuration(ms: number): string {
  const seconds = Math.round((Number.isFinite(ms) ? ms : 0) / 1000);
  if (seconds < 60) return t("chat.usage.seconds", { n: seconds });
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return `${minutes}m ${rem}s`;
}

function fmtDate(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return date;
  return new Intl.DateTimeFormat(locale.value, { year: "numeric", month: "short", day: "numeric" }).format(d);
}

const total = computed(() => overview.value?.total ?? emptyOverview.total);
const hasData = computed(() => total.value.runs > 0);

// ---- 月度预算（本地偏好，仅前端展示）----
const BUDGET_KEY = "gdou.usageBudget";
const budget = ref(Number(localStorage.getItem(BUDGET_KEY) ?? 0) || 0);
const budgetInput = ref(budget.value > 0 ? String(budget.value) : "");
const monthKey = computed(() => new Date().toISOString().slice(0, 7));
const monthCost = computed(() =>
  (overview.value?.byDay ?? [])
    .filter((row) => row.date.startsWith(monthKey.value))
    .reduce((sum, row) => sum + (Number(row.cost) || 0), 0),
);
const budgetPercent = computed(() => {
  if (budget.value <= 0) return 0;
  return Math.min(999, Math.round((monthCost.value / budget.value) * 100));
});
const overBudget = computed(() => budget.value > 0 && monthCost.value > budget.value);
function setBudget() {
  const next = Number(budgetInput.value);
  if (Number.isFinite(next) && next > 0) {
    budget.value = next;
    localStorage.setItem(BUDGET_KEY, String(next));
  } else {
    budget.value = 0;
    budgetInput.value = "";
    localStorage.removeItem(BUDGET_KEY);
  }
}

const cards = computed(() => [
  { icon: "Clock3", label: t("chat.usage.cardRuns"), value: fmtInt(total.value.runs) },
  { icon: "ArrowUp", label: t("chat.usage.cardInput"), value: fmtTokens(total.value.input) },
  { icon: "ArrowUpRight", label: t("chat.usage.cardOutput"), value: fmtTokens(total.value.output) },
  { icon: "CircleDotDashed", label: t("chat.usage.cardCacheRead"), value: total.value.cacheRead > 0 ? fmtTokens(total.value.cacheRead) : "—" },
  { icon: "Timer", label: t("chat.usage.cardElapsed"), value: total.value.elapsedMs > 0 ? fmtDuration(total.value.elapsedMs) : "—" },
  { icon: "Coins", label: t("chat.usage.cardCost"), value: fmtCost(total.value.cost) },
]);

function fmtModel(model: string): string {
  return model || t("chat.usage.unknownModel");
}

async function load() {
  if (!props.connected) { overview.value = undefined; error.value = t("chat.usage.notConnected"); return; }
  loading.value = true; error.value = "";
  try { overview.value = await getUsageOverview(); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { loading.value = false; }
}

onMounted(load);
watch(() => props.connected, load);
</script>

<template>
  <section class="chat-usage" aria-labelledby="usage-title">
    <header class="usage-header">
      <div><span class="usage-kicker">TOKEN USAGE</span><h1 id="usage-title">{{ t("chat.usage.title") }}</h1><p>{{ t("chat.usage.desc") }}</p></div>
      <button type="button" class="usage-icon-button" :aria-label="t('app.refresh')" :disabled="loading" @click="load"><AppIcon name="RefreshCw" :size="16" :class="{ spin: loading }" /></button>
    </header>

    <p v-if="error" class="usage-error" role="alert"><AppIcon name="AlertCircle" :size="15" />{{ error }}</p>

    <template v-if="hasData">
      <div class="usage-cards">
        <article v-for="card in cards" :key="card.label" class="usage-card">
          <span class="usage-card-icon"><AppIcon :name="card.icon" :size="18" /></span>
          <div><span>{{ card.label }}</span><b>{{ card.value }}</b></div>
        </article>
      </div>

      <!-- 月度预算：设置 + 进度 + 超支告警 -->
      <section class="usage-budget" :class="{ 'usage-budget--over': overBudget }">
        <header class="usage-budget__head">
          <h2><AppIcon name="Coins" :size="16" />{{ t("chat.usage.budgetTitle") }}</h2>
          <form class="usage-budget__set" @submit.prevent="setBudget">
            <input v-model="budgetInput" type="number" min="0" step="0.01" :placeholder="t('chat.usage.budgetPlaceholder')" :aria-label="t('chat.usage.budgetTitle')" />
            <button type="submit" :disabled="budgetInput.trim() === ''">{{ t("chat.usage.budgetSet") }}</button>
          </form>
        </header>
        <template v-if="budget > 0">
          <div class="usage-budget__track"><div class="usage-budget__fill" :class="{ 'usage-budget__fill--over': overBudget }" :style="{ width: Math.min(100, budgetPercent) + '%' }" /></div>
          <p class="usage-budget__meta">{{ t("chat.usage.budgetMonthCost", { cost: fmtCost(monthCost), budget: fmtCost(budget) }) }} · {{ t("chat.usage.budgetPercent", { percent: budgetPercent }) }}</p>
          <p v-if="overBudget" class="usage-budget__over" role="alert"><AppIcon name="AlertTriangle" :size="14" />{{ t("chat.usage.budgetOver") }}</p>
        </template>
        <p v-else class="usage-budget__hint">{{ t("chat.usage.budgetHint") }}</p>
      </section>

      <div class="usage-grid">
        <section v-if="overview?.byModel.length" class="usage-table-card">
          <header><h2><AppIcon name="Cpu" :size="16" />{{ t("chat.usage.byModel") }}</h2></header>
          <table>
            <thead><tr><th>{{ t("chat.usage.thModel") }}</th><th>{{ t("chat.usage.thRuns") }}</th><th>{{ t("chat.usage.thInput") }}</th><th>{{ t("chat.usage.thOutput") }}</th><th>{{ t("chat.usage.thCost") }}</th></tr></thead>
            <tbody>
              <tr v-for="row in overview.byModel" :key="row.model">
                <td>{{ fmtModel(row.model) }}</td><td>{{ fmtInt(row.runs) }}</td><td>{{ fmtTokens(row.input) }}</td><td>{{ fmtTokens(row.output) }}</td><td>{{ fmtCost(row.cost) }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section v-if="overview?.byDay.length" class="usage-table-card">
          <header><h2><AppIcon name="Table2" :size="16" />{{ t("chat.usage.byDay") }}</h2></header>
          <table>
            <thead><tr><th>{{ t("chat.usage.thDate") }}</th><th>{{ t("chat.usage.thRuns") }}</th><th>{{ t("chat.usage.thInput") }}</th><th>{{ t("chat.usage.thOutput") }}</th><th>{{ t("chat.usage.thCost") }}</th></tr></thead>
            <tbody>
              <tr v-for="row in overview.byDay" :key="row.date">
                <td>{{ fmtDate(row.date) }}</td><td>{{ fmtInt(row.runs) }}</td><td>{{ fmtTokens(row.input) }}</td><td>{{ fmtTokens(row.output) }}</td><td>{{ fmtCost(row.cost) }}</td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>
    </template>

    <div v-else-if="!error" class="usage-empty">
      <span><AppIcon name="Table2" :size="28" /></span>
      <h2>{{ t("chat.usage.noData") }}</h2><p>{{ t("chat.usage.noDataHint") }}</p>
    </div>
  </section>
</template>

<style scoped>
.chat-usage{height:100%;overflow:auto;padding:42px clamp(24px,5vw,72px) 64px;color:var(--text);background:var(--surface)}
.usage-header{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;max-width:1120px;margin:0 auto 24px}.usage-header h1{margin:5px 0 6px;font-size:32px;letter-spacing:-.04em}.usage-header p{margin:0;color:var(--text-muted)}.usage-kicker{font:700 10px/1.2 ui-monospace,monospace;letter-spacing:.16em;color:#26845e}.usage-icon-button{display:inline-flex;align-items:center;justify-content:center;width:38px;height:38px;border:0;border-radius:9px;color:var(--text);background:var(--surface-soft);cursor:pointer}
.usage-error{display:flex;align-items:center;gap:8px;max-width:1120px;margin:0 auto 14px;padding:10px 13px;border-radius:9px;color:#a94343;background:#fff0ef;font-size:13px}
.usage-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;max-width:1120px;margin:0 auto 22px}.usage-card{display:flex;align-items:center;gap:13px;padding:16px;border:1px solid var(--border);border-radius:14px;background:var(--surface-elevated)}.usage-card-icon{display:grid;width:40px;height:40px;place-items:center;flex:none;border-radius:11px;color:#27805c;background:#eaf6f0}.usage-card>div{display:grid;gap:3px;min-width:0}.usage-card>div>span{color:var(--text-muted);font-size:11px}.usage-card b{font-variant-numeric:tabular-nums;font-size:21px;letter-spacing:-.02em}
.usage-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px;max-width:1120px;margin:0 auto}.usage-table-card{padding:4px 4px 8px;border:1px solid var(--border);border-radius:14px;background:var(--surface-elevated);overflow:hidden}.usage-table-card header h2{display:flex;align-items:center;gap:8px;margin:0;padding:14px 16px 10px;font-size:13px;letter-spacing:.02em;color:var(--text-muted)}.usage-table-card table{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}.usage-table-card th,.usage-table-card td{padding:9px 16px;text-align:left;white-space:nowrap}.usage-table-card th{color:var(--text-muted);font-size:11px;font-weight:600}.usage-table-card tbody tr{border-top:1px solid var(--border)}.usage-table-card td:first-child{overflow:hidden;text-overflow:ellipsis;max-width:220px}.usage-table-card td:not(:first-child){text-align:right}.usage-table-card tbody tr:hover{background:var(--surface-soft)}
.usage-budget{max-width:1120px;margin:0 auto 22px;padding:16px 18px;border:1px solid var(--border);border-radius:14px;background:var(--surface-elevated)}.usage-budget__head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.usage-budget__head h2{display:flex;align-items:center;gap:8px;margin:0;font-size:13px;letter-spacing:.02em;color:var(--text-muted)}.usage-budget__set{display:flex;gap:6px}.usage-budget__set input{width:110px;padding:7px 10px;color:var(--text);background:var(--surface);border:1px solid var(--border);border-radius:9px;font:inherit;outline:none}.usage-budget__set button{padding:7px 12px;border:0;border-radius:9px;color:#fff;background:#202825;font-size:12px;font-weight:600;cursor:pointer}.usage-budget__set button:disabled{opacity:.45;cursor:not-allowed}.usage-budget__track{height:8px;margin:12px 0 8px;border-radius:5px;background:var(--surface-soft);overflow:hidden}.usage-budget__fill{height:100%;border-radius:5px;background:linear-gradient(90deg,#43a77d,#26845e);transition:width .3s ease}.usage-budget__fill--over{background:linear-gradient(90deg,#e5484d,#b23c35)}.usage-budget__meta{margin:0;color:var(--text-muted);font-size:12px}.usage-budget__hint{margin:10px 0 0;color:var(--text-muted);font-size:12px}.usage-budget__over{display:flex;align-items:center;gap:6px;margin:8px 0 0;color:#b23c35;font-size:12px;font-weight:600}.usage-budget--over{border-color:#e8b4b2;background:#fff6f5}
.usage-empty{display:grid;justify-items:center;max-width:520px;margin:90px auto 0;text-align:center}.usage-empty>span{display:grid;width:58px;height:58px;place-items:center;border-radius:18px;color:#348463;background:#eaf6f0}.usage-empty h2{margin:18px 0 7px}.usage-empty p{margin:0;color:var(--text-muted)}
.spin{animation:usage-spin 1s linear infinite}@keyframes usage-spin{to{transform:rotate(360deg)}}
:global([data-app-theme="dark"]) .usage-empty>span,:global([data-app-theme="dark"]) .usage-card-icon{background:#20382e;color:#88c9aa}
</style>