import { Component, signal } from "@angular/core";
import { Vector2 } from "godot";

/**
 * 像素级验证所用的组件（由 visual/main.ts 驱动）。
 *
 * 每条规则各占一行，每行一个颜色。颜色只取纯色原色 / 二次色：Godot 的 UI 颜色要经过
 * sRGB ↔ 线性空间转换，只有 0 与 1 两个端点在转换后保持不变，取中间值（例如绿 200）
 * 时截图读回的数值会偏移，断言必须放宽容差。
 *
 * 五条写入路径，覆盖改造后剩余的全部分支：
 *   title  组件样式（构建期解析）
 *   glob   全局样式（angular.json 的 styles 选项）
 *   dyn    class 绑定（signal → 渲染器 addClass → 标记节点 → effect 刷新）
 *   box    背景（StyleBoxFlat，非字体色，验证另一条写入路径）
 *   btn    :hover 伪类（由引擎信号驱动，Angular 不跟踪该来源）
 */
@Component({
  selector: "visual-root",
  standalone: true,
  styles: [
    `.title { color: rgb(255, 0, 0); font-size: 40px; }`,
    `.dyn { font-size: 40px; }`,
    `.dyn.on { color: rgb(0, 0, 255); }`,
    `.box { background-color: rgb(0, 255, 255); }`,
    `.hb:hover { color: rgb(255, 255, 0); }`,
  ],
  template: `
    <VBoxContainer name="stage" [size_flags]="expand">
      <Label name="title" class="title" text="TITLE"></Label>
      <Label name="dyn" class="dyn" [class.on]="on()" text="DYNAMIC"></Label>
      <Label name="glob" class="glob" text="GLOBAL"></Label>
      <PanelContainer name="box" class="box" [custom_minimum_size]="boxMin">
        <Label name="boxLabel" text="BOX"></Label>
      </PanelContainer>
      <Button name="btn" class="hb" text="HOVER"></Button>
    </VBoxContainer>
  `,
})
export class VisualRoot {
  /** Control.SIZE_EXPAND_FILL */
  readonly expand = 3;
  /** 背景块需要可采样的面积，仅靠 Label 子节点无法撑开尺寸 */
  readonly boxMin = new Vector2(360, 72);
  readonly on = signal(false);
}
