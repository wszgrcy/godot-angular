import { Callable, DisplayServer } from "godot";
import type { Node, Window } from "godot";
import type { MediaEnvironment } from "godot-angular/css";
import type { StyleRuntime } from "./css-runtime";

/**
 * 读取一次当前环境。无显示环境下 `size` 恒 `(0,0)`、`is_dark_mode()` 恒 false，
 * 那是引擎的真实返回值，不是“取不到”，因此原样交给媒体查询判断。
 */
export function readEnvironment(win: Window): MediaEnvironment {
  return {
    width: win.size.x,
    height: win.size.y,
    "prefers-color-scheme": DisplayServer.is_dark_mode() ? "dark" : "light",
  };
}

/**
 * 把窗口尺寸与系统主题的变化接到级联上，返回卸载函数（应用 destroy 时调用）。
 *
 * 两个来源都是引擎现成的通知：`Window.size_changed`，以及
 * `DisplayServer.set_system_theme_change_callback()`（系统主题变化，实现在
 * Android / iOS / macOS / Windows / Linux(X11/Wayland)，无头下是空实现）。后者是引擎上的
 * 单个槽位，同一进程内只保留最后设置的一方。
 *
 * 挂载点必须在树内，否则 `get_window()` 给不出窗口。
 */
export function bindWindowEnvironment(runtime: StyleRuntime, root: Node): () => void {
  const win = root.get_window()!;
  const apply = (): void => runtime.setEnv(readEnvironment(win));
  apply();

  const onSizeChanged = Callable.create(win, apply);
  win.size_changed.connect(onSizeChanged);
  DisplayServer.set_system_theme_change_callback(Callable.create(apply));

  return () => {
    win.size_changed.disconnect(onSizeChanged);
    DisplayServer.set_system_theme_change_callback(new Callable());
  };
}
