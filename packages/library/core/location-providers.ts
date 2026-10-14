import { PlatformLocation, ViewportScroller, ɵNullViewportScroller } from "@angular/common";
import type { Provider } from "@angular/core";
import { GodotPlatformLocation } from "./location";


export const GODOT_LOCATION_PROVIDERS: Provider[] = [
  { provide: PlatformLocation, useClass: GodotPlatformLocation },
  { provide: ViewportScroller, useFactory: () => new ɵNullViewportScroller(), deps: [] },
];
