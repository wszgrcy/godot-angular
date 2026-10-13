/**
 * 端口策略：从配置的端口开始绑，**被占用就 +1 继续绑**，直到成功。
 *
 * 为什么非要自增：固定端口一旦撞上别的进程（编辑器的端口转发就常干这事），整轮测试直接起不来，
 * 而换一个端口本来就是个纯机械动作。
 *
 * 只有 `GodotVitestSession` 一处使用它：监听先于构建开起来，端口在绑定的那一刻定下来，
 * 构建与引擎启动读的都是同一个值，因此这里不需要独立的“探测”函数——先探测再重绑反而多一套口径。
 *
 * 18781 避开手写 runner 使用的 18780。
 */
export const DEFAULT_ENGINE_PORT = 18781;

/** 起始端口被占时最多向后试几个（连续占用 20 个基本等于环境有问题，此时报错比继续试有用） */
export const PORT_RETRIES = 20;

/** 起始端口：未配置取默认值；配置了就照用（它现在是“起始”含义，不再是“必须”） */
export function startPort(port: number | undefined): number {
  return port && port > 0 ? port : DEFAULT_ENGINE_PORT;
}
