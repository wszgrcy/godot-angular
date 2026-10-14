// 路由在 Godot 侧的装配点。`@angular/router` 本身一行不用改：它对平台的依赖全部收敛在
// PlatformLocation / ViewportScroller / TitleStrategy 三个 token 上，
// 这里换掉这四个，其余（Router、RouterOutlet、ActivatedRoute、UrlSerializer…）
// 原样从 `@angular/router` 引入即可。唯一例外是 RouterLink / RouterLinkActive：它们的
// host listener 要读 `$event.button`，而 Button.pressed() 零参数，因此不支持。
export { provideGodotRouter } from "./providers";
export { GodotTitleStrategy } from "./title-strategy";
// 平台位置从 core 转发一份：它属于“Godot 缺的那块平台实现”，但测试与不装路由的应用
// 也要能单独拿到，所以定义在 core/location.ts。
export {
  GODOT_HEADLESS,
  GODOT_INITIAL_URL,
  GODOT_LOCATION_PROVIDERS,
  GodotPlatformLocation,
} from "godot-angular/core";
