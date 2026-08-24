// 存储+整理模块单测(独立于 DSH,验证 vault 写入逻辑)
import { resolveConfig, ensureVault } from "../config.mjs";
import { saveAttachment, appendEntry, updateEntryOcr, parseEntries, todayString } from "../storage.mjs";
import { organizeDay } from "../organize.mjs";
import { mkdirSync, copyFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// 仓库根 = <repo>/test 的上一级
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const vault = join(root, "test", "test-vault");
rmSync(vault, { recursive: true, force: true });
const config = resolveConfig({ vaultPath: vault });
ensureVault(config);

const src = join(root, "test", "sample.png");
const date = todayString();
const results = [];

// 1. 存文档:图片入附件 + 笔记占位(带注释 + 重点标记)
const relDoc = saveAttachment(config, src, date, "20260821_103000", "文档");
results.push(["saveAttachment(文档)", relDoc]);
appendEntry(config, { date, time: "10:30", kind: "文档", imageRel: relDoc, ocrText: null, note: "老师讲的必考题", isKey: true });
results.push(["appendEntry(文档占位+注释+重点)", "OK"]);

// 2. OCR 回填
updateEntryOcr(config, { date, time: "10:30", imageRel: relDoc, ocrText: "测试题目: 3x + 2 = 8,解得 x = 2" });
results.push(["updateEntryOcr", "OK"]);

// 3. 存图片(纯注释,不勾重点)
const relImg = saveAttachment(config, src, date, "20260821_103500", "图片");
appendEntry(config, { date, time: "10:35", kind: "图片", imageRel: relImg, note: "这页图留着参考" });
results.push(["appendEntry(图片+纯注释)", relImg]);

// 3b. 重点标记但不填注释
const relImg2 = saveAttachment(config, src, date, "20260821_104000", "图片");
appendEntry(config, { date, time: "10:40", kind: "图片", imageRel: relImg2, isKey: true });
results.push(["appendEntry(图片+只重点)", relImg2]);

// 4. 解析回读
const note = readFileSync(join(vault, "收件箱", `${date}.md`), "utf8");
const entries = parseEntries(note);
results.push(["parseEntries count", String(entries.length)]);
results.push(["entry[0]", JSON.stringify({ time: entries[0]?.time, kind: entries[0]?.kind, note: entries[0]?.note, isKey: entries[0]?.isKey })]);
results.push(["entry[1] 纯注释", JSON.stringify({ note: entries[1]?.note, isKey: entries[1]?.isKey })]);
results.push(["entry[2] 只重点", JSON.stringify({ note: entries[2]?.note, isKey: entries[2]?.isKey })]);

// 5. 晚间整理:保留全部,分类
const org = organizeDay(config, {
  date,
  keep: null, // all
  categories: { "10:30": "数学", "10:35": "数学", "10:40": "数学" },
  summaryTitle: "今日数学题",
});
results.push(["organize kept", `${org.keptCount}/${org.discardedCount}`]);
results.push(["organize files", JSON.stringify(org.files.map((f) => f.replace(vault, "")))]);

// 6. 校验知识库笔记内容(双链 / 图片 / 重点小节)
const kNote = readFileSync(org.files[0], "utf8");
results.push(["知识库笔记含双链", kNote.includes("[[INDEX]]") && kNote.includes("[[INDEX]]") ? "OK" : "MISSING"]);
results.push(["知识库笔记含图片", kNote.includes("![[") ? "OK" : "MISSING"]);
results.push(["知识库笔记含重点小节", kNote.includes("## 重点") && kNote.includes("# **重点**") ? "OK" : "MISSING"]);
results.push(["知识库笔记含注释", kNote.includes("老师讲的必考题") ? "OK" : "MISSING"]);

// 7. 收件箱已归档
results.push(["收件箱已归档", !existsSync(join(vault, "收件箱", `${date}.md`)) ? "OK" : "STILL EXISTS"]);

console.log(results.map(([k, v]) => `${k.padEnd(30)} => ${v}`).join("\n"));
