import { readFileSync, rmSync } from "node:fs";
import { resolveConfig, ensureVault } from "../config.mjs";
import { saveAttachment, appendEntry, updateEntryOcr } from "../storage.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const vault = join(root, "test", "format-vault");
rmSync(vault, { recursive: true, force: true });
const config = resolveConfig({ vaultPath: vault });
ensureVault(config);
const src = join(root, "test", "sample.png");

const rel1 = saveAttachment(config, src, "2026-08-21", "20260821_120000", "文档");
appendEntry(config, { date: "2026-08-21", time: "12:00", kind: "文档", imageRel: rel1, ocrText: null });
updateEntryOcr(config, { date: "2026-08-21", time: "12:00", imageRel: rel1, ocrText: "测试 OCR 文字" });

const rel2 = saveAttachment(config, src, "2026-08-21", "20260821_120100", "图片");
appendEntry(config, { date: "2026-08-21", time: "12:01", kind: "图片", imageRel: rel2 });

console.log(readFileSync(`${vault}/收件箱/2026-08-21.md`, "utf8"));
