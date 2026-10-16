import { Injectable, inject } from "@angular/core";
import { TitleStrategy, type RouterStateSnapshot } from "@angular/router";
import { GODOT_HEADLESS, GODOT_ROOT } from "godot-angular/core";
import { DisplayServer } from "godot";


@Injectable({ providedIn: "root" })
export class GodotTitleStrategy extends TitleStrategy {
  currentTitle = "";

  private readonly headless = inject(GODOT_HEADLESS) 
  private readonly root = inject(GODOT_ROOT);

  override updateTitle(snapshot: RouterStateSnapshot): void {
    const title = this.buildTitle(snapshot);
    if (title === undefined) return;
    this.currentTitle = title;
    if (this.headless) return;

    const window = this.root.get_window?.() ?? null;
    if (window) window.title = title;
    else DisplayServer.window_set_title(title);
  }
}
