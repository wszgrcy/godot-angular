/**
 * GodotJS 运行时提供的全局对象最小声明。
 *
 * 故意不引入 "dom" lib：那会把 document / window / HTMLElement 全塞进来，
 * 于是"代码在裸 V8 里其实跑不了"这类错误被类型系统掩盖掉。
 * 这里只声明引擎真实存在的东西。
 */
declare var console: {
  log(...args: any[]): void;
  warn(...args: any[]): void;
  error(...args: any[]): void;
  info(...args: any[]): void;
  debug(...args: any[]): void;
};

declare function setTimeout(handler: (...args: any[]) => void, timeout?: number): number;
declare function clearTimeout(handle?: number): void;
declare function setInterval(handler: (...args: any[]) => void, timeout?: number): number;
declare function clearInterval(handle?: number): void;
