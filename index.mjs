import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { ClipboardWatcher } from "./clipboard.mjs";
import { DEFAULT_CONFIG, ensureVault, plain, resolveConfig } from "./config.mjs";
import { createSerialQueue, handleChoice } from "./core.mjs";
import { listEntriesForDate, organizeDay } from "./organize.mjs";
import { readDailyNote, todayString } from "./storage.mjs";

export const name = "dsh-screenshot-capture";
export const inject = ["tools"];

/**
 * 设置命名空间 = 本插件在 profile 里的**条目 id**(cordis.patch.yml 的 insert[].id),
 * 不是随便起的字符串。DSH 0.1.7 起设置服务按条目 id 投影 Config。
 */
const SETTINGS_NS = "dsh-screenshot-capture";

/**
 * 降级包装:schemastery < 3.18.4 没有 .volatile(),直接调用会抛
 * "volatile is not a function"(模块加载期就崩)。带上兜底更稳。
 */
const vol = (schema) => (typeof schema.volatile === "function" ? schema.volatile() : schema);

/**
 * 插件配置 schema。DSH 0.1.7 的设置服务**直接投影 loader 条目上的这个 Config**,
 * 不再需要插件事先 register 一份 schema+值(那是双份数据源)。
 *
 * 两条硬门禁:
 *  ① 必须是**纯具名导出**(`export const Config`),绝不能加 `export default` ——
 *     加载器剥壳后读的是 `plugin.Config`,一旦有 default 就会剥成那个函数,Config 丢失,
 *     设置页**静默消失**(describe() 里 `return []`,一个日志都不打)。
 *  ② 每个会被设置页写入的字段都要 `.volatile()` 盖章 —— 否则整个条目被
 *     volatileForm() 过滤掉;漏盖的单个字段在写入时抛 `Config field "x" is not volatile`。
 *
 * 结构保持扁平:客户端便捷方法 `set(field, value)` 只收单个一级字段名(path:[field])。
 * 嵌套 schema 本身是合法的(volatileForm / isVolatilePath 都递归),这里扁平只是
 * 为了配合 set() —— 所以 host 侧再做一层扁平 ↔ 嵌套的映射。
 */
export const Config = z.object({
  enabled: vol(z.boolean().default(true)),
  vaultPath: vol(z.string().default(DEFAULT_CONFIG.vaultPath)),
  pollIntervalMs: vol(z.number().min(50).max(60000).default(DEFAULT_CONFIG.pollIntervalMs)),
  cooldownMs: vol(z.number().min(0).max(120000).default(DEFAULT_CONFIG.cooldownMs)),
  ocrMode: vol(z.union([z.const("host"), z.const("qwen"), z.const("off")]).default(DEFAULT_CONFIG.ocr.mode)),
  ocrHostModel: vol(z.string().default(DEFAULT_CONFIG.ocr.hostModel)),
  ocrModel: vol(z.string().default(DEFAULT_CONFIG.ocr.model)),
  ocrApiKey: vol(z.string().default("")),
  ocrEndpoint: vol(z.string().default(DEFAULT_CONFIG.ocr.endpoint)),
  ocrPrompt: vol(z.string().default(DEFAULT_CONFIG.ocr.prompt)),
  dialogOffsetX: vol(z.number().min(-1000).max(1000).default(DEFAULT_CONFIG.dialog.offsetX)),
  dialogOffsetY: vol(z.number().min(-1000).max(1000).default(DEFAULT_CONFIG.dialog.offsetY)),
  dialogPreviewMaxWidth: vol(z.number().min(100).max(2000).default(DEFAULT_CONFIG.dialog.previewMaxWidth)),
});

const has = (flat, key) => Object.prototype.hasOwnProperty.call(flat, key) && flat[key] !== undefined;

/** 插件嵌套结构 → 扁平 settings 结构(与 fromFlat 互逆,用于输入归一化) */
function toFlat(config) {
  return {
    enabled: config.enabled,
    vaultPath: config.vaultPath,
    pollIntervalMs: config.pollIntervalMs,
    cooldownMs: config.cooldownMs,
    ocrMode: config.ocr?.mode,
    ocrHostModel: config.ocr?.hostModel ?? "",
    ocrModel: config.ocr?.model,
    ocrApiKey: config.ocr?.apiKey ?? "",
    ocrEndpoint: config.ocr?.endpoint,
    ocrPrompt: config.ocr?.prompt,
    dialogOffsetX: config.dialog?.offsetX,
    dialogOffsetY: config.dialog?.offsetY,
    dialogPreviewMaxWidth: config.dialog?.previewMaxWidth,
  };
}

/** schema 默认值(DEFAULT_CONFIG 与 Config 逐字段同源,拿它当"没配过"的判据) */
const DEFAULTS_FLAT = toFlat(DEFAULT_CONFIG);

/**
 * 丢掉"等于 schema 默认值"的字段。
 *
 * DSH 0.1.7 传进 apply 的 input 是**完整解析后的配置**(默认值全在),
 * 再也分不出"用户显式配了默认值"和"根本没配"。若无脑用它覆盖,
 * config.json 里配好的 vaultPath 会被默认空串冲掉 → 监听直接停摆。
 * 判据取 DEFAULT_CONFIG(与 Config 的 .default() 同源)。
 */
function dropDefaults(flat) {
  return Object.fromEntries(
    Object.entries(flat).filter(([key, value]) => value !== undefined && !Object.is(value, DEFAULTS_FLAT[key])),
  );
}

/**
 * settings 投影值 → 插件嵌套结构(只取真实存在的字段)。
 * 设置服务的 value 是**投影结果**,缺字段时返回 undefined;若无脑写进
 * liveConfig 会把已解析好的默认值冲掉,所以逐字段判存。
 */
function fromFlat(flat) {
  const out = {};
  const ocr = {};
  const dialog = {};
  if (has(flat, "enabled")) out.enabled = flat.enabled;
  if (has(flat, "vaultPath")) out.vaultPath = flat.vaultPath;
  if (has(flat, "pollIntervalMs")) out.pollIntervalMs = flat.pollIntervalMs;
  if (has(flat, "cooldownMs")) out.cooldownMs = flat.cooldownMs;
  if (has(flat, "ocrMode")) ocr.mode = flat.ocrMode;
  if (has(flat, "ocrHostModel")) ocr.hostModel = flat.ocrHostModel ?? "";
  if (has(flat, "ocrModel")) ocr.model = flat.ocrModel;
  if (has(flat, "ocrApiKey")) ocr.apiKey = flat.ocrApiKey || "";
  if (has(flat, "ocrEndpoint")) ocr.endpoint = flat.ocrEndpoint;
  if (has(flat, "ocrPrompt")) ocr.prompt = flat.ocrPrompt;
  if (has(flat, "dialogOffsetX")) dialog.offsetX = flat.dialogOffsetX;
  if (has(flat, "dialogOffsetY")) dialog.offsetY = flat.dialogOffsetY;
  if (has(flat, "dialogPreviewMaxWidth")) dialog.previewMaxWidth = flat.dialogPreviewMaxWidth;
  if (Object.keys(ocr).length > 0) out.ocr = ocr;
  if (Object.keys(dialog).length > 0) out.dialog = dialog;
  return out;
}

/** 把 settings 投影值深合并进 liveConfig(顶层浅合并 + ocr/dialog 逐层合并) */
function mergeSettings(liveConfig, flat) {
  const patch = fromFlat(flat);
  return {
    ...liveConfig,
    ...patch,
    ocr: patch.ocr ? { ...liveConfig.ocr, ...patch.ocr } : liveConfig.ocr,
    dialog: patch.dialog ? { ...liveConfig.dialog, ...patch.dialog } : liveConfig.dialog,
  };
}

export function apply(ctx, input = {}) {
  // 初始配置:默认值 ← config.json ← 插件行显式 config。
  // ① input 先 plain() 解包 Volatile cell(0.1.7 每个 volatile 字段都是 cell);
  // ② 再 dropDefaults 丢掉"等于 schema 默认值"的字段 —— 否则宿主灌进来的
  //    默认值(尤其 vaultPath: "")会把 config.json 里配好的路径冲掉。
  let liveConfig = mergeSettings(resolveConfig(), dropDefaults(toFlat(plain(input))));
  // vaultPath 为空时**不碰磁盘**:ensureVault 用的是 join(vaultPath, ...),
  // 空路径会解析成相对路径、在进程 cwd 下凭空建出「收件箱/知识库」等目录 ——
  // 正是上面那条告警承诺过不会发生的事。
  if (!liveConfig.vaultPath) {
    ctx.logger.warn("dsh-screenshot-capture: 未配置 vaultPath,采集功能已停用");
  } else {
    try {
      ensureVault(liveConfig);
    } catch (err) {
      ctx.logger.warn(`dsh-screenshot-capture: vault 初始化失败:${err.message}`);
    }
  }

  // ---- 剪贴板监听:单例 + 串行化重启 + 助手异常退出自动重试 ----
  // 全程只有一个 watcher。配置变化时先等旧 PowerShell 进程真正退出
  // (stopAsync:kill + taskkill 兜底 + 超时),再起新的;配置没变就不重启,
  // 避免残留多个监听导致一次截图弹多个窗。
  // 助手崩了要能自己回来:以前只打一条日志,任何一次异常退出都变成"静默失效"
  // (用户表现为「截图没弹窗」),所以这里带退避重试 + 明确告警。
  const MAX_RETRY = 5;
  let watcher = null;
  let watcherKey = null; // 当前 watcher 所用配置的特征串
  let disposed = false;
  let restartChain = Promise.resolve();
  let retryTimer = null;
  let retryCount = 0;

  const configKey = (cfg) => JSON.stringify({
    enabled: cfg.enabled,
    vaultPath: cfg.vaultPath,
    pollIntervalMs: cfg.pollIntervalMs,
    cooldownMs: cfg.cooldownMs,
    dialogOffsetX: cfg.dialog?.offsetX,
    dialogOffsetY: cfg.dialog?.offsetY,
    dialogPreviewMaxWidth: cfg.dialog?.previewMaxWidth,
  });

  // ---- 宿主服务句柄(OCR 走宿主大模型用) ----
  // 用 getter 惰性取:服务可能比本插件晚注册,而且**不硬依赖** ——
  // 老版本 DSH / 精简 profile 里没有 llm 或 attachments 时,插件照常跑,
  // 只是 OCR 回落千问,不会因为缺服务整个不激活。
  const host = {
    get llm() { return ctx.get("llm"); },
    get attachments() { return ctx.get("attachments"); },
    get agentDefaultModel() { return ctx.get("agentDefaultModel"); },
    logger: ctx.logger,
  };

  const startWatcher = (cfg) => {
    const w = new ClipboardWatcher(cfg);
    // 连拍两张时两次 handleChoice 会并发,而它内部是「读笔记 → 改 → 写回」→ 会互相覆盖;
    // 统一进串行队列(每次点击一个接一个走,OCR 慢也排队,不再丢文字)。
    const enqueueChoice = createSerialQueue();
    w.on("choice", ({ action, path, note = "", isKey = false }) => {
      enqueueChoice(async () => {
        try {
          const result = await handleChoice(cfg, { action, path, note, isKey }, host);
          ctx.logger.info(`dsh-screenshot-capture: ${result.note} (${action})`);
        } catch (err) {
          ctx.logger.warn(`dsh-screenshot-capture: 处理失败:${err.message}`);
        }
      });
    });
    w.on("err", (ev) => ctx.logger.warn(`dsh-screenshot-capture: ${ev.msg}`));
    w.on("ready", () => {
      if (retryCount > 0) ctx.logger.info(`dsh-screenshot-capture: 监听助手第 ${retryCount} 次重试后已就绪`);
      retryCount = 0;
    });
    w.on("exit", (ev) => {
      ctx.logger.warn(`dsh-screenshot-capture: 监听助手退出 code=${ev.code}`);
      // watcher !== w 说明这是配置变化/卸载时的**预期内**停止,不重试
      if (disposed || watcher !== w) return;
      watcher = null;
      watcherKey = null;
      scheduleRetry();
    });
    watcher = w;
    w.start();
  };

  const scheduleRetry = () => {
    if (disposed || retryTimer) return;
    const cfg = liveConfig;
    if (!cfg.enabled || !cfg.vaultPath) return;
    if (retryCount >= MAX_RETRY) {
      ctx.logger.warn(
        `dsh-screenshot-capture: 监听助手连续 ${MAX_RETRY} 次异常退出,已停止自动重启 —— 请检查 vaultPath 与 scripts/clip-dialog.ps1`,
      );
      return;
    }
    retryCount += 1;
    const delay = Math.min(30000, 2000 * 2 ** (retryCount - 1));
    ctx.logger.warn(`dsh-screenshot-capture: ${delay}ms 后自动重启监听助手(第 ${retryCount}/${MAX_RETRY} 次)`);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      restartChain = restartChain.then(async () => {
        if (disposed) return;
        const cur = liveConfig;
        if (!cur.enabled || !cur.vaultPath) return;
        watcherKey = configKey(cur);
        startWatcher(cur);
      });
    }, delay);
    retryTimer.unref?.();
  };

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
      retryCount = 0;
      startWatcher(cfg);
    });
  };

  const disposeWatcher = () => {
    disposed = true;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
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

  // 设置服务(DSH 0.1.7+):只读回**用户显式配置过**的字段做兜底。**不再自己 register** ——
  // 新契约下权威值就是本插件在 profile 条目上的 Config。
  // 关键:必须用 row.user,不能用 row.value / row.base —— 后两者是"投影结果",
  // schema 默认值也在里面(实测 vaultPath 恒为 "")。拿它覆盖 liveConfig 会把
  // config.json 里配好的 vaultPath 冲成空串 → scheduleRestart 直接 return,
  // 刚起来的监听助手还会被 stopAsync 杀掉 → 截图永远不弹窗(2026-09-29 定位的故障 B)。
  ctx.inject(["settings"], (settingsCtx) => {
    try {
      const settings = settingsCtx.settings;
      // 兼容旧版 DSH:没有 describe 就退回纯 JSON 配置,不报错。
      if (!settings || typeof settings.describe !== "function") return;
      const row = settings.describe().find((r) => r.ns === SETTINGS_NS);
      if (!row) return;
      const explicit = dropDefaults(toFlat(plain(row.user)));
      if (Object.keys(explicit).length === 0) return;
      liveConfig = mergeSettings(liveConfig, explicit);
      scheduleRestart();
    } catch (err) {
      ctx.logger.warn(`dsh-screenshot-capture: 读取设置失败,使用 JSON 配置:${err.message}`);
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
