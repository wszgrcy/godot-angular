import type {
  CancelReason,
  RunnerTaskEventPack,
  RunnerTaskResultPack,
  RunnerTestCase,
  RunnerTestFile,
  SerializedConfig,
  VitestTestRunner,
} from "vitest";
import type { TestModuleRegistry } from "./registry";

interface GodotTestRunnerOptions {
  config: SerializedConfig;
  registry: TestModuleRegistry;
  /** 向宿主推送任务状态变化——vitest 的 reporter 完全依赖它 */
  onTaskUpdate(
    packs: RunnerTaskResultPack[],
    events: RunnerTaskEventPack[],
  ): void | Promise<void>;
  /** 少调用一次，宿主后续每条更新都是 "Entity must be found for task xxx" */
  onCollected?(files: RunnerTestFile[]): void | Promise<void>;
  onQueued?(file: RunnerTestFile): void | Promise<void>;
  onFileFinished?(filepath: string): void | Promise<void>;
}

/**
 * 运行在 GodotJS 中的 `VitestTestRunner`。
 *
 * 与 Node 版 runner 的唯一实质差别是 `importFile`：Node 经 vite 的 module runner
 * 从 dev server 拉取模块，引擎只能从**编译期就编入包内**的注册表中获取。
 */
export class GodotTestRunner implements VitestTestRunner {
  private readonly cancelled = new Set<string>();
  private readonly registeredFiles = new Set<string>();

  constructor(private readonly options: GodotTestRunnerOptions) {}

  get config(): SerializedConfig {
    return this.options.config;
  }

  async importFile(filepath: string): Promise<unknown> {
    const mod = await this.options.registry.load(filepath);
    // 打包器可能再包一层（{__run} / {default:{...}}），需要取出来。
    if (
      typeof mod === "object" &&
      mod !== null &&
      "__run" in mod &&
      typeof (mod as { __run: unknown }).__run === "function"
    ) {
      return (mod as { __run: () => unknown }).__run();
    }
    return mod;
  }

  onCollectStart(file: RunnerTestFile): void {
    this.registeredFiles.add(file.filepath);
    this.cancelled.delete(file.filepath);
    void this.options.onQueued?.(file);
  }

  /**
   * `@vitest/runner` 收集完一个文件后调用此处。Node worker 无需自行处理（vitest 的
   * resolveTestRunner 会包一层去调 rpc），本运行时自带 runner，因此需要自行补充。
   */
  async onCollected(files: RunnerTestFile[]): Promise<void> {
    await this.options.onCollected?.(files);
  }

  onBeforeRunFiles(files: RunnerTestFile[]): void {
    for (const file of files) {
      this.registeredFiles.add(file.filepath);
      this.cancelled.delete(file.filepath);
    }
  }

  async onAfterRunFiles(files: RunnerTestFile[]): Promise<void> {
    for (const file of files) {
      await this.options.onFileFinished?.(file.filepath);
    }
  }

  onBeforeRunTask(test: RunnerTestCase): void {
    if (this.cancelled.has(test.file.filepath)) test.mode = "skip";
  }

  onBeforeTryTask(test: RunnerTestCase): void {
    if (this.cancelled.has(test.file.filepath)) test.mode = "skip";
  }

  async onTaskUpdate(
    packs: RunnerTaskResultPack[],
    events: RunnerTaskEventPack[],
  ): Promise<void> {
    await this.options.onTaskUpdate(packs, events);
  }

  /**
   * 只能将「之后尚未运行的」标为 skip；已在执行的那一条依靠 @vitest/runner 自身的
   * 检查点退出。这是 VitestTestRunner 接口的能力上限，不是实现上的偷懒。
   */
  cancel(_reason: CancelReason): void {
    for (const filepath of this.registeredFiles) this.cancelled.add(filepath);
  }
}
