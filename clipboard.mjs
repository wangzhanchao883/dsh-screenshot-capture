import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PS_SCRIPT = join(__dirname, "scripts", "clip-dialog.ps1");
const POWERSHELL = join(
  process.env.SystemRoot || "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

/**
 * 剪贴板监听器:拉起常驻 PowerShell 助手(轮询剪贴板 + 系统级悬浮窗),
 * 通过事件日志文件(events.log, JSON 每行)通信,避免管道依赖。
 * 事件: "ready" | "img" | "choice" | "err" | "exit"
 */
export class ClipboardWatcher extends EventEmitter {
  constructor(config = {}, options = {}) {
    super();
    this.config = config;
    this.autoAction = options.autoAction || "";
    this.workDir = join(tmpdir(), "dsh-capture");
    this.logPath = join(this.workDir, "events.log");
    this.offset = 0;
    this.child = null;
    this.timer = null;
    this.started = false;
  }

  start() {
    if (this.started) return;
    this.started = true;
    mkdirSync(this.workDir, { recursive: true });
    if (existsSync(this.logPath)) this.offset = statSync(this.logPath).size;
    else this.offset = 0;

    const cfgFile = join(this.workDir, "watcher-config.json");
    writeFileSync(cfgFile, JSON.stringify({
      pollIntervalMs: this.config.pollIntervalMs ?? 200,
      cooldownMs: this.config.cooldownMs ?? 2000,
      offsetX: this.config.dialog?.offsetX ?? 16,
      offsetY: this.config.dialog?.offsetY ?? 16,
      previewMaxWidth: this.config.dialog?.previewMaxWidth ?? 320,
    }), "utf8");

    const args = [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", PS_SCRIPT,
      "-ConfigPath", cfgFile,
    ];
    if (this.autoAction) args.push("-AutoAction", this.autoAction);

    try {
      this.child = spawn(POWERSHELL, args, {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch (err) {
      this.emit("err", { msg: `spawn powershell: ${err.message}` });
      return;
    }

    this.child.on("exit", (code) => {
      this.emit("exit", { code });
      this.started = false;
      this.child = null;
    });

    this.timer = setInterval(() => this.#tick(), 300);
    this.timer.unref?.();
  }

  /** 同步停(用于插件卸载,不等待退出)。 */
  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.child) {
      try { this.child.kill(); } catch { /* ignore */ }
      this.child = null;
    }
    this.started = false;
  }

  /**
   * 异步停:等 PowerShell 子进程真正退出后再 resolve,避免旧监听残留。
   * kill() 之外再用 taskkill /T /F 强杀进程树,并带超时兜底。
   * @param timeoutMs - 等待退出的上限(默认 3s)。
   */
  stopAsync(timeoutMs = 3000) {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.started = false;
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const guard = setTimeout(done, timeoutMs);
      child.once("exit", () => {
        clearTimeout(guard);
        done();
      });
      try {
        child.kill();
      } catch { /* 继续走 taskkill 兜底 */ }
      // Windows 兜底:强制终止进程树(子进程可能处于 Add-Type 初始化等状态)
      try {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.unref?.();
      } catch { /* ignore */ }
    });
  }

  #tick() {
    if (!existsSync(this.logPath)) return;
    const size = statSync(this.logPath).size;
    if (size <= this.offset) return;
    let buf;
    try {
      const fd = readFileSync(this.logPath);
      buf = fd.subarray(this.offset, size);
    } catch {
      return;
    }
    this.offset = size;
    const lines = buf.toString("utf8").split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      this.emit(ev.t, ev);
    }
  }
}
