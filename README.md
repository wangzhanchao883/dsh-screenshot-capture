# dsh-screenshot-capture · 指哪拍哪 (Point-and-Shoot Capture)

DeepSeek Harness 插件:截屏即存 —— 监听剪贴板 → 鼠标位置弹出系统级悬浮窗
【注释输入框 +「重点」复选框 + 复制截图 / 存文档 / 存图片】→ 图片 + 即时 OCR(通义千问多模态)写入 Obsidian 按天合并笔记
→ 晚间 AI 整理(点选保留 / 保存全部 → 归类 → 双链 → 当日总结 → 归档)。

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(DSH) plugin that turns a screenshot (or any copied image) into
an Obsidian note: a system-level floating window appears next to your mouse, lets you add a comment / mark it as a
key point, then saves the image (with instant OCR via the
[Tongyi Qianwen](https://dashscope.aliyuncs.com) multimodal API) into a per-day note, and an optional
evening AI pass organizes the day's entries with categories, backlinks, a summary, and archival.
`v0.2.0` adds a comment box and a "重点 / key point" checkbox to each capture.

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

## 功能 / Features

- **Windows 系统级悬浮窗**:检测到新截图(或复制图片)后,在鼠标旁弹出置顶小窗,三键选择;
- **注释 / 重点标记(v0.2.0)**:弹窗内置注释输入框 +「重点」复选框;勾重点后该条注释以标题一 `**重点**` 写入笔记,提示这是重点;
- **存文档**:图片入库 + 当天笔记立即生成,OCR 文字 1~5 秒后自动回填;
- **存图片**:仅图片入库(`#图片` 标签);
- **即时 OCR**:通义千问多模态,无需本地模型;未配 key 时存文档会标注识别失败,不影响入库;
- **晚间 AI 整理**:对当天收件箱条目,点选保留/保存全部 → 归类 → 生成分类笔记 + 双链 → 当日总结 → 归档;
- **Web 图形配置界面**:DSH 设置 →「截图入库」,改动实时生效。

## 环境要求 / Requirements

- **Windows**(依赖系统自带 PowerShell 5.1 + WinForms)
- 通义千问 API key(通过 `DASHSCOPE_API_KEY` 环境变量,或插件配置文件)
- Obsidian 库(或任意本地 markdown 目录)

## 安装 / Install (DSH plugin)

```sh
# 从 npm 安装(若已发布)
dsh plugin --profile desktop add dsh-screenshot-capture

# 从 GitHub 源安装
dsh plugin --profile desktop add github:wangzhanchao883/dsh-screenshot-capture

# 或用本地目录(开发时)
dsh plugin --profile desktop add ./dsh-screenshot-capture
```

重启 DSH 后生效。剪贴板监听与悬浮窗由插件 host 端自动拉起(需要 DSH 运行中)。

> 首次使用请先在 DSH 设置 →「截图入库」里配置你的 Obsidian 库路径(以及可选的通义千问 API key)。
> 未配置 `vaultPath` 时采集功能会自动停用并告警。

## 配置 / Configuration

### 方式一:Web 图形界面 / Web settings (推荐)

DSH Web 界面 → 侧栏 **设置** → **截图入库** 分区,直接改:
- 通用:启用监听、Obsidian 库路径、轮询间隔、冷却时间
- OCR:识别模式(通义千问 / 关闭)、模型、API Key(留空则用环境变量)
- 悬浮窗:横向/纵向偏移、预览最大宽度

改动**实时生效**(监听器会自动重启)。配置存储在 DSH 的 `settings.yaml` 用户层。

### 方式二:配置文件 / config file (base 层)

`%USERPROFILE%\.dsh-screenshot-capture\config.json`

```jsonc
{
  "enabled": true,
  "vaultPath": "D:\\path\\to\\obsidian-vault",
  "ocr": { "mode": "qwen", "model": "qwen-vl-plus", "apiKey": "" },
  "pollIntervalMs": 200,
  "cooldownMs": 2000
}
```

- OCR key 也可放环境变量 `DASHSCOPE_API_KEY`(推荐,避免明文落盘);
- `ocr.mode` 为 `"off"` 时存文档不识别文字。

> 注意:插件**默认不带库路径**(为空)。未配置 `vaultPath` 时,采集功能会自动停用并告警,不会创建任何目录。首次使用请务必在 Web 设置 / `config.json` 里配置你自己的 Obsidian 库路径。

## 使用 / Usage

1. 开着 DSH;
2. `Win+Shift+S` 框选截图(或 `Ctrl+C` 复制任意图片);
3. 悬浮窗出现在鼠标旁:先在注释框里写注释/评论(可选),需要的话勾选「重点」,再选【复制截图 / 存文档 / 存图片】;
4. 晚上对 DSH 说"整理今天的截图",按提示选择保留条目。

### 注释与「重点」标记 / Comments & key points

- 截图时填写的注释会写入当天收件箱该条目下方;
- 勾选「重点」后,注释上方加一行标题一 `# **重点**` 作为醒目提示;
- 晚间整理时,注释与重点标记随条目进入「知识库/<分类>/」笔记的 `## 重点` 小节(未勾重点的纯注释也保留);
- 点「复制截图」不写笔记,忽略输入框内容。

## Obsidian 结构 / Output layout

```
vault/
├── 收件箱/            # 白天截图进(按天合并)
│   ├── 2026-08-21.md
│   └── attachments/
├── 知识库/<分类>/     # 晚间整理后,按分类
│   ├── INDEX.md
│   └── 20260821_1430_文档.md
├── 总结/              # 当日总结(含双链)
└── 归档/              # 已整理的收件箱笔记
```

## 目录结构 / Repository layout

```
dsh-screenshot-capture/
├── index.mjs           # host 端入口:注册工具 + settings 命名空间 + 剪贴板监听(watcher 单例、配置热重启)
├── core.mjs            # 悬浮窗三键选择的分发处理
├── config.mjs          # 默认配置 / config.json 合并 / 运行时入参覆盖
├── clipboard.mjs       # 拉起 PowerShell 常驻助手并读事件日志
├── storage.mjs         # Obsidian 入库(按天合并、目录结构)
├── ocr.mjs             # 通义千问多模态识别
├── organize.mjs        # 晚间 AI 整理(归类 / 双链 / 总结 / 归档)
├── dev-run.mjs         # 独立开发入口(不需要 DSH)
├── client.js           # 浏览器端:注册 Web 设置页,经 settingsScope 读写配置
├── scripts/
│   └── clip-dialog.ps1 # PowerShell 轮询剪贴板 + 弹出系统级悬浮窗
├── cordis.patch.yml    # DSH bundle patch(声明本插件为可安装 host 端 bundle)
├── test/               # 独立测试脚本(注入 vault 路径即可跑,无需 DSH)
├── package.json        # dsh.bundle + dsh.client manifest
├── LICENSE             # MIT
└── README.md
```

## 架构速览 / Architecture

- **host 端**(Node):`index.mjs` 入口,注册工具 + settings 命名空间 + 剪贴板监听(watcher 单例、配置热重启);`clipboard.mjs` 拉起 PowerShell 常驻助手并读事件日志;`storage.mjs`/`ocr.mjs`/`organize.mjs` 负责入库/识别/整理。
- **client 端**(浏览器):`client.js` 注册 Web 设置页,经 `settingsScope` 读写配置。
- **PowerShell**:`scripts/clip-dialog.ps1` 轮询剪贴板 + 弹出悬浮窗,通过 `%TEMP%\dsh-capture\events.log` 与 Node 通信。

> 注意:悬浮窗脚本是 Windows PowerShell(`Add-Type` + WinForms)。请在可控环境下使用,并只安装你信任的代码(本插件无后门,不联网外传剪贴板数据)。

## 安全说明 / Security

- 本插件**不含任何内置密钥**;OCR key 只从环境变量或配置文件读取;
- 剪贴板图片仅本地处理,OCR 时才向通义千问上传该张图片用于识别;
- 仓库代码不含个人路径之外的敏感信息;配置文件里的 `vaultPath` 等路径是使用者的本地路径,不会写入仓库(仓库默认 `vaultPath` 为空,首次使用需自行配置,未配置时自动停用采集)。

## 开发与独立测试 / Development (no DSH needed)

```sh
npm run dev          # 交互模式(真实弹窗)
npm run dev:auto     # 自动模式:检测到截图自动存文档
npm test             # 运行存储/整理单测(无需 DSH、无需 API key)
```

可用环境变量 `DSC_VAULT_PATH` 覆盖 vault 路径,避免污染真实库。测试说明见 [`test/README.md`](./test/README.md)。

## License

[MIT](./LICENSE) © 2026 wangzhanchao883
