/**
 * 发布辅助：为安装包生成 Tauri updater 签名并产出 latest.json。
 *
 * 用法：node scripts/updater-release.mjs <version> <installer-exe>
 *   例：node scripts/updater-release.mjs 0.1.16 shell/src-tauri/target/release/bundle/nsis/Gdouwork_0.1.0_x64-setup.exe
 *
 * 输出：<installer>.minisig（minisign 签名）与同目录 latest.json。
 * 把安装包、minisig、latest.json 一起上传到 GitHub release，即可被应用内更新器发现
 * （endpoints 指向 https://github.com/NaLanBoO0/Gdou-agent/releases/latest/download/latest.json）。
 *
 * 私钥：默认 ~/.gdou-agent/updater.key（生成：npx tauri signer generate -w ~/.gdou-agent/updater.key），
 * 可用 TAURI_SIGNING_PRIVATE_KEY_PATH 覆盖。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
const installerArg = process.argv[3];
if (!version || !installerArg) {
  console.error('用法: node scripts/updater-release.mjs <version> <installer-exe>');
  process.exit(1);
}
const installer = resolve(installerArg);
if (!existsSync(installer)) {
  console.error(`安装包不存在：${installer}`);
  process.exit(1);
}

const shellDir = join(dirname(fileURLToPath(import.meta.url)), "..", "shell");
const keyPath = process.env.TAURI_SIGNING_PRIVATE_KEY_PATH ?? join(homedir(), ".gdou-agent", "updater.key");
if (!existsSync(keyPath)) {
  console.error(`找不到签名私钥：${keyPath}\n请先生成：cd shell && npx tauri signer generate -w "${keyPath}"`);
  process.exit(1);
}

// 1. minisign 签名 → <installer>.minisig
// 直接经 node 跑 Tauri CLI 入口，绕开 npx/.cmd 的平台差异；私钥经 --private-key-path 显式传入。
// 注意：tauri signer sign 在非交互（后台/无 TTY）环境下会静默挂起（读 stdin 等待），
// 所以这里给它 8 秒超时；超时则提示在真实终端手动执行。
const tauriCli = join(shellDir, "node_modules", "@tauri-apps", "cli", "tauri.js");
const sigPath = `${installer}.minisig`;
if (!existsSync(sigPath)) {
  if (!existsSync(tauriCli)) {
    console.error(`找不到 Tauri CLI：${tauriCli}`);
    process.exit(1);
  }
  const { spawn } = await import("node:child_process");
  const signed = await new Promise((resolve) => {
    const child = spawn(process.execPath, [tauriCli, "signer", "sign", "--private-key-path", keyPath, installer], { stdio: "inherit" });
    const timer = setTimeout(() => { child.kill(); resolve(false); }, 8_000);
    child.on("exit", (code) => { clearTimeout(timer); resolve(code === 0); });
    child.on("error", () => { clearTimeout(timer); resolve(false); });
  });
  if (!signed || !existsSync(sigPath)) {
    console.error(`\n自动签名失败（tauri signer sign 在非交互终端可能挂起）。\n请在真实终端手动执行后重跑本脚本：\n`);
    console.error(`  cd shell`);
    console.error(`  npx tauri signer sign --private-key-path "${keyPath}" "${installer}"\n`);
    process.exit(1);
  }
}
const signature = readFileSync(sigPath, "utf8").trim();

// 2. latest.json（Tauri updater 清单）
const fileName = basename(installer);
const latest = {
  version,
  notes: process.env.UPDATER_NOTES ?? "",
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature,
      url: `https://github.com/NaLanBoO0/Gdou-agent/releases/download/v${version}/${fileName}`,
    },
  },
};
const latestPath = join(dirname(installer), "latest.json");
writeFileSync(latestPath, `${JSON.stringify(latest, null, 2)}\n`, "utf8");

console.log(`\n[updater-release] 完成`);
console.log(`  签名：${sigPath}`);
console.log(`  清单：${latestPath}`);
console.log(`  上传这三个文件到 release v${version}：安装包、${basename(sigPath)}、latest.json`);
