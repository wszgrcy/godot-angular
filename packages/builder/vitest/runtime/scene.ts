import { Node, OS } from "godot";
import { startupGodotVitest, type GodotVitestSession } from "./index";

/**
 * 引擎测试的场景类（`engine_vitest.tscn` 挂载的那个 Node）。与项目无关，因此定义在库中，
 * 由 builder 生成的虚拟入口 default 导出，使用方无需编写任何代码。
 *
 * 此处必须自行 `import godot from "godot"`：`__toESM` 是否读取 `mod.__esModule` 取决于
 * 导入方所在包的 `type`，虚拟入口没有可解析的 package.json，读取该属性会被引擎的
 * Proxy 当场抛 `godot class not found '__esModule'`。
 */
export interface GodotVitestSceneDeps {
  /** spec 清单（虚拟模块提供） */
  modules: Record<string, () => Promise<unknown>>;
  /** 宿主未通过环境变量指定端口时的缺省值 */
  defaultPort: number;
}

/** 读取环境变量（宿主将端口传入的通道），获取失败则返回空串 */
function readEnv(name: string): string {
  try {
    return String(OS.get_environment(name) ?? "");
  } catch {
    return "";
  }
}

export function createGodotVitestScene(deps: GodotVitestSceneDeps): new () => unknown {
  const resolvePort = (): number => {
    const fromEnv = Number(readEnv("CUJ_WS_PORT"));
    return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : deps.defaultPort;
  };

  return class EngineVitest extends Node {
    private session: GodotVitestSession | null = null;

    _ready(): void {
      try {
        this.session = startupGodotVitest({
          port: resolvePort(),
          modules: deps.modules,
          sceneRoot: this,
        });
      } catch (e) {
        console.log(`[EVITEST] BOOT FAIL: ${String(e).replace(/\n/g, " ").slice(0, 400)}`);
        this.get_tree().quit(2);
      }
    }

    _process(): void {
      if (!this.session) return;
      try {
        this.session.tick();
      } catch (e) {
        console.log(`[EVITEST] TICK FAIL: ${String(e).slice(0, 300)}`);
        this.get_tree().quit(2);
        return;
      }
      if (this.session.finished) this.get_tree().quit(this.session.exitCode);
    }
  };
}
