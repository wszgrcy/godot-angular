/// <reference types="vitest" />
import {
  Component,
  NO_ERRORS_SCHEMA,
  Pipe,
  PipeTransform,
  Type,
  provideZonelessChangeDetection,
  signal,
} from "@angular/core";
import { AsyncPipe, DecimalPipe, JsonPipe, PercentPipe, UpperCasePipe } from "@angular/common";
import { ComponentFixture, ComponentFixtureAutoDetect, TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { Vector2 } from "godot";
import { findAllNodes, initGodotTestEnvironment, nodeTexts } from "godot-angular/testing";

async function render<T>(component: Type<T>): Promise<ComponentFixture<T>> {
  await TestBed.configureTestingModule({
    imports: [component],
    providers: [
      { provide: ComponentFixtureAutoDetect, useValue: true },
      provideZonelessChangeDetection(),
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(component);
  await fixture.whenStable();
  return fixture;
}

/** 字节数 → 人类可读；同时统计被调用次数（纯管道的重算口径依赖它验证） */
const fileSizeCalls = { n: 0 };

@Pipe({ name: "fileSize" })
class FileSizePipe implements PipeTransform {
  transform(bytes: number): string {
    fileSizeCalls.n++;
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
}

/** 带参数的管道：超长截断 */
@Pipe({ name: "truncate" })
class TruncatePipe implements PipeTransform {
  transform(value: string, max = 4): string {
    return value.length > max ? `${value.slice(0, max)}…` : value;
  }
}

/** 产出 Godot 结构体：管道直接交引擎的 Vector2，渲染器原样写入 */
@Pipe({ name: "minSize" })
class MinSizePipe implements PipeTransform {
  transform(width: number): Vector2 {
    return new Vector2(width, width / 2);
  }
}

describe("自定义管道", () => {
  beforeEach(() => initGodotTestEnvironment());

  it("管道结果写进 Label.text，输入变了才重算（纯管道）", async () => {
    @Component({
      selector: "t-p-size",
      imports: [FileSizePipe],
      schemas: [NO_ERRORS_SCHEMA],
      template: `<Label text="{{ bytes() | fileSize }}"></Label>`,
    })
    class SizeComp {
      readonly bytes = signal(2048);
    }

    const fixture = await render(SizeComp);
    const label = findAllNodes(fixture.nativeElement, "Label")[0];
    expect(label.text).toBe("2.0 KB");

    fixture.componentInstance.bytes.set(512);
    await fixture.whenStable();
    expect(label.text).toBe("512 B");
  });

  it("纯管道只在输入变化时重算：多次 CD 只算一次", async () => {
    @Component({
      selector: "t-p-pure",
      imports: [FileSizePipe],
      schemas: [NO_ERRORS_SCHEMA],
      template: `<VBoxContainer>
        <Label text="{{ bytes() | fileSize }}"></Label>
        <Button #b text="无关状态" (click)="unrelated.update(n => n + 1)"></Button>
        <Label text="n={{ unrelated() }}"></Label>
      </VBoxContainer>`,
    })
    class PureComp {
      readonly bytes = signal(1024);
      readonly unrelated = signal(0);
    }

    const fixture = await render(PureComp);
    const labels = findAllNodes(fixture.nativeElement, "Label");
    expect(labels[0].text).toBe("1.0 KB");

    const baseline = fileSizeCalls.n;
    // 点击按钮只改动 unrelated：CD 会执行，但 fileSize 的输入未变 → 不应重新计算
    findAllNodes(fixture.nativeElement, "Button")[0].emit_signal("pressed");
    await fixture.whenStable();
    expect(labels[1].text).toBe("n=1");
    expect(fileSizeCalls.n).toBe(baseline);

    fixture.componentInstance.bytes.set(4096);
    await fixture.whenStable();
    expect(labels[0].text).toBe("4.0 KB");
    expect(fileSizeCalls.n).toBe(baseline + 1);
  });

  it("带参数的管道：截断长度由模板传参", async () => {
    @Component({
      selector: "t-p-trunc",
      imports: [TruncatePipe],
      schemas: [NO_ERRORS_SCHEMA],
      template: `<Label text="{{ title() | truncate:6 }}"></Label>`,
    })
    class TruncComp {
      readonly title = signal("a-very-long-title");
    }

    const fixture = await render(TruncComp);
    expect(findAllNodes(fixture.nativeElement, "Label")[0].text).toBe("a-very…");
  });

  it("管道产出结构体也能写入强类型属性（custom_minimum_size → Vector2）", async () => {
    @Component({
      selector: "t-p-vec",
      imports: [MinSizePipe],
      schemas: [NO_ERRORS_SCHEMA],
      template: `<Label text="sized" [custom_minimum_size]="w() | minSize"></Label>`,
    })
    class VecComp {
      readonly w = signal(100);
    }

    const fixture = await render(VecComp);
    const label = findAllNodes(fixture.nativeElement, "Label")[0];
    // 模板里的名字就是引擎侧的名字，读回来时也用同一个名字
    expect(label.custom_minimum_size.x).toBe(100);
    expect(label.custom_minimum_size.y).toBe(50);

    fixture.componentInstance.w.set(200);
    await fixture.whenStable();
    expect(label.custom_minimum_size.x).toBe(200);
  });
});

describe("内置管道", () => {
  beforeEach(() => initGodotTestEnvironment());

  it("Decimal / Percent / UpperCase / Json 都能直接喂给 Godot 属性", async () => {
    @Component({
      selector: "t-p-builtin",
      imports: [DecimalPipe, PercentPipe, UpperCasePipe, JsonPipe],
      schemas: [NO_ERRORS_SCHEMA],
      template: `<VBoxContainer>
        <Label text="{{ ratio() | number: '1.2-2' }}"></Label>
        <Label text="{{ ratio() | percent }}"></Label>
        <Label text="{{ tag() | uppercase }}"></Label>
        <Label text="{{ row() | json }}"></Label>
      </VBoxContainer>`,
    })
    class Builtin {
      readonly ratio = signal(0.25);
      readonly tag = signal("ready");
      readonly row = signal({ id: 1 });
    }

    const fixture = await render(Builtin);
    // JsonPipe 输出带换行缩进的 pretty print，此处只断言内容而不包括排版
    expect(nodeTexts(fixture.nativeElement)).toEqual(["0.25", "25%", "READY", '{\n  "id": 1\n}']);

    fixture.componentInstance.ratio.set(0.5);
    await fixture.whenStable();
    expect(nodeTexts(fixture.nativeElement).slice(0, 2)).toEqual(["0.50", "50%"]);
  });

  it("AsyncPipe 等 Promise：先占位，resolve 后写入节点（zoneless）", async () => {
    @Component({
      selector: "t-p-async",
      imports: [AsyncPipe],
      schemas: [NO_ERRORS_SCHEMA],
      template: `<Label text="{{ status() | async }}"></Label>`,
    })
    class AsyncComp {
      readonly status = signal(Promise.resolve("已连接"));
    }

    const fixture = await render(AsyncComp);
    await fixture.whenStable();
    expect(findAllNodes(fixture.nativeElement, "Label")[0].text).toBe("已连接");
  });
});
