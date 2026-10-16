# godot-angular

在 Godot 中运行 Angular。组件模板被渲染为 Godot 的 `Control` 节点树，不依赖 WebView，
也不需要编写 GDScript 界面代码。

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

必须使用 [GodotJS](https://github.com/godotjs/GodotJS/releases) 提供的引擎构建，
官方 Godot 无法加载 `.js` 脚本。下载对应平台的**编辑器构建**，解压后放入工程目录下的 `bin/`，
目录名与文件名需与下列一致，工具会自动按平台定位，无需配置环境变量：

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

该命令由 `godot-angular` 提供，输出目录需为专用目录。已配置 `GODOT_BIN` 或 `bin/` 时无需
额外参数，否则通过 `--bin <路径>` 指定引擎。

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

官方 Godot 同样自称 “Godot Engine”，`--version` 无法区分。判断依据：使用官方构建运行时会报
`No loader found for resource: res://dist/main.js (expected type: Script)`。

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

无法得到可用 `Control` 时降级为
`VBoxContainer`；标签名以大写字母开头时额外输出告警。判定基于 `ClassDB`，引擎新增控件无需
额外配置。

自定义组件的选择器建议使用小写且不与 Godot 类名冲突的形式（如 `ui-card`），其宿主元素降级为
`VBoxContainer`。

插值表达式 `{{ value }}` 生成 `Label` 节点。富文本与图文混排请直接使用 `RichTextLabel`。

### 属性

Godot 的 `@export` 变量对应 Angular 的属性绑定，例如 `[text]`、`[custom_minimum_size]`、
`[size_flags]`。

- `size_flags` 同时写入 `size_flags_horizontal` 与 `size_flags_vertical`。取值来自引擎枚举，
  枚举必须通过嵌套形式访问：`Control.SizeFlags.SIZE_EXPAND_FILL`。扁平写法
  （`Control.SIZE_EXPAND_FILL`）为 `undefined`。
- `[anchors_preset]` 可用，渲染器将其转换为 `set_anchors_preset()` 调用。
- 移除属性：`[attr.x]="null"` 或 `[x]="null"` 将属性还原为该类创建时的默认值。Godot 属性为强类型，不接受 `null`。

自定义组件的宿主元素同时是模板中的一个元素，静态属性与输入属性是两条独立通道。静态字符串属性
按节点属性写入宿主，宿主为 `VBoxContainer` 时不存在 `title`，因此输出一条「不是真实属性」告警；
输入通道仍会送达该值，显示不受影响。为组件输入传字符串字面量时应写成属性绑定：

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

事件名解析有两条路径：DOM 习惯名查别名表；其余名称原样作为 Godot 信号名查询。事件名不进行
大小写转换，`(buttonDown)`、`(textChanged)` 等驼峰写法无法解析。

| 写法 | 连接的 Godot 信号（按顺序取该控件拥有的第一个） |
| --- | --- |
| `(click)` | `pressed` → `button_up` → `item_selected` → `text_selected` |
| `(change)` | `text_changed` → `value_changed` → `item_selected` → `toggled` |
| `(input)` | `text_changed` → `text_submitted` → `gui_input` |
| `(submit)` | `text_submitted` → `activated` |
| `(focus)` / `(blur)` | `focus_entered` / `focus_exited` |
| `(button_down)` | `button_down`（引擎信号名，原样命中） |

`$event` 的规则只有一条：**实参个数永远与引擎信号一致**，不做任何补偿。
`LineEdit.text_changed(new_text)` 的 `$event` 就是新文本，无需回读属性；
`BaseButton.pressed()` 零参数，所以 `(click)` / `(pressed)` 的 `$event` 就是 `undefined`。

Godot 信号不携带事件对象（对比 DOM：每个监听器都收到一个 `MouseEvent`）。但“谁触发的”仍然
知道 —— `Callable` 绑在具体节点上，模板里每个元素有自己的闭包。需要真实输入事件（坐标 /
双击 / 修饰键）时绑 `Control.gui_input(event: InputEvent)`，那个信号递的是真的 `InputEvent`；
只是 `pressed` 把它丢掉了。

代价是依赖 `$event.xxx` 的第三方指令用不了，目前已知只有 `RouterLink`（见[路由](#路由)）。
曾经为了它补过一个事件对象，但那是拿全局语义换一个小功能，已推翻。

无法解析的事件名被静默忽略。Angular 会为每个 `(...)` 绑定调用 `renderer.listen()`，指令的
`@Output` 名称（`ngModelChange`、`textChange`）同样经过该路径，其行为与浏览器中
`addEventListener("ngModelChange")` 不触发、不报错一致。



### 组件查询

`viewChild()`、`viewChildren()`、`contentChild()`、`contentChildren()` 均可用，返回
`ElementRef`，其 `nativeElement` 为对应的 Godot 节点：

```ts
readonly ok = viewChild.required<ElementRef>("ok");
// this.ok().nativeElement 为 Button 节点
```

### 布局

以下行为由引擎的布局规则决定，写错时不报错也不告警，只表现为界面绘制异常。

**只有 `Container` 会为子节点分配尺寸。** `Button`、`Panel`、`Label` 均不是 `Container`：挂在
其下的子节点停留在自身最小尺寸，也不计入父节点的最小尺寸。含内容的按钮不能写成
`<Button><VBoxContainer>…</VBoxContainer></Button>`——`VBoxContainer` 拿不到宽度，内部 `Label`
会被压成一列竖排文字。可用的写法是 `PanelContainer`（属于 `Container`，把矩形分配给每一个
子节点）叠加一层 flat `Button` 作为点击层：

```html
<PanelContainer class="card-btn">
  <VBoxContainer><!-- 内容，尺寸由 PanelContainer 分配 --></VBoxContainer>
  <Button [flat]="true" (pressed)="go()"></Button>
</PanelContainer>
```

**`white-space` 在两个方向上都会改变最小宽度。** 它映射到 `autowrap_mode`：

- 不折行时，`Label` 的最小宽度等于整行文本宽度。中文不含空格，整条容器链会被顶宽。
- 折行时，`Label` 的最小宽度退化为 1px。在 `HBoxContainer` 中未设置 `SIZE_EXPAND_FILL` 的
  `Label` 会被压成一列竖排文字。

因此不要全局统一设置，按容器区分：纵向容器内默认折行，横向容器内默认不折行，横向容器内确需
折行时单独声明。类选择器的特异度高于类型选择器，`.wrap` 可覆盖 `HBoxContainer > Label`：

```scss
Label { white-space: normal; }
HBoxContainer > Label { white-space: nowrap; }
.wrap { white-space: normal; }
```

装饰用的色块使用 `Panel` 而不是空 `Label`：空 `Label` 仍占一行文字高度，`Panel` 的最小尺寸仅
来自 `width` / `min-height`，配合 `size_flags_horizontal = SHRINK_BEGIN` 可保持在指定的小尺寸
上。

## 状态与变更检测

本项目仅支持 zoneless 变更检测。`tick()` 每帧执行，但只刷新被标记为脏的视图；普通字段赋值
不会标记视图，模板读取不到新值。

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

状态全部由 signal 驱动时不需要 `ChangeDetectorRef`。若必须调用 `markForCheck()` 才能更新界面，
说明该状态应改为 signal，或由某个 signal 派生（`computed`、`linkedSignal`）。本项目不提供
强制触发变更检测的接口。

需要立即读取更新结果时，等待一帧后再读取。

## 表单

表单通过 Angular Forms 的 `ControlValueAccessor` 协议接入。内置指令由 `godot-angular/forms`
提供，该入口独立于 `core`，不使用表单时不会被计入产物。

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
- 适配器只负责搬运值，不进行类型转换、范围限制与去重。类型不符由引擎报错；越界下标由 Godot按自身规则处理。数据校验应在模型侧完成。
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

`registerOnChange`、`registerOnTouched`、`setDisabledState` 由基类实现。值存储在 Godot 属性上时
覆写 `writeValue`，并先调用 `super.writeValue(value)`。

## 样式

Godot 不提供 CSS 级联。本包将 CSS 的一个明确子集编译到 `Theme`、`StyleBoxFlat` 与节点属性。
按支持程度，属性分为三类：第一类在 Godot 中有等价落点；第二类有落点但语义不完全等价，
仅做转换提示；第三类没有落点，输出告警后忽略。下列清单与 `packages/css/runtime/properties.ts`
中的属性表逐条对应，`css-sweep.spec.ts` 校验两者保持一致。

### 等价落点的属性

| 属性 | Godot 落点 |
| --- | --- |
| `color` | theme 颜色 `font_color`；处于 `:hover` 等状态时自动改用对应的状态项（如 `font_hover_color`） |
| `caret-color` | theme 颜色 `caret_color`（LineEdit、TextEdit） |
| `font-size` | theme 字号 `font_size` |
| `opacity` | `CanvasItem.modulate.a` |
| `background-color`、`background` | 该类实际绘制的 stylebox 的 `bg_color`（Button 为 `normal`，PanelContainer 为 `panel`） |
| `border-color` | StyleBoxFlat 的 `border_color` |
| `border-top-color` 等单边颜色 | 同上。Godot 的 StyleBoxFlat 只有一个 `border_color`，四边同色；单边属性名输出告警，并按整圈边框处理 |
| `border-top-width` 等四边宽度 | StyleBoxFlat 的 `border_width_*`，四边相互独立 |
| `border-top-left-radius` 等四角半径 | StyleBoxFlat 的 `corner_radius_*`，四角相互独立 |
| `box-shadow` | StyleBoxFlat 的 `shadow_*` |
| `padding`、`padding-top` 等 | StyleBoxFlat 的 `content_margin_*` |

关于命名：`padding` 落在 `content_margin_*`，是命名差异而非语义差异。Godot 从内容视角命名
（stylebox 内侧为内容预留的空白，增大即压缩内容可用空间），CSS 从盒子视角命名（边框以内
的填充），两者指同一段距离。引擎另有 `expand_margin_*`，用于把绘制范围向外扩展到控件矩形
之外，不影响尺寸下界与可点击区域，与 padding 无关，本包不使用。反向的对应关系同样存在：
CSS 的 `margin`（外边距）在 Godot 的 Control 上不存在对应概念，MarginContainer 的 theme
常量 `margin_*` 实际是它为子节点预留的内侧空白，语义上更接近 padding。

简写属性在构建期展开为 longhand，级联因此定义在 longhand 上。参与展开的简写有：`border`、
`border-width`、`border-style`、`border-radius`、`background`、`margin`、`padding`、`flex`、`font`。
其中 `border-style` 仅识别 `solid` 与 `none`，其余线型无落点；`font` 仅提取字号，例如
`font: 14px/1.5 sans-serif` 展开为 `font-size: 14px`，字体族、字重与行高无落点。

### 仅做转换提示的属性

这类属性有落点，但 Godot 的模型与 CSS 不同，落点为近似值（属性表中标记为 `level: 3`）。

| 属性 | 落点与差异 |
| --- | --- |
| `width`、`min-width` | `custom_minimum_size.x`。Godot 只提供尺寸下界，不存在固定宽度；`%`、`em`、`rem` 输出告警并忽略 |
| `height`、`min-height` | 同上，写入 `custom_minimum_size.y` |
| `margin`、`margin-top` 等 | MarginContainer 的 theme 常量 `margin_*`。其他类不具备该常量，输出告警并忽略；本包不会为承载 margin 而向节点树插入容器 |
| `gap`、`row-gap`、`column-gap` | BoxContainer 的 theme 常量 `separation`（单轴，轴向由 `vertical` 决定）；GridContainer、FlowContainer、ItemList 的 `h_separation` 与 `v_separation`。`gap: 4px 8px` 表示行间距 4px、列间距 8px |
| `justify-content` | `BoxContainer.alignment`，仅支持 `flex-start`、`center`、`flex-end`；`space-between` 等取值输出告警。仅对容器类生效 |
| `flex`、`flex-grow` | 置位 `size_flags_*` 的 `SIZE_EXPAND` 并写入 `size_flags_stretch_ratio`；`flex-basis` 与 `flex-shrink` 无落点 |
| `visibility` | `CanvasItem.visible`；`hidden` 对应 `false` |
| `text-align` | `horizontal_alignment`；不具备该属性的非容器类（Button、LineEdit）改用 `alignment` |
| `cursor` | `Control.mouse_default_cursor_shape`。支持 `pointer`、`text`、`move`、`not-allowed`、`*-resize` 等关键字，表外取值输出告警 |
| `text-overflow` | `Label.text_overrun_behavior`。`clip` 与 `ellipsis` 可用；自定义省略号字符串无落点，引擎固定使用 `…` |
| `white-space` | `Label.autowrap_mode`。`nowrap`、`normal`、`pre`、`pre-wrap`、`break-all` 可用。Godot 不折叠空白，源码中的连续空格按原样绘制 |
| `direction` | `Control.layout_direction`。`ltr` 与 `rtl` 可用；`inherit` 属于 CSS 全局关键字，在进入属性表之前即被拦截 |

### 无落点的属性

以下属性不会生效。其落点要么是节点树结构（由 Angular 持有，本包不予修改），要么在 Godot 中
不存在对应概念。书写这些属性时输出一条说明原因的告警，不静默忽略。

| 分组 | 属性 |
| --- | --- |
| 布局结构 | `display`、`flex-direction`、`flex-flow`、`flex-wrap`、`flex-basis`、`flex-shrink`、`align-items`、`align-self`、`align-content`、`justify-items`、`order`、`aspect-ratio`、`grid`、`grid-template-columns` |
| 定位 | `position`、`inset`、`top`、`right`、`bottom`、`left`、`float`、`z-index` |
| 尺寸 | `max-width`、`max-height`（Godot 无尺寸上界）、`box-sizing` |
| 字体排印 | `font-family`、`font-weight`、`font-style`、`line-height`、`letter-spacing`、`word-spacing`、`text-decoration`、`text-transform`、`writing-mode` |
| 背景与边框 | `background-image`（`url()` 与 gradient）、`outline`、`border-style` 的非实线取值 |
| 视觉与动画 | `transform`、`transition`、`animation`、`animation-name`、`filter`、`backdrop-filter`、`will-change` |
| 交互与其他 | `overflow`、`user-select`、`pointer-events`、`content`、`::before`、`::after` |

关于 `outline`：Godot 的 StyleBoxFlat 没独立的描边层，因此 `outline` 无落点。引擎的
`expand_margin_*` 与 CSS 的 `outline` 有一点相似——都绘制在控件矩形之外且不影响布局（引擎
文档亦建议它配合 `border_width_*` 在控件矩形外描边），但它扩展的是整个 stylebox：底色一并
外扩，描边也只能沿用同一 stylebox 的 `border_color` 与 `border_width_*`，无法独立取色，
因此不构成 `outline` 的落点。另需注意 theme 常量 `outline_size` 与颜色 `font_outline_color`
指的是文字描边（对应 CSS 的 `-webkit-text-stroke`），与 `outline` 无关。

因此**焦点环必须用 `:focus` 自己画**：主题给 `Button/focus` 盒的描边（`border_width_* = 2`）
属于“没声明的字段”，只要基规则没写 `border-*` 就原样保留；一旦基规则写了 `border-color`
或 `border-width`，按层叠它会在 `focus` 盒里覆盖掉主题那圈描边，键盘焦点就看不见了。
写 `Button:focus { border-color: …; border-width: 2px; }` 即可恢复。

关于 `box-shadow`：第四段长度（spread）与 `inset` 无落点——本引擎的 StyleBoxFlat 没有
`shadow_expand`，也不支持内阴影，解析时输出告警（多层阴影仅取第一层）。

### 通用属性与限定属性

上述清单中的落点能否真正生效，还取决于节点所属的类。判定依据有二：一是 theme 词汇表
（由 `pnpm dump:vocabulary` 从引擎导出，当前覆盖 44 个类），二是节点自身的属性。两者任一
不满足，运行期输出一条告警并忽略，不会写入不生效的 override。构建期 lint 仅校验语法与
选择器拼写，不包含这项检查。

**与类无关的属性**：对任意 `Control` 均成立。

| 属性 | 落点 |
| --- | --- |
| `opacity` | `CanvasItem.modulate.a` |
| `visibility` | `CanvasItem.visible` |
| `width`、`min-width`、`height`、`min-height` | `Control.custom_minimum_size` |
| `flex`、`flex-grow` | `Control.size_flags_*` 与 `size_flags_stretch_ratio` |
| `cursor` | `Control.mouse_default_cursor_shape` |
| `direction` | `Control.layout_direction` |

**取决于 theme 词汇表的属性**：下表列出当前 dump 中成立的类，未列出的类不成立。

| 属性 | 需要的 theme item | 成立的类 |
| --- | --- | --- |
| `color` | `font_color`（RichTextLabel 为 `default_color`） | Button、CheckBox、CheckButton、CodeEdit、ColorPickerButton、FoldableContainer、ItemList、Label、LineEdit、LinkButton、MenuBar、MenuButton、OptionButton、ProgressBar、Tree、TextEdit |
| `font-size` | `font_size`（RichTextLabel 为 `normal_font_size`） | 上一行的 16 个类，再加 TabContainer、TabBar |
| `caret-color` | `caret_color` | LineEdit、TextEdit、CodeEdit |
| `background-color`、`background`、`border-*`、`padding`、`box-shadow` | 该类需绘制 stylebox（`panel`、`normal`、`background`、`focus` 之一） | Button、CheckBox、CheckButton、CodeEdit、ColorPickerButton、FoldableContainer、GraphEdit、GraphFrame、GraphNode、ItemList、Label、LineEdit、LinkButton、MenuBar、MenuButton、OptionButton、Panel、PanelContainer、ProgressBar、RichTextLabel、ScrollContainer、TabContainer、Tree、TextEdit |
| `margin`、`margin-top` 等 | `margin_left` / `margin_top` / `margin_right` / `margin_bottom` | MarginContainer（仅此一类） |
| `gap`、`row-gap`、`column-gap` | `separation`，或 `h_separation` 与 `v_separation` | 前者：BoxContainer、HBoxContainer、VBoxContainer、HSeparator、VSeparator、SplitContainer、HSplitContainer、VSplitContainer、ColorPicker、GraphNode；后者：GridContainer、FlowContainer、HFlowContainer、VFlowContainer、ItemList、Tree |

**取决于节点属性的属性**：

| 属性 | 需要的节点属性 | 成立的类 |
| --- | --- | --- |
| `justify-content` | `alignment`，且该类属于 `Container` | BoxContainer、HBoxContainer、VBoxContainer、FlowContainer 系 |
| `text-align` | `horizontal_alignment`；不具备时回退到 `alignment`（容器类除外） | Label、RichTextLabel；Button、LineEdit |
| `text-overflow` | `text_overrun_behavior` | Label、Button、LinkButton、ItemList |
| `white-space` | `autowrap_mode` | Label、Button、RichTextLabel、TextEdit |

词汇表未收录的类（`Control`、`Container`、`CenterContainer`、`AspectRatioContainer`、
`TextureRect`、`ColorRect` 等）不具备任何 theme item，外观类属性对其一律输出告警。
告警按「属性 + 类名」去重，同一组合仅输出一次。

### 伪类状态

`:hover`、`:active`、`:focus`、`:pressed` 由 Godot 信号驱动；`:checked`、`:disabled`、`:enabled`、
`:read-only` 除了信号还由**节点属性**驱动（见下表）。声明的目标 theme item 由**选择器自身声明的
状态伪类**决定，与节点当前处于哪些状态无关，无需额外属性：

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

- **`:hover` 会向祖先冒泡，与 CSS 一致**。引擎只在「最深接收控件 + 它往上直到第一个
  `mouse_filter = STOP` 的祖先」这条链上发 `mouse_entered`：一个 STOP 子控件（`Button` /
  `CheckBox` / 用来撑位的空 `Control`）会把事件整个吃掉，父级一个信号都收不到。于是浏览器里
  天经地义的 `.list-row:hover { border-color: … }`（指针停在行内的 `CheckBox` 上，整行也得亮）
  在引擎里会退化成「只有指针精确落在行自身那一圈 padding 上才亮」。本库补齐了冒泡：任一节点
  报告进入悬停，它的所有 Control 祖先一并进入 `:hover`，退出时同样一路撤掉。同一个祖先可以被
  多个来源同时举着（它自身 + 某个子孙），只有最后一个来源消失才撤悬停，因此父子先后进出也不会
  互相顶掉。节点被 `queue_free` / 移出节点树时按退出处理（引擎此时不再补发 `mouse_exited`）。
  `:focus` 不冒泡是对的（CSS 里那叫 `:focus-within`）；`:active` / `:pressed` 也只落在控件自身，
  浏览器会连祖先一起点亮的那条行为本库未做。

- **勾选态复用 `pressed` 落点**。Godot 的开关控件（`CheckBox` / `CheckButton` /
  `toggle_mode=true` 的 `Button`）在 `button_pressed=true` 时绘制的是 `pressed` 盒与
  `font_pressed_color`，而不是 `normal` / `font_color`。因此浅色主题下仅声明
  `CheckBox { color: … }` 不足以覆盖勾选态，需同时声明 `CheckBox:checked { color: … }`
  （或为勾选态单独准备一份 `font_pressed_color`）。
  `hover` 与勾选同时成立时使用合成 item（`hover_pressed` / `font_hover_pressed_color`）。
  反之，`toggle_mode=false` 的普通 `Button` 写入 `button_pressed=true` 不会生效（引擎的
  `is_pressed()` 即 `toggle_mode && button_pressed`，setter 自带门控），因此 `:checked`
  仅对开关控件有效；使用 `[toggle_mode]` + `[button_pressed]` 绑定时必须**先写 `toggle_mode`**，
  之后写入的 `button_pressed` 才会被保留。
- **颜色落点的重定向仅取决于主体段的伪类**。主体段指选择器最右侧的复合选择器，即被样式命中的
  节点本身。`.card:hover .btn` 要求的是卡片悬停，与按钮自身状态无关，因此仍写基 item
  （`:not(:hover)` 同理不计入状态要求）。基规则的 `color` 永远写 `font_color`，不会被顶进
  `font_disabled_color`——那条 override 属于 `:disabled` 规则，基规则没资格写。
- **stylebox 走层叠合成，与颜色是两套口径**。Godot 为每个状态各存一个完整、互不继承的盒，
  而 CSS 的 `:hover` 只覆盖它自己声明的那几条、其余沿用基规则。因此本库按字段来源合成：

  > **状态盒 = 引擎该状态的默认盒 ⊕ 基规则声明过的字段 ⊕ 该状态声明的字段**

  一句话：**没声明的字段一个字节都不碰；声明过的字段必须贯穿所有状态。**于是
  `Button.primary { padding: 8px 12px; border-radius: 9px }` 在悬停、按下、获得焦点时
  都成立（不写 `:hover` 也不会塌回引擎默认的直角小盒），而作者没写过的底色、描边粗细
  仍由主题决定，引擎自己的悬停加深不会被抹掉。

  推论：基规则写了 `background-color`，禁用态也就还是那个底色（与浏览器一致——作者写了
  background，主题的禁用底色就被覆盖）。需要专属状态外观必须显式声明：

```css
Button.primary { background-color: #2b7fff; padding: 8px 12px; border-radius: 9px; }
Button.primary:disabled { background-color: #b9c6d6; }  /* 不写就沿用上面那条蓝 */
Button.primary:hover  { background-color: #4a90ff; }    /* 不写就沿用上面那条蓝 */
Button.primary:focus  { border-color: #6cb2f5; }        /* 焦点环同理，见下方 outline */
```

  两个盒名集合之外的状态不参与合成：`Tree` 的 `hovered`、`TabBar` 的 `tab_hovered`、
  `FoldableContainer` 的 `title_hover_panel` 是**行级 / 标签级 / 标题条级**状态，CSS 的
  `:hover` 说的不是它们，因此 `Tree:hover` 落的是整棵树的 `panel`，不是行高亮盒。

- **基规则与状态规则各自写自己的 item，互不覆盖**。`Button.primary { color: 蓝 }` 写 `font_color`，
  `Button.primary:hover { color: 红 }` 写 `font_hover_color`，两份 override 同时存在，引擎按当前
  状态各自读取。层叠的“后者覆盖前者”只在**同一落点内**比较特异度与源码顺序：

```css
Button.primary       { color: #2b7fff; }  /* → font_color */
Button.primary:hover { color: #ff4040; }  /* → font_hover_color，不被下一条抢走 */
Button.primary.x     { color: #00c853; }  /* → font_color，只覆盖同落点的基规则 */
```

  状态规则不再命中（或整张样式表被移除）时，它写过的 item 会被显式撤销，不会漏出上一轮的
  颜色；颜色因此回落到主题默认值（stylebox 不同：回落到基规则声明的值，见上条）。
- **属性驱动的伪类仅对声明了该属性的控件有效**。下表列出各伪类的前置属性与适用类；
  不满足前置条件的伪类无法推导，运行时按「伪类 × 类名」组合告警一次：

| 伪类 | 前置引擎属性 | 具备该属性的控件 | 不具备（伪类无效） |
| --- | --- | --- | --- |
| `:checked` | `button_pressed`（且 `toggle_mode=true`） | `Button` / `CheckBox` / `CheckButton` / `LinkButton` / `MenuButton` | `LineEdit` / `TextEdit` / `Slider` / `SpinBox` / `ItemList` / `ScrollBar` / `ColorPicker` |
| `:disabled` `:enabled` | `disabled` | `BaseButton` 系：`Button` / `CheckBox` / `CheckButton` / `OptionButton` / `MenuButton` / `LinkButton` | `LineEdit` / `TextEdit` / `Slider` / `SpinBox` / `ItemList` / `ScrollBar` / `ColorPicker` |
| `:read-only` | `editable`（`false` 时成立） | `LineEdit` / `TextEdit` / `SpinBox` / `Slider` | `Button` 系 / `ItemList` / `ScrollBar` / `ColorPicker` |

  上表末列的控件如需禁用外观，只能通过 class 通道声明。其中 `ItemList` / `ColorPicker` /
  `ScrollBar` 两个前置属性均不具备，表单指令只能以 `mouse_filter = MOUSE_FILTER_IGNORE`
  表达不可交互；而**鼠标穿透不等价于禁用**（`Label` 等控件默认即为 `IGNORE`），因此本库
  不会将 `IGNORE` 推导为禁用态。这三类的禁用外观请使用 class 通道：

```html
<ItemList class="files" [class.off]="locked()"></ItemList>
```
```css
.files.off { color: #666; }
```

- **仅具备 `editable` 的控件，其禁用状态推导为 `:read-only` 而非 `:disabled`**。`LineEdit` /
  `TextEdit` / `Slider` / `SpinBox` 类上不存在 `disabled` 属性（Godot 文档中其属性集仅含
  `bool editable`），表单指令的 `setDisabledState()` 只能写 `editable = !isDisabled`，而
  `editable=false` 推导出的仍是 `:read-only`。于是同一段模板：

```html
<LineEdit class="field" [ngModel="note()" [disabled]="locked()"></LineEdit>
```
```css
.field:disabled   { color: #666; }  /* ✗ 永远不会命中：LineEdit 没有 disabled 属性 */
.field:read-only  { color: #666; }  /* ✓ 表单禁用与只读在这里共用一个落点 */
```

  这是引擎的属性粒度所致，并非适配层遗漏通道：`editable` 一个属性同时承载 CSS 中
  `disabled` 与 `readonly` 两个语义，本库无法从属性值区分二者。声明这类控件的禁用样式时
  应直接使用 `:read-only`（或采用上述 class 通道）。需要区分时，只有 class 通道能够区分：

```html
<LineEdit class="field" [class.off]="locked()" [class.view]="isView()"></LineEdit>
```
```css
.field.view { color: #999; }   /* 只读 */
.field.off  { color: #666; }   /* 表单禁用 */
```

- **同一条选择器写了多个状态伪类时，按引擎的 `get_draw_mode()` 合成一个 item**，顺序是
  `disabled` → `active`/`pressed`/`checked` → `selected` → `hover` → `focus` → `read-only`。
  例如 `.btn:hover:active` 落到 `hover_pressed` / `font_hover_pressed_color`。`disabled` 居首
  对应引擎先判定 `is_enabled()`、后判定勾选与悬停的顺序：一个已勾选的禁用 `CheckBox` 读取
  的是 `font_disabled_color`，此时写入 `font_pressed_color` 不会被读取。注意这只作用于
  **单条选择器内部**：`.btn:hover` 与 `.btn:disabled` 是两条规则，各自写 `hover` 与 `disabled`
  两个盒，互不覆盖。
- **状态属性没有变更信号**。`disabled` / `editable` 在 Godot 中不发出任何变更通知
  （`button_pressed` 赋值会附带发出 `toggled`，但 `set_pressed_no_signal()` 不会），因此由
  以下写入方负责标脏，级联在帧末重算时从属性上读回伪类：模板绑定（`[button_pressed]` /
  `[disabled]` / `[editable]`）、表单指令（`ngModel` / `formControl` 的 `writeValue` /
  `setDisabledState`）。直接对节点赋值（`node.button_pressed = true`）绕过上述通道，需手动标脏：

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

`class` 为有效输入：`[class.disabled]="busy()"`、`[class]` 与静态 `class="a b"` 在帧末重新计算
级联。特异度按 CSS 算法计算，`!important` 独立成层（普通 → 内联 → important）。
`ViewEncapsulation` 的分层与浏览器端一致：`Emulated`（默认）为局部层，`None` 与 `ShadowDom`
归入全局层；Godot 没有 shadow root，`ShadowDom` 会告警并按 `None` 处理。

支持的选择器：`*`、类型选择器（对应节点类名）、`.class`、`#id`（对应 Angular 的 `id` 绑定，
不是 `node.name`）、`[attr]`、`[attr=v]`、后代 `A B`、子选择器 `A > B`、相邻 `A + B`、
兄弟 `A ~ B`、并列 `A.b`、逗号分组。组件样式中的 `:host` 与 `:host.on` 由 Angular 编译为宿主
属性选择器。

`@media` 支持 `width`、`height`、`orientation`、`prefers-color-scheme`（`aspect-ratio` 这类
特性不在环境键里，写了也不会命中）。自动注入只提供 `width` / `height` /
`prefers-color-scheme`，`orientation` 与 `device-width` / `device-height` 需要自行注入：

```ts
inject(STYLE_RUNTIME).setEnv({ width: 1280, height: 720, "prefers-color-scheme": "dark" });
```

自动注入的宽高量的是**挂载点（`GODOT_ROOT`）自己占多大**，不是操作系统窗口多大：局部挂载
就是局部断点。「快速开始」那个例子的挂载点是 1024×768，那么 `@media (max-width: 1100px)` 就会
命中，不管窗口实际有多宽。两种情况退回量窗口：挂载点不是 `Control`，或它还没被布局过（尺寸 0）。

量到的一律是**布局坐标系**（与 `Control.size` 同一坐标系），不是窗口物理像素：开了内容缩放时
两者差一个缩放因子——基准 1280×720 的项目在 1920×1080 的窗口里布局宽度仍是 1280，断点按
1280 写就对了，不要拿 `Window.size` 换算。挂载点铺满窗口（`PRESET_FULL_RECT`）时，它的 `size`
与窗口视口逐位相等，两种量法等价。

CSS 自定义属性（`--x`、`var(--x)`）已支持。

以下伪类语法合法，但在 Godot 中既无信号也无属性可推，不会自动生效，样式表使用时输出一次告警：
`:valid`、`:invalid`、`:indeterminate`、`:selected`、`:required`、`:optional`。请改用 class
通道，或显式设置：

```ts
inject(STYLE_RUNTIME).setPseudoClass(node, "selected", true);
```

属性驱动的伪类（`:checked` / `:disabled` / `:enabled` / `:read-only`）**只对真有那个属性的控件
有效**：`:checked` 要 `button_pressed`（开关控件），`:disabled` / `:enabled` 要 `disabled`
（`BaseButton` 以次），`:read-only` 要 `editable`（`LineEdit` / `TextEdit` / `Slider` / `SpinBox`）。
样式表用到了某伪类、而当前这类控件没有对应属性时，会按「伪类 × 类名」告警一次：

```
ItemList 没有 disabled 属性，:disabled 在它身上推不出来（不会自动生效）。
如需该外观，请走 class 通道（[class."disabled"]="…" 配合 CSS .x.disabled）。
```

`:selected` 有真实落点（`ItemList` / `Tree` 的 `selected` 盒与 `font_selected_color`），只是引擎
没有“整个控件被选中”这种信号：行级选中属于 ItemList 内部，CSS 选择器只能到控件粒度。

以下特性不支持，处理时输出一次告警并忽略：`calc()`、`url()`、`@keyframes` 与动画、
`position: fixed` / `absolute`、`overflow` 滚动裁切、`grid` 的真实网格（仅转换为
`GridContainer` 的列数）、字体加载、伪元素 `::before` 与 `::after`。

CSS 嵌套（nesting）不支持。解析器将声明块内部的 `{` 视为语法错误，下列写法会输出一条
告警，且其中的声明不会生效：

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

如需使用嵌套语法，应将样式表保存为 `.scss`、`.sass` 或 `.less`。构建期会先调用 vite 的
`preprocessCSS`（与组件 `styleUrls` 使用同一入口），由预处理器展开嵌套后再交给解析器。
全局样式与 `styleUrls` 均适用；扩展名为 `.css` 的文件不做预处理。

长度单位仅支持 `px`、`%` 与不带单位的数值（按 `px` 处理）。`em`、`rem`、`vw`、`vh`、`cm`、
`pt` 等单位会告警并丢弃该条声明。

`add_theme_*_override` 与 `theme_type_variation` 按条目互斥：已写入 override 的条目在切换变体后
仍返回 override 值。同一条目不应同时使用静态主题变体与运行时级联，默认全部使用运行时级联。

无显示环境（CI、无头模式）中根窗口是个 dummy 值：实测 `Window.size` 与 `get_visible_rect()` 均为
`64×64`（4.6.1 与 4.8-dev6 一致），`DisplayServer.screen_get_size()` 为 `(0, 0)`，`is_dark_mode()`
恒为 `false`。也就是说无头下媒体查询会静默落在**窄屏分支**（64 ≤ 任意 `max-width` 断点），要
确定性结果就显式 `setEnv`。真实窗口尺寸变化与系统深色模式的切换效果需在带显示的环境中确认。

## 路由

`@angular/router` 原样可用，不需要改它一行。路由对平台的全部依赖收敛在三个 token 上，
`provideGodotRouter` 提供 Godot 侧的实现：

| token | 浏览器实现 | Godot 实现 |
| --- | --- | --- |
| `PlatformLocation` | `window.location` + `window.history` | 内存历史栈（`GodotPlatformLocation`） |
| `ViewportScroller` | 浏览器视口 | 空实现（滚动属于 `ScrollContainer`，与视口无关） |
| `TitleStrategy` | 写 `document.title` | 写窗口标题 |

`DOCUMENT` 不在此列：它是 core 里无 factory 的裸 token，而当前装配链里没人 `inject(DOCUMENT)`
（`route.title` 已改走 `GodotTitleStrategy`，`PathLocationStrategy` 的兜底读被
`getBaseHrefFromDOM()` 返回的空串断在 `??` 上），所以不提供。

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

`router-outlet` 不是 Godot 类，渲染为一个**空的** `VBoxContainer`：它只是锚点，激活的页面插在
它**后面**（与它平级），不是它的子节点。浏览器里也是这样 —— 路由内容本来就是
`<router-outlet>` 的兄弟（所以才有 `router-outlet + *` 这种选择器），这里只是把同样的
结构搬到了节点树上。

`Router`、`Location`、`ActivatedRoute` 从 `@angular/router` 直接导入，用法与浏览器一致。
`Location.back()` / `forward()` 有效。

### routerLink 不支持

`RouterLink` / `RouterLinkActive` 在 Godot 里用不了，跳转请写 `(click)="go(...)"` 加
`router.navigate()`。原因：`RouterLink` 的 host listener 是
`click: onClick($event.button, $event.ctrlKey, …)`，而 `Button.pressed()` 零参数，
`$event` 为 `undefined`，读成员当场 TypeError。

两条退路都实测过，都不通：

- **继承覆写 `onClick` 救不了**。Angular 的 `inheritHostBindings` 是**合并**而非覆盖
  （先跑 `superHostBindings(rf, ctx)` 再跑子类那份），报错在 Angular 生成的
  `RouterLink_click_HostBindingHandler` 里，根本进不到 `onClick`。
- **自己写一个同名指令会丢 `routerLinkActive`**。`RouterLinkActive` 靠
  `@ContentChildren(RouterLink)` 找链接，而 Angular 匹配指令用的是 `def.type === token`
  精确相等，不走 `instanceof`，子类与替身指令都查不到。

这不是“差一步就能支持”：要支持就得给所有零参数信号伪造 `$event`，拿全局语义换一个小功能。

### 路由的边界

- **URL 不持久化**。历史栈活在内存里，进程结束即消失，重启从起始 URL 重新开始。
- **起始 URL 由 `GODOT_INITIAL_URL` 声明**，默认 `/`。Godot 没有地址栏，“从哪个页面开始”
  必须从外部进来（启动参数、配置、存档）：

  ```ts
  bootstrapGodotApp(App, root, [
    provideGodotRouter(routes),
    { provide: GODOT_INITIAL_URL, useValue: parseDeepLinkFromArgv() },
  ]);
  ```

  它不只是“少写一次 `navigate`”：初始导航就是导航到这个地址，所以**路由表里没有空路径时
  它是唯一入口** —— 不给则初始导航匹配不上，outlet 保持空（而不是先渲染再跳）。
- **URL 解析就是 WHATWG 标准本身**：跑的是 `whatwg-url-minimum`（whatwg-url 的零依赖版，
  拿原版对拍过 24222 条用例逐条一致），不是手写的子集。所以 `/a/../b` 折叠成 `/b`、
  `about` 相对当前目录解析、`?q=1` 会丢掉锚点、需要编码的字符编一次不会二次编码 ——
  与浏览器里 `history.pushState(url)` 同源。代价约 215KB 源码。
- **`URL` / `URLSearchParams` 默认可用**。GodotJS 原生没有（V8 只给 ECMAScript），库会把它们
  装到全局，用户代码解析启动参数 / 存档里的链接可以直接 `new URL(...)`。
- **懒加载不可用**。`loadComponent` / `loadChildren` 依赖运行时动态 `import()`，GodotJS 不支持。
- `withHashLocation()` 可用（URL 落在 `#` 上）；`withExperimentalPlatformNavigation()` 不可用，
  它要浏览器的 Navigation API。
- **参数变化要订阅 `paramMap` / `queryParamMap`**。只改参数时同一个组件实例被复用，
  读 `snapshot` 的普通 getter 不会重跑变更检测——这是 Angular 的既有行为，与 Godot 无关。
- `route.title` 写窗口标题。无显示环境（CI / `--headless` / 专用服务器）由 `GODOT_HEADLESS`
  **主动声明**，库不去猜 `DisplayServer.get_name()`：猜错只多一行日志，靠猜永远不会在 CI
  上被发现。默认 `false`（按有窗口处理），无显示时自己传：

  ```ts
  bootstrapGodotApp(App, root, [provideGodotRouter(routes), { provide: GODOT_HEADLESS, useValue: true }]);
  ```

  声明为无头后不碰窗口，但标题仍记录在 `GodotTitleStrategy.currentTitle`，组件可以把它
  绑到标题栏 `Label` 上，因此无头下页面标题照样有地方显示。

  写的是根窗口的 `Window.title`（而不是 `DisplayServer.window_set_title()`）：后者只改操作系统
  那侧的文字、**不回写** `Window.title`，而 Godot 又没有 `DisplayServer.window_get_title()`，
  于是当前标题从写入那一刻就再也读不回来。走 `Window.title` 后 `get_window().title` 与
  `title_changed` 都是可信的（取不到窗口时才退回 `DisplayServer`）。

### 读取当前标题

路由器先派发 `NavigationEnd`，随后才更新标题，两者位于同一段同步代码中。在 `NavigationEnd`
处理器里读 `GodotTitleStrategy.currentTitle`，得到的是上一次导航的标题（首次导航时为空字符串）。
延后一个微任务即可：

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

产物名称为 `output` 与文件相对 `input` 的路径之和（去除 `.ts` 扩展名）。`input` 缺省取 `glob`
中第一个含通配符的段之前的部分，因此产物名称仅由配置决定，与实际匹配结果无关。

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

`engine_vitest.tscn` 指向 `res://dist-engine-test/vitest-entry.js`，该入口由构建器生成，
使用方无需编写任何测试入口文件。`specInclude` 是测试文件匹配模式的唯一来源。

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

`godot-angular/testing` 提供测试环境（`initGodotTestEnvironment`、`GodotTestingModule`）、
节点查询（`findAllNodes`、`nodeTexts`、`newNode`）与等待引擎帧（`awaitFrames`）。等待变更检测
统一使用官方的 `fixture.whenStable()`。

布局计算与 `queue_free` 需要真实帧：`add_child` 之后立即读取 `size` 为 0，测试中使用
`awaitFrames(2)`。

命令行过滤参数透传至 vitest：

```bash
ng test --file-filters=godot     # 按文件过滤
ng test --filter="信号"           # 按用例名过滤
ng test --reporters=json
```

覆盖率在 `angular.json` 中启用（`"coverage": true` 或完整配置对象）。

## 构建选项

`godot-angular` 提供两个 builder。选项名称与语义沿用官方 `@angular/build:application`，
未提供的能力通过 `viteConfig` 配置。

### `godot-angular:application`

| 选项 | 说明 |
| --- | --- |
| `entries` | 入口 `.ts` 文件，可配置多个，形状沿用 `assets` 的 `{glob,input,output,ignore}` |
| `resRoot` | `outputPath` 对应的 `res://` 前缀 |
| `viteConfig` | vite 配置文件路径，叠加在本 builder 之上；`plugins` 为追加而非替换 |
| `styles` | 全局样式表，构建期解析并编入产物，运行时作为 application 层样式参与级联。不接受 `bundleName` 与 `inject` |
| `tsConfig` `outputPath` `optimization` `sourceMap` `define` | 与官方同名同义 |
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

包含上表中除 `entries`（由构建器合成）与 `styles`（测试链路不使用样式构建，配置后被忽略）
之外的共用选项，另加：

| 选项 | 说明 |
| --- | --- |
| `specInclude` | 必填。测试文件 glob，相对 workspaceRoot |
| `exclude` | 排除的测试文件 glob |
| `engine` | 必填。`projectPath`、`scene`、`port`（起始端口，被占则 +1）、`connectTimeout`、`godotBin`、`noLaunch` |
| `skipRun` / `skipBuild` | 仅构建不执行 / 仅执行不构建 |
| `reporters` / `filter` / `fileFilters` | 透传 vitest |
| `coverage` | `true` 或配置对象：`enabled`、`include`、`exclude`、`instrument`、`sourceRoot`、`reportsDirectory`、`reporter`、`thresholds`、`reportOnFailure` |
| `watch` | vitest 监听模式，修改测试文件后重新执行 |

不提供 `setupFiles`：引擎中执行的是已编译的 bundle，无法在运行时载入未编入该 bundle 的文件。
等价做法是在测试文件的 `beforeEach` 中完成全局环境准备。

命令行选项使用 kebab-case（`--skip-build`）。对象类型选项（`engine`、完整形式的 `coverage`）
只能通过 `angular.json` 配置。

## 导入路径

所有 API 位于二级入口，包主入口不导出任何内容。

| 路径 | 内容 |
| --- | --- |
| `godot-angular/core` | 运行时：`bootstrapGodotApp`、`GodotAngularApp`、`GODOT_ROOT`、`tryConnectGodotSignal`、`godotClass`、`GodotRenderer`、样式运行时（`StyleRuntime`、`STYLE_RUNTIME`）、解析工具（`resolveTag`、`resolveSignalName`、`nodeHasProperty`） |
| `godot-angular/builder/vite/polyfills.mjs` | 运行环境补丁（`queueMicrotask` / `requestAnimationFrame` / `performance` / `document` / `URL` / `URLSearchParams` / `atob`）。**不是库入口**，属于构建器内部；由构建器自动注入，无需手动导入 |
| `godot-angular/forms` | 表单指令与 `GodotControlBase`、`GodotValueAccessorBase` |
| `godot-angular/css` | CSS 子集的纯逻辑层（解析、选择器、级联、词表）——**库内部实现层**，不保证兼容 |

样式落点相关的 `applyStyle` / `clearStyle` / `styleLedger` 与整个 `godot-angular/css` 入口同属
内部实现，不在公开清单内，其签名与行为看库内需求变动，不遵循语义化版本。需要命令式改变外观请
使用组件样式 / class 选择器，或内联绑定 `[style.x]`。
| `godot-angular/router` | `provideGodotRouter`、`GodotTitleStrategy`，并转发 `GODOT_HEADLESS` / `GODOT_INITIAL_URL` / `GodotPlatformLocation`。需自行安装 `@angular/router` |
| `godot-angular/testing` | 测试工具 |
| `godot-angular/vitest` | 宿主侧 vitest 插件 |
| `godot-angular/vitest/runtime` | 引擎侧 vitest worker |

可执行命令：`npx godot-typings`。

## 限制

- 仅支持 zoneless 变更检测。`tick()` 是变更检测的驱动点。
- 不支持运行时懒加载（路由 `loadComponent` 等）。运行环境的动态 `import()` 不受支持。
  构建期静态分包可用，运行时按需载入模块不可用。
- 不支持 `RouterLink` / `RouterLinkActive`：它们的 host listener 要读 `$event.button`，
  而 `Button.pressed()` 零参数。路由本身可用，跳转写 `router.navigate()`，见[路由](#路由)。
- 不依赖 `document` 与 DOM API。`document` 仅为占位实现，不具备真实 DOM 语义。
  `navigator`、`location`、`fetch`、`structuredClone`、`MutationObserver` 等浏览器全局未提供。
  `@angular/platform-browser` 的 `Browser` / `BrowserModule` 因此不可用；路由不依赖它们，
  见[路由](#路由)。
- 构建过程不执行类型检查。TypeScript 类型错误、模板中的未知属性、`strictTemplates` 均不会导致
  `ng build` 失败。类型检查需通过 `tsc --noEmit` 或编辑器完成。
- `tsconfig` 的 `lib` 中不应包含 `dom`。
- 一个应用对应一个根 `Control`，`tick()` 必须每帧调用。
- 文本节点渲染为 `Label`。富文本使用 `RichTextLabel`。
- 引擎枚举必须通过嵌套形式访问：`Control.SizeFlags.SIZE_EXPAND_FILL`、
  `Control.LayoutPreset.PRESET_FULL_RECT`。
- CSS 仅覆盖上述明确子集，完整清单见「样式」一节。不支持 CSS 嵌套（nesting）；如需嵌套
  语法，应将样式表保存为 `.scss`、`.sass` 或 `.less`，由构建期的 `preprocessCSS` 展开。

## 常见问题

| 现象 | 原因 |
| --- | --- |
| `No loader found for resource: res://dist/main.js (expected type: Script)` | 使用的是官方 Godot，而非 GodotJS 构建 |
| 启动时报 `godot class not found '__esModule'` | 使用了默认导入或命名空间导入，应改为具名导入 |
| `needs to be compiled using the JIT compiler, but '@angular/compiler' is not available` | 组件的 AOT 产物不完整，通常由自闭合的 Godot 标签（`<Label />`）导致 |
| `Xxx.yyy 不是真实属性，赋值已忽略` | 属性名拼写错误，或使用了驼峰写法。另一种成因是给自定义组件的宿主写了静态字符串属性（`<ui-card title="x">`），见[属性](#属性) |
| `Component 'Xxx' is not resolved: - templateUrl: ./xxx.html` | 该组件的模板存在解析错误，构建阶段不报错，运行时才暴露。常见写法：HTML 空元素写了结束标签（`<hr></hr>`）、Godot 标签自闭合（`<Label />`）。核对方法：`grep -c "ɵcmp" dist/main.js`，数量少于组件数即有模板未编译 |
| `@charset 不支持，已忽略` | 样式表含非 ASCII 字符（典型场景：`.scss` 中用 `/* */` 写中文注释，它们会保留到编译产物，sass 因此在开头插入 `@charset`）。改用 `//` 行注释，编译时会被剔除 |
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

