import { Control, DirAccess, FileAccess, Image, Input, Node, Rect2, Vector2, Viewport } from "godot";
import { GodotAngularApp, bootstrapGodotApp } from "godot-angular/core";
import { VisualRoot } from "./app";

/**
 * 像素级验证的驱动入口（场景根脚本）。
 *
 * 流程：启动应用 → 按帧推进 → 在指定帧截图 → 统计指定节点画面区域内目标颜色的像素数量
 * → 写入 report.txt。像素统计放在引擎内而不是交给外部脚本：节点的画面位置只能由引擎
 * 提供（get_global_rect()），JS 侧可直接取用，无需图像库和坐标换算。
 *
 * 截图取到的是**上一帧**的渲染结果（_process 在本帧绘制之前执行），因此每个动作之后至少
 * 留两帧：一帧让变更检测与样式刷新执行完毕，一帧让结果进入绘制。
 */

const OUT_DIR = "res://visual-out";
const REPORT = `${OUT_DIR}/report.txt`;
/** FileAccess.ModeFlags.WRITE；该枚举常量在 GodotJS 侧不一定可用，因此直接写数值 */
const FILE_WRITE = 2;
/** 超时保护的帧数上限：超过则输出报告并退出，避免进程挂起 */
const WATCHDOG_FRAMES = 1800;

type Rgb = [number, number, number];

interface Expect {
  /** 在哪个节点的画面区域内查找 */
  node: string;
  color: Rgb;
  /** present = 必须存在；absent = 必须不存在 */
  want: "present" | "absent";
  what: string;
}

interface Shot {
  name: string;
  checks: Expect[];
  /** 失败时需要额外查看的内部状态（“未写入”与“已写入但未绘制”两种原因需要区分） */
  extra?: () => string[];
}

const RED: Rgb = [255, 0, 0];
const BLUE: Rgb = [0, 0, 255];
const CYAN: Rgb = [0, 255, 255];
const YELLOW: Rgb = [255, 255, 0];
const MAGENTA: Rgb = [255, 0, 255];

/** 每个截图点的断言。absent 与 present 同样必要：只断言存在无法验证撤销 */
const SHOTS: Shot[] = [
  {
    name: "01-first-frame",
    checks: [
      { node: "title", color: RED, want: "present", what: "组件样式在首帧已绘制" },
      { node: "glob", color: MAGENTA, want: "present", what: "全局样式（angular.json styles）在首帧已绘制" },
      { node: "box", color: CYAN, want: "present", what: "背景色（StyleBoxFlat）在首帧已绘制" },
      { node: "dyn", color: BLUE, want: "absent", what: "class 未开启时不应出现蓝色" },
      { node: "btn", color: YELLOW, want: "absent", what: "未悬停时不应出现黄色" },
    ],
  },
  {
    name: "02-class-on",
    checks: [
      { node: "dyn", color: BLUE, want: "present", what: "signal 修改 class 后蓝色文字已绘制" },
      { node: "title", color: RED, want: "present", what: "修改单个节点不影响其他节点" },
    ],
  },
  {
    name: "03-class-off",
    checks: [
      { node: "dyn", color: BLUE, want: "absent", what: "class 移除后蓝色已撤销" },
      { node: "dyn", color: RED, want: "absent", what: "撤销不会残留其他颜色" },
    ],
  },
  {
    name: "04-hover",
    checks: [{ node: "btn", color: YELLOW, want: "present", what: ":hover 在真实鼠标悬停后绘制黄色文字" }],
    extra: hoverDiag,
  },
  {
    name: "05-hover-off",
    checks: [{ node: "btn", color: YELLOW, want: "absent", what: "鼠标移出后悬停色已撤销" }],
    extra: hoverDiag,
  },
];

/** 截图点需要额外读取内部状态时从这里取节点（在 _ready 中赋值） */
let stageRoot: Node | null = null;

/** 悬停诊断：「样式层未写入」与「已写入但 Button 未按悬停状态绘制」是两种不同原因 */
function hoverDiag(): string[] {
  const btn = stageRoot == null ? null : findByName(stageRoot, "btn");
  if (btn == null) return ["btn MISSING"];
  const b = btn as unknown as { has_theme_color_override(p: string): boolean };
  const vp = stageRoot?.get_viewport() as Viewport | null;
  const p = vp?.get_mouse_position();
  const r = rectOf(btn);
  const over =
    p == null
      ? "?"
      : String(
          p.x >= r.position.x &&
            p.x <= r.position.x + r.size.x &&
            p.y >= r.position.y &&
            p.y <= r.position.y + r.size.y,
        );
  const at = p == null ? "?" : `${Math.round(p.x)},${Math.round(p.y)}`;
  return [
    `mouse=${at}`,
    `mouse_over_btn=${over}`,
    `font_hover_color_override=${b.has_theme_color_override("font_hover_color")}`,
  ];
}

/** 查找到的节点均为 Control，但 get_child() 的声明类型是 Node，取画面矩形需要转换 */
function rectOf(node: Node): Rect2 {
  return (node as unknown as Control).get_global_rect();
}

function findByName(node: Node, name: string): Node | null {
  const count = node.get_child_count();
  for (let i = 0; i < count; i++) {
    const child = node.get_child(i) as Node;
    if (child.get_name() === name) return child;
    const deeper = findByName(child, name);
    if (deeper) return deeper;
  }
  return null;
}

/**
 * 统计矩形区域内落在目标颜色容差内的像素数量。文字只占区域的一部分，因此只能统计命中
 * 数量，不能取单点代表整块。
 */
function countColor(img: Image, rect: Rect2, target: Rgb, tol = 0.1): number {
  const tr = target[0] / 255;
  const tg = target[1] / 255;
  const tb = target[2] / 255;
  const x0 = Math.max(0, Math.floor(rect.position.x));
  const y0 = Math.max(0, Math.floor(rect.position.y));
  const x1 = Math.min(img.get_width() - 1, Math.ceil(rect.position.x + rect.size.x));
  const y1 = Math.min(img.get_height() - 1, Math.ceil(rect.position.y + rect.size.y));
  let hits = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const c = img.get_pixel(x, y);
      if (Math.abs(c.r - tr) <= tol && Math.abs(c.g - tg) <= tol && Math.abs(c.b - tb) <= tol) hits++;
    }
  }
  return hits;
}

/** 按固定步长采样整幅画面的颜色种类数，用于判断截图是否为纯色空帧 */
function distinctColors(img: Image): number {
  const seen = new Set<string>();
  for (let y = 0; y < img.get_height(); y += 37) {
    for (let x = 0; x < img.get_width(); x += 53) {
      seen.add(img.get_pixel(x, y).to_html(true));
    }
  }
  return seen.size;
}

interface Step {
  at: number;
  run: () => void;
}

export default class VisualMain extends Node {
  private app: GodotAngularApp | null = null;
  private root: Control | null = null;
  private frames = 0;
  private startFrame = 0;
  private steps: Step[] = [];
  private lines: string[] = [];
  private failures = 0;
  private finished = false;

  _ready(): void {
    DirAccess.make_dir_recursive_absolute(OUT_DIR);
    const root = new Control();
    root.name = "AngularRoot";
    root.size = new Vector2(1280, 720);
    this.root = root;
    stageRoot = root;
    this.add_child(root);
    bootstrapGodotApp(VisualRoot, root)
      .then((app) => {
        this.app = app;
      })
      .catch((err) => this.finish(`bootstrap 失败: ${String(err)}`));
  }

  _process(delta: number): void {
    this.frames++;
    // 先调用 tick()：本帧应执行的变更检测与样式刷新排在帧钟里，步骤需要在其之后观察结果
    this.app?.tick(delta * 1000);
    if (this.app !== null && this.startFrame === 0) {
      this.startFrame = this.frames;
      this.plan();
    }
    while (this.steps.length > 0 && this.steps[0].at <= this.frames) {
      const step = this.steps.shift() as Step;
      try {
        step.run();
      } catch (err) {
        this.finish(`步骤异常: ${String(err)}`);
        return;
      }
    }
    if (!this.finished && this.frames > WATCHDOG_FRAMES) this.finish("watchdog 超时");
  }

  /** 动作与截图按帧排布：每个动作之后至少留两帧，一帧供变更检测与样式刷新执行，一帧供绘制 */
  private plan(): void {
    const base = this.startFrame;
    const at = (offset: number, run: () => void): void => {
      this.steps.push({ at: base + offset, run });
    };
    const comp = (): VisualRoot | undefined => this.app?.rootComponent as VisualRoot | undefined;
    const center = (name: string): Vector2 | null => {
      const node = findByName(this.root as Node, name);
      if (node == null) return null;
      const r = rectOf(node);
      return new Vector2(r.position.x + r.size.x / 2, r.position.y + r.size.y / 2);
    };
    /** 将鼠标移动到按钮上方。emit_signal("mouse_entered") 不足以验证：它只让样式层写入
     *  font_hover_color，而 Button 依据真实鼠标位置选择绘制状态，鼠标不在其上方时不会
     *  读取该 item。真实窗口下 warp_mouse 会实际移动指针。*/
    const hover = (on: boolean): void => {
      const at = on ? center("btn") : new Vector2(1200, 700);
      if (at != null) Input.warp_mouse(at);
    };

    at(1, () => this.shot("01-first-frame"));
    at(3, () => comp()?.on.set(true));
    at(5, () => this.shot("02-class-on"));
    at(7, () => comp()?.on.set(false));
    at(9, () => this.shot("03-class-off"));
    at(11, () => hover(true));
    at(14, () => this.shot("04-hover"));
    at(16, () => hover(false));
    at(19, () => this.shot("05-hover-off"));
    at(20, () => this.finish());
  }

  private shot(name: string): void {
    const shot = SHOTS.find((s) => s.name === name);
    if (shot === undefined) {
      this.failures++;
      this.lines.push(`shot=${name} UNKNOWN`);
      return;
    }
    const viewport = this.get_viewport();
    if (viewport == null) {
      this.finish(`拿不到 viewport（${name}）`);
      return;
    }
    const texture = viewport.get_texture();
    if (texture == null) {
      this.finish(`拿不到 viewport 纹理（${name}）`);
      return;
    }
    const img = texture.get_image();
    if (img == null || img.get_width() === 0) {
      this.finish(`截图为空（${name}）`);
      return;
    }
    const err = img.save_png(`${OUT_DIR}/${name}.png`);
    this.lines.push(
      `shot=${name} ${img.get_width()}x${img.get_height()} save_png_err=${err} distinct_colors=${distinctColors(img)}`,
    );
    if (err !== 0) this.failures++;
    if (shot.extra != null) for (const line of shot.extra()) this.lines.push(`diag[${name}] ${line}`);

    for (const check of shot.checks) {
      const node = findByName(this.root as Node, check.node);
      if (node == null) {
        this.failures++;
        this.lines.push(`check[${name}] ${check.node} MISSING 找不到节点`);
        continue;
      }
      const rect = rectOf(node);
      const hits = countColor(img, rect, check.color);
      const ok = check.want === "present" ? hits > 0 : hits === 0;
      if (!ok) this.failures++;
      this.lines.push(
        `check[${name}] ${check.node} ${check.want} rgb(${check.color.join(",")}) ` +
          `rect=${Math.round(rect.position.x)},${Math.round(rect.position.y)},` +
          `${Math.round(rect.size.x)}x${Math.round(rect.size.y)} pixels=${hits} ${ok ? "PASS" : "FAIL"} ${check.what}`,
      );
    }
  }

  private finish(reason?: string): void {
    if (this.finished) return;
    this.finished = true;
    if (reason != null) {
      this.failures++;
      this.lines.push(`abort=${reason}`);
    }
    this.lines.unshift(`frames=${this.frames} start_frame=${this.startFrame}`);
    this.lines.push(`result=${this.failures === 0 ? "PASS" : "FAIL"}`);
    for (const line of this.lines) console.log(`[visual] ${line}`);
    const file = FileAccess.open(REPORT, FILE_WRITE);
    if (file == null) {
      console.log(`[visual] report_open_failed ${REPORT}`);
    } else {
      file.store_string(this.lines.join("\n") + "\n");
      file.close();
    }
    (this.get_tree() as unknown as { quit(code: number): void }).quit(this.failures === 0 ? 0 : 1);
  }
}
