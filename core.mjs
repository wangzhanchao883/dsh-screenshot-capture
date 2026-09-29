import { appendFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ocrImage } from "./ocr.mjs";
import {
  appendEntry,
  KIND,
  saveAttachment,
  stampParts,
  updateEntryOcr,
} from "./storage.mjs";

/** 回填彻底失败时,识别结果的兜底暂存位置(每行一个 JSON) */
const PENDING_OCR_LOG = join(tmpdir(), "dsh-capture", "pending-ocr.jsonl");

/**
 * 串行队列:保证同一时刻只有一个任务在跑。
 *
 * 为什么需要:悬浮窗每次点击都会触发一次 handleChoice,而它内部是
 * 「读当天笔记 → 改 → 写回」;连拍两张(间隔可能小于一次 OCR 耗时)时两次会并发,
 * 后写覆盖先写 → 笔记里留下一句「OCR: 识别中…」永远不再更新(2026-09-29 现场踩到)。
 * 前一个任务失败不影响后续任务。
 */
export function createSerialQueue() {
  let tail = Promise.resolve();
  return (task) => {
    const run = tail.then(task, task);
    tail = run.then(
      () => {},
      () => {},
    );
    return run;
  };
}

/**
 * 悬浮窗选择处理(插件与独立测试共用):
 *   copy → 剪贴板原样不动,仅清理临时图
 *   doc  → 图片入附件 + 当天笔记立即追加(#文档,OCR 占位)→ 后台 OCR → 回填文字
 *   img  → 图片入附件 + 当天笔记追加(#图片,无 OCR)
 * note/isKey 来自悬浮窗:用户注释 + 「重点」标记(标题一 # **重点**)。
 * host 是宿主服务句柄({ llm, attachments, agentDefaultModel, logger });OCR 默认走宿主大模型,缺服务时回落千问。
 */
export async function handleChoice(config, { action, path, note = "", isKey = false }, host = {}) {
  const now = new Date();
  const { date, fileStamp, time } = stampParts(now);

  if (action === "copy") {
    try { unlinkSync(path); } catch { /* ignore */ }
    return { action, date, time, note: "已忽略(剪贴板原样保留,可直接粘贴)" };
  }

  const kind = action === "doc" ? KIND.DOC : KIND.IMG;
  const imageRel = saveAttachment(config, path, date, fileStamp, kind);

  if (kind === KIND.IMG) {
    try { unlinkSync(path); } catch { /* ignore */ }
    const notePath = appendEntry(config, { date, time, kind, imageRel, note, isKey });
    return { action, date, time, imageRel, notePath, note: `已存图片:${imageRel}` };
  }

  // 文档:先占位落笔记,后台 OCR 后回填
  const notePath = appendEntry(config, { date, time, kind, imageRel, ocrText: null, note, isKey });
  let ocrText = "";
  let ocrError = "";
  try {
    ocrText = await ocrImage(config, path, host);
  } catch (err) {
    ocrError = err.message;
  } finally {
    try { unlinkSync(path); } catch { /* ignore */ }
  }

  const text = ocrError ? `（识别失败:${ocrError}）` : ocrText;
  const written = await writeBackWithRetry(config, { date, time, imageRel, ocrText: text }, host);
  return {
    action,
    date,
    time,
    imageRel,
    notePath,
    ocrText: ocrText || null,
    ocrError: ocrError || null,
    ocrWritten: written.ok,
    note: ocrError
      ? `图片已存,但 OCR 失败:${ocrError}`
      : written.ok
        ? `已存文档(含 OCR 文字,${ocrText.length} 字)`
        : `已存文档,但文字没能写回笔记:${written.reason}`,
  };
}

/**
 * 把识别结果写回笔记(带重试与兜底暂存)。
 *
 * 单次失败不再直接放弃:云同步盘 / Obsidian 会短暂占用文件,先等 800ms 重试一次;
 * 两次都不行就把识别结果**暂存**到 %TEMP%\dsh-capture\pending-ocr.jsonl 并明确告警,
 * 绝不静默丢字(2026-09-29 现场:一条卡在「OCR: 识别中…」,其实文字已经识别出来了)。
 */
async function writeBackWithRetry(config, payload, host) {
  let result = { ok: false, reason: "未执行" };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      result = updateEntryOcr(config, payload);
    } catch (err) {
      result = { ok: false, reason: `写入异常 ${err.code ?? ""} ${err.message}`.trim() };
    }
    if (result.ok) return result;
    if (attempt === 0) await new Promise((r) => setTimeout(r, 800));
  }
  try {
    appendFileSync(PENDING_OCR_LOG, `${JSON.stringify({ at: new Date().toISOString(), ...payload })}\n`, "utf8");
    result.salvaged = PENDING_OCR_LOG;
  } catch {
    /* 暂存都失败就只能靠日志 */
  }
  host.logger?.warn?.(
    `dsh-screenshot-capture: OCR 文字没能写回笔记(${result.reason});图片 ${payload.imageRel}` +
      (result.salvaged ? `;识别结果已暂存 ${result.salvaged}` : ";识别结果仅在日志里"),
  );
  return result;
}
