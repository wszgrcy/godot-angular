// 脚本类 fixture：产物名 = 本文件相对工程根的路径（引擎靠它反推 .ts 源码）。
//
// 生命周期计数用字段初始化，不写 constructor —— 官方文档明确不建议脚本类自定义
// constructor（GodotJS 会为 CDO、跨绑定等特殊用途构造类）。
import { Node } from "godot";

export default class ScriptClassProbeTs extends Node {
  readyCalls = 0;
  processCalls = 0;

  override _ready(): void {
    this.readyCalls++;
  }

  override _process(_delta: number): void {
    this.processCalls++;
  }

  /** 验子类自有方法在实例上真的可用，不是只有引擎回调能跑 */
  twice(x: number): number {
    return x * 2;
  }
}
