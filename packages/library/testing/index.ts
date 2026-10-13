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

export { captureWarn, expectWarned, type WarnCapture } from "./spy";
// 告警去重表的重置开关（定义在 core/warn，此处只是转发到测试入口）。
export { resetWarnOnce } from "godot-angular/core";
