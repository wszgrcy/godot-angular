import { Control, Node, Vector2 } from "godot";
import { bootstrapGodotApp } from "godot-angular/core";
import { App } from "../app";


/**
 * 多入口示例页 B。与 hello.ts 导入同一个 App，构建后两者的 Angular 运行时与 App
 * 都落在共享 chunk（`dist-pages/chunks/`）中，入口本身只剩几百字节。
 */
export default class CounterPage extends Node {
  private app: any = null;

  _ready(): void {
    const root = new Control();
    root.size = new Vector2(1024, 768);
    this.add_child(root);
    bootstrapGodotApp(App, root).then((app) => {
      this.app = app;
      (app.rootComponent as InstanceType<typeof App>).count.set(7);
      app.tick(0);
      console.log("[pages/counter] count 已设置为 7");
    });
  }

  _process(delta: number): void {
    this.app?.tick(delta * 1000);
  }
}
