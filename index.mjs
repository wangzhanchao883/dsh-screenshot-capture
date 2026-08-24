import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { ClipboardWatcher } from "./clipboard.mjs";
import { DEFAULT_CONFIG, ensureVault, resolveConfig } from "./config.mjs";
import { handleChoice } from "./core.mjs";
import { listEntriesForDate, organizeDay } from "./organize.mjs";
import { readDailyNote, todayString } from "./storage.mjs";

export const name = "dsh-screenshot-capture";
export const inject = ["tools"];

/**
 * 设置命名空间:Web 配置界面读写它。用户层持久化在 settings.yaml,
 * config.json 作为 base(旧配置自动继承)。配置变化实时生效。
 */
const SETTINGS_NS = "dsh-screenshot-capture";

/**
 * 扁平 schema:settings 客户端的 set(field, value) 只支持单段路径,
 * 所以把嵌套的 ocr/dialog 拍平,host 侧再映射回插件结构。
 */
const settingsSchema = z.object({
  enabled: z.boolean().default(true),
  vaultPath: z.string().default(DEFAULT_CONFIG.vaultPath),
  pollIntervalMs: z.number().min(50).max(60000).default(DEFAULT_CONFIG.pollIntervalMs),
  cooldownMs: z.number().min(0).max(120000).default(DEFAULT_CONFIG.cooldownMs),
  ocrMode: z.union([z.const("qwen"), z.const("off")]).default(DEFAULT_CONFIG.ocr.mode),
  ocrModel: z.string().default(DEFAULT_CONFIG.ocr.model),
  ocrApiKey: z.string().default(""),
  ocrEndpoint: z.string().default(DEFAULT_CONFIG.ocr.endpoint),
  ocrPrompt: z.string().default(DEFAULT_CONFIG.ocr.prompt),
  dialogOffsetX: z.number().min(-1000).max(1000).default(DEFAULT_CONFIG.dialog.offsetX),
  dialogOffsetY: z.number().min(-1000).max(1000).default(DEFAULT_CONFIG.dialog.offsetY),
  dialogPreviewMaxWidth: z.number().min(100).max(2000).default(DEFAULT_CONFIG.dialog.previewMaxWidth),
});

/** 插件嵌套结构 → 扁平 settings 结构 */
function toFlat(config) {
  return {
    enabled: config.enabled,
    vaultPath: config.vaultPath,
    pollIntervalMs: config.pollIntervalMs,
    cooldownMs: config.cooldownMs,
    ocrMode: config.ocr?.mode,
    ocrModel: config.ocr?.model,
    ocrApiKey: config.ocr?.apiKey ?? "",
    ocrEndpoint: config.ocr?.endpoint,
    ocrPrompt: config.ocr?.prompt,
    dialogOffsetX: config.dialog?.offsetX,
    dialogOffsetY: config.dialog?.offsetY,
    dialogPreviewMaxWidth: config.dialog?.previewMaxWidth,
  };
}

/** 扁平 settings 结构 → 插件嵌套结构 */
function fromFlat(flat) {
  return {
    enabled: flat.enabled,
    vaultPath: flat.vaultPath,
    pollIntervalMs: flat.pollIntervalMs,
    cooldownMs: flat.cooldownMs,
    ocr: {
      mode: flat.ocrMode,
      model: flat.ocrModel,
      apiKey: flat.ocrApiKey || "",
      endpoint: flat.ocrEndpoint,
      prompt: flat.ocrPrompt,
    },
    dialog: {
      offsetX: flat.dialogOffsetX,
      offsetY: flat.dialogOffsetY,
      previewMaxWidth: flat.dialogPreviewMaxWidth,
    },
  };
}

export function apply(ctx, input = {}) {
  // 初始配置:默认值 ← config.json ← 插件行 config
  let liveConfig = resolveConfig(input);
  if (!liveConfig.vaultPath) {
    ctx.logger.warn("dsh-screenshot-capture: 未配置 vaultPath,采集功能已停用");
  }
  try {
    ensureVault(liveConfig);
  } catch (err) {
    ctx.logger.warn(`dsh-screenshot-capture: vault 初始化失败:${err.message}`);
  }

  // ---- 剪贴板监听:单例 + 串行化重启 ----
  // 全程只有一个 watcher。配置变化时先等旧 PowerShell 进程真正退出
  // (stopAsync:kill + taskkill 兜底 + 超时),再起新的;配置没变就不重启,
  // 避免残留多个监听导致一次截图弹多个窗。
  let watcher = null;
  let watcherKey = null; // 当前 watcher 所用配置的特征串
  let disposed = false;
  let restartChain = Promise.resolve();

  const configKey = (cfg) => JSON.stringify({
    enabled: cfg.enabled,
    vaultPath: cfg.vaultPath,
    pollIntervalMs: cfg.pollIntervalMs,
    cooldownMs: cfg.cooldownMs,
    dialogOffsetX: cfg.dialog?.offsetX,
    dialogOffsetY: cfg.dialog?.offsetY,
    dialogPreviewMaxWidth: cfg.dialog?.previewMaxWidth,
  });

  const scheduleRestart = () => {
    const cfg = liveConfig;
    const key = configKey(cfg);
    restartChain = restartChain.then(async () => {
      if (disposed || key === watcherKey) return;
      watcherKey = key;
      const old = watcher;
      if (old) {
        watcher = null;
        await old.stopAsync();
      }
      if (!cfg.enabled || !cfg.vaultPath) return;
      const w = new ClipboardWatcher(cfg);
      w.on("choice", async ({ action, path, note = "", isKey = false }) => {
        try {
          const result = await handleChoice(cfg, { action, path, note, isKey });
          ctx.logger.info(`dsh-screenshot-capture: ${result.note} (${action})`);
        } catch (err) {
          ctx.logger.warn(`dsh-screenshot-capture: 处理失败:${err.message}`);
        }
      });
      w.on("err", (ev) => ctx.logger.warn(`dsh-screenshot-capture: ${ev.msg}`));
      w.on("exit", (ev) => ctx.logger.info(`dsh-screenshot-capture: 监听助手退出 code=${ev.code}`));
      watcher = w;
      w.start();
    });
  };

  const disposeWatcher = () => {
    disposed = true;
    if (watcher) {
      watcher.stop();
      watcher = null;
    }
  };

  ctx.effect(
    () => {
      scheduleRestart();
      return disposeWatcher;
    },
    "dsh-screenshot-capture.watcher",
  );

  // 设置命名空间:Web 配置界面的数据层。settings 服务由 dsh-settings-file
  // 提供,apply 时未必已就绪,须用 ctx.inject 等它可用后再注册(直接
  // ctx.get 会拿到 undefined,导致命名空间没注册、界面显示不可用)。
  ctx.inject(["settings"], (settingsCtx) => {
    try {
      const scope = settingsCtx.settings.register(SETTINGS_NS, settingsSchema, {
        base: toFlat(liveConfig),
      });
      const resolved = scope.get();
      if (resolved) {
        liveConfig = { ...liveConfig, ...fromFlat(resolved) };
        scheduleRestart();
      }
      scope.watch((next) => {
        if (!next) return;
        liveConfig = { ...liveConfig, ...fromFlat(next) };
        scheduleRestart();
      });
    } catch (err) {
      ctx.logger.warn(`dsh-screenshot-capture: 设置命名空间注册失败,使用 JSON 配置:${err.message}`);
    }
  });

  // 工具
  ctx.tools.register(textTool({
    name: "screenshot_status",
    description:
      "查询「截图入库」插件的状态:监听是否开启、vault 路径、今天的已收条目数。",
    parameters: {},
    async execute() {
      const today = todayString();
      const note = readDailyNote(liveConfig, today);
      const count = (note.match(/^## /gm) || []).length;
      return [
        `监听:${watcher?.started ? "运行中" : "未运行"}`,
        `vault:${liveConfig.vaultPath}`,
        `OCR:${liveConfig.ocr?.mode ?? "off"}`,
        `今日条目:${count}`,
      ].join("\n");
    },
  }));

  ctx.tools.register(textTool({
    name: "screenshot_inbox_list",
    description:
      "列出某天「收件箱」里的全部截图条目(时间/类型/OCR文字)。晚间整理前调用,展示给用户选择保留哪些。",
    parameters: {
      date: { type: "string", description: "日期 YYYY-MM-DD,缺省今天" },
    },
    async execute(args) {
      const date = args.date || todayString();
      const entries = listEntriesForDate(liveConfig, date);
      if (entries.length === 0) return `${date} 收件箱为空(还没有截图入库)`;
      return entries
        .map((e, i) => {
          const lines = [`${i + 1}. [${e.time}] #${e.kind} ${e.imageRel ?? ""}`];
          if (e.isKey) lines.push(`   重点:是`);
          if (e.note) lines.push(`   注释:${e.note}`);
          lines.push(`   OCR:${(e.ocrText || "无").slice(0, 120)}`);
          return lines.join("\n");
        })
        .join("\n");
    },
  }));

  ctx.tools.register(textTool({
    name: "screenshot_inbox_organize",
    description:
      "晚间整理:对某天收件箱里【保留】的条目,按分类写入知识库并生成笔记、更新分类索引、写当日总结、加双链,然后把当天收件箱笔记移入归档。keep 传 'all' 表示全部保留。",
    parameters: {
      date: { type: "string", description: "日期 YYYY-MM-DD,缺省今天" },
      keep: {
        type: "array",
        items: { type: "string" },
        description: "保留条目的时间列表(如 ['14:30','15:02']),或 ['all'] 表示全部保留",
      },
      categories: {
        type: "object",
        additionalProperties: true,
        description: "可选:时间→分类名 的映射(如 {'14:30':'数学'}),缺省归入『未分类』",
      },
      summaryTitle: { type: "string", description: "可选:当日总结标题" },
    },
    async execute(args) {
      const date = args.date || todayString();
      const keepRaw = Array.isArray(args.keep) ? args.keep : ["all"];
      const keep = keepRaw.includes("all") ? null : keepRaw;
      const result = organizeDay(liveConfig, {
        date,
        keep,
        categories: args.categories ?? {},
        summaryTitle: args.summaryTitle ?? "",
      });
      return [
        `日期:${result.date}`,
        `保留:${result.keptCount} 条,丢弃:${result.discardedCount} 条`,
        `分类:${JSON.stringify(result.categories)}`,
        `总结:${result.summaryPath}`,
        `归档:${result.archived ?? "无"}`,
        `生成笔记:`,
        ...result.files.map((f) => `  ${f}`),
      ].join("\n");
    },
  }));
}

function textTool(definition) {
  return defineTool({
    ...definition,
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    presentCall: (args) => ({
      card: "generic",
      kind: "text",
      title: definition.name,
      rawInput: args,
    }),
  });
}
