import { describe, expect, it } from "vitest";
import { Time } from "godot";
import type { CssNode, StyleBackend } from "godot-angular/css";
import { applyCssProperty, Cascade, buildRuleSets } from "godot-angular/css";
import type { StyleBoxHandle } from "godot-angular/css";

function sheet(ruleCount: number): string {
  let css = "";
  for (let i = 0; i < ruleCount; i++) {
    css += `.c${i} { color: rgb(${i % 256}, 10, 20); font-size: ${10 + (i % 20)}px; }\n`;
    css += `.c${i}:hover { color: rgb(255, 0, 0); }\n`;
  }
  return css;
}

function ms(fn: () => void): number {
  // GodotJS 中没有 process.hrtime：使用引擎自身的微秒计时（与帧钟无关，不受 polyfill 影响）
  const t0 = Number(Time.get_ticks_usec());
  fn();
  return (Number(Time.get_ticks_usec()) - t0) / 1000;
}

/**
 * 取 N 次中的最小值——“最优耗时”的稳健估计。
 *
 * 只取 2 次不够：在约 3ms 量级的操作上，一次 GC 停顿或调度抖动就能将比值从 4 推到 10。
 * min-of-N 能承受偶发抖动：只要有一次运行干净就能取到那个值；代价是总耗时乘以 N。
 */
function bestOf(runs: number, fn: () => void): number {
  let best = Infinity;
  for (let i = 0; i < runs; i++) best = Math.min(best, ms(fn));
  return best;
}

/** 假后端：写入只计数，不接触任何引擎；但 CSS 名 → theme item 的映射使用真实的那套 */
function fakeBackend(): { backend: StyleBackend; writes: () => number } {
  let writes = 0;
  const box = {
    setBackground() {}, setTexture() {}, setCornerRadii() {}, setBorderWidths() {},
    setBorderColor() {}, setShadow() {}, setContentMargin() {},
  };
  const count = () => { writes++; };
  // applyProperty 必须接回真实的 applyCssProperty：返回 false 会将“解析 + 特异度 + 写入”
  // 整条路径短路掉，量出来的是空转，那个护栏就失去意义了
  const backend: StyleBackend = {
    classOf: () => "Label",
    bulk: <T>(_n: CssNode, fn: () => T): T => fn(),
    mutateStyleBox: (_n: CssNode, _item: string, fn: (b: StyleBoxHandle) => void) =>
      fn(box as unknown as StyleBoxHandle),
    setColorOverride: count,
    setFontSizeOverride: count,
    setConstantOverride: count,
    setFontOverride: () => true,
    setMinimumSize() {}, setOpacity() {},
    setNodeNumber() {}, getNodeNumber: () => 0, setNodeBoolean() {},
    hasNodeProperty: () => false,
    parentOf: (n: CssNode) => n.parent ?? null,
    childrenOf: () => [],
    clearProperty() {},
    applyProperty: (node, cssName, raw, warnings, states) =>
      applyCssProperty(node, cssName, raw, { backend, warn: () => {}, states }, warnings),
  };
  return { backend, writes: () => writes };
}

class FakeNode implements CssNode {
  [key: string]: unknown;
  parent: CssNode | null = null;
  cssType = "Label";
  cssClasses = new Set<string>();
  cssPseudoClasses = new Set<string>();
}

describe("性能护栏", () => {
  it("解析是线性的：规则 4 倍，耗时不许超 8 倍", () => {
    const small = sheet(250);
    const big = sheet(1000);
    // 各运行一次预热（JIT），再取多次最小值，避免首次编译影响比例
    buildRuleSets(small);
    buildRuleSets(big);
    const tSmall = bestOf(9, () => buildRuleSets(small));
    const tBig = bestOf(9, () => buildRuleSets(big));
    const ratio = tBig / Math.max(tSmall, 0.5);
    // 平方时 tSmall 会小到让比例失真，所以先要求绝对值在合理区间
    expect(tSmall, `解析绝对耗时异常（${tSmall.toFixed(2)}ms），先确认机器状态`).toBeLessThan(500);
    // 数字必须写进失败信息：只报“9.94 < 8”无法判断是哪个量偏了
    expect(
      ratio,
      `比值 ${ratio.toFixed(2)} 超线：small=${tSmall.toFixed(2)}ms big=${tBig.toFixed(2)}ms`,
    ).toBeLessThan(8);
  });

  it("5000 条规则解析在秒级以内（真实工程的样式表很容易到这个量级）", () => {
    const css = sheet(5000);
    expect(ms(() => buildRuleSets(css))).toBeLessThan(1000);
  });

  it("首帧写入后，空 flush 被 diff 全部短路", () => {
    const { backend, writes } = fakeBackend();
    const cascade = new Cascade({ backend, schedule: () => {} });
    cascade.addCss(sheet(200));
    for (let i = 0; i < 500; i++) {
      const node = new FakeNode();
      cascade.attach(node);
      node.cssClasses.add(`c${i % 200}`);
    }
    cascade.flush();
    const before = cascade.stats.flushes;
    const writesAfterFirst = writes();
    expect(writesAfterFirst, "首帧总得写点什么").toBeGreaterThan(0);
    // 没脏节点时 flush 直接返 0（连“逐节点比一遍”都省了），所以 flushes 不增
    const elapsed = ms(() => cascade.flush());
    expect(cascade.stats.flushes, "空 flush 不该重新走一遍写入").toBe(before);
    expect(writes(), "空 flush 一次写入都不该发出").toBe(writesAfterFirst);
    expect(elapsed).toBeLessThan(5);
  });

  it("单节点换 class 是亚毫秒级（这是最常见的交互）", () => {
    const { backend } = fakeBackend();
    const cascade = new Cascade({ backend, schedule: () => {} });
    cascade.addCss(sheet(200));
    const nodes: FakeNode[] = [];
    for (let i = 0; i < 1000; i++) {
      const node = new FakeNode();
      cascade.attach(node);
      node.cssClasses.add(`c${i % 200}`);
      nodes.push(node);
    }
    cascade.flush();
    const elapsed = ms(() => {
      nodes[0].cssClasses.add("c199");
      cascade.flush();
    });
    expect(elapsed).toBeLessThan(2);
  });
});
