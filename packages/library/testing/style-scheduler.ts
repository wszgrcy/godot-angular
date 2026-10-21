import {
  EnvironmentInjector,
  Injector,
  ɵEffectScheduler,
  ɵINJECTOR_SCOPE,
  provideZonelessChangeDetection,
} from "@angular/core";
import { StyleRuntime, type StyleRuntimeOptions } from "godot-angular/core";

/**
 * 测试用的 injector 脚手架。生产路径不需要这两个函数：应用自带 EnvironmentInjector，
 * 变更检测会执行 effect。这里的东西只在测试用例里单独实例化。
 */

/**
 * 建一个独立使用的根 injector，给不在 Angular 应用里的 `StyleRuntime` 驱动 effect。
 *
 * 三项 provider 缺一不可（实测）：
 *
 *  - `ɵINJECTOR_SCOPE: "root"`：否则 `Injector.create` 建出的是普通 injector，`effect()`
 *    无法在其上建立生命周期。
 *  - `provideZonelessChangeDetection()`：提供 `ChangeDetectionScheduler` 与 `ɵEffectScheduler`。
 *  - `EnvironmentInjector` 自引用：zoneless 的调度器实现会反查 `EnvironmentInjector`，取不到时
 *    报 NG0201。`useFactory` 是延迟求值的，因此可以引用尚未完成赋值的 `self`；但必须写在
 *    同一个 providers 数组里——`Injector.create` 之后再往数组追加已经无效。
 *
 * 每次调用返回新实例：injector 决定 effect 何时销毁，一个被测运行时一份，互不干扰。
 */
export function createStyleSchedulerInjector(): Injector {
  // 自引用：useFactory 延迟求值，因此引用稍后才赋值的 self 是安全的
  let self: Injector | null = null;
  // provideZonelessChangeDetection() 返回 EnvironmentProviders：Injector.create 运行时接受它，
  // 但入参类型里没标出来，因此在这里做一次转换
  const providers = [
    { provide: ɵINJECTOR_SCOPE, useValue: "root" },
    provideZonelessChangeDetection(),
    { provide: EnvironmentInjector, useFactory: () => self as Injector },
  ] as unknown as Parameters<typeof Injector.create>[0]["providers"];
  self = Injector.create({ providers });
  return self;
}

/**
 * 同步执行 `injector` 上已排队的 effect。
 *
 * 用例用它把刷新时机变成确定的：不等微任务、不等帧，调用完就能断言节点上的结果。
 */
export function flushStyleEffects(injector: Injector): void {
  injector.get(ɵEffectScheduler).flush();
}

/**
 * 建一个带自动刷新时机的测试运行时：内部传入一个独立 injector，走的是生产路径同一条
 * effect 调度链路。
 *
 * 需要它的原因：`new StyleRuntime()` 不传 injector 时不安排自动刷新（core 不自己造 injector，
 * 那是测试脚手架），而很多用例验的就是“改完 class 不用手动 flush 也能看到新值”。
 */
export function newStyleRuntime(options: StyleRuntimeOptions = {}): StyleRuntime {
  return new StyleRuntime({ injector: createStyleSchedulerInjector(), ...options });
}
