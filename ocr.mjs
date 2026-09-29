import { readFileSync } from "node:fs";

const DEFAULT_PROMPT =
  "请识别图片中的全部文字内容,原样输出;数学公式用 LaTeX 输出。只输出识别结果,不要任何解释。";

/**
 * 图片文字识别(OCR)。
 *
 * 三种模式(config.ocr.mode):
 *   host → **宿主大模型**(DSH 0.1.7+ 的 llm + attachments 服务),零配置、不另要 key
 *   qwen → 通义千问兼容接口(key 取配置,其次环境变量 DASHSCOPE_API_KEY)
 *   off  → 不识别
 *
 * host 模式带**回落链**:宿主没有 llm/attachments、默认模型没声明图片输入、
 * 请求报错或返回空 → 只要有千问 key 就自动回落 qwen;两条都不行才抛错,
 * 并把两条原因都写进错误里(笔记里能直接看到,不静默)。
 *
 * @param host - 宿主服务句柄 { llm, attachments, agentDefaultModel, logger },由插件注入的 getter 提供
 */
export async function ocrImage(config, imagePath, host = {}) {
  const mode = config.ocr?.mode ?? "host";
  if (mode === "off") return "";
  if (mode === "qwen") return ocrQwen(config, imagePath);
  if (mode === "host") return ocrHostWithFallback(config, imagePath, host);
  throw new Error(`OCR: 未知模式 ${mode}`);
}

/** host 优先,失败回落 qwen,都不行则把两条原因一起抛出 */
async function ocrHostWithFallback(config, imagePath, host) {
  const reasons = [];
  try {
    return await ocrHost(config, imagePath, host);
  } catch (err) {
    reasons.push(`宿主模型: ${err.message}`);
    host.logger?.warn?.(`dsh-screenshot-capture: 宿主 LLM 识别失败,尝试回落千问 —— ${err.message}`);
  }
  const apiKey = config.ocr?.apiKey || process.env.DASHSCOPE_API_KEY;
  if (!apiKey) {
    reasons.push("千问: 未配置 key(可选,配了就能兜底)");
    throw new Error(reasons.join(" | "));
  }
  try {
    return await ocrQwen(config, imagePath);
  } catch (err) {
    reasons.push(`千问: ${err.message}`);
    throw new Error(reasons.join(" | "));
  }
}

// ---------------------------------------------------------------- 宿主大模型

/**
 * 用宿主的大模型做识别(零配置路)。
 *
 * 契约(0.1.7 实测):
 *  ① 图片必须走**附件服务**换 ImageAttachmentRef —— 消息里的 ImageBlock 只认 attachment,
 *     不能塞 base64 data URL;宿主会按模型的像素/字节预算自己重编码。
 *  ② 一次性调用用 `RequestUserInput`({role,content},不带 id/source)最省事。
 *  ③ `ctx.llm` 只有 stream(),没有 call();必须收 text-delta。
 *  ④ 是否支持图片看 **catalog 的 inputModalities**(不是模型真实能力),所以要校验。
 */
async function ocrHost(config, imagePath, host) {
  const llm = host.llm;
  const attachments = host.attachments;
  if (!llm || typeof llm.stream !== "function") {
    throw new Error("宿主 llm 服务不可用(需要 DSH 0.1.7+ 且该 profile 已加载 dsh-llm)");
  }
  if (!attachments || typeof attachments.saveImage !== "function") {
    throw new Error("宿主 attachments 服务不可用(需要 dsh-attachment)");
  }

  const route = await resolveHostRoute(config, llm, host);

  const data = readFileSync(imagePath);
  const mediaType = data[0] === 0x89 && data[1] === 0x50 ? "image/png" : "image/jpeg";
  const limits = attachments.imageLimits;
  if (limits?.mediaTypes && !limits.mediaTypes.includes(mediaType)) {
    throw new Error(`宿主不接受 ${mediaType}`);
  }
  if (limits?.maxImageBytes && data.byteLength > limits.maxImageBytes) {
    throw new Error(`图片 ${(data.byteLength / 1048576).toFixed(1)}MB 超过宿主上限 ${(limits.maxImageBytes / 1048576).toFixed(1)}MB`);
  }

  const ref = await attachments.saveImage({ data, mediaType, name: `screenshot.${mediaType === "image/png" ? "png" : "jpg"}` });
  const prompt = config.ocr?.prompt || DEFAULT_PROMPT;
  const message = {
    role: "user",
    content: [
      { type: "text", text: prompt },
      { type: "image", attachment: ref },
    ],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  let out = "";
  try {
    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      messages: [message],
      // 识别只要结果,不要推理:推理会吃掉输出预算,把整批变成"解析为空"
      reasoningEffort: "off",
      maxTokens: 4000,
      signal: controller.signal,
    })) {
      if (chunk?.type === "text-delta" && typeof chunk.text === "string") out += chunk.text;
      if (chunk?.type === "finish" && chunk.reason?.kind === "error") {
        throw new Error(`模型返回错误 ${chunk.reason.failure?.code ?? "unknown"}: ${chunk.reason.failure?.message ?? ""}`);
      }
    }
  } catch (err) {
    if (err?.name === "AbortError") throw new Error("宿主模型调用超时(120s)");
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const text = out.trim();
  if (!text) throw new Error("宿主模型返回空文本");
  return text;
}

/**
 * 选宿主模型路由:先看显式配置的 hostModel,再看宿主默认模型,最后在目录里
 * 找第一个声明了 image 模态的。选不出来就抛错(交给回落链)。
 */
async function resolveHostRoute(config, llm, host) {
  const want = String(config.ocr?.hostModel ?? "").trim();
  let sel = null;
  try {
    sel = host.agentDefaultModel?.currentSelection?.() ?? null;
  } catch {
    sel = null;
  }

  const candidates = [];
  if (want) {
    const provider = sel?.provider ?? (llm.listProviders?.()[0]?.id ?? undefined);
    candidates.push({ provider, model: want, why: "配置的 hostModel" });
  }
  if (sel?.provider && sel.model) candidates.push({ provider: sel.provider, model: sel.model, why: "宿主默认模型" });

  // 目录兜底:同一 provider 优先,其次任意 provider
  try {
    const providers = (llm.listProviders?.() ?? []).map((p) => p?.id ?? p).filter(Boolean);
    const ordered = sel?.provider ? [sel.provider, ...providers.filter((p) => p !== sel.provider)] : providers;
    for (const provider of ordered) {
      const models = await llm.listModels(provider);
      const hit = (models ?? []).find((m) => (m.inputModalities ?? []).includes("image"));
      if (hit) candidates.push({ provider: hit.provider ?? provider, model: hit.id, why: "目录中声明图片输入的模型" });
    }
  } catch {
    /* 目录不可用就不兜底,靠前面的候选 */
  }

  const seen = new Set();
  for (const cand of candidates) {
    if (!cand.provider || !cand.model) continue;
    const key = `${cand.provider}/${cand.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (await modelAcceptsImage(llm, cand)) {
      host.logger?.info?.(`dsh-screenshot-capture: OCR 使用宿主模型 ${key}(${cand.why})`);
      return cand;
    }
  }

  const tried = [...seen].join(", ") || "（无候选）";
  throw new Error(
    `宿主没有声明图片输入的模型(试过 ${tried});` +
      `可在 DSH 设置里给模型加 inputModalities: [text, image],或在插件设置里指定 ocrHostModel`,
  );
}

/** catalog 里该模型是否声明了 image 模态(宿主拦图片请求就是看这个);查不到就放行让请求自己报错 */
async function modelAcceptsImage(llm, { provider, model }) {
  try {
    const models = await llm.listModels(provider);
    const hit = (models ?? []).find((m) => m.id === model);
    if (!hit) return true;
    return (hit.inputModalities ?? []).includes("image");
  } catch {
    return true;
  }
}

// ------------------------------------------------------------------ 通义千问

async function ocrQwen(config, imagePath) {
  const apiKey = config.ocr?.apiKey || process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error("未配置通义 API key(配置 config.json 或环境变量 DASHSCOPE_API_KEY)");

  const b64 = readFileSync(imagePath).toString("base64");
  const mime = imagePath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
  const endpoint = config.ocr?.endpoint ?? "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
  const model = config.ocr?.model ?? "qwen-vl-plus";
  const prompt = config.ocr?.prompt ?? DEFAULT_PROMPT;

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
      throw new Error(`通义接口 ${res.status} ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== "string") throw new Error("通义返回格式异常");
    return text.trim();
  } finally {
    clearTimeout(timer);
  }
}
