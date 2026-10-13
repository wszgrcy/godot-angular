/// <reference types="vitest" />
import { Component, provideZonelessChangeDetection, signal } from "@angular/core";
import { ComponentFixtureAutoDetect, TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { initGodotTestEnvironment } from "godot-angular/testing";

@Component({
  selector: "t-hello",
  standalone: true,
  template: `<Label [text]="name()"></Label>`,
})
class HelloComponent {
  readonly name = signal("Hello Godot");
}

describe("hello world", () => {
  beforeEach(() => initGodotTestEnvironment());

  it("Label 上就是组件给的那句文本", async () => {
    await TestBed.configureTestingModule({
      imports: [HelloComponent],
      providers: [
        { provide: ComponentFixtureAutoDetect, useValue: true },
        provideZonelessChangeDetection(),
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(HelloComponent);
    await fixture.whenStable();

    const label = fixture.nativeElement.get_child(0);
    expect(label.get_class()).toBe("Label");
    expect(label.text).toBe("Hello Godot");
  });
});
