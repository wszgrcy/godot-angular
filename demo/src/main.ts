import { bootstrapGodotApp, setGodotHost, type GodotAngularApp } from "@control-ui-js/core";
import { App } from "./app";

/**
 * 由 Godot 侧入口（手写 CJS 脚本）调用的唯一出口。
 * godot 命名空间从这里注入，Angular 侧代码不出现 `import ... from "godot"`。
 *
 * core 这一行必须排在 ./app 之前：import core = 装 polyfill，而 ./app 的组件定义
 * （ɵɵdefineComponent）在模块求值阶段就要 performance。
 */
export async function create(godotNamespace: any, root: any): Promise<GodotAngularApp> {
  setGodotHost(godotNamespace);
  return bootstrapGodotApp(App, root);
}
