/**
 * GodotJS 的 mock，只用于单元测试（不启引擎）。
 *
 * 刻意复刻了实测到的 GodotJS 怪癖，否则单测过了引擎里照样炸：
 *   1. ClassDB 返回的数组是 Godot Array 包装：可 for...of，但**不是 JS 数组**（无 length/map）
 *   2. 数组元素是 Dictionary：`.name` 拿不到，必须 `.get("name")`
 *   3. class_get_property_list(cls, true) 的 includeInherited 被忽略，只给本类属性
 *   4. 给不存在的属性赋值静默接受（写成普通 JS 键）
 *   5. 信号只能连 Callable，普通函数会报 "Expected: Callable. Found: function"
 */

/** 模拟 Godot Array：可迭代，但故意不给 length / map，逼调用方走 for...of */
function godotArray<T>(items: T[]): Iterable<T> {
  const obj: Record<string | symbol, any> = {};
  obj[Symbol.iterator] = function* () {
    for (const it of items) yield it;
  };
  obj.size = () => items.length;
  return obj as Iterable<T>;
}

/** 模拟 Godot Dictionary：`.get(key)` 取值，`.name` 取不到 */
function godotDict(entries: Record<string, unknown>): any {
  return { get: (k: string) => entries[k] };
}

/** 类名 → 自有属性名（不含继承，和 GodotJS 行为一致） */
const OWN_PROPERTIES: Record<string, string[]> = {
  Object: ["script"],
  Node: ["name", "owner", "process_mode", "auto_translate"],
  Control: [
    "mouse_filter", "size", "position", "rotation", "modulate", "self_modulate", "visible",
    "size_flags_horizontal", "size_flags_vertical", "custom_minimum_size", "anchors_preset",
    "theme", "tooltip_text", "focus_mode",
  ],
  Label: ["text", "horizontal_alignment", "vertical_alignment", "autowrap_mode"],
  Button: ["text", "button_pressed", "flat", "icon"],
  LineEdit: ["text", "placeholder_text", "secret", "editable", "max_length"],
  VBoxContainer: ["alignment", "separation"],
  HBoxContainer: ["alignment", "separation"],
  GridContainer: ["columns"],
  PanelContainer: [],
  Separator: [],
  OptionButton: ["selected", "item_count"],
  ProgressBar: ["value", "min_value", "max_value"],
};

const SIGNALS: Record<string, string[]> = {
  Node: ["ready", "entered_tree"],
  Control: ["gui_input", "focus_entered", "focus_exited", "resized"],
  Button: ["pressed", "button_up", "button_down", "toggled"],
  LineEdit: ["text_changed", "text_submitted", "up_pressed"],
  OptionButton: ["item_selected", "item_activated"],
};

const PARENTS: Record<string, string> = {
  Node: "Object",
  Control: "Node",
  Label: "Control",
  Button: "Control",
  LineEdit: "Control",
  BoxContainer: "Control",
  VBoxContainer: "BoxContainer",
  HBoxContainer: "BoxContainer",
  GridContainer: "Control",
  PanelContainer: "Control",
  Separator: "Control",
  OptionButton: "Control",
  ProgressBar: "Control",
};

const KNOWN_CLASSES = [...Object.keys(PARENTS), ...Object.keys(OWN_PROPERTIES)];

let INSTANCE_COUNTER = 0;

export class MockCallable {
  constructor(
    readonly target: unknown,
    readonly callback: (...args: any[]) => unknown,
  ) {}
}

export class MockNode {
  name = "";
  size = { x: 0, y: 0 };
  position = { x: 0, y: 0 };
  text = "";
  custom_minimum_size = { x: 0, y: 0 };
  modulate = { r: 1, g: 1, b: 1, a: 1 };
  size_flags_horizontal = 1;
  size_flags_vertical = 1;
  visible = true;

  readonly parent: MockNode | null = null;
  readonly children: MockNode[] = [];
  readonly connected: Map<string, MockCallable[]> = new Map();
  readonly themeColorOverrides = new Map<string, unknown>();
  readonly themeFontSizeOverrides = new Map<string, number>();
  /** 记录 emit 过的信号，便于断言 */
  readonly emitted: Array<[string, unknown[]]> = [];
  private readonly __id = ++INSTANCE_COUNTER;
  private __freed = false;

  constructor(className = "Control") {
    Object.defineProperty(this, "__class", { value: className, enumerable: false });
    // GodotJS 把信号暴露成节点上的对象：btn.pressed.connect(callable)
    let cls: string | undefined = className;
    while (cls) {
      for (const sig of SIGNALS[cls] ?? []) {
        if (!(sig in this)) {
          (this as any)[sig] = {
            connect: (c: MockCallable) => this.connect(sig, c),
            disconnect: (c: MockCallable) => this.disconnect(sig, c),
          };
        }
      }
      cls = PARENTS[cls];
    }
  }

  get_class(): string {
    return (this as any).__class;
  }

  add_child(node: MockNode): void {
    if (node.parent) throw new Error(`Can't add child, already has a parent`);
    (node as any).parent = this;
    this.children.push(node);
  }

  remove_child(node: MockNode): void {
    const i = this.children.indexOf(node);
    if (i >= 0) this.children.splice(i, 1);
    (node as any).parent = null;
  }

  get_child(i: number): MockNode {
    return this.children[i];
  }

  get_child_count(): number {
    return this.children.length;
  }

  get_index(): number {
    return this.parent ? this.parent.children.indexOf(this) : -1;
  }

  get_index_in_parent(): number {
    return this.get_index();
  }

  get_parent(): MockNode | null {
    return this.parent;
  }

  move_child(child: MockNode, index: number): void {
    const from = this.children.indexOf(child);
    if (from < 0 || index < 0) return;
    this.children.splice(from, 1);
    this.children.splice(index, 0, child);
  }

  get_instance_id(): number {
    return this.__id;
  }

  queue_free(): void {
    this.__freed = true;
  }

  free(): void {
    this.__freed = true;
  }

  is_queued_for_deletion(): boolean {
    return this.__freed;
  }

  add_theme_color_override(name: string, value: unknown): void {
    this.themeColorOverrides.set(name, value);
  }
  remove_theme_color_override(name: string): void {
    this.themeColorOverrides.delete(name);
  }
  has_theme_color_override(name: string): boolean {
    return this.themeColorOverrides.has(name);
  }
  add_theme_font_size_override(name: string, value: number): void {
    this.themeFontSizeOverrides.set(name, value);
  }
  remove_theme_font_size_override(name: string): void {
    this.themeFontSizeOverrides.delete(name);
  }
  has_theme_font_size_override(name: string): boolean {
    return this.themeFontSizeOverrides.has(name);
  }

  /** 信号连接入口：只接受 MockCallable，复刻 GodotJS 的类型校验 */
  connect(signalName: string, callable: MockCallable): void {
    if (!(callable instanceof MockCallable)) {
      throw new Error("Failed to convert JS variable to Variant. Expected: Callable. Found: function");
    }
    const list = this.connected.get(signalName) ?? [];
    list.push(callable);
    this.connected.set(signalName, list);
  }

  disconnect(signalName: string, callable: MockCallable): void {
    const list = this.connected.get(signalName) ?? [];
    const i = list.indexOf(callable);
    if (i >= 0) list.splice(i, 1);
  }

  emit_signal(signalName: string, ...args: unknown[]): void {
    this.emitted.push([signalName, args]);
    for (const c of this.connected.get(signalName) ?? []) c.callback(...args);
  }
}

function classHas(cls: string, signalName: string): boolean {  let c: string | undefined = cls;
  while (c) {
    if ((SIGNALS[c] ?? []).includes(signalName)) return true;
    c = PARENTS[c];
  }
  return false;
}

export const mockClassDB = {
  class_exists: (cls: string) => KNOWN_CLASSES.includes(cls),
  get_parent_class: (cls: string) => PARENTS[cls] ?? null,
  is_parent_class: (cls: string, base: string) => {
    let c: string | undefined = cls;
    while (c) {
      if (c === base) return true;
      c = PARENTS[c];
    }
    return false;
  },
  can_instantiate: (cls: string) => KNOWN_CLASSES.includes(cls) && cls !== "Node",
  get_inheriters_from_class: (base: string) =>
    godotArray(Object.keys(PARENTS).filter((c) => PARENTS[c] === base)),
  class_has_signal: classHas,
  // 只返回本类属性：GodotJS 的 includeInherited 实测无效
  class_get_property_list: (cls: string) =>
    godotArray((OWN_PROPERTIES[cls] ?? []).map((n) => godotDict({ name: n }))),
  class_get_signal_list: (cls: string) =>
    godotArray((SIGNALS[cls] ?? []).map((n) => godotDict({ name: n }))),
};

export class MockVector2 {
  constructor(
    public x = 0,
    public y = 0,
  ) {}
}

export class MockColor {
  constructor(
    public r = 0,
    public g = 0,
    public b = 0,
    public a = 1,
  ) {}
}

/** 构造一个可直接 setGodotHost() 的 mock 模块 */
export function createMockGodot(): Record<string, any> {
  const ns: Record<string, any> = {};
  for (const cls of KNOWN_CLASSES) {
    ns[cls] = class MockTypedNode extends MockNode {
      constructor() {
        super(cls);
      }
    };
  }
  return {
    ...ns,
    ClassDB: mockClassDB,
    Vector2: MockVector2,
    Color: MockColor,
    Callable: {
      create: (target: unknown, callback: (...args: any[]) => unknown) => {
        if (!(target instanceof MockNode)) throw new Error("bad object");
        return new MockCallable(target, callback);
      },
    },
  };
}

export { OWN_PROPERTIES, PARENTS, SIGNALS };
