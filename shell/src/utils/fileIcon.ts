import { getIconForFile } from "vscode-icons-js";

// 本地打包的 vscode-icons 文件类型图标集（离线，不依赖 CDN）
// 键为相对本文件的 glob 路径，值为打包后的 URL（<4KB 内联为 data URI，其余独立文件）
const localIcons = import.meta.glob("../assets/file-icons/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

// 按文件名（含扩展名）返回对应类型图标的本地 URL；未覆盖的扩展名返回空串
export function fileTypeIconUrl(filename: string): string {
  const name = getIconForFile(filename);
  return localIcons[`../assets/file-icons/${name}`] ?? "";
}
