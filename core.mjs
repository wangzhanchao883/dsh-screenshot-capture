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
  const written = updateEntryOcr(config, { date, time, imageRel, ocrText: text });
  if (!written.ok) {
    // 回填失败必须留痕:以前只 return null,笔记里就干留一句「识别中…」,谁也看不出出了问题
    host.logger?.warn?.(
      `dsh-screenshot-capture: OCR 文字没能写回笔记(${written.reason});图片 ${imageRel},识别结果 ${text.length} 字`,
    );
  }
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
