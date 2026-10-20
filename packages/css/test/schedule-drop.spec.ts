/**
 * 帧末调度被丢弃时的兜底（**node** 环境，vitest.node.config.mts）。
 *
 * 真机现象：主应用 → 混合场景 → 回主应用，回来那一趟整屏无样式（节点都在、文字都在，
 * 只是所有 CSS 落点没写上去），而且此后永远不恢复。
 *
 * 根因不在 rAF，而在 `Invalidator.flushScheduled`：它只在 `endFlush()` 里复位，而已
 * 排上的回调有两种消失方式 ——
 *   1. 排的时候帧钟停摆（上一个应用 destroy 之后、新应用 start 之前），rAF 直接拒收；
 *   2. 排上之后被 `stopFrameCallbacks()` 连队列一起丢掉。
 * 两种情况下 `flushScheduled` 都停在 true，此后每次 invalidate 都在
 * `if (this.flushScheduled) return` 处返回，帧钟恢复也不会再安排刷新。
 *
 * 对应的两处修改：
 *   - `scheduleAtFrameEnd` 返回 false（拒收）→ `Invalidator` 当场同步刷一次，不丢改动。
 *     这一处与跨应用无关：单个应用只要在自己的 start 之前排过队就会遇到。
 *   - 跨应用那条路径（已排上的回调被 stop 丢掉）由运行时归属解决：`GODOT_APP_PROVIDERS`
 *     为每个应用创建独立 `StyleRuntime`（配套的全局样式交接语义见 `global-css.spec.ts`），
 *     调度状态随应用一起销毁，不会留到下一个应用。下面第二条测试仍验证「回调被丢弃后
 *     `flush()` 能补写样式并复位标记」，因为绕过应用生命周期的 stop() 仍可能触发它。
 *
 * 引擎侧的完整链路（切场景来回切、首帧有样式）在模板工程里验证；本文件只钉纯逻辑。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { Cascade, type CssNode, type StyleBackend } from "godot-angular/css";

class FakeNode implements CssNode {
  parent: CssNode | null = null;
  cssType: string;
  cssClasses?: Set<string>;
  cssPseudoClasses?: Set<string>;
  children: FakeNode[] = [];

  constructor(cssType: string) {
    this.cssType = cssType;
  }
}

/** 每次真实写入记一条 `cssName=值`；被 diff 短路的写入不会进来 */
let writes: string[] = [];

const backend: StyleBackend = {
  classOf: (node) => (node as FakeNode).cssType,
  bulk: (_node, apply) => apply(),
  mutateStyleBox: () => {},
  setColorOverride: () => {},
  setFontSizeOverride: () => {},
  setConstantOverride: () => {},
  setFontOverride: () => true,
  setMinimumSize: () => {},
  setOpacity: () => {},
  setNodeNumber: () => {},
  getNodeNumber: () => 0,
  setNodeBoolean: () => {},
  hasNodeProperty: () => false,
  parentOf: (node) => (node as FakeNode).parent ?? null,
  childrenOf: (node) => (node as FakeNode).children,
  clearProperty: () => {},
  applyProperty: (_node, cssName, raw) => {
    writes.push(`${cssName}=${raw.trim()}`);
    return true;
  },
};

/** 模拟帧钟：`accept` 为 false 时等价于「停摆」，调度被拒收 */
let accept = true;
/** 已排上的 flush 回调；清空它等价于 `stopFrameCallbacks()` 丢队列 */
let queue: (() => void)[] = [];

let cascade: Cascade;

beforeEach(() => {
  accept = true;
  queue = [];
  writes = [];
  cascade = new Cascade({
    backend,
    schedule: (flush) => {
      if (!accept) return false;
      queue.push(flush);
      return true;
    },
  });
});

/** 放行所有已排上的调度 */
function pump(): void {
  const pending = queue;
  queue = [];
  for (const flush of pending) flush();
}

function makeLabel(classes: string[] = []): FakeNode {
  const node = new FakeNode("Label");
  cascade.attach(node);
  for (const name of classes) node.cssClasses!.add(name);
  return node;
}

describe("帧末调度被丢弃", () => {
  it("调度器拒收时当场同步刷：样式不丢，调度标记也不残留", () => {
    cascade.addCss(`Label { color: rgb(255, 0, 0); } .hi { color: rgb(0, 0, 255); }`);
    const node = makeLabel();
    pump();
    expect(writes).toContain("color=rgb(255, 0, 0)");

    writes = [];
    accept = false; // 帧钟停摆：schedule 返回 false
    node.cssClasses!.add("hi");

    // 没有帧钟可用，也必须把这次改动写下去（同步补刷）
    expect(writes).toContain("color=rgb(0, 0, 255)");
    expect(cascade.isDirty(node)).toBe(false);

    // 标记已复位：帧钟恢复后，下一次改动照常排上帧末
    accept = true;
    queue = [];
    node.cssClasses!.add("other");
    expect(queue.length).toBe(1);
  });

  it("回调排上后被丢弃：flush() 补写样式并重新放行调度", () => {
    cascade.addCss(`Label { color: rgb(0, 255, 0); }`);
    const node = makeLabel();

    queue = []; // 等价 stopFrameCallbacks()：回调永不执行
    writes = [];

    // flushScheduled 仍为 true → 再标脏也排不上调度，样式不会落地（真机上的「首帧无样式」）
    cascade.invalidateAll();
    expect(queue.length).toBe(0);
    expect(writes.length).toBe(0);
    expect(cascade.isDirty(node)).toBe(true);

    // 显式 flush()：补写样式，同时复位 flushScheduled
    cascade.flush();
    expect(writes).toContain("color=rgb(0, 255, 0)");
    expect(cascade.isDirty(node)).toBe(false);

    cascade.invalidateAll();
    expect(queue.length).toBe(1);
  });
});
