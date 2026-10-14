import { Injectable, inject } from "@angular/core";
import { TitleStrategy, type RouterStateSnapshot } from "@angular/router";
import { GODOT_HEADLESS } from "godot-angular/core";
import { DisplayServer } from "godot";


@Injectable({ providedIn: "root" })
export class GodotTitleStrategy extends TitleStrategy {
  currentTitle = "";
  private readonly headless = inject(GODOT_HEADLESS);

  override updateTitle(snapshot: RouterStateSnapshot): void {
    const title = this.buildTitle(snapshot);
    if (title === undefined) return;
    this.currentTitle = title;
    if (!this.headless) DisplayServer.window_set_title(title);
  }
}
