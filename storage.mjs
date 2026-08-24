import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { ensureVault } from "./config.mjs";

export const KIND = { DOC: "文档", IMG: "图片" };

export function stampParts(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const fileStamp = `${date.replaceAll("-", "")}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return { date, fileStamp, time };
}

export function dailyNotePath(config, date) {
  return join(config.vaultPath, config.inboxFolder, `${date}.md`);
}

export function attachmentRelPath(config, date, fileStamp, kind) {
  return `${config.attachmentsFolder}/${fileStamp}_${kind}.png`;
}

/** 把剪贴板临时图复制进 vault 附件,返回 vault 内相对路径 */
export function saveAttachment(config, srcPath, date, fileStamp, kind) {
  ensureVault(config);
  const rel = attachmentRelPath(config, date, fileStamp, kind);
  const dest = join(config.vaultPath, config.inboxFolder, rel);
  copyFileSync(srcPath, dest);
  return rel;
}

const NOTE_HEADER = `# {date} 收件箱

> 每日截图收件箱,晚间整理后归档。\`#文档\` = 含 OCR 文字,\`#图片\` = 纯图片。

`;

function ensureDailyNote(config, date) {
  const path = dailyNotePath(config, date);
  if (!existsSync(path)) {
    writeFileSync(path, NOTE_HEADER.replace("{date}", date), "utf8");
  }
  return path;
}

/** 向当天笔记追加一条记录;OCR 结果可为 null(占位待更新),note/isKey 为悬浮窗注释与重点标记 */
export function appendEntry(config, { date, time, kind, imageRel, ocrText = null, note = "", isKey = false }) {
  const path = ensureDailyNote(config, date);
  const block = [
    "",
    `## ${time} #${kind}`,
    "",
    `![${imageRel.split("/").pop()}](<${imageRel}>)`,
    "",
  ];
  if (kind === KIND.DOC) {
    block.push(ocrText === null ? "> OCR: 识别中…" : `> OCR: ${ocrText || "（无文字）"}`, "");
  }
  if (note || isKey) {
    if (isKey) block.push("# **重点**", "");
    if (note) block.push(note, "");
  }
  const existing = readFileSync(path, "utf8");
  const updated = existing.replace(/\n*$/, "\n") + block.join("\n") + "\n";
  writeFileSync(path, updated, "utf8");
  return path;
}

/** 更新某条记录的 OCR 文字(按时间+图片文件名定位占位行) */
export function updateEntryOcr(config, { date, time, imageRel, ocrText }) {
  const path = dailyNotePath(config, date);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  const fileName = imageRel.split("/").pop();
  const marker = "> OCR: 识别中…";
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `(## ${time} #文档\\n\\n!\\[[^\\]]*${esc(fileName)}[^\\]]*\\]\\([^)]*\\)\\n\\n)(> OCR: 识别中…)`,
  );
  if (!re.test(text)) return null;
  const updated = text.replace(re, `$1> OCR: ${ocrText || "（无文字）"}`);
  writeFileSync(path, updated, "utf8");
  return path;
}

/** 解析当天笔记为条目列表 */
export function parseEntries(noteText) {
  const entries = [];
  const chunks = noteText.split(/^## /m).slice(1);
  for (const chunk of chunks) {
    const header = chunk.match(/^(\d{2}:\d{2}) (#文档|#图片)/);
    if (!header) continue;
    const [, time, tag] = header;
    const body = chunk.slice(header[0].length);
    const img = body.match(/!\[[^\]]*\]\(<([^>]+)>\)/)?.[1] ?? null;
    const ocr = body.match(/^> OCR: (.*)$/m)?.[1] ?? null;
    const isKey = /^# \*\*重点\*\*\s*$/m.test(body);
    const noteLines = body
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("![") && !l.startsWith("> OCR") && l !== "# **重点**");
    const note = noteLines.length ? noteLines.join("\n") : null;
    entries.push({ time, kind: tag.slice(1), imageRel: img, ocrText: ocr, note, isKey });
  }
  return entries;
}

export function readDailyNote(config, date) {
  const path = dailyNotePath(config, date);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** 归档:当天收件箱笔记移动到 归档 文件夹 */
export function archiveDailyNote(config, date) {
  ensureVault(config);
  const src = dailyNotePath(config, date);
  if (!existsSync(src)) return null;
  const dest = join(config.vaultPath, config.archiveFolder, `${date}.md`);
  renameSync(src, dest);
  return dest;
}

export function todayString(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
