import { Component, Input, NO_ERRORS_SCHEMA, signal } from "@angular/core";
import { Vector2 } from "godot";

/**
 * ng-content 投影演示用的卡片。选择器小写、不是 Godot 类 → 宿主元素降级为
 * VBoxContainer。`styles` + `styleUrls` 是构建期 CSS 通道的回归样本：demo 保留它们，
 * “产物中 grep 不到未替换的作用域标记”这条断言才有内容可验证。
 * 注释会随代码进入产物，因此此处不要书写那个标记的字面量，否则会污染 grep 结果。
 */
@Component({
  selector: "ui-card",
  standalone: true,
  schemas: [NO_ERRORS_SCHEMA],
  styles: [".card-body { color: rebeccapurple }"],
  styleUrls: ["./app.css"],
  template: `
    <PanelContainer>
      <VBoxContainer>
        <Label [text]="title"></Label>
        <ng-content></ng-content>
      </VBoxContainer>
    </PanelContainer>
  `,
})
export class CardComponent {
  @Input() title = "card";
}

@Component({
  selector: "app-root",
  standalone: true,
  imports: [CardComponent],
  schemas: [NO_ERRORS_SCHEMA],
  templateUrl: "./app.html",
})
export class App {
  /** Control.SIZE_EXPAND_FILL */
  readonly expand = 3;
  /** Control.SIZE_SHRINK_BEGIN */
  readonly shrink = 0;
  /** 结构体属性直接递引擎对象，渲染器不做形状猜测 */
  readonly labelMinSize = new Vector2(0, 40);

  readonly count = signal(0);
  readonly showIf = signal(true);
  readonly mode = signal<"a" | "b" | "c">("a");
  readonly items = signal([
    { id: 1, name: "item-1" },
    { id: 2, name: "item-2" },
    { id: 3, name: "item-3" },
  ]);
  readonly lastInput = signal("");
  readonly log = signal<string[]>([]);

  inc(): void {
    this.count.update((n) => n + 1);
    this.push("inc");
  }

  toggleIf(): void {
    this.showIf.update((v) => !v);
  }

  cycleMode(): void {
    this.mode.update((m) => (m === "a" ? "b" : m === "b" ? "c" : "a"));
  }

  addItem(): void {
    this.items.update((list) => [...list, { id: list.length + 1, name: `item-${list.length + 1}` }]);
  }

  removeFirst(): void {
    this.items.update((list) => list.slice(1));
  }

  onInput(value: string): void {
    this.lastInput.set(value);
  }

  private push(entry: string): void {
    this.log.update((l) => [...l.slice(-4), entry]);
  }
}
