// OCR 联调测试:用真实 key 识别测试图,验证 key/模型/接口可用
import { resolveConfig } from "../config.mjs";
import { ocrImage } from "../ocr.mjs";

const config = resolveConfig();
console.log(`[ocr-test] mode=${config.ocr.mode} model=${config.ocr.model} key=${config.ocr.apiKey ? "已配置(" + config.ocr.apiKey.slice(0, 8) + "...)" : "未配置"}`);

try {
  const text = await ocrImage(config, "D:/workout/deepseekharness/dsh-screenshot-capture/test/sample.png");
  console.log("[ocr-test] 成功,识别结果:");
  console.log(text);
} catch (err) {
  console.error("[ocr-test] 失败:", err.message);
  process.exitCode = 1;
}
