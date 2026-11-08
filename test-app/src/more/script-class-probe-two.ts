// 第二个脚本类 fixture，放在与 script-class-probe.ts 不同的目录，用来验
// `entries` 的 `input` 能写多个位置，而产物名仍按相对工程根计算。
import { Node } from "godot";

export default class ScriptClassProbeTwo extends Node {
  processCalls = 0;

  override _process(_delta: number): void {
    this.processCalls++;
  }

  plusOne(x: number): number {
    return x + 1;
  }
}
