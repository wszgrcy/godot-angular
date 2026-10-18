import { warnOnce } from "./warn";
import { tryConnectGodotSignal } from "./godot-events";
import { isControlClass } from "./registry";
import { PROPERTY_STATE_CLASSES } from "godot-angular/css";
import type { Node } from "godot";

/**
 * 设置某个伪类开关的函数。
 *
 * `target` 省略时写本节点。只有 `:hover` 用得到它：CSS 的悬停会向祖先冒泡，而引擎不会，
 * 于是驱动 `:hover` 的那一侧需要把状态写到祖先身上（见 `hoverPair`）。
 */
export type PseudoSetter = (name: string, on: boolean, target?: Node) => void;

type Unbind = () => void;

/**
 * 一个伪类的驱动方式。
 *
 * `set(开关, 写给谁)`：默认写给本节点，`:hover` 会顺带写给祖先链。
 */
type Binder = (node: Node, set: (on: boolean, target?: Node) => void) => Unbind | null;

/** 一进一出的信号对（focus / 按下）。 */
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

/* ------------------------------------------------------------------ *
 * `:hover` —— 唯一需要向祖先冒泡的伪类
 * ------------------------------------------------------------------ */

/**
 * 祖先 → 「当前有哪些节点在它身上报告被悬停」（含报告者自己）。
 *
 * 为什么不直接「进入时全链写 true、离开时全链写 false」：同一个祖先可能同时被两条来源举着
 * （它自己收到 mouse_entered，同时它的某个子控件也收到了），子控件离开时把整条链清掉，
 * 就会把仍然成立的悬停误抹掉。登记表让「清除」只在最后一个来源消失时发生，与信号到达
 * 顺序无关（引擎先发完全部 mouse_exited 再发 mouse_entered，但这一点没有文档保证）。
 */
const hoverSources = new WeakMap<object, Set<object>>();

/**
 * 报告者 → 它报告那一刻所处的祖先链（含自己）。
 *
 * 必须提前记下：`tree_exited` 到达时节点早已脱离父级，`get_parent()` 已是 null，
 * 退出时现查会让祖先永远停在悬停态（`@for` 删项 / queue_free 就是这个场景）。
 */
const hoverChains = new WeakMap<object, Node[]>();

/** 从 node 往上的 Control 祖先；遇到非 Control（根 Viewport / Window）即停。 */
function controlAncestors(node: Node): Node[] {
  const out: Node[] = [];
  let p = node.get_parent();
  while (p) {
    if (!isControlClass(p.get_class())) break;
    out.push(p);
    p = p.get_parent();
  }
  return out;
}

/** 报告者此刻所处的祖先链（含自己）：进入时记下，退出时取回（见 `hoverChains`）。 */
function hoverChain(node: Node, on: boolean): Node[] {
  if (on) {
    const chain = [node, ...controlAncestors(node)];
    hoverChains.set(node, chain);
    return chain;
  }
  // 没记过就退回现查（只可能来自引擎自己发的 exited，节点还在树上）
  const chain = hoverChains.get(node) ?? [node, ...controlAncestors(node)];
  hoverChains.delete(node);
  return chain;
}

/**
 * 登记 / 注销「node 此刻被悬停」，返回真正需要写入的 (节点, 开关) 序列。
 *
 * 报告者自己也占一个来源：CSS 里元素自身与子孙各能独立让 `:hover` 成立，
 * 子孙离开时元素自身若仍在悬停，就不该被一起清掉。
 */
function reportHover(node: Node, on: boolean): Array<[Node, boolean]> {
  const writes: Array<[Node, boolean]> = [];
  for (const host of hoverChain(node, on)) {
    let sources = hoverSources.get(host);
    if (on) {
      if (!sources) {
        sources = new Set();
        hoverSources.set(host, sources);
      }
      sources.add(node);
      writes.push([host, true]);
      continue;
    }
    // 没登记过就一个字节也不写：否则会把别的来源举着的悬停顶掉
    if (!sources || !sources.has(node)) continue;
    sources.delete(node);
    if (sources.size === 0) writes.push([host, false]);
  }
  return writes;
}

/**
 * `:hover` 的驱动。
 *
 * 引擎只在「最深接收控件 + 它往上直到第一个 STOP 祖先」这条链上发 mouse_entered：
 * 一个 `mouse_filter = STOP` 的子控件（Button / CheckBox / 用来撑位的空 Control）会把
 * 事件整个吃掉，父级一个信号都收不到。于是 CSS 里天经地义的
 * `.list-row:hover { border-color: … }`（指针停在行内的 CheckBox 上也要让整行亮）
 * 在引擎里变成「只有指针落在父级自己那一圈空白上才亮」。这里把冒泡补上：任何节点报告
 * 悬停，它的 Control 祖先一律跟着亮，退出时同样一路撤掉。
 */
function hoverPair(): Binder {
  return (node, set) => {
    const report = (on: boolean): void => {
      for (const [host, value] of reportHover(node, on)) set(value, host);
    };
    const enter = tryConnectGodotSignal(node, "mouse_entered", () => report(true));
    const leave = tryConnectGodotSignal(node, "mouse_exited", () => report(false));
    // 节点被释放 / 移出树时引擎不保证补发 mouse_exited，不补这一步祖先会永久停在悬停态
    const gone = tryConnectGodotSignal(node, "tree_exited", () => report(false));
    if (!enter && !leave) return null;
    return () => {
      enter?.();
      leave?.();
      gone?.();
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
 * 需要 `:selected` 这类既无信号、也无法从属性推出来的状态时：自行调用
 * `runtime.setPseudoClass(node, "selected", on)`。
 *
 * `:checked` / `:disabled` / `:read-only` 除了这里的信号，还有一条**属性同步**通道（见下方
 * PROPERTY_DRIVEN_STATES）：`toggled` 只在用户交互那一刻发，而 `[button_pressed]="true"` 是
 * 创建时就为真，光靠信号会永远不开。
 */
const BINDERS: Record<string, Binder> = {
  hover: hoverPair(),
  focus: signalPair("focus_entered", "focus_exited"),
  // BaseButton：按下 / 抬起。CSS 的 :active 与 :pressed 在 Godot 中是同一件事
  active: signalPair("button_down", "button_up"),
  pressed: signalPair("button_down", "button_up"),
  // 只是标脏器，不是独立状态源：引擎先存 `button_pressed` 再发 `toggled`，所以信号
  // 到达时属性已是新值，级联随后从属性读回同一个答案。反过来说，只发信号不改属性
  // （测试里 `emit_signal("toggled", true)` 而不写 `button_pressed`）会被同步读回去。
  checked: signalToggle("toggled"),
};

/**
 * 来源：css 包 PROPERTY_STATE_CLASSES（名单只保留一份，避免两边漂移）
 *
 * 由节点属性自动同步的伪类。它们没有信号，但级联每次重算前会读一次属性，因此同样“自动生效”。
 */
const PROPERTY_DRIVEN_STATES: ReadonlySet<string> = new Set(PROPERTY_STATE_CLASSES.map((entry) => entry.state));

/** 该伪类是否存在自动来源（信号或节点属性）。`warnUnboundPseudoClasses` 靠它判定哪些伪类需要提示“不会自动生效”。 */
export function hasPseudoBinder(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(BINDERS, name) || PROPERTY_DRIVEN_STATES.has(name);
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
    const unbind = binder(node, (on, target) => set(name, on, target));
    if (unbind) unbinds.push(unbind);
  }
  if (!unbinds.length) return null;
  return () => {
    for (const unbind of unbinds) unbind();
  };
}

/** 样式表使用了、但既无信号也无属性来源的伪类：提示一次，不静默忽略。 */
export function warnUnboundPseudoClasses(names: Iterable<string>): void {
  if (!ngDevMode) return;
  for (const name of names) {
    if (hasPseudoBinder(name)) continue;
    warnOnce(
      `css:pseudo-unbound:${name}`,
      `样式表使用了 :${name}，但 Godot 无对应的信号/属性，它不会自动生效。可选方案：` +
        `① 通过 class 通道表达该状态（如 [class."${name}"]="…" 配合 CSS .x.${name}），class 变化会触发通知；` +
        `② 状态变化时自行调用 runtime.setPseudoClass(node, "${name}", true/false)。`,
    );
  }
}
