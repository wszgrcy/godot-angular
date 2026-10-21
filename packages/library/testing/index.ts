export {
  setEngineSceneRoot,
  getEngineSceneRoot,
  newNode,
  makeRenderer,
  childNodes,
  walkNodes,
  findAllNodes,
  nodeTexts,
  awaitFrames,
  pumpEngineFrames,
  type GodotClassName,
  type GodotInstance,
} from "./render";

// Angular 测试环境：TestBed 运行在真实引擎中，仅有这一套实现。
export { initGodotTestEnvironment, GodotTestingModule } from "./test-env";

export { captureWarn, expectWarned, expectWarnCode, expectNoWarn, type WarnCapture } from "./spy";
// 测试用的 injector 脚手架：给不在应用里的 StyleRuntime 驱动 effect，并同步把排队的 effect 跑完。
export {
  createStyleSchedulerInjector,
  flushStyleEffects,
  newStyleRuntime,
} from "./style-scheduler";
// 屏幕级操作：定位节点、注入鼠标键盘、读取实际渲染出的像素。
export {
  Screen,
  isHeaded,
  requireHeaded,
  provideGlobalCss,
  type Rgb,
} from "./screen";
// 告警去重表与运行期开关的重置（定义于 core/warn，此处仅转发至测试入口）。
export { resetWarnOnce, setWarnEnabled } from "godot-angular/core";
