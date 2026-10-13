import { warnOnce } from "./warn";
import { tryConnectGodotSignal } from "./godot-events";
import type { Node } from "godot";

/** 设置某个伪类开关的函数。 */
export type PseudoSetter = (name: string, on: boolean) => void;

type Unbind = () => void;

/** 一个伪类的驱动方式。 */
type Binder = (node: Node, set: (on: boolean) => void) => Unbind | null;

/** 一进一出的信号对（hover / focus / 按下）。 */
function signalPair(onSignal: string, offSignal: string): Binder {
  return (node, set) => {
    const on = tryConnectGodotSignal(node, onSignal, () => set(true));
    const off = tryConnectGodotSignal(node, offSignal, () => set(false));
    if (!on && !off) return null;
    return () => {
      on?.();
      off?.();
    };
  };
}

/**
 * 带布尔参数的信号（`BaseButton.toggled(on)`）。
 * CheckBox / CheckButton / OptionButton 都使用这一个信号，因此 `:checked` 一条即可覆盖。
 */
function signalToggle(signal: string): Binder {
  return (node, set) =>
    tryConnectGodotSignal(node, signal, (args: unknown) => set(args !== undefined && args !== null && args !== false));
}

/**
 * 具有信号来源的伪类——可自动驱动的就这几个。引擎中伪类状态必须事件驱动，属性轮询 /
 * `property_list_changed` 均不可靠，因此名单之外的一律不自动生效（运行时会 warnOnce）。
 * 需要 `:disabled` 这类状态时：走 class 通道 `[class.disabled]="ctrl.disabled"`，
 * 或自行调用 `runtime.setPseudoClass(node, "disabled", on)`。
 */
const BINDERS: Record<string, Binder> = {
  hover: signalPair("mouse_entered", "mouse_exited"),
  focus: signalPair("focus_entered", "focus_exited"),
  // BaseButton：按下 / 抬起。CSS 的 :active 与 :pressed 在 Godot 中是同一件事
  active: signalPair("button_down", "button_up"),
  pressed: signalPair("button_down", "button_up"),
  checked: signalToggle("toggled"),
};

/** 该伪类是否存在自动落点。`warnUnboundPseudoClasses` 靠它判定哪些伪类需要提示“不会自动生效”。 */
export function hasPseudoBinder(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(BINDERS, name);
}

/**
 * 为一个节点连接它所使用的伪类信号。
 *
 * 返回卸载函数（未连接任何信号时返回 null）。每个伪类单独尝试：一个节点可能只支持
 * 其中几个（Button 支持 hover/active/checked，Label 一个都不支持）。
 */
export function bindPseudoClasses(node: Node, names: Iterable<string>, set: PseudoSetter): Unbind | null {
  const unbinds: Unbind[] = [];
  for (const name of names) {
    const binder = BINDERS[name];
    if (!binder) continue;
    const unbind = binder(node, (on) => set(name, on));
    if (unbind) unbinds.push(unbind);
  }
  if (!unbinds.length) return null;
  return () => {
    for (const unbind of unbinds) unbind();
  };
}

/** 样式表使用了但没有信号来源的伪类：提示一次，不静默忽略。 */
export function warnUnboundPseudoClasses(names: Iterable<string>): void {
  for (const name of names) {
    if (hasPseudoBinder(name)) continue;
    warnOnce(
      `css:pseudo-unbound:${name}`,
      `样式表使用了 :${name}，但 Godot 无对应的信号/通知，它不会自动生效。可选方案：` +
        `① 通过 class 通道表达该状态（如 [class."${name}"]="..." 配合 CSS .x.${name}），class 变化会触发通知；` +
        `② 状态变化时自行调用 runtime.setPseudoClass(node, "${name}", true/false)。`,
    );
  }
}
