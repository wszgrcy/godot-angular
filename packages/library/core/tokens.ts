import { InjectionToken } from "@angular/core";
import type { Node } from "godot";

/**
 * 承载 Angular 组件树的 Godot 根节点（由入口提供）。
 * 上界取 `Node` 而不是 `Control`：任何节点都能 `add_child`，控件挂在谁下面都成立。
 */
export const GODOT_ROOT = new InjectionToken<Node>("godot-angular GODOT_ROOT");

/** 本应用的 CSS 级联运行时。做成 token 而不是模块级单例：一个进程可以运行多个应用，
 * 各自持有一套样式表与状态，才能互不污染。默认提供 `defaultStyleRuntime()`。 */
export const STYLE_RUNTIME = new InjectionToken<import("./css-runtime").StyleRuntime>(
  "godot-angular STYLE_RUNTIME",
);
