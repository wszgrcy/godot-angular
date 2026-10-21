/// <reference types="vitest" />
// 非 Control 节点支持（Node3D / Timer）：模板建节点、属性绑定、信号事件。
// RxJS 桥本身另有 rx.spec.ts 专门覆盖，这里只用一次确认它能接非 Control 节点的信号。
import {
  AfterViewInit,
  Component,
  ElementRef,
  Type,
  provideZonelessChangeDetection,
  signal,
  viewChild,
} from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { CssCode } from "godot-angular/css";
import { Node, Timer, Vector3 } from "godot";
import { godotSignal$ } from "godot-angular/core";
import {
  captureWarn,
  expectWarnCode,
  findAllNodes,
  getEngineSceneRoot,
  initGodotTestEnvironment,
  makeRenderer,
  walkNodes,
  awaitFrames,
} from "godot-angular/testing";

@Component({
  selector: "app-3d",
  standalone: true,
  // one_shot / wait_time 不能用 [xxx] 绑定：Angular 拒绝以 on 开头的属性名（NG0306），只能在代码里写
  template: `
    <Node3D>
      <Camera3D [fov]="fov()"></Camera3D>
      <MeshInstance3D [position]="pos"></MeshInstance3D>
    </Node3D>
    <Timer #t (timeout)="onTimeout()"></Timer>
    <div><p>hits={{hits()}}</p></div>
  `,
})
class Scene3DComponent implements AfterViewInit {
  fov = signal(62.5);
  pos = new Vector3(1, 2, 3);
  hits = signal(0);
  timer = viewChild<ElementRef>("t");

  ngAfterViewInit(): void {
    const ref = this.timer();
    if (!ref) return;
    // viewChild 拿到的是 ElementRef，节点在 .nativeElement 里
    const t = ref.nativeElement as unknown as Timer;
    t.wait_time = 0.05;
    t.one_shot = true;
    t.start();
  }

  onTimeout(): void {
    this.hits.update((h) => h + 1);
  }
}

@Component({
  selector: "app-3d-inset",
  standalone: true,
  // 真实用法：Angular 根是 Control，3D 世界装在 SubViewport 里，由 SubViewportContainer 画到屏幕
  template: `
    <SubViewportContainer stretch="true">
      <SubViewport>
        <Camera3D></Camera3D>
        <DirectionalLight3D></DirectionalLight3D>
        <MeshInstance3D [position]="pos"></MeshInstance3D>
      </SubViewport>
    </SubViewportContainer>
  `,
})
class Inset3DComponent {
  pos = new Vector3(0, 1, 0);
}

async function render<T>(component: Type<T>) {
  await TestBed.configureTestingModule({
    imports: [component],
    providers: [provideZonelessChangeDetection()],
  }).compileComponents();
  const fixture = TestBed.createComponent(component);
  await fixture.whenStable();
  return fixture;
}

describe("非 Control 节点", () => {
  beforeEach(() => {
    initGodotTestEnvironment();
  });

  it("模板能建出 Node3D 子树并写入属性", async () => {
    const fixture = await render(Scene3DComponent);
    const classes = walkNodes(fixture.nativeElement).map((n) => n.get_class());
    expect(classes).toContain("Node3D");
    expect(classes).toContain("Camera3D");
    expect(classes).toContain("MeshInstance3D");
    expect(classes).toContain("Timer");

    const cam = findAllNodes(fixture.nativeElement, "Camera3D")[0] as unknown as { fov: number };
    expect(cam.fov).toBe(62.5);
    const mesh = findAllNodes(fixture.nativeElement, "MeshInstance3D")[0] as unknown as {
      position: Vector3;
    };
    expect([mesh.position.x, mesh.position.y, mesh.position.z]).toEqual([1, 2, 3]);
  });

  it("非 Control 节点的信号能接进模板事件", async () => {
    const fixture = await render(Scene3DComponent);
    expect(fixture.componentInstance.hits()).toBe(0);
    await awaitFrames(12);
    expect(fixture.componentInstance.hits()).toBe(1);
  });

  it("class / style 落在非 Control 节点上只告警，不崩", () => {
    const { renderer } = makeRenderer();
    const captured = captureWarn(() => {
      const node3d = renderer.createElement("Node3D");
      renderer.addClass(node3d, "box");
      renderer.setStyle(node3d as never, "color", "#ff0000");
      renderer.setAttribute(node3d, "class", "box");
    });
    expectWarnCode(captured.warn, CssCode.CssOnNonControl);
  });

  it("非 Control 节点上的 anchors_preset 只告警，不崩", () => {
    const { renderer } = makeRenderer();
    const captured = captureWarn(() => {
      const node3d = renderer.createElement("Node3D");
      renderer.setProperty(node3d, "anchors_preset", 1);
    });
    expectWarnCode(captured.warn, CssCode.CssOnNonControl);
  });

  it("SubViewport 套路：Angular 能建出可显示的 3D 子树", async () => {
    const fixture = await render(Inset3DComponent);
    const svc = findAllNodes(fixture.nativeElement, "SubViewportContainer")[0];
    const sv = findAllNodes(fixture.nativeElement, "SubViewport")[0];
    expect(svc).toBeTruthy();
    expect(sv).toBeTruthy();
    expect(findAllNodes(fixture.nativeElement, "Camera3D").length).toBe(1);
    expect(findAllNodes(fixture.nativeElement, "DirectionalLight3D").length).toBe(1);
    const box = findAllNodes(fixture.nativeElement, "MeshInstance3D")[0] as unknown as {
      position: Vector3;
    };
    expect([box.position.x, box.position.y, box.position.z]).toEqual([0, 1, 0]);
    // 子视口尺寸由容器布局决定，无头下拿不到真尺寸，只断言层级关系
    expect(sv.get_parent()!.get_class()).toBe("SubViewportContainer");
  });

  it("Godot 信号可以包成 RxJS 流", async () => {
    const root = new Node();
    root.set_name("ProbeRoot");
    getEngineSceneRoot()!.add_child(root);
    const timer = new Timer();
    timer.wait_time = 0.05;
    timer.one_shot = true;
    root.add_child(timer);

    const seen: unknown[][] = [];
    const sub = godotSignal$(timer, "timeout").subscribe((args) => seen.push(args));
    timer.start();
    await awaitFrames(12);
    expect(seen.length).toBe(1);
    sub.unsubscribe();
    root.free();
  });
});
