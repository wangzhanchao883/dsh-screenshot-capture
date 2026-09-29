import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  pollIntervalMs: 200,
  cooldownMs: 2000,
  // 默认库路径留空:未配置时采集功能自动停用并告警,绝不创建无关目录。
  // 首次使用请在 Web 设置 / config.json 里配置你自己的 Obsidian 库路径。
  vaultPath: "",
  inboxFolder: "收件箱",
  attachmentsFolder: "attachments",
  knowledgeFolder: "知识库",
  summaryFolder: "总结",
  archiveFolder: "归档",
  recycleFolder: "回收站",
  ocr: {
    // 默认走**宿主大模型**(DSH 0.1.7+ 的 llm + attachments 服务):零配置、不用另申请 key。
    // 宿主不可用 / 模型没声明图片输入时自动回落 qwen。取值:"host" | "qwen" | "off"
    mode: "host",
    // 空 = 跟随 DSH 当前默认模型;填了则强制用该模型(仍需它声明 inputModalities 含 image)
    hostModel: "",
    model: "qwen-vl-plus",
    apiKey: "",
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    prompt: "请识别图片中的全部文字内容,原样输出;数学公式用 LaTeX 输出。只输出识别结果,不要任何解释。",
  },
  dialog: { offsetX: 16, offsetY: 16, previewMaxWidth: 320 },
  // 同一屏被剪贴板连写两遍(Snipping Tool 常见)时的去重窗口,毫秒;0 = 关闭去重。
  // 不进设置面板(保持面板干净),需要时改 config.json。
  dupWindowMs: 6000,
  organize: { addBacklinks: true },
});

export function configDir() {
  return join(homedir(), ".dsh-screenshot-capture");
}

export function configPath() {
  return join(configDir(), "config.json");
}

/**
 * 递归解包 DSH 0.1.7+ 的 volatile 配置形态。
 *
 * 宿主会把 Config schema 里盖过 `.volatile()` 的字段包成 Volatile cell
 * (`{ get(): value }`，自身可枚举键只有 `get`) 再传进 `apply(ctx, input)`；
 * 嵌套的普通对象不受影响。直接把它当值用会出事:
 *   - `JSON.stringify(cell)` → `{}`(写进 watcher-config.json 就是 `{}`)
 *   - `path.join(cell, "收件箱")` → TypeError(path must be of type string)
 * 所以任何来自宿主的配置都要先过这一层。
 */
export function plain(value) {
  if (Array.isArray(value)) return value.map(plain);
  if (value !== null && typeof value === "object") {
    if (typeof value.get === "function" && Object.keys(value).every((k) => k === "get")) {
      return plain(value.get());
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  }
  return value;
}

/** 合并默认配置 + 配置文件 + 运行时入参(DSh 插件配置覆盖最高) */
export function resolveConfig(input = {}) {
  let file = {};
  try {
    if (existsSync(configPath())) {
      file = JSON.parse(readFileSync(configPath(), "utf8"));
    }
  } catch {
    file = {};
  }
  const merged = mergeDeep(structuredClone(DEFAULT_CONFIG), file);
  return mergeDeep(merged, plain(input));
}

export function saveConfig(config) {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(config, null, 2), "utf8");
}

function mergeDeep(base, patch) {
  if (patch === undefined || patch === null) return base;
  if (typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = typeof v === "object" && v !== null && !Array.isArray(v) && typeof out[k] === "object" && out[k] !== null
      ? mergeDeep(out[k], v)
      : v;
  }
  return out;
}

export function ensureVault(config) {
  const folders = [
    join(config.vaultPath, config.inboxFolder),
    join(config.vaultPath, config.inboxFolder, config.attachmentsFolder),
    join(config.vaultPath, config.knowledgeFolder),
    join(config.vaultPath, config.summaryFolder),
    join(config.vaultPath, config.archiveFolder),
    join(config.vaultPath, config.recycleFolder),
  ];
  for (const dir of folders) mkdirSync(dir, { recursive: true });
  return folders;
}
