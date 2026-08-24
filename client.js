/* dsh-screenshot-capture client bundle — 浏览器半端(Web 设置页)。
 * 以经典脚本形式注册到 window.__ModuleLoader__;工厂内用 require 取 React,
 * 不能用 JSX(无构建步骤),一律 React.createElement。 */
window.__ModuleLoader__.load({
  id: "dsh-screenshot-capture",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");
    const h = React.createElement;
    const { useEffect, useRef, useState } = React;

    const NS = "settings.screenshotCapture";
    const SETTINGS_NAMESPACE = "dsh-screenshot-capture";

    const zh = {
      nav: "截图入库",
      loading: "正在读取配置…",
      unavailable: "配置面板不可用(设置服务未挂载)。请直接编辑配置 JSON 文件。",
      saved: "已保存",
      error: "保存失败:",
      general: "通用",
      enabled: "启用剪贴板监听",
      enabledHint: "关闭后不再监听剪贴板,悬浮窗也不会弹出",
      vaultPath: "Obsidian 库路径",
      vaultPathHint: "截图笔记会写入这个库",
      pollIntervalMs: "剪贴板轮询间隔 (ms)",
      cooldownMs: "截图冷却时间 (ms)",
      ocr: "OCR 文字识别",
      ocrMode: "识别模式",
      ocrModeQwen: "通义千问 (qwen)",
      ocrModeOff: "关闭(只存图不识别)",
      ocrModel: "模型",
      ocrApiKey: "API Key",
      ocrApiKeyHint: "留空则使用环境变量 DASHSCOPE_API_KEY",
      dialog: "悬浮窗",
      dialogOffsetX: "横向偏移 (px)",
      dialogOffsetY: "纵向偏移 (px)",
      dialogPreviewMaxWidth: "预览最大宽度 (px)",
    };

    const en = {
      nav: "Screenshot Capture",
      loading: "Reading configuration…",
      unavailable: "Configuration panel unavailable (settings service not mounted). Edit the config JSON file directly instead.",
      saved: "Saved",
      error: "Save failed:",
      general: "General",
      enabled: "Enable clipboard watching",
      enabledHint: "When off, clipboard watching and the floating window are disabled",
      vaultPath: "Obsidian vault path",
      vaultPathHint: "Screenshots are stored into this vault",
      pollIntervalMs: "Clipboard poll interval (ms)",
      cooldownMs: "Screenshot cooldown (ms)",
      ocr: "OCR",
      ocrMode: "Recognition mode",
      ocrModeQwen: "Qwen (qwen)",
      ocrModeOff: "Off (store without OCR)",
      ocrModel: "Model",
      ocrApiKey: "API Key",
      ocrApiKeyHint: "Leave empty to use the DASHSCOPE_API_KEY environment variable",
      dialog: "Floating window",
      dialogOffsetX: "Horizontal offset (px)",
      dialogOffsetY: "Vertical offset (px)",
      dialogPreviewMaxWidth: "Preview max width (px)",
    };

    const STYLES = [
      ".scc-config{max-width:640px;display:flex;flex-direction:column;gap:16px;color:var(--dsw-alias-label-primary)}",
      ".scc-group{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:14px;background:var(--dsw-alias-bg-layer-2)}",
      ".scc-group h3{margin:0 0 12px;font-size:13px;font-weight:600}",
      ".scc-field{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}",
      ".scc-field label{font-size:12px;font-weight:500}",
      ".scc-field input[type=text],.scc-field input[type=number],.scc-field input[type=password],.scc-field select{height:30px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:6px;padding:0 8px;font:inherit;font-size:13px;box-sizing:border-box}",
      ".scc-hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}",
      ".scc-switch{display:flex;align-items:center;gap:8px;margin-bottom:6px}",
      ".scc-switch input{accent-color:var(--dsw-alias-state-business-primary)}",
      ".scc-status{font-size:12px;color:var(--dsw-alias-label-tertiary);min-height:16px}",
      ".scc-row{display:flex;gap:12px}",
      ".scc-row .scc-field{flex:1}",
    ].join("");

    /** 一行标签 + 控件 + 提示 */
    function Field({ label, hint, children }) {
      return h("div", { className: "scc-field" },
        h("label", null, label),
        children,
        hint ? h("div", { className: "scc-hint" }, hint) : null,
      );
    }

    /** 文本输入:本地草稿,失焦/回车时才提交 */
    function TextInput({ value, onCommit, password }) {
      const [draft, setDraft] = useState(value);
      useEffect(() => setDraft(value), [value]);
      return h("input", {
        type: password ? "password" : "text",
        value: draft,
        onChange: (e) => setDraft(e.target.value),
        onBlur: () => {
          if (draft !== value) onCommit(draft);
        },
        onKeyDown: (e) => {
          if (e.key === "Enter") e.target.blur();
        },
      });
    }

    /** 数字输入:解析失败则回退当前值 */
    function NumberInput({ value, onCommit, min, max }) {
      const [draft, setDraft] = useState(String(value ?? ""));
      useEffect(() => setDraft(String(value ?? "")), [value]);
      const commit = () => {
        const n = Number(draft);
        if (Number.isFinite(n) && n !== value) onCommit(n);
        else setDraft(String(value ?? ""));
      };
      return h("input", {
        type: "number",
        min,
        max,
        value: draft,
        onChange: (e) => setDraft(e.target.value),
        onBlur: commit,
        onKeyDown: (e) => {
          if (e.key === "Enter") e.target.blur();
        },
      });
    }

    /** 设置页:绑定 settings 命名空间,展示并保存配置 */
    function ConfigSection({ scope, t }) {
      const [snap, setSnap] = useState(() => scope.getSnapshot());
      const [status, setStatus] = useState("");
      const statusTimer = useRef(null);
      useEffect(() => scope.subscribe(() => setSnap(scope.getSnapshot())), [scope]);
      useEffect(() => () => {
        if (statusTimer.current) clearTimeout(statusTimer.current);
      }, []);
      const flash = (msg) => {
        setStatus(msg);
        if (statusTimer.current) clearTimeout(statusTimer.current);
        statusTimer.current = setTimeout(() => setStatus(""), 2500);
      };
      const save = (field, v) => {
        Promise.resolve(scope.set(field, v))
          .then(() => flash(t("saved")))
          .catch((err) => flash(`${t("error")} ${err && err.message ? err.message : String(err)}`));
      };

      if (snap.status === "loading") return h("p", { className: "scc-status" }, t("loading"));
      if (snap.status === "unavailable") return h("p", { className: "scc-status" }, t("unavailable"));
      const v = snap.value || {};

      return h("div", { className: "scc-config" }, [
        h("div", { className: "scc-group" }, [
          h("h3", null, t("general")),
          h("div", { className: "scc-switch" }, [
            h("input", {
              type: "checkbox",
              id: "scc-enabled",
              checked: !!v.enabled,
              onChange: (e) => save("enabled", e.target.checked),
            }),
            h("label", { htmlFor: "scc-enabled" }, t("enabled")),
          ]),
          h("div", { className: "scc-hint" }, t("enabledHint")),
          Field({
            label: t("vaultPath"),
            hint: t("vaultPathHint"),
            children: h(TextInput, { value: v.vaultPath || "", onCommit: (val) => save("vaultPath", val) }),
          }),
          h("div", { className: "scc-row" }, [
            Field({
              label: t("pollIntervalMs"),
              children: h(NumberInput, { value: v.pollIntervalMs, min: 50, max: 60000, onCommit: (n) => save("pollIntervalMs", n) }),
            }),
            Field({
              label: t("cooldownMs"),
              children: h(NumberInput, { value: v.cooldownMs, min: 0, max: 120000, onCommit: (n) => save("cooldownMs", n) }),
            }),
          ]),
        ]),
        h("div", { className: "scc-group" }, [
          h("h3", null, t("ocr")),
          Field({
            label: t("ocrMode"),
            children: h("select", { value: v.ocrMode || "qwen", onChange: (e) => save("ocrMode", e.target.value) }, [
              h("option", { value: "qwen" }, t("ocrModeQwen")),
              h("option", { value: "off" }, t("ocrModeOff")),
            ]),
          }),
          Field({
            label: t("ocrModel"),
            children: h(TextInput, { value: v.ocrModel || "", onCommit: (val) => save("ocrModel", val) }),
          }),
          Field({
            label: t("ocrApiKey"),
            hint: t("ocrApiKeyHint"),
            children: h(TextInput, { value: v.ocrApiKey || "", password: true, onCommit: (val) => save("ocrApiKey", val) }),
          }),
        ]),
        h("div", { className: "scc-group" }, [
          h("h3", null, t("dialog")),
          h("div", { className: "scc-row" }, [
            Field({
              label: t("dialogOffsetX"),
              children: h(NumberInput, { value: v.dialogOffsetX, min: -1000, max: 1000, onCommit: (n) => save("dialogOffsetX", n) }),
            }),
            Field({
              label: t("dialogOffsetY"),
              children: h(NumberInput, { value: v.dialogOffsetY, min: -1000, max: 1000, onCommit: (n) => save("dialogOffsetY", n) }),
            }),
          ]),
          Field({
            label: t("dialogPreviewMaxWidth"),
            children: h(NumberInput, { value: v.dialogPreviewMaxWidth, min: 100, max: 2000, onCommit: (n) => save("dialogPreviewMaxWidth", n) }),
          }),
        ]),
        h("div", { className: "scc-status" }, status),
      ]);
    }

    function apply(ctx) {
      ctx.effect(() => {
        const tag = document.createElement("style");
        tag.setAttribute("data-plugin", "dsh-screenshot-capture");
        tag.textContent = STYLES;
        document.head.appendChild(tag);
        return () => {
          if (tag.parentNode) tag.parentNode.removeChild(tag);
        };
      }, "dsh-screenshot-capture: styles");

      ctx.effect(() => {
        return ctx.locale.register(NS, { zh, en });
      }, "dsh-screenshot-capture: dictionaries");

      const t = ctx.locale.bind(NS);
      const scope = ctx.settingsScope.bind({ namespace: SETTINGS_NAMESPACE });
      const injected = () => ({ scope });

      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "screenshot-capture",
        order: 200,
        label: () => t("nav"),
        locale: NS,
        inject: injected,
      }, ConfigSection));
    }

    module.exports = {
      name: "dsh-screenshot-capture",
      inject: ["slots", "locale", "settingsScope"],
      apply,
    };
    return module.exports;
  },
});
