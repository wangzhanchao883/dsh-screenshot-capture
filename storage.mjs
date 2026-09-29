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

/**
 * 同步重试写入。Obsidian / 同步盘会短暂占用文件(EBUSY/EPERM),
 * 一次写失败就丢掉整段 OCR 文字太亏,所以按 60/120/180ms 退避重试。
 */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* 环境不允许同步等待就直接继续 */
  }
}

function writeFileRetry(path, text, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      writeFileSync(path, text, "utf8");
      return;
    } catch (err) {
      lastErr = err;
      if (!["EBUSY", "EPERM", "EACCES"].includes(err.code)) throw err;
      sleepSync(60 * (i + 1));
    }
  }
  throw lastErr;
}

/**
 * 把剪贴板临时图复制进 vault 附件,返回 vault 内相对路径。
 * 同一秒内连拍两张时 `fileStamp` 会撞车(文件名相同 → 后者覆盖前者),
 * 所以目标已存在就顺延 `_2`、`_3`…(相对路径会带这个后缀,笔记里也对得上)。
 */
export function saveAttachment(config, srcPath, date, fileStamp, kind) {
  ensureVault(config);
  let rel = attachmentRelPath(config, date, fileStamp, kind);
  let dest = join(config.vaultPath, config.inboxFolder, rel);
  for (let i = 2; existsSync(dest); i += 1) {
    rel = `${config.attachmentsFolder}/${fileStamp}_${kind}_${i}.png`;
    dest = join(config.vaultPath, config.inboxFolder, rel);
  }
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
  writeFileRetry(path, updated);
  return path;
}

/**
 * 更新某条记录的 OCR 文字:按**图片文件名**定位条目块,再替换块内的占位行。
 *
 * 旧实现用 `## <time> #文档\n\n![…](…)\n\n> OCR: 识别中…` 一整个正则硬匹配,有三个脆弱点:
 *   ① 行尾必须是纯 LF(CRLF 的笔记直接不匹配);
 *   ② 同一分钟内连拍两张时 time 相同,全靠文件名兜住;
 *   ③ 匹配不上就 `return null`,**调用方拿不到任何信号** → 笔记里干留「识别中…」。
 * 现在:定位失败/占位符缺失都返回 `{ ok:false, reason }`,由调用方打日志 + 告知用户。
 */
export function updateEntryOcr(config, { date, time, imageRel, ocrText }) {
  const path = dailyNotePath(config, date);
  if (!existsSync(path)) return { ok: false, path: null, reason: `笔记不存在(${date})` };
  const fileName = String(imageRel ?? "").split("/").pop();
  if (!fileName) return { ok: false, path: null, reason: "缺少图片文件名" };

  const text = readFileSync(path, "utf8");
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const imgIdx = text.search(new RegExp(`!\\[[^\\]]*${esc(fileName)}[^\\]]*\\]\\(`));
  if (imgIdx === -1) return { ok: false, path: null, reason: `笔记里找不到图片 ${fileName}` };

  const headerIdx = text.lastIndexOf("## ", imgIdx);
  if (headerIdx === -1) return { ok: false, path: null, reason: `图片 ${fileName} 不在任何条目块里` };
  const nextIdx = text.indexOf("\n## ", imgIdx);
  const end = nextIdx === -1 ? text.length : nextIdx;
  const block = text.slice(headerIdx, end);

  const markerRe = /^> OCR: 识别中…[ \t]*$/m;
  if (!markerRe.test(block)) {
    return { ok: false, path: null, reason: `条目 ${time} 里没有待回填的 OCR 占位符(可能已回填过)` };
  }

  const newBlock = block.replace(markerRe, `> OCR: ${ocrText || "（无文字）"}`);
  writeFileRetry(path, text.slice(0, headerIdx) + newBlock + text.slice(end));
  return { ok: true, path, reason: "" };
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
