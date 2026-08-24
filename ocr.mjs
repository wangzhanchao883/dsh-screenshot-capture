import { readFileSync } from "node:fs";

/** 通义千问多模态 OCR。key 优先取配置,其次环境变量 DASHSCOPE_API_KEY。 */
export async function ocrImage(config, imagePath) {
  const mode = config.ocr?.mode ?? "off";
  if (mode === "off") return "";
  if (mode === "qwen") return ocrQwen(config, imagePath);
  throw new Error(`OCR: 未知模式 ${mode}`);
}

async function ocrQwen(config, imagePath) {
  const apiKey = config.ocr?.apiKey || process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error("OCR: 未配置通义 API key(配置 config.json 或环境变量 DASHSCOPE_API_KEY)");

  const b64 = readFileSync(imagePath).toString("base64");
  const mime = imagePath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
  const endpoint = config.ocr?.endpoint ?? "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
  const model = config.ocr?.model ?? "qwen-vl-plus";
  const prompt = config.ocr?.prompt ?? "请识别图片中的全部文字内容,原样输出;数学公式用 LaTeX 输出。只输出识别结果,不要任何解释。";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
              { type: "text", text: prompt },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OCR: 通义接口 ${res.status} ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== "string") throw new Error("OCR: 通义返回格式异常");
    return text.trim();
  } finally {
    clearTimeout(timer);
  }
}
