import { unlinkSync } from "node:fs";
import { ocrImage } from "./ocr.mjs";
import {
  appendEntry,
  KIND,
  saveAttachment,
  stampParts,
  updateEntryOcr,
} from "./storage.mjs";

/**
 * 悬浮窗选择处理(插件与独立测试共用):
 *   copy → 剪贴板原样不动,仅清理临时图
 *   doc  → 图片入附件 + 当天笔记立即追加(#文档,OCR 占位)→ 后台 OCR → 回填文字
 *   img  → 图片入附件 + 当天笔记追加(#图片,无 OCR)
 * note/isKey 来自悬浮窗:用户注释 + 「重点」标记(标题一 # **重点**)。
 */
export async function handleChoice(config, { action, path, note = "", isKey = false }) {
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
    ocrText = await ocrImage(config, path);
  } catch (err) {
    ocrError = err.message;
  } finally {
    try { unlinkSync(path); } catch { /* ignore */ }
  }
  if (!ocrError) {
    updateEntryOcr(config, { date, time, imageRel, ocrText });
  } else {
    // OCR 失败时也把占位替换为失败说明
    updateEntryOcr(config, { date, time, imageRel, ocrText: `（识别失败:${ocrError}）` });
  }
  return {
    action,
    date,
    time,
    imageRel,
    notePath,
    ocrText: ocrText || null,
    ocrError: ocrError || null,
    note: ocrError
      ? `图片已存,但 OCR 失败:${ocrError}`
      : `已存文档(含 OCR 文字,${ocrText.length} 字)`,
  };
}
