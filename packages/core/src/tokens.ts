import { InjectionToken } from "@angular/core";

/** 承载 Angular 组件树的 Godot 根 Control（由入口提供） */
export const GODOT_ROOT = new InjectionToken<any>("@control-ui-js/core GODOT_ROOT");
