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

/**
 * 本进程是否跑在**无显示**环境（CI、`--headless`、专用服务器）。为真时不得碰任何窗口状态
 * （如 `DisplayServer.window_set_title`）——那里没有可命名的窗口，写了只会多一行引擎错误。
 *
 * 默认 `false`（有窗口），**不做运行期探测**：部署形态是部署时就知道的事实，由调用方
 * （或测试环境）主动声明，而不是让库去猜 `DisplayServer.get_name()`。猜错时症状很轻
 * （只多一行日志），靠猜永远不会在 CI 上被发现。
 */
export const GODOT_HEADLESS = new InjectionToken<boolean>("godot-angular GODOT_HEADLESS", {
  factory: () => false,
});
