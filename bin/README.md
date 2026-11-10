# bin/ —— GodotJS 引擎二进制放置目录

- <https://github.com/godotjs/GodotJS/releases>（上游）
- <https://github.com/wszgrcy/GodotJS/releases>（本项目维护者自编译）

当前对齐 **GodotJS 1.3.8**（Godot 4.7.2 + V8 12.6），下载 `linux-editor-4.7.2-v8.zip` /
`windows-editor-4.7.2-v8.zip`。目录名只区分平台与运行时，**不带引擎版本号**，升级时直接覆盖同一个文件。

```
bin/
├── linux-v8/
│   ├── godot.linuxbsd.editor.x86_64
│   └── icudtl.dat
└── windows-v8/
    ├── godot.windows.editor.x86_64.exe
    ├── godot.windows.editor.x86_64.console.exe
    └── icudtl.dat
```

## icudtl.dat 必须跟二进制放在一起

release 包里带一份 `icudtl.dat`（V8 的 ICU 语言资源，约 10 MB），解压后天然就在
可执行文件旁边，**别删也别挪**。引擎按这个顺序找它：项目设置
`GodotJS/runtime/intl/icu_data_path` > 环境变量 `GODOTJS_ICU_DATA` > 可执行文件旁边 >
`res://icudtl.dat`。

少了它不会安静降级，而是坏得很难看懂：

- `Intl.Collator` / `NumberFormat` / `PluralRules` 抛 `Internal error. Icu error.`
- `Date.prototype.toLocaleDateString`、`Intl.Segmenter` **直接终止进程**（V8 当成内存耗尽）
- 启动日志里有一条 `ICU data not loaded from ...` 的 WARNING，那是唯一说清根因的一行

`\p{...}` Unicode 属性正则**不需要**这个文件（用的是 V8 编译进去的字符属性表），
所以只有 `Intl.*` 与 `toLocale*` 这条路会受影响。

导出构建时同样要把 `icudtl.dat` 带到可执行文件旁边（或打进 pck 走 `res://icudtl.dat`，
Android 只能这么带）。

## 确认手上那份对不对

`--version` 只记 Godot 内核（各版次都报 `4.7.2.stable.gh.ed1daf0bf`），分不出 GodotJS 版次；
`strings` 里的版本串来自手维护的 `jsb_version.h`，也不能用来判版次。比 md5：

| 文件 | md5 |
| --- | --- |
| `linux-v8/godot.linuxbsd.editor.x86_64` | `77117cac35e7ab534f9feb0451605d79` |
| `windows-v8/godot.windows.editor.x86_64.exe` | `19beb6bf56ef00b7177a1e77ea34ecd2` |
| `windows-v8/godot.windows.editor.x86_64.console.exe` | `188f64ea6b538f76c2c47e2f28cda021` |
| `icudtl.dat`（两份相同） | `ffd67c1e24cb35dc109a24024b1ba7ec` |

```bash
md5sum bin/linux-v8/godot.linuxbsd.editor.x86_64 bin/linux-v8/icudtl.dat
```

想确认 ICU 真的通了，看启动日志就行：带 `--verbose` 起引擎，出现
`ICU data initialized` 说明数据加载上了；出现 `ICU data not loaded from ...` 说明没找到，
Intl 那套就是坏的。

CI 下载走 `tools/ci/install-godotjs.sh`（它会顺带检查 `icudtl.dat` 有没有解出来），版本号集中在
`.github/workflows/publish.yml` 顶部的 `GODOTJS_REPO` / `GODOTJS_TAG` / `GODOT_VERSION` /
`GODOT_RUNTIME` 四个变量里。
