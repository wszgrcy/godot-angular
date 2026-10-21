import {
  DirAccess,
  DisplayServer,
  Image,
  Input,
  InputEventKey,
  InputEventMouseButton,
  Node,
  Vector2,
  Vector2i,
  type Window,
} from "godot";
import { awaitFrames, walkNodes } from "./render";

/**
 * 屏幕级操作工具：定位节点、注入输入、读取实际渲染出来的像素。
 *
 * 与 Playwright 的区别：测试代码本身就运行在引擎进程里，这里没有跨进程协议，
 * 每个方法都是普通函数调用。代价是引擎的布局与绘制按帧推进，所以每个动作之后必须
 * 等帧，本文件里的动作方法内部已经等好了，调用方不需要再手写等待。
 *
 * 能力分两档：
 * - 定位与输入注入在无头模式下同样有效（实测：点击能触发 `Button.pressed`，
 *   键盘输入能写进 `LineEdit.text`）。
 * - 读取像素必须有头模式。无头下 `Viewport.get_texture().get_image()` 返回 null。
 */

/** 颜色用 0..1 的三个分量表示，与 `Image.get_pixel()` 返回的 `Color` 一致 */
export type Rgb = readonly [number, number, number];

/** 鼠标左键的按键编号（`MouseButtons.LEFT`）；GodotJS 侧枚举常量不一定可用，直接写数值 */
const MOUSE_LEFT = 1;

/**
 * 当前是否运行在有头模式（引擎真的开了窗口）。
 *
 * 只能用 `DisplayServer.get_name()` 判断：`OS.has_feature("headless")` 在无头下也返回
 * false，用它判断会得到反向的结论。
 */
export function isHeaded(): boolean {
  return DisplayServer.get_name() !== "headless";
}

/**
 * 像素相关操作的前置检查：无头下取到的是空图，静默返回会让断言看起来"通过"了，
 * 因此这里直接报错说明原因。
 */
export function requireHeaded(what: string): void {
  if (isHeaded()) return;
  throw new Error(
    `${what} 需要引擎以有头模式运行（当前 display_server=${DisplayServer.get_name()}）。`
      + " 在 angular.json 的测试目标里设 engine.headless=false，并保证环境有显示服务"
      + "（Linux 上为 DISPLAY，CI 中由 Xvfb 提供）。",
  );
}

/**
 * 把全局样式表交给运行时，效果等同于 angular.json 的 `styles` 选项。
 *
 * 构建产物是由生成的代码写入同一个交接位（见 `core/global-css.ts`），测试目标没有 `styles`
 * 选项，因此用这个函数在启动应用之前补上。必须在 `bootstrapGodotApp()` 之前调用。
 */
export function provideGlobalCss(stylesheets: string[]): void {
  (globalThis as Record<string, unknown>).__CUJ_GLOBAL_CSS__ = [...stylesheets];
}

/** 节点在窗口里的矩形。`Control` 才有这两个属性，非 Control 节点返回 null。 */
function rectOf(node: Node): { x: number; y: number; w: number; h: number } | null {
  const c = node as unknown as { global_position?: Vector2; size?: Vector2 };
  const pos = c.global_position;
  const size = c.size;
  if (!pos || !size) return null;
  return { x: pos.x, y: pos.y, w: size.x, h: size.y };
}

/** 读取节点当前的 class 集合。集合由级联挂在节点上，渲染器的 addClass 改的就是它。 */
function classesOf(node: Node): Set<string> | null {
  const set = (node as unknown as { cssClasses?: Set<string> }).cssClasses;
  return set instanceof Set ? set : null;
}

/** 字符对应的引擎按键码：字母与数字用其大写字母码（`KEY_A` 为 65，`KEY_0` 为 48） */
function keycodeOf(ch: string): number {
  return ch.toUpperCase().charCodeAt(0);
}

/**
 * 一个可操作的屏幕。包住承载应用的节点，坐标与截图都以它所在的窗口为准。
 *
 * 典型用法：
 * ```ts
 * const app = await bootstrapGodotApp(MyComp, initGodotTestEnvironment());
 * const screen = Screen.attach(appRoot);
 * await screen.click(screen.byName("btn"));
 * expect(screen.hasColor(screen.byName("title"), [1, 0, 0])).toBe(true);
 * ```
 */
export class Screen {
  private constructor(
    readonly host: Node,
    readonly viewport: Window,
  ) {}

  /** 以 `host` 所在的窗口建立屏幕。`host` 通常是测试环境创建的场景根。 */
  static attach(host: Node): Screen {
    const viewport = host.get_tree().root as unknown as Window;
    return new Screen(host, viewport);
  }

  /* ----------------------------- 定位 ----------------------------- */

  /** 按节点名查找（模板里的 `name="..."`），找不到直接报错，避免后续断言拿到 null */
  byName(name: string): Node {
    const found = this.findName(name);
    if (!found) throw new Error(`屏幕里没有名为 ${name} 的节点`);
    return found;
  }

  findName(name: string): Node | null {
    return walkNodes(this.host).find((n) => n.get_name() === name) ?? null;
  }

  /** 按 `text` 属性精确匹配（Label / Button 那一支才有 text） */
  byText(text: string): Node | null {
    return (
      walkNodes(this.host).find(
        (n) => (n as unknown as { text?: unknown }).text === text,
      ) ?? null
    );
  }

  /** 按 class 查找，返回全部命中的节点 */
  byClass(cls: string): Node[] {
    return walkNodes(this.host).filter((n) => classesOf(n)?.has(cls) ?? false);
  }

  /** 按引擎类名查找，如 `byType("Label")` */
  byType(className: string): Node[] {
    return walkNodes(this.host).filter((n) => n.get_class() === className);
  }

  /* ----------------------------- 交互 ----------------------------- */

  /** 节点中心点在窗口里的坐标 */
  centerOf(target: Node): Vector2 {
    const r = rectOf(target);
    if (!r) throw new Error(`${target.get_name()} 不是 Control，没有画面位置`);
    return new Vector2(r.x + r.w / 2, r.y + r.h / 2);
  }

  /**
   * 点击：先把指针移到目标上，再分两帧按下与抬起。
   *
   * 两个步骤都实测过：按下与抬起放在同一帧不会触发 `pressed`；指针位置不更新时，
   * 事件坐标落在别处也不会命中目标。
   */
  async click(target: Node): Promise<void> {
    const at = this.centerOf(target);
    Input.warp_mouse(at);
    await this.settle(1);
    this.mouseButton(true, at);
    await this.settle(1);
    this.mouseButton(false, at);
    await this.settle(1);
  }

  /** 把指针移到节点上并停留，用于 `:hover` 这类依赖真实指针位置的样式 */
  async hover(target: Node): Promise<void> {
    Input.warp_mouse(this.centerOf(target));
    await this.settle(2);
  }

  /** 把指针移到窗口右下角，离开所有控件，用于验证悬停样式已撤销 */
  async moveMouseAway(): Promise<void> {
    const size = this.viewport.size;
    Input.warp_mouse(new Vector2(size.x - 4, size.y - 4));
    await this.settle(2);
  }

  /** 逐字符输入文本。每个字符的按下与抬起各占一帧。 */
  async typeText(text: string): Promise<void> {
    for (const ch of text) {
      const code = keycodeOf(ch);
      this.key(true, code, ch.charCodeAt(0));
      await this.settle(1);
      this.key(false, code, ch.charCodeAt(0));
      await this.settle(1);
    }
  }

  /** 按一个键（键码用引擎常量，如 `Key.ENTER`） */
  async pressKey(keycode: number): Promise<void> {
    this.key(true, keycode, 0);
    await this.settle(1);
    this.key(false, keycode, 0);
    await this.settle(1);
  }

  private mouseButton(down: boolean, at: Vector2): void {
    const ev = new InputEventMouseButton();
    ev.button_index = MOUSE_LEFT;
    ev.pressed = down;
    ev.position = at;
    ev.global_position = at;
    Input.parse_input_event(ev);
  }

  private key(down: boolean, keycode: number, unicode: number): void {
    const ev = new InputEventKey();
    ev.pressed = down;
    ev.keycode = keycode;
    ev.unicode = unicode;
    Input.parse_input_event(ev);
  }

  /** 等引擎真的走过 n 帧。样式刷新、布局、绘制都排在帧上，动作之后需要等帧才看得到结果。 */
  async settle(frames = 2): Promise<void> {
    await awaitFrames(frames);
  }

  /* ----------------------------- 观察 ----------------------------- */

  /**
   * 设置窗口尺寸。无头下默认视口只有 64x64，超出该范围的坐标点不到，
   * 因此无头下做交互测试前需要先设一次；有头下同样有效。
   */
  async setWindowSize(width: number, height: number): Promise<void> {
    this.viewport.size = new Vector2i(width, height);
    await this.settle(2);
  }

  /** 当前窗口内容的一帧图像。无头下抛错而不是返回空图。 */
  screenshot(): Image {
    requireHeaded("读取像素");
    const texture = this.viewport.get_texture();
    const image = texture ? texture.get_image() : null;
    if (!image) throw new Error("引擎没有返回图像内容");
    return image;
  }

  /**
   * 统计节点画面区域内与目标颜色接近的像素个数。
   *
   * 数像素而不是取中心一点：文字只占节点矩形的一部分，取中心很可能落在空白处。
   */
  countColor(target: Node, color: Rgb, tolerance = 0.1): number {
    const rect = rectOf(target);
    if (!rect) throw new Error(`${target.get_name()} 不是 Control，没有画面区域`);
    const image = this.screenshot();
    const [r, g, b] = color;
    let hits = 0;
    const x0 = Math.max(0, Math.floor(rect.x));
    const y0 = Math.max(0, Math.floor(rect.y));
    const x1 = Math.min(image.get_width(), Math.ceil(rect.x + rect.w));
    const y1 = Math.min(image.get_height(), Math.ceil(rect.y + rect.h));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const p = image.get_pixel(x, y);
        if (
          Math.abs(p.r - r) <= tolerance
          && Math.abs(p.g - g) <= tolerance
          && Math.abs(p.b - b) <= tolerance
        ) {
          hits++;
        }
      }
    }
    return hits;
  }

  /** 节点区域内是否出现了目标颜色 */
  hasColor(target: Node, color: Rgb, tolerance = 0.1): boolean {
    return this.countColor(target, color, tolerance) > 0;
  }

  /**
   * 逐帧轮询直到条件成立，最多等 `maxFrames` 帧；返回是否等到。
   *
   * 指针事件从窗口系统送过来需要几帧，固定等几帧会时好时坏。需要等渲染结果的断言
   * 先过这一层，既不会因偶发慢一帧而误报，也不会因等待而掩盖真的没生效。
   */
  async waitFor(condition: () => boolean, maxFrames = 60): Promise<boolean> {
    for (let i = 0; i < maxFrames; i++) {
      if (condition()) return true;
      await this.settle(1);
    }
    return condition();
  }

  /** 等节点区域内出现（或消失）目标颜色 */
  async waitForColor(
    target: Node,
    color: Rgb,
    want = true,
    maxFrames = 60,
  ): Promise<boolean> {
    return this.waitFor(() => this.hasColor(target, color) === want, maxFrames);
  }

  /** 把当前帧存成 PNG，返回引擎内的路径，便于失败时人工查看 */
  savePng(name: string, dir = "res://visual-out"): string {
    const image = this.screenshot();
    // 目录可能还不存在（刚克隆的仓库里只有 .gdignore），save_png 不会自己建目录
    DirAccess.make_dir_recursive_absolute(dir);
    const path = `${dir}/${name}.png`;
    image.save_png(path);
    return path;
  }
}
