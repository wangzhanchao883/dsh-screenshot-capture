// OCR 联调测试:用真实 key 识别测试图,验证 key/模型/接口可用。
// 需要配置 DASHSCOPE_API_KEY 或 config.json 的 ocr.apiKey 才能真实调用;
// 未配置时直接跳过(不报错),避免纯本地 CI 因缺 key/无网络而失败。
import { resolveConfig } from "../config.mjs";
import { ocrImage } from "../ocr.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, "test", "sample.png");
const config = resolveConfig();
console.log(`[ocr-test] mode=${config.ocr.mode} model=${config.ocr.model} key=${config.ocr.apiKey ? "已配置" : "未配置"}`);

if (!config.ocr.apiKey) {
  console.log("[ocr-test] 未配置 ocr.apiKey/DASHSCOPE_API_KEY,跳过真实 OCR 联调(本地无 key 时测试不应失败)。");
  process.exit(0);
}

try {
  const text = await ocrImage(config, src);
  console.log("[ocr-test] 成功,识别结果:");
  console.log(text);
} catch (err) {
  console.error("[ocr-test] 失败:", err.message);
  process.exitCode = 1;
}
