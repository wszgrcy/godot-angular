# bin/ —— GodotJS 引擎二进制放置目录

- <https://github.com/godotjs/GodotJS/releases>（上游）
- <https://github.com/wszgrcy/GodotJS/releases>（本项目维护者自编译）

当前对齐 **GodotJS 1.3.5**（Godot 4.7.2 + V8 12.6），下载 `linux-editor-4.7.2-v8.zip` /
`windows-editor-4.7.2-v8.zip`（zip 里只有一个裸可执行文件，需自己建目录并加执行位）。
目录名只区分平台与运行时，**不带引擎版本号**，升级时直接覆盖同一个文件。

```
bin/
├── linux-v8/godot.linuxbsd.editor.x86_64
└── windows-v8/godot.windows.editor.x86_64.exe
```

`--version` 只记 Godot 内核（各版次都报 `4.7.2.stable.gh.ed1daf0bf`），分不出 GodotJS 版次；
`strings` 里的版本串来自手维护的 `jsb_version.h`，也不能用来判版次。确认手上那份是不是 1.3.5，比 md5：

| 文件 | md5 |
| --- | --- |
| `linux-v8/godot.linuxbsd.editor.x86_64` | `9c93e230f851dbcf42a3d88c6d2ec8ae` |
| `windows-v8/godot.windows.editor.x86_64.exe` | `64d9f644c1cc9d1c316723103fbb516c` |

```bash
md5sum bin/linux-v8/godot.linuxbsd.editor.x86_64
```

CI 下载走 `tools/ci/install-godotjs.sh`，版本号集中在 `.github/workflows/publish.yml` 顶部的
`GODOTJS_REPO` / `GODOTJS_TAG` / `GODOT_VERSION` / `GODOT_RUNTIME` 四个变量里。
