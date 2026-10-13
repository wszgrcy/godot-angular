import { Control, Node, OS, Vector2 } from "godot";
import { bootstrapGodotApp } from "godot-angular/core";
import { App } from "./app";

/** 无头模式下导出节点树快照前等待的帧数，为布局与变更检测预留时间。 */
const SNAPSHOT_AFTER_FRAMES = 5;

/** Angular 的异常细节通常挂在 ngErrorMessage / ngTokenPath 上，裸 message 往往只有 “NG0201”。 */
function describeError(err: unknown): string {
  if (!err) return String(err);
  const e = err as {
    stack?: string;
    toString(): string;
    ngErrorMessage?: string;
    ngTokenPath?: unknown;
  };
  const parts = [e.stack || e.toString()];
  if (e.ngErrorMessage) parts.push(`ngErrorMessage: ${e.ngErrorMessage}`);
  if (e.ngTokenPath) parts.push(`ngTokenPath: ${String(e.ngTokenPath)}`);
  return parts.join("\n  ");
}

/** 递归打印节点树；无头模式下这是唯一可观察的输出。 */
function printTree(node: any, depth: number): void {
  const pad = "  ".repeat(depth);
  const size = node.size ? `${Math.round(node.size.x)}x${Math.round(node.size.y)}` : "-";
  const pos = node.position ? `@${Math.round(node.position.x)},${Math.round(node.position.y)}` : "";
  const text = node.text ? ` text="${node.text}"` : "";
  console.log(`${pad}${node.get_class()} ${node.name} ${size} ${pos}${text}`);
  for (let i = 0; i < node.get_child_count(); i++) printTree(node.get_child(i), depth + 1);
}

export default class Main extends Node {
  private app: any = null;
  private frames = 0;
  private snapshot = false;
  private rootNode: any = null;

  _ready(): void {
    this.snapshot = OS.get_environment("CUJ_MODE") === "snapshot";

    // Angular 的挂载点。实际项目会调用 set_anchors_preset(FULL_RECT) 跟随窗口，
    // 此处使用固定尺寸，目的是使无头模式下的布局断言保持稳定。
    const root = new Control();
    root.name = "AngularRoot";
    root.size = new Vector2(1024, 768);
    this.add_child(root);
    this.rootNode = root;

    bootstrapGodotApp(App, root)
      .then((app) => {
        this.app = app;
        console.log("[demo] Angular bootstrapped");
      })
      .catch((err) => {
        console.error("[demo] Angular bootstrap failed\n  " + describeError(err));
        this.get_tree().quit(1);
      });
  }

  _process(delta: number): void {
    this.frames++;
    if (this.app) this.app.tick(delta * 1000);
    if (this.snapshot && this.app && this.frames >= SNAPSHOT_AFTER_FRAMES) {
      console.log("[demo] --- node tree ---");
      printTree(this.rootNode, 0);
      this.get_tree().quit(0);
    }
  }
}
