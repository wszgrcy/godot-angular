import { Callable, DisplayServer } from "godot";
import type { Control, Node } from "godot";
import type { MediaEnvironment } from "godot-angular/css";
import type { StyleRuntime } from "./css-runtime";
import { tryConnectGodotSignal } from "./godot-events";
import { isControlClass } from "./registry";

/**
 * 量一次「视口」：量的是**挂载点自己占多大**，不是操作系统窗口多大。
 *
 * CSS 里 `@media (width)` 说的是视口，而本工程的视口就是 Angular 的挂载点（`GODOT_ROOT`）：
 * 宿主把应用挂在窗口里一块 1024×768 的面板上时，UI 只有 1024 可排版，断点就该按 1024 判
 * ——局部挂载即局部断言。挂载点铺满窗口时，它的 `size` 与窗口视口逐位相等，两种量法等价。
 *
 * 挂载点不是 Control、或还没被布局过（尺寸 0）时退回所在窗口的 `get_visible_rect()`：
 * 报 0 会让所有 `max-width` 断点静默命中，比退回窗口更糟；等它拿到真实尺寸时 `resized`
 * 会再驱动一次重算。
 *
 * 窗口那一侧用 `get_visible_rect()` 而不是 `Window.size`：前者是布局坐标系（与 Control.size
 * 同一坐标系），后者是窗口物理像素，开了内容缩放时差一个缩放因子。`content_scale_factor`
 * 不能拿来换算——它是用户设定的基准缩放（默认 1.0），不是引擎算出的实际缩放因子。
 */
function measureViewport(node: Node): { width: number; height: number } {
  if (isControlClass(node.get_class())) {
    const size = (node as Control).size;
    if (size.x > 0 && size.y > 0) return { width: size.x, height: size.y };
  }
  const rect = node.get_window()!.get_visible_rect();
  return { width: rect.size.x, height: rect.size.y };
}

/**
 * 读取一次当前环境。无显示环境下根窗口是个 dummy 尺寸（实测 `64×64`）、`is_dark_mode()`
 * 恒 false，那是引擎的真实返回值，不是“取不到”，因此原样交给媒体查询判断。
 *
 * 参数是挂载点（`GODOT_ROOT`）；传 `Window` 也成立——它不是 Control，会走窗口那一支。
 */
export function readEnvironment(node: Node): MediaEnvironment {
  const { width, height } = measureViewport(node);
  return {
    width,
    height,
    "prefers-color-scheme": DisplayServer.is_dark_mode() ? "dark" : "light",
  };
}

/**
 * 把挂载点尺寸、窗口尺寸与系统主题的变化接到级联上，返回卸载函数（应用 destroy 时调用）。
 *
 * 三个来源都是引擎现成的通知：
 * - `Control.resized`（挂载点）：宿主直接改 `size`、锚点跟随窗口、容器重排都走这里；
 *   容器重排延迟到帧末，所以这一路必须靠信号，不能只在绑定时读一次。
 * - `Window.size_changed`：窗口那一支的回退值，以及内容缩放设置变化。
 * - `DisplayServer.set_system_theme_change_callback()`：系统主题变化（实现在 Android /
 *   iOS / macOS / Windows / Linux(X11/Wayland)，无头下是空实现）。后者是引擎上的单个槽位，
 *   同一进程内只保留最后设置的一方。
 *
 * 挂载点必须在树内，否则 `get_window()` 给不出窗口。
 */
export function bindWindowEnvironment(runtime: StyleRuntime, root: Node): () => void {
  const win = root.get_window()!;
  const apply = (): void => runtime.setEnv(readEnvironment(root));
  apply();

  const detach: (() => void)[] = [];
  const onSizeChanged = Callable.create(win, apply);
  win.size_changed.connect(onSizeChanged);
  detach.push(() => win.size_changed.disconnect(onSizeChanged));
  // 非 Control 的挂载点没有 resized，tryConnect 返回 null，静默跳过
  const onResized = tryConnectGodotSignal(root, "resized", apply);
  if (onResized) detach.push(onResized);
  DisplayServer.set_system_theme_change_callback(Callable.create(apply));

  return () => {
    for (const off of detach) off();
    DisplayServer.set_system_theme_change_callback(new Callable());
  };
}
