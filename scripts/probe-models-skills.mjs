// Probe the stage-2 additions: model profiles (save/select/delete/test) and
// skill management (install/uninstall/set_enabled), plus the disabled filter on
// skill.list. The probe restores settings and removes the installed skill, so
// repeated runs leave no trace.
// Requires a running bridge: node scripts/probe-bridge.mjs first, then this.
// Run: node scripts/probe-models-skills.mjs

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const ws = new WebSocket("ws://127.0.0.1:7438");
let id = 0;
const pending = new Map();

function request(method, params = {}) {
  return new Promise((resolve, reject) => {
    const reqId = String(++id);
    pending.set(reqId, { resolve, reject });
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: reqId, method, params }));
  });
}

ws.on("open", async () => {
  const fail = (label, detail) => console.log(`FAIL ${label}: ${detail}`);
  const ok = (label, detail = "") => console.log(`ok   ${label}${detail ? ` ${detail}` : ""}`);

  // Snapshot state so it can be restored exactly. settings.get returns the
  // settings object directly (no { settings: ... } wrapper) and reports the
  // model but not the profile list — the picker's list is the truth for that.
  const original = await request("settings.get", {});
  const originalModel = original.model ?? "";
  const originalCount = (await request("provider.model_list", {})).models.length;

  const profileIds = [];
  try {
    // ---- model profiles ----------------------------------------------
    const savedA = await request("provider.model_save", {
      name: "探测档案A",
      model: "deepseek/deepseek-flash",
      provider: "openai",
    });
    const aRow = (savedA.models ?? []).find((m) => m.model === "deepseek/deepseek-flash");
    profileIds.push(aRow?.id ?? "");
    ok("model_save stores a profile", `id=${aRow?.id}`);
    const isCurrent = Boolean(aRow?.is_current);
    isCurrent ? ok("saving makes the model current") : fail("saving makes the model current", JSON.stringify(savedA.models));

    const savedB = await request("provider.model_save", {
      name: "探测档案B",
      model: "deepseek/deepseek-v4-pro",
      provider: "openai",
    });
    const bRow = (savedB.models ?? []).find((m) => m.model === "deepseek/deepseek-v4-pro");
    profileIds.push(bRow?.id ?? "");
    ok("a second profile joins the list", `${savedB.models.length} model(s)`);

    const listed = await request("provider.model_list", {});
    const hasBoth = ["deepseek/deepseek-flash", "deepseek/deepseek-v4-pro"].every((spec) =>
      listed.models.some((m) => m.model === spec),
    );
    hasBoth ? ok("model_list returns both profiles") : fail("model_list returns both profiles", JSON.stringify(listed.models.map((m) => m.model)));

    const selectedA = await request("provider.model_select", { model_id: profileIds[0] });
    const selectWorked = selectedA.settings?.model === "deepseek/deepseek-flash";
    selectWorked ? ok("model_select switches the running model") : fail("model_select switches the running model", selectedA.settings?.model);

    const unknownModel = await request("provider.model_test", { model: "no-such-provider/no-such-model" });
    !unknownModel.success && String(unknownModel.error).includes("未知模型")
      ? ok("model_test refuses an unknown spec", unknownModel.error)
      : fail("model_test refuses an unknown spec", JSON.stringify(unknownModel));

    // A real connectivity test only when the provider cannot be configured:
    // probing a live key spends the user's tokens on every run. The gate is the
    // bridge's own answer (a stored key counts even though no env var is set).
    const status = await request("provider.status", {});
    if (status.api_key_configured) {
      const live = await request("provider.model_test", { model: "deepseek/deepseek-flash" });
      ok("live model_test", live.success ? `success in ${live.elapsed_ms}ms (${live.input_tokens}+${live.output_tokens} tokens)` : `failed: ${live.error}`);
    } else {
      const noKey = await request("provider.model_test", { model: "deepseek/deepseek-flash" });
      !noKey.success && String(noKey.error).includes("未配置")
        ? ok("model_test reports a missing key without calling the network", noKey.error)
        : fail("model_test reports a missing key", JSON.stringify(noKey));
    }

    // ---- skills -------------------------------------------------------
    const skillId = "probe-skill";
    const probeRoot = join(tmpdir(), `gdou-probe-${process.pid}`);
    const sourceDir = join(probeRoot, skillId);
    mkdirSync(join(sourceDir, "references"), { recursive: true });
    writeFileSync(join(sourceDir, "SKILL.md"), "---\nname: 探针技能\ndescription: 探针验证用\n---\n\n探针正文。\n", "utf-8");
    writeFileSync(join(sourceDir, "references", "note.md"), "# 说明\n", "utf-8");
    try {
      // A crashed previous run may have left the skill behind; install refuses
      // to overwrite, so clear it first.
      await request("skill.uninstall", { skill_id: skillId, workspace_id: process.cwd(), confirm: "uninstall" }).catch(() => {});
      const installed = await request("skill.install", { source_path: sourceDir, scope: "workspace", workspace_id: process.cwd() });
      installed.skill?.id === skillId && installed.skill?.display_name === "探针技能"
        ? ok("skill.install copies the skill", `display_name=${installed.skill?.display_name}`)
        : fail("skill.install copies the skill", JSON.stringify(installed.skill));

      const beforeDisable = await request("skill.list", {});
      const listedAfterInstall = (beforeDisable.skills ?? []).some((s) => s.id === skillId);
      listedAfterInstall ? ok("skill.list shows the installed skill") : fail("skill.list shows the installed skill");

      const disabled = await request("skill.set_enabled", { skill_id: skillId, enabled: false, workspace_id: process.cwd() });
      disabled.skill?.enabled === false
        ? ok("set_enabled turns a skill off", `enabled=${disabled.skill?.enabled}`)
        : fail("set_enabled turns a skill off", JSON.stringify(disabled.skill));
      const afterDisable = await request("skill.list", {});
      const hidden = !(afterDisable.skills ?? []).some((s) => s.id === skillId);
      hidden ? ok("skill.list hides a disabled skill") : fail("skill.list hides a disabled skill");

      const reEnabled = await request("skill.set_enabled", { skill_id: skillId, enabled: true, workspace_id: process.cwd() });
      reEnabled.skill?.enabled === true
        ? ok("set_enabled turns a skill back on")
        : fail("set_enabled turns a skill back on", JSON.stringify(reEnabled.skill));

      const builtinRefusal = await request("skill.uninstall", { skill_id: "git-commit", workspace_id: process.cwd(), confirm: "uninstall" }).catch((e) => e);
      builtinRefusal instanceof Error && String(builtinRefusal.message).includes("内置")
        ? ok("uninstalling a built-in skill is refused", builtinRefusal.message)
        : fail("uninstalling a built-in skill is refused", JSON.stringify(builtinRefusal));

      const missingConfirm = await request("skill.uninstall", { skill_id: skillId, workspace_id: process.cwd() }).catch((e) => e);
      missingConfirm instanceof Error
        ? ok("uninstall without confirm is refused")
        : fail("uninstall without confirm is refused", JSON.stringify(missingConfirm));

      await request("skill.uninstall", { skill_id: skillId, workspace_id: process.cwd(), confirm: "uninstall" });
      const afterUninstall = await request("skill.list", {});
      const gone = !(afterUninstall.skills ?? []).some((s) => s.id === skillId);
      gone ? ok("skill.uninstall removes the skill") : fail("skill.uninstall removes the skill");
    } finally {
      rmSync(probeRoot, { recursive: true, force: true });
    }
  } catch (error) {
    console.error("probe crashed:", error instanceof Error ? error.message : String(error));
  } finally {
    // Restore: drop the profiles we created and the model we switched to.
    for (const profileId of profileIds) {
      if (!profileId) continue;
      await request("provider.model_delete", { model_id: profileId }).catch(() => {});
    }
    await request("settings.update", { model: originalModel }).catch(() => {});
    const restored = await request("settings.get", {});
    const restoredCount = (await request("provider.model_list", {})).models.length;
    const modelRestored = (restored.model ?? "") === originalModel;
    const profilesRestored = restoredCount === originalCount;
    modelRestored && profilesRestored
      ? ok("settings restored", `model=${restored.model ?? "(none)"}, models=${restoredCount}/${originalCount}`)
      : fail("settings restored", `model=${restored.model}, models=${restoredCount}/${originalCount}`);
  }

  ws.close();
  process.exit(0);
});

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString("utf8"));
  if (msg.jsonrpc && msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result ?? {});
  }
});

ws.on("error", (e) => { console.error("ws error:", e.message); process.exit(1); });
setTimeout(() => { console.log("timeout"); process.exit(1); }, 30000);
