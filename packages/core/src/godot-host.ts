/**
 * Godot 运行时接入点。
 *
 * 为什么不由 core 自己 `import ... from "godot"`：GodotJS 运行时是 CommonJS，
 * `godot` 是引擎注入的模块，且类是惰性暴露的；打包器对 external 命名空间做
 * interop 包装会破坏惰性取值。所以由入口把 `require("godot")` 交进来：
 *
 *      setGodotHost(require("godot"))
 *
 * 附带好处：测试可以注入 mock，不需要启动引擎。
 */

export interface GodotHost {
  /** 原始 godot 模块，按类名取构造函数 */
  readonly ns: Record<string, any>;
  readonly ClassDB: any;
  readonly Vector2: any;
  readonly Color: any;
  readonly Callable: any;
}

let current: GodotHost | null = null;

export function setGodotHost(raw: Record<string, any>): GodotHost {
  current = {
    ns: raw,
    ClassDB: raw.ClassDB,
    Vector2: raw.Vector2,
    Color: raw.Color,
    Callable: raw.Callable,
  };
  return current;
}

export function getGodotHost(): GodotHost {
  if (!current) throw new Error('先执行 setGodotHost(require("godot"))');
  return current;
}

/** 按类名取构造函数；不存在返回 undefined */
export function godotClass(className: string): (new (...args: any[]) => any) | undefined {
  const ctor = getGodotHost().ns[className];
  return typeof ctor === "function" ? ctor : undefined;
}
