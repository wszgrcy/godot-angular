import type {
  LocationChangeEvent,
  LocationChangeListener,
  PlatformLocation,
} from "@angular/common";
import { Inject, Injectable, InjectionToken } from "@angular/core";

/**
 * 合成 origin。Godot 没有 URL，但 `PlatformLocation` 的 href / protocol / hostname 是抽象成员，
 * 必须有确定值。`HashLocationStrategy` 会读 `href`，因此它得长得像个 URL。
 *
 * host 用 `localhost`（渲染出来是 `godot://localhost/detail/7`）：它本来就是“本机、不走网络”
 * 的惯例写法，与 `hostname` getter 返回值一致。两个写不得的变体：
 *  - 纯 scheme `godot:` 不能当 base —— opaque path，`new URL(ref, "godot:")` 直接抛 TypeError。
 *  - `godot://detail/7`（两段斜杠后直接跟路由）会把 `detail` 解析成 host、pathname 变成 `/7`，
 *    而路由匹配读的就是 pathname，首段会被吃掉。
 */
const GODOT_ORIGIN = "godot://localhost";

/**
 * 应用的起始 URL。没有持久化：每次启动都从这里开始，默认根路径。
 * 需要深链启动（例如由宿主按命令行参数决定进哪个页面）时 provide 一个别的值。
 */
export const GODOT_INITIAL_URL = new InjectionToken<string>("godot-angular initial url", {
  factory: () => "/",
});

/** 拆开的三段，与浏览器的 `location` 一一对应。 */
interface UrlParts {
  pathname: string;
  search: string;
  hash: string;
}

interface HistoryEntry {
  url: UrlParts;
  state: unknown;
}

/**
 * 以 `base` 为基准解析 `raw`，得到新的三段。
 *
 * 解析整个交给 `whatwg-url-minimum`（URL 标准参考实现的零依赖版），这里只负责两件事：
 * 拼出基准 URL，以及把结果切成 Angular 要的三段。浏览器里 `history.pushState(url)`
 * 的 url 也是相对当前文档 URL 解析的，所以「基准 = 当前条目」这条规则与浏览器同构。
 *
 * `pathname || "/"`：合成 scheme 不是「特殊协议」，规范允许它的 path 为空（`godot://o`
 * 那种），但空 path 会让路由匹配不上；http(s) 下浏览器本来就是 `/`，这里补齐那一步。
 *
 * 解析不出来时（非法主机名之类）按 `URL` 的语义抛 TypeError —— 浏览器的 `pushState`
 * 同样抛 DOMException，不做吞掉的兜底。
 */
function resolveParts(base: UrlParts, raw: string): UrlParts {
  const url = new URL(raw ?? "", `${GODOT_ORIGIN}${base.pathname}${base.search}${base.hash}`);
  return { pathname: url.pathname || "/", search: url.search, hash: url.hash };
}

/** 起始 URL 相对 origin 根解析，与浏览器里文档 URL 所处的位置一致。 */
function splitParts(raw: string): UrlParts {
  return resolveParts({ pathname: "/", search: "", hash: "" }, raw);
}

/**
 * Godot 版 PlatformLocation —— 纯内存历史栈，让 `@angular/router` 原封不动地跑。
 *
 * 浏览器那份靠 window.history 与 PopStateEvent，GodotJS 两者都没有。历史栈语义对齐浏览器：
 * pushState 截断前向历史、back/forward 触发 popstate、越界导航静默。URL 不持久化，进程结束即消失。
 *
 * 本文件刻意只从 `@angular/common` 取类型：历史栈是纯逻辑，Node 侧可直接断言，
 * 不需要把 DI 接线（以及它牵连的 `ViewportScroller`）一起拖进来。
 */
@Injectable({ providedIn: 'root' })
export class GodotPlatformLocation implements PlatformLocation {
  private readonly entries: HistoryEntry[];
  private index = 0;
  private readonly popListeners = new Set<LocationChangeListener>();
  private readonly hashListeners = new Set<LocationChangeListener>();

  /**
   * `GODOT_INITIAL_URL` 自带 factory（默认 `/`），所以 DI 总会递一个值进来；这里的参数默认值
   * 只服务于不用 DI 的直接构造（Node 侧用例就是这么跑的）。
   */
  constructor(@Inject(GODOT_INITIAL_URL) initialUrl: string = "/") {
    this.entries = [{ url: splitParts(initialUrl), state: null }];
  }

  private get entry(): HistoryEntry {
    return this.entries[this.index];
  }

  /** 历史栈长度（含当前条目）。 */
  get length(): number {
    return this.entries.length;
  }

  /** 当前条目下标，`back()` 到尽头时为 0。 */
  get position(): number {
    return this.index;
  }

  getBaseHrefFromDOM(): string {
    // 没有 <base>，也没有可推导的 origin。必须是空串而不是 undefined：PathLocationStrategy
    // 的 `href ?? getBaseHrefFromDOM() ?? inject(DOCUMENT).location?.origin` 用 `??`，
    // 空串能断掉这条链；返回 undefined 会一路走到 inject(DOCUMENT)，而那个 token 我们不提供。
    return "";
  }

  getState(): unknown {
    return this.entry.state;
  }

  onPopState(fn: LocationChangeListener): VoidFunction {
    this.popListeners.add(fn);
    return () => {
      this.popListeners.delete(fn);
    };
  }

  onHashChange(fn: LocationChangeListener): VoidFunction {
    this.hashListeners.add(fn);
    return () => {
      this.hashListeners.delete(fn);
    };
  }

  get href(): string {
    return `${GODOT_ORIGIN}${this.pathname}${this.search}${this.hash}`;
  }
  get protocol(): string {
    return "godot:";
  }
  get hostname(): string {
    // 与 GODOT_ORIGIN 里的 host 保持一致。
    return "localhost";
  }
  get port(): string {
    return "";
  }
  get pathname(): string {
    return this.entry.url.pathname;
  }
  get search(): string {
    return this.entry.url.search;
  }
  get hash(): string {
    return this.entry.url.hash;
  }

  pushState(state: any, _title: string, url: string): void {
    const next = resolveParts(this.entry.url, url);
    // 浏览器语义：入栈即丢弃 forward 分支
    this.entries.length = this.index + 1;
    this.entries.push({ url: next, state });
    this.index = this.entries.length - 1;
  }

  replaceState(state: any, _title: string, url: string): void {
    this.entries[this.index] = { url: resolveParts(this.entry.url, url), state };
  }

  forward(): void {
    this.historyGo(1);
  }

  back(): void {
    this.historyGo(-1);
  }

  historyGo(relativePosition: number = 0): void {
    const target = Math.min(Math.max(this.index + relativePosition, 0), this.entries.length - 1);
    // 越界时 target 落回当前下标，于是既不移动也不发事件 —— 与浏览器一致
    if (target === this.index) return;
    this.index = target;
    const event: LocationChangeEvent = { type: "popstate", state: this.entry.state };
    // 快照：回调里退订不应影响本轮派发
    for (const fn of Array.from(this.popListeners)) fn(event);
  }
}
