import { Control, Node, Vector2 } from "godot";
import { bootstrapGodotApp } from "godot-angular/core";
import { App } from "../app";


/**
 * 多入口示例页 A。与 counter.ts 导入同一个 App，构建后两者的 Angular 运行时与
 * App 都落在共享 chunk 中（`dist-pages/chunks/`），入口本身只剩几百字节。
 */
export default class HelloPage extends Node {
  private app: any = null;

  _ready(): void {
    const root = new Control();
    root.size = new Vector2(1024, 768);
    this.add_child(root);
    bootstrapGodotApp(App, root).then((app) => {
      this.app = app;
      app.tick(0);
      console.log(`[pages/hello] 挂载完成，根控件子节点数：${root.get_child_count()}`);
    });
  }

  _process(delta: number): void {
    this.app?.tick(delta * 1000);
  }
}
