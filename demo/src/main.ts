import "./polyfills-first";
import { bootstrapGodotApp, setGodotHost, type GodotAngularApp } from "@control-ui-js/core";
import { App } from "./app";

/**
 * 由 Godot 侧入口（手写 CJS 脚本）调用的唯一出口。
 * godot 命名空间从这里注入，Angular 侧代码不出现 `import ... from "godot"`。
 */
export async function create(godotNamespace: any, root: any): Promise<GodotAngularApp> {
  setGodotHost(godotNamespace);
  return bootstrapGodotApp(App, root);
}
