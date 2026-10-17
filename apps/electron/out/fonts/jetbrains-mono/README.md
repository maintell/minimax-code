# JetBrains Mono

Electron 随包携带的官方原版字体，用于外观设置中的 JetBrains Mono 选项；无需联网或安装系统字体。

- 上游：[JetBrains/JetBrainsMono v2.304](https://github.com/JetBrains/JetBrainsMono/tree/v2.304)
- 文件来源：上游 `fonts/webfonts/`，未修改字体文件。
- 字重：400、500、600、700，包含正体与斜体。
- 许可证：SIL Open Font License 1.1，版权声明及完整条款见同目录 `OFL.txt`；随字体一同分发。
- 加载入口：`apps/electron/src/app/_code-fonts.scss`。构建时随 `public` 复制到静态输出，生产版从应用本地资源加载。

更新时固定上游版本，同时更新字体、许可证和本说明，并核对无系统安装字体、离线启动、首次选用字体及已打开编辑器/终端的布局。
