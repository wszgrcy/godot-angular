import { beforeEach, describe, expect, it } from "vitest";
import {
  CheckBox,
  Color,
  Control,
  HBoxContainer,
  Label,
  PanelContainer,
  type StyleBoxFlat,
} from "godot";
import { StyleRuntime } from "godot-angular/core";
import { awaitFrames, makeRenderer, resetWarnOnce } from "godot-angular/testing";

/**
 * `:hover` 向祖先冒泡（CSS 语义，库侧补齐）。
 *
 * 引擎只在「最深接收控件 + 它往上直到第一个 STOP 祖先」这条链上发 mouse_entered：
 * 子控件是 `mouse_filter = STOP`（Button / CheckBox / 用来撑位的空 Control）时把事件整个
 * 吃掉，父级一个信号都收不到。于是示例工程里
 * `.list-row:hover { border-color: … }` 变成「只有指针精确写在行边框那一圈空白上才亮」，
 * 停在行内的 CheckBox 上反而不亮。引擎不发冒泡，只能库侧补，见
 * `library/core/css-pseudo.ts` 的 `hoverPair`。
 */

let runtime: StyleRuntime;
let root: Control;

beforeEach(() => {
  runtime = new StyleRuntime();
  root = makeRenderer().root;
  resetWarnOnce();
  runtime.addCss(`.row { background-color: rgb(255, 255, 255); }`);
  runtime.addCss(`.row:hover { background-color: rgb(1, 2, 3); }`);
});

/** 纳入级联（可选带上 class），返回节点本身 */
function attach<T extends Control>(node: T, cls?: string): T {
  runtime.attach(node);
  if (cls) (node as unknown as { cssClasses: Set<string> }).cssClasses.add(cls);
  return node;
}

/**
 * 一行列表项：PanelContainer(.row) > HBoxContainer(.cell) > CheckBox(.box) + Label(.tag)。
 * 与示例工程 `@for` 生成的结构同形——撑位的空 Control / CheckBox 都是 STOP。
 */
function makeRow(): { row: PanelContainer; cell: HBoxContainer; box: CheckBox; tag: Label } {
  const row = new PanelContainer();
  const cell = new HBoxContainer();
  const box = new CheckBox();
  const tag = new Label();
  row.add_child(cell);
  cell.add_child(box);
  cell.add_child(tag);
  root.add_child(row);
  attach(row, "row");
  attach(cell, "cell");
  attach(box, "box");
  attach(tag, "tag");
  runtime.flush();
  return { row, cell, box, tag };
}

/** 节点上某个 item 当前真正生效的盒 */
function boxOf(node: Control, item: string): StyleBoxFlat {
  return node.get_theme_stylebox(item) as StyleBoxFlat;
}

function css(r: number, g: number, b: number): Color {
  return new Color(r / 255, g / 255, b / 255, 1);
}

/** 颜色按 html 比较：每次读出的 Color 都是新实例 */
function hex(value: Color): string {
  return value.to_html(true);
}

/** PanelContainer 只有一个盒：:hover 复用 panel（见 css-state-box.spec.ts） */
function rowColor(row: PanelContainer): string {
  return hex(boxOf(row, "panel").bg_color);
}

const BASE = css(255, 255, 255);
const HOVER = css(1, 2, 3);

/* ------------------------------------------------------------------ */

describe(":hover 冒泡到祖先", () => {
  it("停在 STOP 子控件上：整条祖先链的 :hover 一起成立", async () => {
    const { row, cell, box } = makeRow();
    expect(rowColor(row)).toBe(hex(BASE));

    box.emit_signal("mouse_entered");
    await awaitFrames(1);

    expect(rowColor(row)).toBe(hex(HOVER));
    // 中间那层容器同样要亮（CSS 里 :hover 一路到根）
    expect((cell as unknown as { cssPseudoClasses?: Set<string> }).cssPseudoClasses?.has("hover")).toBe(true);
  });

  it("子控件退出：祖先链一起撤掉", async () => {
    const { row, cell, box } = makeRow();
    box.emit_signal("mouse_entered");
    await awaitFrames(1);
    expect(rowColor(row)).toBe(hex(HOVER));

    box.emit_signal("mouse_exited");
    await awaitFrames(1);

    expect(rowColor(row)).toBe(hex(BASE));
    expect((cell as unknown as { cssPseudoClasses?: Set<string> }).cssPseudoClasses?.has("hover")).toBe(false);
  });

  it("父级自身与子孙同时举着悬停：子孙退出不得把父级一起抹掉", async () => {
    const { row, box } = makeRow();
    // 引擎会同时给父（PASS 链）与子（STOP）发进入信号，两条来源叠在一起
    row.emit_signal("mouse_entered");
    box.emit_signal("mouse_entered");
    await awaitFrames(1);
    expect(rowColor(row)).toBe(hex(HOVER));

    box.emit_signal("mouse_exited");
    await awaitFrames(1);
    // 父级自己仍在悬停中，不能被子孙的退出顶掉
    expect(rowColor(row)).toBe(hex(HOVER));

    row.emit_signal("mouse_exited");
    await awaitFrames(1);
    expect(rowColor(row)).toBe(hex(BASE));
  });

  it("退出与进入的先后顺序无关（先新后旧也要留在悬停态）", async () => {
    const { row, cell, box } = makeRow();
    box.emit_signal("mouse_entered");
    await awaitFrames(1);

    // 引擎实际是「先发完全部 exited 再发 entered」，但这一点没有文档保证，
    // 登记表口径下反过来发也不会把仍然成立的悬停误抹掉
    cell.emit_signal("mouse_entered");
    box.emit_signal("mouse_exited");
    await awaitFrames(1);

    expect(rowColor(row)).toBe(hex(HOVER));
  });

  it("节点被移出树时引擎不补发 mouse_exited：祖先不得停在悬停态", async () => {
    const { row, cell, box } = makeRow();
    box.emit_signal("mouse_entered");
    await awaitFrames(1);
    expect(rowColor(row)).toBe(hex(HOVER));

    // @for 删项 / queue_free 前先把节点摘走：此刻没有 mouse_exited
    cell.remove_child(box);
    await awaitFrames(1);

    expect(rowColor(row)).toBe(hex(BASE));
  });

  it("不属于本级联的祖先不写（挂载点没 attach，标脏它等于整棵树白重算）", async () => {
    const { box } = makeRow();
    box.emit_signal("mouse_entered");
    await awaitFrames(1);

    const pseudo = (root as unknown as { cssPseudoClasses?: Set<string> }).cssPseudoClasses;
    expect(pseudo?.has("hover") ?? false).toBe(false);
  });

  it("IGNORE 的 Label 也能把悬停交给祖先（引擎本来就会给 PASS 链发信号）", async () => {
    const { row, tag } = makeRow();
    tag.emit_signal("mouse_entered");
    await awaitFrames(1);
    expect(rowColor(row)).toBe(hex(HOVER));
  });
});
