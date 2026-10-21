import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Button, Callable, Input, Label, LineEdit, Vector2 } from "godot";
import { Screen, initGodotTestEnvironment, isHeaded } from "godot-angular/testing";

/**
 * 交互工具本身的验证：注入的鼠标与键盘事件是否真的走到了控件。
 *
 * 这些用例不需要渲染，无头与有头下都跑。像素相关能力在 `visual-pixels.spec.ts` 里验证。
 */

describe("Screen 交互工具", () => {
  let screen: Screen;
  let host: ReturnType<typeof initGodotTestEnvironment>;
  let button: Button;
  let entry: LineEdit;
  let clicks = 0;

  beforeAll(async () => {
    host = initGodotTestEnvironment({ width: 400, height: 300 });

    const title = new Label();
    title.set_name("title");
    title.text = "标题";
    host.add_child(title);

    button = new Button();
    button.set_name("btn");
    button.text = "按下";
    button.position = new Vector2(10, 10);
    button.size = new Vector2(60, 24);
    host.add_child(button);
    // 普通 JS 函数不能直接当 Callable 用（引擎会报无法转换），得用 Callable.create
    button.pressed.connect(Callable.create(button, () => {
      clicks += 1;
    }));

    entry = new LineEdit();
    entry.set_name("entry");
    entry.position = new Vector2(10, 50);
    entry.size = new Vector2(160, 28);
    host.add_child(entry);

    screen = Screen.attach(host);
    await screen.settle(2);
  });

  afterAll(async () => {
    // 指针停在控件上会让后面的用例收到多余的悬停事件，焦点残留同理，所以收尾时清掉。
    // 节点本身不 free：其余用例也不在收尾时释放测试根，释放反而会让测试环境持有已释放引用。
    entry.release_focus();
    Input.warp_mouse(new Vector2(4000, 4000));
    await screen.settle(2);
  });

  it("按名字与按文本定位", () => {
    expect(screen.byName("btn").get_class()).toBe("Button");
    expect(screen.byText("标题")?.get_name()).toBe("title");
    expect(screen.byType("LineEdit").length).toBe(1);
    expect(() => screen.byName("不存在")).toThrowError(/没有名为 不存在 的节点/);
  });

  it("click 注入的点击会触发 pressed 信号", async () => {
    const before = clicks;
    await screen.click(button);
    expect(clicks, "注入的点击没有触发 pressed").toBe(before + 1);
  });

  it("typeText 注入的按键会写进 LineEdit", async () => {
    entry.grab_focus();
    await screen.settle(1);
    await screen.typeText("ab");
    expect(entry.text).toBe("ab");
  });

  it("无头模式下读取像素会直接报错，而不是返回空图", () => {
    if (isHeaded()) {
      // 有头下这条路径应当可用；能否真的取到图像由像素用例负责
      expect(() => screen.screenshot()).not.toThrow();
      return;
    }
    expect(() => screen.screenshot()).toThrowError(/需要引擎以有头模式运行/);
  });
});
