/**
 * 独立测试入口(不依赖 DSH):拉起剪贴板监听 + 悬浮窗,处理选择并写入 Obsidian。
 *
 * 用法:
 *   node dev-run.mjs                 # 交互模式:截图后真实弹窗
 *   node dev-run.mjs --auto doc      # 自动模式:检测到截图自动"存文档"(无弹窗)
 *   node dev-run.mjs --auto img --seconds 30
 *
 * 环境变量:
 *   DSC_VAULT_PATH  覆盖 vault 路径
 *   DASHSCOPE_API_KEY  通义 OCR key
 */
import { resolveConfig, saveConfig } from "./config.mjs";
import { ClipboardWatcher } from "./clipboard.mjs";
import { handleChoice } from "./core.mjs";
import { todayString, readDailyNote } from "./storage.mjs";

const args = process.argv.slice(2);
const autoIdx = args.indexOf("--auto");
const autoAction = autoIdx >= 0 ? args[autoIdx + 1] || "doc" : "";
const secIdx = args.indexOf("--seconds");
const seconds = secIdx >= 0 ? Number(args[secIdx + 1]) || 0 : 0;

const config = resolveConfig(process.env.DSC_VAULT_PATH ? { vaultPath: process.env.DSC_VAULT_PATH } : {});

console.log(`[dev] vault: ${config.vaultPath}`);
console.log(`[dev] OCR:   ${config.ocr.mode}${config.ocr.apiKey ? "" : " (未配置 key,OCR 将失败但流程可跑通)"}`);
console.log(`[dev] auto:  ${autoAction || "交互弹窗"}`);

const watcher = new ClipboardWatcher(config, { autoAction });
watcher.on("ready", () => console.log("[dev] 监听助手就绪,去 Win+Shift+S 截图或 Ctrl+C 复制图片吧"));
watcher.on("img", (ev) => console.log(`[dev] 检测到截图:${ev.path}`));
watcher.on("err", (ev) => console.error(`[dev] 错误:${ev.msg}`));
watcher.on("choice", async (ev) => {
  try {
    const r = await handleChoice(config, ev);
    console.log(`[dev] ${r.note}`);
    if (r.action !== "copy") {
      console.log(`[dev]   笔记: ${r.notePath}`);
      if (r.ocrText) console.log(`[dev]   OCR(${r.ocrText.length}字): ${r.ocrText.slice(0, 100)}…`);
      if (r.ocrError) console.error(`[dev]   OCR 失败: ${r.ocrError}`);
    }
  } catch (err) {
    console.error(`[dev] 处理失败:${err.message}`);
  }
});
watcher.on("exit", (ev) => console.log(`[dev] 监听助手退出 code=${ev.code}`));

watcher.start();

if (seconds > 0) {
  setTimeout(() => {
    console.log(`[dev] ${seconds}s 到,停止。`);
    watcher.stop();
    process.exit(0);
  }, seconds * 1000);
}

process.on("SIGINT", () => {
  watcher.stop();
  console.log("[dev] 已停止。今天的收件箱笔记:");
  console.log(readDailyNote(config, todayString()) || "(空)");
  process.exit(0);
});
