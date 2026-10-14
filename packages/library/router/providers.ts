import { EnvironmentProviders, makeEnvironmentProviders } from "@angular/core";
import { provideRouter, RouterFeatures, Routes, TitleStrategy } from "@angular/router";
import { GODOT_LOCATION_PROVIDERS } from "godot-angular/core";
import { GodotTitleStrategy } from "./title-strategy";


export function provideGodotRouter(
  routes: Routes,
  ...features: RouterFeatures[]
): EnvironmentProviders {
  return makeEnvironmentProviders([
    provideRouter(routes, ...features),
    ...GODOT_LOCATION_PROVIDERS,
    // useExisting 而不是 useFactory：GodotTitleStrategy 自己是 @Injectable，DI 负者构造；
    // 这里只把 TitleStrategy 这个 token 指过去。注意 TitleStrategy 在 root 上的默认工厂是
    // `inject(DefaultTitleStrategy)`（写 document.title），环境注入器里这条会盖掉它。
    { provide: TitleStrategy, useExisting: GodotTitleStrategy },
  ]);
}
