import { Component, Input, NO_ERRORS_SCHEMA, signal } from "@angular/core";

/**
 * ng-content 投影演示用的卡片。
 * 选择器小写、不是 Godot 类 → 宿主元素降级为 VBoxContainer（会自适应子节点尺寸）。
 */
@Component({
  selector: "ui-card",
  standalone: true,
  schemas: [NO_ERRORS_SCHEMA],
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
