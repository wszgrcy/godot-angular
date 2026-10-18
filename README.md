# godot-angular

在 Godot 中运行 Angular。组件模板被渲染为 Godot 的 `Control` 节点树，不依赖 WebView，也不需要编写 GDScript 界面代码。

- 运行时为 [GodotJS](https://github.com/GodotJS/GodotJS)（将 V8 集成进引擎的 C++ 模块）
- Angular 使用 AOT 编译与 zoneless 变更检测
- 构建由 `godot-angular:application` builder 完成，支持多入口与共享分包

```
Angular 模板（一个或多个入口）
   │  ng build → godot-angular:application
   ▼
dist/main.js + dist/chunks/*.js        CommonJS，多入口共享 chunk
   │  require() 载入 GodotJS 的 V8
   ▼
GodotRenderer（Renderer2 实现）
   ▼
Label / Button / VBoxContainer …       真实 Godot 节点
```

本文档面向已具备 Godot 与 Angular 基础的开发者，仅说明两者的接口、配置方式与限制。

## 目录

- [快速开始](#快速开始)
- [环境要求](#环境要求)
- [模板语法](#模板语法)
- [状态与变更检测](#状态与变更检测)
- [表单](#表单)
- [样式](#样式)
- [路由](#路由)
- [多入口与多场景](#多入口与多场景)
- [单元测试](#单元测试)
- [构建选项](#构建选项)
- [导入路径](#导入路径)
- [限制](#限制)
- [常见问题](#常见问题)
- [相关文档](#相关文档)

---

## 快速开始

一个工程同时是 Godot 工程与 Angular 工作区，两者位于同一目录。

### 1. 准备工程

新建目录，放入下列文件（`dist/` 由构建产出，不是手写）：

```
my-app/
├── project.godot        # run/main_scene = res://main.tscn
├── main.tscn            # 根节点脚本 = res://dist/main.js
├── angular.json         # godot-angular:application 的 target
├── tsconfig.json        # typeRoots 指向生成的 typings 目录
├── package.json         # 依赖 godot-angular 与 Angular
└── src/
    ├── main.ts          # 入口：_ready() 里 bootstrapGodotApp(App, root)，_process() 里 tick()
    └── app.ts           # 根组件
```

`project.godot` 与 `main.tscn`（场景根节点的脚本直接指向构建产物）：

```ini
; Engine configuration file.
config_version=5

[application]

config/name="my-app"
run/main_scene="res://main.tscn"
config/features=PackedStringArray("4.6")
```

```ini
[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://dist/main.js" id="1_root"]

[node name="Main" type="Node"]
script = ExtResource("1_root")
```

`angular.json`（`builder` 的完整选项见[构建选项](#构建选项)）：

```jsonc
{
  "version": 1,
  "projects": {
    "app": {
      "projectType": "application",
      "root": "src",
      "sourceRoot": "src",
      "architect": {
        "build": {
          "builder": "godot-angular:application",
          "options": {
            "entries": ["src/main.ts"],
            "tsConfig": "tsconfig.json",
            "outputPath": "dist",
            "resRoot": "res://dist",
            "optimization": false,
            "sourceMap": false
          }
        }
      }
    }
  }
}
```

入口把 Angular 挂到一个 `Control` 上，并每帧驱动变更检测：

```ts
// src/main.ts
import { Control, Node, Vector2 } from "godot";
import { bootstrapGodotApp, GodotAngularApp } from "godot-angular/core";
import { App } from "./app";

export default class Main extends Node {
  private app: GodotAngularApp | null = null;

  _ready(): void {
    const root = new Control();
    root.name = "AngularRoot";
    root.size = new Vector2(1024, 768); // 需要跟随窗口时改用 set_anchors_and_offsets_preset(FULL_RECT)
    this.add_child(root);
    bootstrapGodotApp(App, root).then((app) => (this.app = app));
  }

  _process(delta: number): void {
    this.app?.tick(delta * 1000); // zoneless 变更检测由这一帧驱动，不调用则界面不更新
  }
}
```

在该目录安装依赖：

```bash
npm install godot-angular
```

该命令同时安装 `package.json` 中声明的其余依赖（Angular、rxjs、tslib 等）。

### 2. 安装引擎

必须使用 [GodotJS](https://github.com/godotjs/GodotJS/releases) 提供的引擎构建，官方 Godot 无法加载 `.js` 脚本。下载对应平台的**编辑器构建**，解压后放入工程目录下的 `bin/`，目录名与文件名需与下列一致，工具会自动按平台定位，无需配置环境变量：

```
bin/
├── linux-editor-4.6.1-v8/godot.linuxbsd.editor.x86_64
└── windows-editor-4.6.1-v8/godot.windows.editor.x86_64.exe
```

Linux 下需要授予执行权限。也可以将引擎放在任意位置，通过环境变量指定：

```bash
export GODOT_BIN=/path/to/engine          # Linux / macOS
$env:GODOT_BIN = "C:\path\to\engine.exe"  # Windows PowerShell
```

`GODOT_BIN` 可以指向可执行文件，也可以指向按上述布局组织的目录。

### 3. 生成引擎类型声明

```bash
npx godot-typings --out typings
```

该命令由 `godot-angular` 提供，输出目录需为专用目录。已配置 `GODOT_BIN` 或 `bin/` 时无需额外参数，否则通过 `--bin <路径>` 指定引擎。

### 4. 构建并运行

```bash
npm run build      # = ng build app，产出 dist/main.js
godot --path .     # 或使用 Godot 编辑器打开该目录并按 F5
```

`project.godot` 的主场景为 `res://main.tscn`，该场景引用 `res://dist/main.js`。

修改 `dist/*.js` 后引擎无输出时，说明脚本资源缓存未刷新，请重启引擎或执行：

```bash
godot --headless --path . --import
```

## 环境要求

| 项 | 要求 |
| --- | --- |
| 引擎 | GodotJS 构建的 Godot，版本 4.6.1，需编辑器构建 |
| Node.js | `^22.22.3 \|\| ^24.15.0 \|\| >=26.0.0` |
| Angular | `^22.0.0` |
| 平台 | Linux x86_64、Windows x64 |

官方 Godot 同样自称 “Godot Engine”，`--version` 无法区分。判断依据：使用官方构建运行时会报 `No loader found for resource: res://dist/main.js (expected type: Script)`。

## 模板语法

### 标签

标签解析规则如下：

1. 命中 HTML 别名表时以表为准（区分大小写，仅接受小写名）：

   | 标签 | Godot 类 |
   | --- | --- |
   | `div` `section` `main` `form` `ul` `ol` | `VBoxContainer` |
   | `header` `footer` `nav` `li` | `HBoxContainer` |
   | `p` `span` `label` `h1`–`h4` | `Label` |
   | `hr` | `Separator` |
   | `button` | `Button` |
   | `input` | `LineEdit` |
   | `textarea` | `TextEdit` |
   | `select` | `OptionButton` |
   | `progress` | `ProgressBar` |
   | `img` | `TextureRect` |
   | `a` | `LinkButton` |
   | `table` | `GridContainer` |

2. 未命中别名表时按原样作为类名处理：`<Label>` 创建 `Label`。类名区分大小写。

无法得到可用 `Control` 时降级为 `VBoxContainer`；标签名以大写字母开头时额外输出告警。判定基于 `ClassDB`，引擎新增控件无需额外配置。

自定义组件的选择器建议使用小写且不与 Godot 类名冲突的形式（如 `ui-card`），其宿主元素降级为 `VBoxContainer`。

插值表达式 `{{ value }}` 生成 `Label` 节点。富文本与图文混排请直接使用 `RichTextLabel`。文字一律按 `<Label text="…" />` 写：单独插值只是兜底，不是 CSS 的书写面（它不占样式语义，兄弟组合器也不为它做特例）。

### 属性

Godot 的 `@export` 变量对应 Angular 的属性绑定，例如 `[text]`、`[custom_minimum_size]`、`[size_flags]`。

- `size_flags` 同时写入 `size_flags_horizontal` 与 `size_flags_vertical`。取值来自引擎枚举，枚举必须通过嵌套形式访问：`Control.SizeFlags.SIZE_EXPAND_FILL`。扁平写法（`Control.SIZE_EXPAND_FILL`）为 `undefined`。
- `[anchors_preset]` 可用，渲染器将其转换为 `set_anchors_preset()` 调用。
- `name` 写入的是引擎中的真实节点名。该 JS 绑定未为 `Node.name` 生成属性访问器，通用赋值只会写入一个 JS 字段而引擎侧不变（`find_child` / `get_node` 查不到），因此渲染器为其单独调用 `set_name()`。引擎语义不变：同级重名会被自动改名（自动名形如 `@Button@4`），`. : @ / " %` 会被替换为下划线（`name="a.b"` → `a_b`）。读取节点名使用 `get_name()`，JS 上的 `.name` 不是事实来源。`[attr.name]="null"` 不会清空名字：引擎不接受空名（树内 `set_name("")` 被忽略），而 ClassDB 的默认值是 `null`，“回到未命名”在引擎中没有对应操作，因此只能保持现值，改名需重新绑定新值。
- 移除属性：`[attr.x]="null"` 或 `[x]="null"` 将属性还原为该类创建时的默认值。Godot 属性为强类型，不接受 `null`。

自定义组件的宿主元素同时是模板中的一个元素，静态属性与输入属性是两条独立通道。静态字符串属性按节点属性写入宿主，宿主为 `VBoxContainer` 时不存在 `title`，因此输出一条「不是真实属性」告警；输入通道仍会送达该值，显示不受影响。为组件输入传字符串字面量时应写成属性绑定：

```html
<ui-card [title]="'文本'"></ui-card>
```

布局由容器与 `size_flags` 决定，CSS 不参与节点树结构调整：

```ts
readonly expand = Control.SizeFlags.SIZE_EXPAND_FILL;
```

```html
<VBoxContainer [size_flags]="expand">
  <HBoxContainer>
    <Label text="名字"></Label>
    <LineEdit [size_flags]="expand"></LineEdit>
  </HBoxContainer>
  <GridContainer [columns]="2"></GridContainer>
</VBoxContainer>
```

### 事件

Godot signal 与 Angular signal 是两套互不相关的机制。本文档中 Angular signal 指响应式状态。

事件名解析有两条路径：DOM 习惯名查别名表；其余名称原样作为 Godot 信号名查询。事件名不进行大小写转换，`(buttonDown)`、`(textChanged)` 等驼峰写法无法解析。

| 写法 | 连接的 Godot 信号（按顺序取该控件拥有的第一个） |
| --- | --- |
| `(click)` | `pressed` → `button_up` → `item_selected` → `text_selected` |
| `(change)` | `text_changed` → `value_changed` → `item_selected` → `toggled` |
| `(input)` | `text_changed` → `text_submitted` → `gui_input` |
| `(submit)` | `text_submitted` → `activated` |
| `(focus)` / `(blur)` | `focus_entered` / `focus_exited` |
| `(button_down)` | `button_down`（引擎信号名，原样命中） |

`$event` 的规则只有一条：**实参个数永远与引擎信号一致**，不做任何补偿。`LineEdit.text_changed(new_text)` 的 `$event` 就是新文本，无需回读属性；`BaseButton.pressed()` 零参数，所以 `(click)` / `(pressed)` 的 `$event` 就是 `undefined`。

Godot 信号不携带事件对象（对比 DOM：每个监听器都收到一个 `MouseEvent`）。但“谁触发的”仍然知道 —— `Callable` 绑在具体节点上，模板里每个元素有自己的闭包。需要真实输入事件（坐标 /双击 / 修饰键）时绑 `Control.gui_input(event: InputEvent)`，那个信号递的是真的 `InputEvent`；只是 `pressed` 把它丢掉了。

代价是依赖 `$event.xxx` 的第三方指令无法使用，目前已知仅 `RouterLink`（见[路由](#路由)）。曾为其补过一个事件对象，但那是以全局语义换取单一功能，已推翻。

无法解析的事件名被静默忽略。Angular 会为每个 `(...)` 绑定调用 `renderer.listen()`，指令的 `@Output` 名称（`ngModelChange`、`textChange`）同样经过该路径，其行为与浏览器中 `addEventListener("ngModelChange")` 不触发、不报错一致。



### 组件查询

`viewChild()`、`viewChildren()`、`contentChild()`、`contentChildren()` 均可用，返回 `ElementRef`，其 `nativeElement` 为对应的 Godot 节点：

```ts
readonly ok = viewChild.required<ElementRef>("ok");
// this.ok().nativeElement 为 Button 节点
```

### 布局

以下行为由引擎的布局规则决定，写错时不报错也不告警，只表现为界面绘制异常。

**只有 `Container` 会为子节点分配尺寸。** `Button`、`Panel`、`Label` 均不是 `Container`：挂在其下的子节点停留在自身最小尺寸，也不计入父节点的最小尺寸。含内容的按钮不能写成 `<Button><VBoxContainer>…</VBoxContainer></Button>`——`VBoxContainer` 拿不到宽度，内部 `Label` 会被压成一列竖排文字。可用的写法是 `PanelContainer`（属于 `Container`，把矩形分配给每一个子节点）叠加一层 flat `Button` 作为点击层：

```html
<PanelContainer class="card-btn">
  <VBoxContainer><!-- 内容，尺寸由 PanelContainer 分配 --></VBoxContainer>
  <Button [flat]="true" (pressed)="go()"></Button>
</PanelContainer>
```

**`white-space` 在两个方向上都会改变最小宽度。** 它映射到 `autowrap_mode`：

- 不折行时，`Label` 的最小宽度等于整行文本宽度。中文不含空格，整条容器链会被顶宽。
- 折行时，`Label` 的最小宽度退化为 1px。在 `HBoxContainer` 中未设置 `SIZE_EXPAND_FILL` 的 `Label` 会被压成一列竖排文字。

因此不要全局统一设置，按容器区分：纵向容器内默认折行，横向容器内默认不折行，横向容器内确需折行时单独声明。类选择器的特异度高于类型选择器，`.wrap` 可覆盖 `HBoxContainer > Label`：

```scss
Label { white-space: normal; }
HBoxContainer > Label { white-space: nowrap; }
.wrap { white-space: normal; }
```

装饰用的色块使用 `Panel` 而不是空 `Label`：空 `Label` 仍占一行文字高度，`Panel` 的最小尺寸仅来自 `width` / `min-height`，配合 `size_flags_horizontal = SHRINK_BEGIN` 可保持在指定的小尺寸上。

## 状态与变更检测

本项目仅支持 zoneless 变更检测。`tick()` 每帧执行，但只刷新被标记为脏的视图；普通字段赋值不会标记视图，模板读取不到新值。

```ts
// 不支持：模板读取不到变化
count = 0;

// 正确
count = signal(0);
```

组件内所有被模板读取的状态必须为 signal，包括 `@for` 的数据源与 `@if` 的条件。

```ts
@Component({
  selector: "app-root",
  template: `
    <VBoxContainer>
      <Label [text]="'count = ' + count()"></Label>
      <Button text="+1" (click)="count.set(count() + 1)"></Button>
      <LineEdit (input)="onInput($event)"></LineEdit>
    </VBoxContainer>
  `,
})
export class App {
  readonly count = signal(0);
}
```

状态全部由 signal 驱动时不需要 `ChangeDetectorRef`。若必须调用 `markForCheck()` 才能更新界面，说明该状态应改为 signal，或由某个 signal 派生（`computed`、`linkedSignal`）。本项目不提供强制触发变更检测的接口。

需要立即读取更新结果时，等待一帧后再读取。

## 表单

表单通过 Angular Forms 的 `ControlValueAccessor` 协议接入。内置指令由 `godot-angular/forms` 提供，该入口独立于 `core`，不使用表单时不会被计入产物。

```ts
import { FormsModule } from "@angular/forms";
import { GodotLineEditValueAccessor } from "godot-angular/forms";

@Component({ imports: [FormsModule, GodotLineEditValueAccessor], /* … */ })
export class Login {
  readonly name = signal("");
}
```

```html
<LineEdit [ngModel]="name()" (ngModelChange)="name.set($event)"
          [ngModelOptions]="{standalone: true}"></LineEdit>
```

| 指令 | 匹配标签 | 值属性 | 变更信号 | 禁用属性 | 空值写入 |
| --- | --- | --- | --- | --- | --- |
| `GodotLineEditValueAccessor` | `LineEdit` | `text` | `text_changed` | `editable` | `""` |
| `GodotTextEditValueAccessor` | `TextEdit` | `text` | `text_changed` | `editable` | `""` |
| `GodotSliderValueAccessor` | `HSlider` `VSlider` | `value` | `value_changed` | `editable` | `0` |
| `GodotSpinBoxValueAccessor` | `SpinBox` | `value` | `value_changed` | `editable` | `0` |
| `GodotScrollBarValueAccessor` | `HScrollBar` `VScrollBar` | `value` | `value_changed` | `mouse_filter` | `0` |
| `GodotToggleValueAccessor` | `CheckBox` `CheckButton` | `button_pressed` | `toggled` | `disabled` | `false` |
| `GodotOptionButtonValueAccessor` | `OptionButton` | `selected`（下标） | `item_selected` | `disabled` | `-1` |
| `GodotItemListValueAccessor` | `ItemList` | 选中项下标集合 `number[]` | `item_selected` + `multi_selected` | `mouse_filter` | `[]` |
| `GodotColorPickerValueAccessor` | `ColorPicker` | `color` | `color_changed` | `mouse_filter` | 不写入 |

全部指令可通过 `GODOT_FORM_DIRECTIVES` 一次性导入。

注意事项：

- 未包裹在 `<form>` 中的 `ngModel` 必须声明 `[ngModelOptions]="{standalone: true}"`。缺少该声明时在 Promise 中抛出错误，运行环境不处理未捕获的 Promise 拒绝，表现为无提示的失败。
- `writeValue(null)` 在表单初始化时必然被调用。Godot 的 `text` 等属性不接受 `null`，会中断后续赋值。上表列出了各指令对空值的处理，自定义 `ControlValueAccessor` 必须同样处理。
- 适配器只负责搬运值，不进行类型转换、范围限制与去重。类型不符由引擎报错；越界下标由 Godot 按自身规则处理。数据校验应在模型侧完成。
- `ItemList` 的候选项通过 `add_item` 添加，`ngModel` 仅表达选中下标集合。
- `HScrollBar`、`VScrollBar`、`ItemList`、`ColorPicker` 没有 `disabled` 与 `editable` 属性，禁用通过 `mouse_filter = IGNORE` 实现，解除禁用时恢复原值。

自定义复合控件继承 `GodotControlBase`，并在自身的 `providers` 中注册：

```ts
@Component({
  selector: "app-stepper",
  providers: [{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => AppStepper), multi: true }],
  template: `<HBoxContainer>
    <Button text="-" (pressed)="step(-1)"></Button>
    <Label text="v={{ value$() }}"></Label>
    <Button text="+" (pressed)="step(1)"></Button>
  </HBoxContainer>`,
})
export class AppStepper extends GodotControlBase<number> {
  step(delta: number) { this.valueAndTouchedChange(this.value$() + delta); }
}
```

`registerOnChange`、`registerOnTouched`、`setDisabledState` 由基类实现。值存储在 Godot 属性上时覆写 `writeValue`，并先调用 `super.writeValue(value)`。

## 样式

Godot 不提供 CSS 级联。本包将 CSS 的一个明确子集翻译为 Godot 的主题项（`Theme`）、盒子（`StyleBoxFlat`）与节点属性。下文将每条 CSS 属性最终写入的 Godot 对象统一称为**落点**。按支持程度分为三类：

- **等价**：Godot 存在对应实现，效果与 CSS 一致。
- **近似**：可以书写，但 Godot 的模型与 CSS 不同，结果为近似值（差异见各条说明）。
- **不支持**：Godot 无对应概念，书写后输出告警并忽略，不会静默生效。

**长度单位仅支持 `px` 与不带单位的数值。** 百分比、`em`、`rem`、`vw` 一律输出告警并忽略：这类单位需要参照尺寸才能换算，而本包不参与布局计算，无法取得参照值。`opacity: 50%` 等写法同样不支持，应写 `opacity: 0.5`。

### 等价：Godot 有对应实现

| 属性 | Godot 落点 |
| --- | --- |
| `color` | theme 颜色 `font_color`；处于 `:hover` 等状态时自动改用对应的状态项（如 `font_hover_color`） |
| `caret-color` | theme 颜色 `caret_color`（LineEdit、TextEdit） |
| `font-size` | theme 字号 `font_size` |
| `font-family` | theme 字体 `font`：已登记者取 `@font-face` 登记的资源，未登记者将整串候选交给 `SystemFont.font_names`（见下节） |
| `opacity` | `CanvasItem.modulate.a` |
| `background-color`、`background` | 该类实际绘制的 stylebox 的 `bg_color`（Button 为 `normal`，PanelContainer 为 `panel`） |
| `background-image` | 将同一 stylebox 替换为 `StyleBoxTexture` 并设置 `texture`（与 `background-color` 互斥，见下节） |
| `border-color` | StyleBoxFlat 的 `border_color` |
| `border-top-color` 等单边颜色 | 同上。Godot 的 StyleBoxFlat 只有一个 `border_color`，四边同色；单边属性名输出告警，并按整圈边框处理 |
| `border-top-width` 等四边宽度 | StyleBoxFlat 的 `border_width_*`，四边相互独立 |
| `border-top-left-radius` 等四角半径 | StyleBoxFlat 的 `corner_radius_*`，四角相互独立 |
| `box-shadow` | StyleBoxFlat 的 `shadow_*` |
| `padding`、`padding-top` 等 | StyleBoxFlat 的 `content_margin_*` |

**`padding` 对应 `content_margin_*`，属于命名差异，语义相同。** Godot 以内容视角命名（盒子内部为内容预留的空白），CSS 以盒子视角命名（边框以内的填充），两者指同一段距离。需要区分以下两项：

- 引擎另有 `expand_margin_*`，用于将绘制范围扩展至控件矩形之外，与 padding 无关，本包不使用该项。
- `MarginContainer` 的主题常量同样名为 `margin_*`，但其含义是为**子节点**预留的内侧空白，语义上更接近 padding，并非 CSS 的 margin。CSS 的 margin（外边距）在 Godot 的 Control 上不存在对应概念。

**无背景盒的类不支持背景相关属性。** 底色、边框、`padding`、`box-shadow` 均需写入某个盒子，而部分类默认不绘制任何盒子。典型为 `LinkButton`（HTML 的 `a`）：它仅绘制文字与下划线，默认主题中不存在 `normal` 盒，唯一的盒子是获得键盘焦点时绘制的 `focus`。因此：

```css
a { background-color: #ffe08a; }        /* 不生效并输出告警：LinkButton 无背景盒 */
a:focus { background-color: #ffe08a; }  /* 生效：获得键盘焦点时显示该底色 */
```

本包不会将基规则的底色改写到 `focus` 盒：那样该底色仅在获得键盘焦点时可见，与声明意图不符。需要状态底色时，应显式书写状态伪类。`TabBar` 同样不支持底色声明（其盒子按标签状态命名，如 `tab_selected`，不属于背景盒）。需要常驻底色时，使用 `PanelContainer` 包裹该节点，并将底色声明在 `PanelContainer` 上。

简写属性在构建期展开为 longhand，级联因此定义在 longhand 上。参与展开的简写有：`border`、`border-width`、`border-style`、`border-radius`、`background`、`margin`、`padding`、`flex`、`font`。其中 `border-style` 仅识别 `solid` 与 `none`，其余线型无落点；`font` 仅提取字号，例如 `font: 14px/1.5 sans-serif` 展开为 `font-size: 14px`，字体族、字重与行高无落点。

### 近似：支持，但为近似实现

这类属性有落点，但 Godot 的模型与 CSS 不同，落点为近似值（属性表中标记为 `level: 3`）。

| 属性 | 落点与差异 |
| --- | --- |
| `min-width` | `custom_minimum_size.x`（尺寸下界）。`%`、`em`、`rem` 输出告警并忽略 |
| `min-height` | 同上，写入 `custom_minimum_size.y` |
| `margin`、`margin-top` 等 | MarginContainer 的 theme 常量 `margin_*`。其他类不具备该常量，输出告警并忽略；本包不会为承载 margin 而向节点树插入容器 |
| `gap`、`row-gap`、`column-gap` | BoxContainer 的 theme 常量 `separation`（单轴，轴向由 `vertical` 决定）；GridContainer、FlowContainer、ItemList 的 `h_separation` 与 `v_separation`。`gap: 4px 8px` 表示行间距 4px、列间距 8px |
| `justify-content` | `BoxContainer.alignment`，仅支持 `flex-start`、`center`、`flex-end`；`space-between` 等取值输出告警。仅对容器类生效 |
| `flex`、`flex-grow` | 置位 `size_flags_*` 的 `SIZE_EXPAND` 并写入 `size_flags_stretch_ratio`；`flex-basis` 与 `flex-shrink` 无落点 |
| `text-shadow` | Label / RichTextLabel 的 `font_shadow_color` + 常量 `shadow_offset_x` / `shadow_offset_y`。与 `box-shadow` 无关（后者落在 stylebox）；模糊半径无落点，输出告警 |
| `visibility` | `CanvasItem.visible`；`hidden` 对应 `false` |
| `overflow` | `Control.clip_contents`。`hidden` 与 `visible` 可用；`auto`、`scroll` 无落点（滚动由 ScrollContainer 承担） |
| `pointer-events` | `none` → `Control.mouse_filter = IGNORE`。Godot 的 IGNORE 仅使本节点不接收鼠标事件，**不屏蔽子节点**，与 CSS 不同；`auto` 等其余取值无落点 |
| `text-align` | `horizontal_alignment`；不具备该属性的非容器类（Button、LineEdit）改用 `alignment` |
| `cursor` | `Control.mouse_default_cursor_shape`。支持 `pointer`、`text`、`move`、`not-allowed`、`*-resize` 等关键字，表外取值输出告警 |
| `text-overflow` | `Label.text_overrun_behavior`。`clip` 与 `ellipsis` 可用；自定义省略号字符串无落点，引擎固定使用 `…` |
| `white-space` | `Label.autowrap_mode`。`nowrap`、`normal`、`pre`、`pre-wrap`、`break-all` 可用。Godot 不折叠空白，源码中的连续空格按原样绘制 |
| `direction` | `Control.layout_direction`。`ltr` 与 `rtl` 可用；`inherit` 属于 CSS 全局关键字，在进入属性表之前即被拦截 |

### 不支持：输出告警并忽略

以下属性不会生效：其落点要么涉及节点树结构（由 Angular 持有，本包不修改），要么在 Godot 中不存在对应概念。书写时输出一条说明原因的告警，不静默忽略。

| 分组 | 属性 |
| --- | --- |
| 布局结构 | `display`、`flex-direction`、`flex-flow`、`flex-wrap`、`flex-basis`、`flex-shrink`、`align-items`、`align-self`、`align-content`、`justify-items`、`order`、`aspect-ratio`、`grid`、`grid-template-columns` |
| 定位 | `position`、`inset`、`top`、`right`、`bottom`、`left`、`float`、`z-index` |
| 尺寸 | `width`、`height`、`max-width`、`max-height`（Godot 无尺寸上界）、`box-sizing` |
| 字体排印 | `font-weight`、`font-style`、`line-height`、`letter-spacing`、`word-spacing`、`text-decoration`、`text-transform`、`writing-mode` |
| 背景与边框 | `outline`、`border-style` 的非实线取值 |
| 视觉与动画 | `transform`、`transition`、`animation`、`animation-name`、`filter`、`backdrop-filter`、`will-change` |
| 交互与其他 | `user-select`、`content`、`::before`、`::after` |

**本包不提供 `width` / `height`。** Godot 的控件具有 `size`，但控件位于容器内时，容器每次布局都会重新分配子节点尺寸，直接设置的值会在下一次布局时被覆盖。因此：

- 需要规定最小尺寸时，使用 `min-width` / `min-height`
- 需要参与剩余空间分配时，使用 `flex-grow`
- `max-width` / `max-height` 同样不提供：Godot 直至 4.7 才引入尺寸上界

**`overflow` 仅支持 `hidden` 与 `visible`。** Godot 只提供“是否裁剪超出部分”这一个开关。`scroll` 与 `auto` 不支持：滚动在 Godot 中是一种容器（`ScrollContainer`），而非样式开关。

**`pointer-events: none` 的作用范围小于 CSS。** CSS 中该声明会使整棵子树都不接收指针事件；Godot 的 `MOUSE_FILTER_IGNORE` 仅作用于本节点，子节点仍可接收事件，因此书写该声明时输出一条 `[兼容]` 告警。`pointer-events: auto` 不支持：Godot 各控件的默认值不一致（`Button` 接收、`Label` 不接收），本包无法据此恢复原值；需要恢复时请删除该条声明。

**`outline` 无对应实现。** Godot 的盒子没有独立的描边层。引擎的 `expand_margin_*` 与之相似（同样绘制在控件矩形之外且不影响布局），但它扩展的是整个盒子：底色随之外扩，描边只能沿用同一盒子的 `border_color`，无法单独取色。**`outline_size` 与 `font_outline_color` 指文字描边**，与 `outline` 无关。

**焦点框需由 `:focus` 自行声明。** 主题的 `Button/focus` 盒自带 2px 描边：未书写 `border-*` 时原样保留；基规则一旦声明 `border-color` 或 `border-width`，将覆盖该描边，键盘焦点不再可见。补充一条声明即可恢复：

```css
Button:focus { border-color: #6cb2f5; border-width: 2px; }
```

**`box-shadow` 仅取第一段阴影的偏移与颜色。** 第四段扩散值（spread）与内阴影 `inset` 不支持（本引擎的 StyleBoxFlat 无 `shadow_expand`，也不绘制内阴影），多层阴影仅取第一层。

**不支持 `::before` / `::after`。** Godot 无伪元素概念，样式只能声明在控件自身。书写伪元素会使整条规则失效并输出告警，告警中原样给出所书写的伪元素名称。

### 字体：`@font-face` 与 `font-family`

Godot 的字体是资源，而非名称。本包仅借用 `@font-face` 的语法完成一件事：将一份引擎可加载的字体资源关联到一个家族名下，`font-family` 此后方可解析到该资源。它并非 CSS Fonts 规范的实现，写法因此受到严格限制：

```css
@font-face {
  font-family: "Source Han Sans";
  src: url("res://assets/fonts/SourceHanSansSC-Regular.otf");
}

.title {
  font-family: "Source Han Sans";
}
```

规则如下：

- `src` 仅允许**一个** `url()`。CSS 的候选源列表（`url(a) format("woff2"), url(b)`）依赖「逐个尝试直至可用」，Godot 的一份 FontFile 不存在该机制，书写多个将被直接拒收。
- 路径必须以 `res://` 开头。CSS 编译后会被内联进 JS，组件样式来自 `styleUrls` 时连文件名也不再保留，相对路径在运行时已无参照物。`res://` 是引擎的虚拟根，指向 `project.godot` 所在目录；置于工程目录内的字体文件会随工程一并导出，运行时直接加载。
- `local()` 在 `@font-face` 中无落点（登记仅用于将一份工程内资源关联到名称；系统字体无需登记，直接在 `font-family` 中书写名称即可，见下）。
- 后缀必须是引擎可识别的字体容器（`ttf` `ttc` `otf` `otc` `woff` `woff2` `pfb`），或者包含 Font 派生类型的 `tres` / `res` 资源（`FontVariation` 在工程中即以 `.tres` 形式存在）。
- `font-weight`、`font-style`、`font-stretch`、`font-display`、`unicode-range` 无落点：Godot 中一个字体名仅对应一份字体文件，不存在「同一家族按字重或字形选择变体」这一层。书写时会输出告警，但登记本身仍然有效。
- 家族名不区分大小写，引号可加可不加。

#### `font-family` 的两级解析

`font-family` 的落点是 theme 字体项 `font`，候选列表整串均有意义：

```
font-family: A, B, C
  1. 按序查 @font-face 登记表，首个命中者生效 → 使用其 res:// 资源
  2. 全部未命中 → new SystemFont(); font_names = ["A", "B", "C"] → 同一个 override
     引擎按序选取系统中首个存在的字体；若全部不存在 → 由引擎静默回退至默认字体
```

已登记的字体由本包校验，资源加载失败时告警会点名路径；未登记的候选属于**尽力回退**，是否生效由引擎决定，本包不探测结果，也不输出告警。

以下两点需要留意：

- **登记优先，与候选顺序无关**。`@font-face` 登记的字体总是优先于同名系统字体，无论它在候选列表中的位置。引擎未提供「查询系统是否安装某字体」的能力，无法按 CSS 语义逐个尝试。
- **Godot 的回退是字形级，而非字体级**。`Font.fallbacks` 与 `allow_system_fallback`（默认开启）处理的是「当前字体缺少某个字形」，而非「当前字体未安装」。引擎默认字体（`ThemeDB.fallback_font`）本身不含中文字形，但渲染中文时会自动从系统获取字形，因此在不配置任何字体的情况下中文仍可显示。

移除一段包含 `@font-face` 的样式表时，由其建立的字体覆盖一并撤销，与其它属性同口径。

### 背景图：`background-image`

`background-image: url()` 落在同一个 stylebox 上，仅将该 stylebox 替换为 `StyleBoxTexture`：

```css
.panel {
  background-image: url("res://assets/ui/panel.png");
}
```

规则与 `@font-face` 的 `src` 完全一致（共用同一套校验）：仅允许**一个** `url()`、路径必须以 `res://` 开头、后缀必须是引擎可导入的图片（`png` `svg` `jpg` `jpeg` `webp` `bmp` `ktx2`）或包含 Texture2D 的 `tres` / `res` 资源。`gradient` 仍无落点（Godot 的 StyleBoxTexture 仅接受纹理，不接受渐变），将单独输出告警，而非按 `url()` 写法错误处理。

**与 `background-color` 互斥。** Godot 的一个 StyleBox 只能绘制其中一种：StyleBoxFlat 无 `texture`，StyleBoxTexture 无 `bg_color`。CSS 允许两者同时声明，本包不叠加，也不代为推断，**按层叠顺序取最后一条**，口径与 `width:1px;width:2px` 完全一致：

```css
.a { background-color: blue; background-image: url("res://a.png"); } /* 图赢 */
.b { background-image: url("res://a.png"); background-color: blue; } /* 色赢 */
```

跨规则同样如此：特异度更高（或特异度相同但登记更晚）的那一条决定该位置绘制何种内容。前一条仅失去填充字段，圆角、边框、`padding` 等几何字段仍照常叠加在同一 stylebox 上。纹理声明被撤销后，底色会重新生效（互斥关系并非永久占用）。

纹理资源加载失败时，该条声明按「无落点」处理并输出告警，不会遗留一个不绘制任何内容的空纹理盒。

### 与控件类型相关的属性

上述落点是否真正生效，还取决于节点所属的类。判定依据有两条：一是该类的主题中是否存在对应项，二是节点自身是否具备对应属性。任一条件不满足，运行时输出告警并忽略，不会写入无效的覆盖值。构建期 lint 仅校验语法与选择器拼写，不包含这项检查。

**与类无关的属性**：对任意 `Control` 均成立。

| 属性 | 落点 |
| --- | --- |
| `opacity` | `CanvasItem.modulate.a` |
| `visibility` | `CanvasItem.visible` |
| `min-width`、`min-height` | `Control.custom_minimum_size` |
| `flex`、`flex-grow` | `Control.size_flags_*` 与 `size_flags_stretch_ratio` |
| `cursor` | `Control.mouse_default_cursor_shape` |
| `direction` | `Control.layout_direction` |

**依赖主题项的属性**：下表列出支持的类，未列出的类不成立。

| 属性 | 需要的 theme item | 成立的类 |
| --- | --- | --- |
| `color` | `font_color`（RichTextLabel 为 `default_color`） | Button、CheckBox、CheckButton、CodeEdit、ColorPickerButton、FoldableContainer、ItemList、Label、LineEdit、LinkButton、MenuBar、MenuButton、OptionButton、ProgressBar、Tree、TextEdit |
| `font-size` | `font_size`（RichTextLabel 为 `normal_font_size`） | 上一行的 16 个类，再加 TabContainer、TabBar |
| `caret-color` | `caret_color` | LineEdit、TextEdit、CodeEdit |
| `background-color`、`background`、`border-*`、`padding`、`box-shadow` | 该类要有一个背景盒（`panel`、`normal`、`background` 之一） | Button、CheckBox、CheckButton、CodeEdit、ColorPickerButton、FoldableContainer、GraphEdit、GraphFrame、GraphNode、ItemList、Label、LineEdit、MenuBar、MenuButton、OptionButton、Panel、PanelContainer、ProgressBar、RichTextLabel、ScrollContainer、TabContainer、Tree、TextEdit（`LinkButton` 与 `TabBar` 没有背景盒，见上节） |
| `margin`、`margin-top` 等 | `margin_left` / `margin_top` / `margin_right` / `margin_bottom` | MarginContainer（仅此一类） |
| `gap`、`row-gap`、`column-gap` | `separation`，或 `h_separation` 与 `v_separation` | 前者：BoxContainer、HBoxContainer、VBoxContainer、HSeparator、VSeparator、SplitContainer、HSplitContainer、VSplitContainer、ColorPicker、GraphNode；后者：GridContainer、FlowContainer、HFlowContainer、VFlowContainer、ItemList、Tree |

**取决于节点属性的属性**：

| 属性 | 需要的节点属性 | 成立的类 |
| --- | --- | --- |
| `justify-content` | `alignment`，且该类属于 `Container` | BoxContainer、HBoxContainer、VBoxContainer、FlowContainer 系 |
| `text-align` | `horizontal_alignment`；不具备时回退到 `alignment`（容器类除外） | Label、RichTextLabel；Button、LineEdit |
| `text-overflow` | `text_overrun_behavior` | Label、Button、LinkButton、ItemList |
| `white-space` | `autowrap_mode` | Label、Button、RichTextLabel、TextEdit |

下列类不支持外观属性（`Control`、`Container`、`CenterContainer`、`AspectRatioContainer`、`TextureRect`、`ColorRect` 等）：其主题中不存在任何可用项，外观类属性对其一律输出告警。告警按「属性 + 类名」去重，同一组合仅输出一次。

### 伪类状态

`:hover`、`:active`、`:focus`、`:pressed` 由 Godot 信号驱动；`:checked`、`:disabled`、`:enabled`、`:read-only` 除信号外还取决于**节点属性**（见下表）。写入哪个状态的主题项，由选择器声明的状态伪类决定，与节点当前实际状态无关：

| 伪类 | 来源 | stylebox | 颜色中缀 |
| --- | --- | --- | --- |
| `:hover` | `mouse_entered` / `mouse_exited`（**向 Control 祖先冒泡**，见下） | `hover` | `font_hover_color` |
| `:focus` | `focus_entered` / `focus_exited` | `focus` | `font_focus_color` |
| `:active` `:pressed` | `button_down` / `button_up` | `pressed` | `font_pressed_color` |
| `:checked` | `toggled` 信号 + `button_pressed` 属性（**仅 `toggle_mode=true` 时成立**） | `pressed` | `font_pressed_color` |
| `:selected` | 手动 `setPseudoClass` | `selected` | `font_selected_color` |
| `:read-only` | `editable` 属性（`editable=false`） | `read_only` | `font_readonly_color` / `font_uneditable_color` |
| `:disabled` | `disabled` 属性 | `disabled` | `font_disabled_color` |
| `:enabled` | `disabled` 属性取反 | —（同 `normal`） | —（同 `font_color`） |

以下行为需要特别注意：

- **`:hover` 会向祖先传播，`:focus` / `:active` / `:pressed` 不会**。指针停在行内控件（`Button`、`CheckBox` 等）上时，外层 `.row:hover` 同样进入悬停，与浏览器一致。差异在于：CSS 的 `:focus-within` 没有对应实现，`:focus` 仅作用于获得键盘焦点的控件自身；`:active` / `:pressed` 同样仅作用于控件自身，浏览器中祖先一并进入激活状态的行为不支持。

- **勾选态使用 `pressed` 系列主题项，而非 `normal`**。开关控件（`CheckBox` / `CheckButton` / `toggle_mode=true` 的 `Button`）勾选时绘制的是 `pressed` 盒与 `font_pressed_color`。因此仅声明 `CheckBox { color: … }` 时，勾选后颜色不会变化，需追加一条声明：

```css
CheckBox         { color: #333; }
CheckBox:checked { color: #333; }  /* 勾选时引擎读取 font_pressed_color */
```

  悬停与勾选同时成立时，引擎读取 `hover_pressed` / `font_hover_pressed_color`，本包自动写入该项。反之，`toggle_mode=false` 的普通 `Button` 设置 `button_pressed=true` 不生效（引擎仅接受 `toggle_mode && button_pressed`），因此 `:checked` 仅对开关控件有效。使用 `[toggle_mode]` + `[button_pressed]` 绑定时需**先写 `toggle_mode`**，随后写入的 `button_pressed` 才会保留。
- **盒子与颜色遵循两套规则**。颜色按状态各存一个值；盒子则每个状态各存一整份，Godot 不会让 `:hover` 盒继承基规则。CSS 的语义是 `:hover` 仅覆盖自身声明的属性，其余沿用基规则，因此本包按字段来源合成盒子：

  > 某状态的盒子 = 引擎该状态的默认盒子 ⊕ 基规则写过的字段 ⊕ 该状态写过的字段

  即：**未声明的字段不做任何修改；已声明的字段在所有状态下均生效。** 于是 `Button.primary { padding: 8px 12px; border-radius: 9px }` 在悬停、按下、获得焦点时都成立（未声明 `:hover` 也不会退回引擎默认的直角小盒），而未声明的底色、描边粗细仍由主题决定，引擎自身的悬停加深不会被抹掉。

  推论：基规则写了 `background-color`，禁用态也就还是那个底色（与浏览器一致——作者写了 background，主题的禁用底色就被覆盖）。需要专属状态外观必须显式声明：

```css
Button.primary { background-color: #2b7fff; padding: 8px 12px; border-radius: 9px; }
Button.primary:disabled { background-color: #b9c6d6; }  /* 不写就沿用上面那条蓝 */
Button.primary:hover  { background-color: #4a90ff; }    /* 不写就沿用上面那条蓝 */
Button.primary:focus  { border-color: #6cb2f5; }        /* 焦点环同理，见下方 outline */
```

  两个盒名集合之外的状态不参与合成：`Tree` 的 `hovered`、`TabBar` 的 `tab_hovered`、`FoldableContainer` 的 `title_hover_panel` 是**行级 / 标签级 / 标题条级**状态，CSS 的 `:hover` 说的不是它们，因此 `Tree:hover` 改的是整棵树的盒与文字色，不是某一行的；行级外观请直接设置主题。

- **基规则与状态规则分别写入各自的主题项，互不覆盖**。`Button.primary { color: 蓝 }` 写入 `font_color`，`Button.primary:hover { color: 红 }` 写入 `font_hover_color`，两个值同时存在，引擎按当前状态各自读取。层叠的“后者覆盖前者”只在**同一个主题项内**比较特异度与源码顺序：

```css
Button.primary       { color: #2b7fff; }  /* → font_color */
Button.primary:hover { color: #ff4040; }  /* → font_hover_color，不被下一条抢走 */
Button.primary.x     { color: #00c853; }  /* → font_color，只覆盖同落点的基规则 */
```

  前提是该类真有对应的状态项。没有时两条声明只能抢同一个主题项（`Label` 只有 `font_color`；`font-size` 与 `gap` 这类常量全类都没有状态变体），此时回到正常的层叠比较，状态规则**没有**优先权：

```css
.title:hover { color: #ff4040; }   /* 0,2,0 在前 */
.title.on    { color: #00c853; }   /* 0,2,0 在后 → 悬停时仍是它（Label 无 font_hover_color） */

.menu        { font-size: 14px; }
.menu:hover  { font-size: 18px; }  /* font-size 无状态变体，与下一条同抢 font_size */
.menu.open   { font-size: 20px; }  /* 同为 0,2,0 且在后 → 展开 + 悬停仍是 20 */
```

  状态规则不再命中（或整张样式表被移除）时，它写过的 item 会被显式撤销，不会漏出上一轮的颜色；颜色因此回落到主题默认值（stylebox 不同：回落到基规则声明的值，见上条）。
- **属性驱动的伪类仅对声明了该属性的控件有效**。下表列出各伪类的前置属性与适用类；不满足前置条件的伪类无法推导，运行时按「伪类 × 类名」组合告警一次：

| 伪类 | 前置引擎属性 | 具备该属性的控件 | 不具备（伪类无效） |
| --- | --- | --- | --- |
| `:checked` | `button_pressed`（且 `toggle_mode=true`） | `Button` / `CheckBox` / `CheckButton` / `LinkButton` / `MenuButton` | `LineEdit` / `TextEdit` / `Slider` / `SpinBox` / `ItemList` / `ScrollBar` / `ColorPicker` |
| `:disabled` `:enabled` | `disabled` | `BaseButton` 系：`Button` / `CheckBox` / `CheckButton` / `OptionButton` / `MenuButton` / `LinkButton` | `LineEdit` / `TextEdit` / `Slider` / `SpinBox` / `ItemList` / `ScrollBar` / `ColorPicker` |
| `:read-only` | `editable`（`false` 时成立） | `LineEdit` / `TextEdit` / `SpinBox` / `Slider` | `Button` 系 / `ItemList` / `ScrollBar` / `ColorPicker` |

  上表末列的控件如需禁用外观，只能通过 class 通道声明。其中 `ItemList` / `ColorPicker` /`ScrollBar` 两个前置属性均不具备，表单指令只能以 `mouse_filter = MOUSE_FILTER_IGNORE` 表达不可交互；而**鼠标穿透不等价于禁用**（`Label` 等控件默认即为 `IGNORE`），因此本包不会将 `IGNORE` 推导为禁用态。这三类的禁用外观请使用 class 通道：

```html
<ItemList class="files" [class.off]="locked()"></ItemList>
```
```css
.files.off { color: #666; }
```

- **仅具备 `editable` 的控件，其禁用状态推导为 `:read-only` 而非 `:disabled`**。`LineEdit` /`TextEdit` / `Slider` / `SpinBox` 类上不存在 `disabled` 属性（Godot 文档中其属性集仅含 `bool editable`），表单指令的 `setDisabledState()` 只能写 `editable = !isDisabled`，而 `editable=false` 推导出的仍是 `:read-only`。于是同一段模板：

```html
<LineEdit class="field" [ngModel="note()" [disabled]="locked()"></LineEdit>
```
```css
.field:disabled   { color: #666; }  /* ✗ 永远不会命中：LineEdit 没有 disabled 属性 */
.field:read-only  { color: #666; }  /* ✓ 表单禁用与只读在这里共用一个落点 */
```

  原因在于 `editable` 一个属性同时承载 CSS 中 `disabled` 与 `readonly` 两个语义，无法从属性值区分。声明这类控件的禁用样式时应直接使用 `:read-only`（或采用上述 class 通道）。需要区分时，只有 class 通道能够区分：

```html
<LineEdit class="field" [class.off]="locked()" [class.view]="isView()"></LineEdit>
```
```css
.field.view { color: #999; }   /* 只读 */
.field.off  { color: #666; }   /* 表单禁用 */
```

- **状态属性没有变更信号**。`disabled` / `editable` 变化时引擎不发通知，因此只有经模板绑定（`[button_pressed]` /`[disabled]` / `[editable]`）或表单指令（`ngModel` / `formControl`）修改时，样式才会更新。直接对节点赋值（`node.button_pressed = true`）绕过上述通道，需手动标脏：

```ts
inject(STYLE_RUNTIME).invalidate(node); // 伪类会在帧末从属性上读回来
```

样式的三个入口共用同一套级联规则：

```ts
// 组件样式：构建期解析，运行时按 Angular 的作用域规则隔离
@Component({ styles: [`.title { color: #ff8800 }`], styleUrls: ["./app.css"] })
```

```jsonc
// 全局样式：angular.json 的 styles 选项
"styles": ["src/global.css"]
```

```html
<!-- 单键绑定：不受作用域隔离影响 -->
<Label [style.color]="'#ff8800'" [style.fontSize]="28"></Label>
```

`class` 为有效输入：`[class.disabled]="busy()"`、`[class]` 与静态 `class="a b"` 在帧末重新计算级联。特异度按 CSS 算法计算，`!important` 独立成层（普通 → 内联 → important）。`ViewEncapsulation` 的分层与浏览器端一致：`Emulated`（默认）为局部层，`None` 与 `ShadowDom` 归入全局层；Godot 没有 shadow root，`ShadowDom` 会告警并按 `None` 处理。

支持的选择器：`*`、类型选择器（对应节点类名）、`.class`、`[attr]`、`[attr=v]`、后代 `A B`、子选择器 `A > B`、相邻 `A + B`、兄弟 `A ~ B`、并列 `A.b`、逗号分组。组件样式中的 `:host` 与 `:host.on` 由 Angular 编译为宿主属性选择器。

不支持 `#id`：Godot 节点没有 `id` 属性，`name` 允许重名，不能作为标识使用；需要单独选中某个节点时使用 class（样式表中出现 `#id` 会告警一次，选择器解析本身保留）。

`+`（紧邻兄弟）与 `~`（后续兄弟）仅在元素之间计算。`@if`、`@for` 会在节点树中留下占位节点，它们**不占用兄弟位置**，也不会被兄弟选择器命中（与浏览器中 `nextElementSibling` 跳过注释节点的行为一致）；插入或删除节点后，同级的 `+` / `~` 会自动重算。

`@media` 支持 `width`、`height`、`orientation`、`prefers-color-scheme`（`aspect-ratio` 这类特性不在环境键里，写了也不会命中）。自动注入只提供 `width` / `height` /`prefers-color-scheme`，`orientation` 与 `device-width` / `device-height` 需要自行注入：

```ts
inject(STYLE_RUNTIME).setEnv({ width: 1280, height: 720, "prefers-color-scheme": "dark" });
```

自动注入的宽高量的是**挂载点（`GODOT_ROOT`）自己占多大**，不是操作系统窗口多大：局部挂载就是局部断点。「快速开始」那个例子的挂载点是 1024×768，那么 `@media (max-width: 1100px)` 就会命中，不管窗口实际有多宽。两种情况退回量窗口：挂载点不是 `Control`，或它还没被布局过（尺寸 0）。

量到的一律是**布局坐标系**（与 `Control.size` 同一坐标系），不是窗口物理像素：开了内容缩放时两者差一个缩放因子——基准 1280×720 的项目在 1920×1080 的窗口里布局宽度仍是 1280，断点按 1280 写就对了，不要拿 `Window.size` 换算。挂载点铺满窗口（`PRESET_FULL_RECT`）时，它的 `size` 与窗口视口逐位相等，两种量法等价。

CSS 自定义属性（`--x`、`var(--x)`）已支持。

以下伪类语法合法，但在 Godot 中既无信号也无属性可推，不会自动生效，样式表使用时输出一次告警：`:valid`、`:invalid`、`:indeterminate`、`:selected`、`:required`、`:optional`。请改用 class 通道，或显式设置：

```ts
inject(STYLE_RUNTIME).setPseudoClass(node, "selected", true);
```

属性驱动的伪类（`:checked` / `:disabled` / `:enabled` / `:read-only`）**只对真有那个属性的控件有效**：`:checked` 要 `button_pressed`（开关控件），`:disabled` / `:enabled` 要 `disabled`（`BaseButton` 系），`:read-only` 要 `editable`（`LineEdit` / `TextEdit` / `Slider` / `SpinBox`）。样式表用到了某伪类、而当前这类控件没有对应属性时，会按「伪类 × 类名」告警一次：

```
ItemList 没有 disabled 属性，:disabled 在它身上推不出来（不会自动生效）。
如需该外观，请走 class 通道（[class."disabled"]="…" 配合 CSS .x.disabled）。
```

`:selected` 有对应主题项（`ItemList` / `Tree` 的 `selected` 盒与 `font_selected_color`），但引擎没有“整个控件被选中”的信号：行级选中属于控件内部，CSS 选择器只能到控件粒度，因此需手动驱动。

以下特性不支持，处理时输出一次告警并忽略：`calc()`、`url()`、`@keyframes` 与动画、`position: fixed` / `absolute`、`overflow` 滚动裁切、`grid` 的真实网格（仅转换为 `GridContainer` 的列数）、字体加载、伪元素 `::before` 与 `::after`。

CSS 嵌套（nesting）不支持。解析器将声明块内部的 `{` 视为语法错误，下列写法会输出一条告警，且其中的声明不会生效：

```css
/* 不支持：内层块会被当作声明解析 */
HBoxContainer {
  Label {
    margin-right: 320px;
  }
}
```

改写为平铺选择器即可保持相同的后代语义：

```css
HBoxContainer Label {
  margin-right: 320px;
}
```

如需使用嵌套语法，应将样式表保存为 `.scss`、`.sass` 或 `.less`。构建期会先调用 vite 的 `preprocessCSS`（与组件 `styleUrls` 使用同一入口），由预处理器展开嵌套后再交给解析器。全局样式与 `styleUrls` 均适用；扩展名为 `.css` 的文件不做预处理。

长度单位仅支持 `px` 与不带单位的数值。`%`、`em`、`rem`、`vw`、`vh`、`cm`、`pt` 等单位均无落点，将输出告警并丢弃该条声明（见「样式」开头的单位说明）。

`add_theme_*_override` 与 `theme_type_variation` 按条目互斥：已写入 override 的条目在切换变体后仍返回 override 值。同一条目不应同时使用静态主题变体与运行时级联，默认全部使用运行时级联。

class 选择器与 `theme_type_variation` 无关，本包不会由 class 推导变体名。需要使用变体时，请自行设置节点属性。

无显示环境（CI、无头模式）下取不到真实屏幕信息，媒体查询会静默落在**窄屏分支**（根窗口尺寸是个极小值，小于任意 `max-width` 断点），`prefers-color-scheme` 恒为浅色。需要确定性结果时请显式调用 `setEnv`；真实窗口尺寸变化与系统深色模式的切换效果需在带显示的环境中确认。

### 告警与生产构建

运行期告警分两级，输出里用标记区分：

| 标记 | 含义 | 应当如何处理 |
| --- | --- | --- |
| `[忽略]` | 完全不支持，该条声明被丢弃，Godot 侧无对应实现 | 改写，或者接受该效果不存在 |
| `[兼容]` | 已写入并生效，但 Godot 的语义与 CSS 不同，结果仅为近似 | 判断近似能否接受，不能接受则改用其它写法 |

例：`border-top-color` 只能落在四边共用的 `border_color` 上，写入后生效，但四边将同色，因此是 `[兼容]`；`outline` 在 Godot 中没有不占位的描边层，无法写入，因此是 `[忽略]`。

运行期告警统一受 Angular 自身的 `ngDevMode` 控制，且是**编译期消除，而非运行时不打印**：开发构建保留全部告警；生产构建中告警连同提示文字一并从产物移除。因此不要在生产构建中依赖告警定位样式问题，应在开发构建阶段修正。

构建期检查（选择器拼写、属性名、不支持的类）不受该标记影响，无论是否开启优化都会输出。

同一类问题仅报告一次（按“属性 + 原因”去重），不会逐帧重复输出。

## 路由

`@angular/router` 原样可用，不需要改它一行。路由对平台的全部依赖收敛在三个 token 上，`provideGodotRouter` 提供 Godot 侧的实现：

| token | 浏览器实现 | Godot 实现 |
| --- | --- | --- |
| `PlatformLocation` | `window.location` + `window.history` | 内存历史栈（`GodotPlatformLocation`） |
| `ViewportScroller` | 浏览器视口 | 空实现（滚动属于 `ScrollContainer`，与视口无关） |
| `TitleStrategy` | 写 `document.title` | 写窗口标题 |

`DOCUMENT` 不在此列：它是 core 里无 factory 的裸 token，而当前装配链里没人 `inject(DOCUMENT)`（`route.title` 已改走 `GodotTitleStrategy`，`PathLocationStrategy` 的兜底读被 `getBaseHrefFromDOM()` 返回的空串断在 `??` 上），所以不提供。

安装 `@angular/router`（本包的可选 peer 依赖），然后像浏览器里一样配置：

```ts
// src/main.ts
import { bootstrapGodotApp } from "godot-angular/core";
import { provideGodotRouter } from "godot-angular/router";
import { App } from "./app";

_ready() {
  bootstrapGodotApp(App, this, [
    provideGodotRouter([
      { path: "", component: Home },
      { path: "detail/:id", component: Detail },
    ]),
  });
}
```

```html
<!-- src/app.html -->
<VBoxContainer>
  <Button text="首页" (click)="go('/')"></Button>
  <Button text="详情" (click)="go('/detail', 7)"></Button>
  <router-outlet></router-outlet>
</VBoxContainer>
```

```ts
// src/app.ts
@Component({ /* … */ })
export class App {
  private readonly router = inject(Router);
  go(...commands: unknown[]): void {
    void this.router.navigate(commands);
  }
}
```

`router-outlet` 不是 Godot 类，渲染为一个**空的** `VBoxContainer`：它只是占位容器，激活的页面插在它**后面**（与它平级），不是它的子节点。浏览器里也是这样 —— 路由内容本来就是 `<router-outlet>` 的兄弟（所以才有 `router-outlet + *` 这种选择器），这里只是把同样的结构搬到了节点树上。

`Router`、`Location`、`ActivatedRoute` 从 `@angular/router` 直接导入，用法与浏览器一致。`Location.back()` / `forward()` 有效。

### routerLink 不支持

`RouterLink` / `RouterLinkActive` 在 Godot 中不可用，跳转请写 `(click)="go(...)"` 配合 `router.navigate()`。原因：`RouterLink` 的 host listener 是 `click: onClick($event.button, $event.ctrlKey, …)`，而 `Button.pressed()` 零参数，`$event` 为 `undefined`，读取成员时抛出 TypeError。

继承覆写 `onClick` 或自行定义同名指令都无法绕过，两者均已验证不生效：前者的报错发生在 Angular 生成的宿主绑定处理器中，执行得早于 `onClick`；后者会使 `RouterLinkActive` 找不到链接。

### 路由的边界

- **URL 不持久化**。历史栈活在内存里，进程结束即消失，重启从起始 URL 重新开始。
- **起始 URL 由 `GODOT_INITIAL_URL` 声明**，默认 `/`。Godot 没有地址栏，“从哪个页面开始”必须从外部进来（启动参数、配置、存档）：

  ```ts
  bootstrapGodotApp(App, root, [
    provideGodotRouter(routes),
    { provide: GODOT_INITIAL_URL, useValue: parseDeepLinkFromArgv() },
  ]);
  ```

  除省略一次 `navigate` 调用之外，初始导航即导航到该地址：路由表中没有空路径时它是唯一入口，未提供时初始导航无法匹配，outlet 保持为空（不会先渲染再跳转）。
- **URL 解析与浏览器一致**：`/a/../b` 折叠成 `/b`、`about` 相对当前目录解析、`?q=1` 会丢弃锚点、需要编码的字符仅编码一次不会二次编码，与浏览器中 `history.pushState(url)` 同源。代价是约 215KB 源码体积。
- **`URL` / `URLSearchParams` 默认可用**。GodotJS 原生没有（V8 只给 ECMAScript），库会把它们装到全局，用户代码解析启动参数 / 存档里的链接可以直接 `new URL(...)`。
- **懒加载不可用**。`loadComponent` / `loadChildren` 依赖运行时动态 `import()`，GodotJS 不支持。
- `withHashLocation()` 可用（URL 落在 `#` 上）；`withExperimentalPlatformNavigation()` 不可用，它要浏览器的 Navigation API。
- **参数变化要订阅 `paramMap` / `queryParamMap`**。只改参数时同一个组件实例被复用，读 `snapshot` 的普通 getter 不会重跑变更检测——这是 Angular 的既有行为，与 Godot 无关。
- `route.title` 写窗口标题。无显示环境（CI / `--headless` / 专用服务器）由 `GODOT_HEADLESS`**主动声明**，库不去猜 `DisplayServer.get_name()`：猜错只多一行日志，靠猜永远不会在 CI 上被发现。默认 `false`（按有窗口处理），无显示时自己传：

  ```ts
  bootstrapGodotApp(App, root, [provideGodotRouter(routes), { provide: GODOT_HEADLESS, useValue: true }]);
  ```

  声明为无头后不操作窗口，但标题仍记录在 `GodotTitleStrategy.currentTitle`，组件可将其绑定到标题栏 `Label` 上，因此无头环境下页面标题仍有显示位置。

  写的是根窗口的 `Window.title`（而不是 `DisplayServer.window_set_title()`）：后者只改操作系统那侧的文字、**不回写** `Window.title`，而 Godot 又没有 `DisplayServer.window_get_title()`，于是当前标题从写入那一刻就再也读不回来。走 `Window.title` 后 `get_window().title` 与 `title_changed` 都是可信的（取不到窗口时才退回 `DisplayServer`）。

### 读取当前标题

路由器先派发 `NavigationEnd`，随后才更新标题，两者位于同一段同步代码中。在 `NavigationEnd` 处理器里读 `GodotTitleStrategy.currentTitle`，得到的是上一次导航的标题（首次导航时为空字符串）。延后一个微任务即可：

```ts
this.router.events
  .pipe(filter((e) => e instanceof NavigationEnd))
  .subscribe(() => queueMicrotask(() => title.set(this.titles.currentTitle)));
```

### 一条无害的输出

| 输出 | 说明 |
| --- | --- |
| `unhandled promise rejection: NoMatch` | 引擎在 promise reject 的那一刻就打印，不看下一句有没有 `catch`。路由靠异常控制流试匹配候选路由，因此每次导航都会打一行。导航结果由测试逐条断言过 |

## 多入口与多场景

一个 Angular 工作区可以产出多个场景脚本，共享同一份运行时：

```jsonc
"pages": {
  "builder": "godot-angular:application",
  "options": {
    "entries": [{ "glob": "**/*.ts", "input": "src/pages" }],
    "tsConfig": "tsconfig.json",
    "outputPath": "dist-pages",
    "resRoot": "res://dist-pages"
  }
}
```

产物名称为 `output` 与文件相对 `input` 的路径之和（去除 `.ts` 扩展名）。`input` 缺省取 `glob` 中第一个含通配符的段之前的部分，因此产物名称仅由配置决定，与实际匹配结果无关。

| 写法 | 产物 |
| --- | --- |
| `"src/main.ts"` | `dist/main.js` |
| `"src/pages/**/*.ts"` | `dist/hello.js`、`dist/counter.js` |
| `{ glob: "**/*.ts", input: "src/pages" }` | 同上 |
| `{ glob: "*.ts", input: "src/pages", output: "pages" }` | `dist/pages/hello.js` |
| `{ glob: "**/*.ts", input: "src", ignore: ["**/tests/**"] }` | `dist/app.js`、`dist/main.js`、`dist/pages/hello.js` |

两种配置产生同名产物时构建报错。入口名称必须保持稳定，场景文件按名称引用脚本。

每个入口对应一个场景文件，场景路径作为命令行位置参数传入：

```bash
godot --headless --path . res://pages.tscn
```

## 单元测试

测试在真实 GodotJS 进程中执行，用例写法与标准 Angular TestBed 一致。

```jsonc
"test": {
  "builder": "godot-angular:vitest",
  "options": {
    "tsConfig": "tsconfig.json",
    "outputPath": "dist-engine-test",
    "resRoot": "res://dist-engine-test",
    "specInclude": ["src/tests/engine/*.spec.ts"],
    "engine": {
      "projectPath": ".",                 // 指定后自动启动引擎；noLaunch: true 时自行启动
      "scene": "res://engine_vitest.tscn",
      "port": 18781,                     // 起始端口，被占用则 +1（可省略）
      "connectTimeout": 30000
    }
  }
}
```

`engine_vitest.tscn` 指向 `res://dist-engine-test/vitest-entry.js`，该入口由构建器生成，使用方无需编写任何测试入口文件。`specInclude` 是测试文件匹配模式的唯一来源。

```ts
import { initGodotTestEnvironment } from "godot-angular/testing";

beforeEach(() => initGodotTestEnvironment());   // 每个用例使用独立的 Control 根节点

it("signal 改动会落到真实节点", async () => {
  await TestBed.configureTestingModule({
    imports: [MyComp],
    providers: [
      { provide: ComponentFixtureAutoDetect, useValue: true },
      provideZonelessChangeDetection(),
    ],
  }).compileComponents();

  const fixture = TestBed.createComponent(MyComp);
  await fixture.whenStable();
  expect(fixture.nativeElement.get_child(0).text).toBe("…");
});
```

`godot-angular/testing` 提供测试环境（`initGodotTestEnvironment`、`GodotTestingModule`）、节点查询（`findAllNodes`、`nodeTexts`、`newNode`）与等待引擎帧（`awaitFrames`）。等待变更检测统一使用官方的 `fixture.whenStable()`。

布局计算与 `queue_free` 需要真实帧：`add_child` 之后立即读取 `size` 为 0，测试中使用 `awaitFrames(2)`。

命令行过滤参数透传至 vitest：

```bash
ng test --file-filters=godot     # 按文件过滤
ng test --filter="信号"           # 按用例名过滤
ng test --reporters=json
```

覆盖率在 `angular.json` 中启用（`"coverage": true` 或完整配置对象）。

## 构建选项

`godot-angular` 提供两个 builder。选项名称与语义沿用官方 `@angular/build:application`，未提供的能力通过 `viteConfig` 配置。

### `godot-angular:application`

| 选项 | 说明 |
| --- | --- |
| `entries` | 入口 `.ts` 文件，可配置多个，形状沿用 `assets` 的 `{glob,input,output,ignore}` |
| `resRoot` | `outputPath` 对应的 `res://` 前缀 |
| `viteConfig` | vite 配置文件路径，叠加在本 builder 之上；`plugins` 为追加而非替换 |
| `styles` | 全局样式表，构建期解析并编入产物，运行时作为 application 层样式参与级联。不接受 `bundleName` 与 `inject` |
| `tsConfig` `outputPath` `sourceMap` `define` | 与官方同名同义 |
| `optimization` | 同名但仅接受 `true` / `false` 或 `{ scripts }`。`scripts` 开启 JS 压缩并将 `ngDevMode` 固定为 `false`（运行期告警随之停止），关闭时固定为 `true`。不接受 `styles` 与 `fonts`：本包不压缩 CSS、不内联字体，书写时直接报错，而非静默无效 |
| `polyfills` | 追加的 polyfill 说明符，默认 `[]`。构建器始终先生成一个入口，首行固定引入它自带的补丁模块（`builder/vite/polyfills.ts`），本选项的条目追加其后，无法关闭必带项。注意：只能写包名或绝对路径，`./xxx` 这种相对路径解析不了（虚拟入口无目录基准） |
| `externalDependencies` | 不打入产物、运行时由外部提供的包。口径与官方一致，`godot` 固定为外部依赖 |
| `fileReplacements` | 按文件替换，`{replace, with}` |
| `assets` | 原样拷贝到产物目录（主题 `.tres`、字体、图标），不做 hash |
| `deleteOutputPath` | 构建前清空 `outputPath`，默认 `true` |
| `outputHashing` | 仅支持 `none` 与 `bundles`。入口名称必须稳定，仅共享 chunk 可附加 hash |
| `preserveSymlinks` `conditions` | 透传 vite `resolve.*` |
| `loader` | 仅支持 `text` 与 `base64` |
| `budgets` `statsJson` | 判定与报错文案与官方一致 |
| `watch` `poll` | 仅保证产物更新。Godot 将 `.js` 作为 Script 资源缓存，引擎不重启或不执行 `--import` 时读取不到新内容 |
| `verbose` | 详细构建日志 |

不提供 `aot` 选项：始终使用 AOT 编译，运行环境不支持运行时 JIT。

官方选项中未提供的部分及原因：

| 选项 | 原因 |
| --- | --- |
| `index` `baseHref` `deployUrl` `crossOrigin` `subresourceIntegrity` `browser` `security` `scripts` `ssr` `server` `serviceWorker` `prerender` `appShell` `outputMode` `inlineStyleLanguage` | 浏览器与 HTML 专用，无对应概念 |
| `localize` `i18nDuplicateTranslation` `i18nMissingTranslation` | 官方 i18n 流程未接入 |
| `stylePreprocessorOptions` `webWorkerTsConfig` `allowedCommonJsDependencies` `namedChunks` `extractLicenses` `progress` `clearScreen` | 无对应行为，或需通过 `viteConfig` 配置 |

### `godot-angular:vitest`

包含上表中除 `entries`（由构建器合成）与 `styles`（测试链路不使用样式构建，配置后被忽略）之外的共用选项，另加：

| 选项 | 说明 |
| --- | --- |
| `specInclude` | 必填。测试文件 glob，相对 workspaceRoot |
| `exclude` | 排除的测试文件 glob |
| `engine` | 必填。`projectPath`、`scene`、`port`（起始端口，被占则 +1）、`connectTimeout`、`godotBin`、`noLaunch` |
| `skipRun` / `skipBuild` | 仅构建不执行 / 仅执行不构建 |
| `reporters` / `filter` / `fileFilters` | 透传 vitest |
| `coverage` | `true` 或配置对象：`enabled`、`include`、`exclude`、`instrument`、`sourceRoot`、`reportsDirectory`、`reporter`、`thresholds`、`reportOnFailure` |
| `watch` | vitest 监听模式，修改测试文件后重新执行 |

不提供 `setupFiles`：引擎中执行的是已编译的 bundle，无法在运行时载入未编入该 bundle 的文件。等价做法是在测试文件的 `beforeEach` 中完成全局环境准备。

命令行选项使用 kebab-case（`--skip-build`）。对象类型选项（`engine`、完整形式的 `coverage`）只能通过 `angular.json` 配置。

## 导入路径

所有 API 位于二级入口，包主入口不导出任何内容。

| 路径 | 内容 |
| --- | --- |
| `godot-angular/core` | 运行时：`bootstrapGodotApp`、`GodotAngularApp`、`GODOT_ROOT`、`tryConnectGodotSignal`、`godotClass`、`GodotRenderer`、样式运行时（`StyleRuntime`、`STYLE_RUNTIME`）、解析工具（`resolveTag`、`resolveSignalName`、`nodeHasProperty`） |
| `godot-angular/builder/vite/polyfills.mjs` | 运行环境补丁（`queueMicrotask` / `requestAnimationFrame` / `performance` / `document` / `URL` / `URLSearchParams` / `atob`）。**不是库入口**，属于构建器内部；由构建器自动注入，无需手动导入 |
| `godot-angular/forms` | 表单指令与 `GodotControlBase`、`GodotValueAccessorBase` |
| `godot-angular/css` | CSS 子集的纯逻辑层（解析、选择器、级联、词表）——**库内部实现层**，不保证兼容 |

样式落点相关的 `applyStyle` / `clearStyle` / `styleLedger` 与整个 `godot-angular/css` 入口同属内部实现，不在公开清单内，其签名与行为看库内需求变动，不遵循语义化版本。需要命令式改变外观请使用组件样式 / class 选择器，或内联绑定 `[style.x]`。
| `godot-angular/router` | `provideGodotRouter`、`GodotTitleStrategy`，并转发 `GODOT_HEADLESS` / `GODOT_INITIAL_URL` / `GodotPlatformLocation`。需自行安装 `@angular/router` |
| `godot-angular/testing` | 测试工具 |
| `godot-angular/vitest` | 宿主侧 vitest 插件 |
| `godot-angular/vitest/runtime` | 引擎侧 vitest worker |

可执行命令：`npx godot-typings`。

## 限制

- 仅支持 zoneless 变更检测。`tick()` 是变更检测的驱动点。
- 不支持运行时懒加载（路由 `loadComponent` 等）。运行环境的动态 `import()` 不受支持。构建期静态分包可用，运行时按需载入模块不可用。
- 不支持 `RouterLink` / `RouterLinkActive`：它们的 host listener 要读 `$event.button`，而 `Button.pressed()` 零参数。路由本身可用，跳转写 `router.navigate()`，见[路由](#路由)。
- 不依赖 `document` 与 DOM API。`document` 仅为占位实现，不具备真实 DOM 语义。`navigator`、`location`、`fetch`、`structuredClone`、`MutationObserver` 等浏览器全局未提供。`@angular/platform-browser` 的 `Browser` / `BrowserModule` 因此不可用；路由不依赖它们，见[路由](#路由)。
- 构建过程不执行类型检查。TypeScript 类型错误、模板中的未知属性、`strictTemplates` 均不会导致 `ng build` 失败。类型检查需通过 `tsc --noEmit` 或编辑器完成。
- `tsconfig` 的 `lib` 中不应包含 `dom`。
- 一个应用对应一个根 `Control`，`tick()` 必须每帧调用。
- 文本节点渲染为 `Label`。富文本使用 `RichTextLabel`。
- 引擎枚举必须通过嵌套形式访问：`Control.SizeFlags.SIZE_EXPAND_FILL`、`Control.LayoutPreset.PRESET_FULL_RECT`。
- CSS 仅覆盖上述明确子集，完整清单见「样式」一节。不支持 CSS 嵌套（nesting）；如需嵌套语法，应将样式表保存为 `.scss`、`.sass` 或 `.less`，由构建期的 `preprocessCSS` 展开。

## 常见问题

| 现象 | 原因 |
| --- | --- |
| `No loader found for resource: res://dist/main.js (expected type: Script)` | 使用的是官方 Godot，而非 GodotJS 构建 |
| 启动时报 `godot class not found '__esModule'` | 使用了默认导入或命名空间导入，应改为具名导入 |
| `needs to be compiled using the JIT compiler, but '@angular/compiler' is not available` | 组件的 AOT 产物不完整，通常由自闭合的 Godot 标签（`<Label />`）导致 |
| `Xxx.yyy 不是真实属性，赋值已忽略 ` | 属性名拼写错误，或使用了驼峰写法。另一种成因是给自定义组件的宿主写了静态字符串属性（`<ui-card title="x">`），见[属性](#属性) |
| `Component 'Xxx' is not resolved: - templateUrl: ./xxx.html` | 该组件的模板存在解析错误，构建阶段不报错，运行时才暴露。常见写法：HTML 空元素写了结束标签（`<hr></hr>`）、Godot 标签自闭合（`<Label />`）。核对方法：`grep -c "ɵcmp" dist/main.js`，数量少于组件数即有模板未编译 |
| `@charset 不支持，已忽略 ` | 样式表含非 ASCII 字符（典型场景：`.scss` 中用 `/* */` 写中文注释，它们会保留到编译产物，sass 因此在开头插入 `@charset`）。改用 `//` 行注释，编译时会被剔除 |
| ScrollContainer 内的内容把整个界面撑宽 | 横向滚动模式为 `SCROLL_MODE_OFF` 时，子节点的最小宽度会向上传播。保持 `AUTO`，并在 `resized` 中把 `scroller.size.x` 写回内容节点的 `custom_minimum_size.x` |
| `(size_changed)="..."` 不报错也从不触发 | `size_changed` 是 `Window` 的信号，`Control` 上对应的信号是 `resized`。无法解析的事件名被静默忽略，见[事件](#事件)。核对方法：`ClassDB.class_has_signal(node.get_class(), "信号名")` |
| 界面不随窗口变大而放大，或窗口变小文字随之缩小 | 未启用内容缩放。设置 `display/window/stretch/mode=canvas_items` 与 `display/window/stretch/aspect=expand`，基准尺寸写在 `display/window/size/viewport_width` / `viewport_height`。启用后 CSS 中的 `px` 指基准像素；`@media` 读取的是挂载点的布局尺寸，不是 `Window.size`（物理像素） |
| `Unable to convert JS string to Godot float` | 静态属性为字符串且无法转换，改用属性绑定：`[min_value]="0"` |
| `Unable to convert JS null to Godot String` | 向强类型属性写入 `null`。自定义 `ControlValueAccessor` 的 `writeValue` 需处理空值 |
| `Failed to convert JS variable to Variant. Expected: Callable` | 信号只能连接 `Callable`，应使用 `tryConnectGodotSignal()` |
| 修改 `dist/*.js` 后引擎无输出 | 脚本资源缓存未刷新，重启引擎或执行 `godot --headless --path . --import` |
| 界面不更新 | `_process` 中未调用 `tick()`，或模板读取的状态不是 signal |
| `NG0201` / `NG0402` 无详细信息 | 生产构建移除开发期错误说明，使用 development 配置重建 |
| 表单可显示但无法回写，且无报错 | 缺少 `NG_VALUE_ACCESSOR` provider，或缺少 `[ngModelOptions]="{standalone: true}"` |
| `ng test` 等待引擎连接超时 | `engine.projectPath` 或 `engine.scene` 配置错误；端口会自增避开占用，连续 20 个都不可用时才会报错 |
| 直接运行 `res://engine_vitest.tscn` 无输出 | 该场景需要宿主先启动服务，应通过 `ng test` 执行 |
| `angular.json` 中某选项无效果 | 选项名拼写错误，未识别的选项被忽略且不报错 |
| 导航时刷 `unhandled promise rejection: NoMatch` | 引擎在 promise reject 当时就打印，不看下一句有无 `catch`。路由试匹配候选路由就靠这个异常，导航本身正常，见[路由](#路由) |
| 导航后页面不切换，但 `Location.path()` 已变 | 用了 `platform-browser` 的 `BOOTSTRAP` 入口，而不是 `bootstrapGodotApp`；或初始导航未触发（`provideGodotRouter` 已自动处理） |
| 只改路由参数时页面不更新 | 组件实例被复用，需订阅 `ActivatedRoute.paramMap`，不能只读 `snapshot` |
| `routerLink` 点了没反应，或 `Cannot read properties of undefined (reading 'button')` | `RouterLink` 不支持（它的 host listener 要读 `$event.button`，而 `Button.pressed()` 零参数）。改用 `(click)="go(...)"` 加 `router.navigate()`，见[路由](#路由) |

