# 工作区 PDF 阅读器

Desktop、Web、Native 共用仓库内 PDF.js 4.2.67 阅读资源。`PdfView` 使用同源
`/pdf/web/viewer.html`，在 `webviewerloaded` 初始化前关闭 PDF scripting、动态 eval
和 annotation editor。父应用只连接本组件 iframe 的 Window，其他预览不能触发连接。
PPT 的跨源 `mavis-preview` bridge 保持独立。

阅读器只显示一条应用工具栏：页码、缩放与适合页面/宽度、区域截图、搜索、旋转和下载。
`packages/ui/src/components/file-preview/pdf/PdfReaderToolbar.tsx` 通过 PDF.js application /
event bus 操作导航和全文查找；搜索显示当前/总匹配数，支持 Enter、Shift+Enter、Esc
和阅读器范围内的 Ctrl/Cmd+F，高级匹配选项按需展开。旧 findbar 与底部页码缩放条仅在
本组件拥有的 iframe 内隐藏，没有改写三端静态资源或其他类型的预览 UI。窄面板收起
重复的前后页/加减按钮，保留页码输入和缩放菜单。选区控制器、共享选区浮条与上下文绑定
保持各自原有职责；搜索、阅读工具与选区交互分别维护。

`web/cmaps/`、`web/standard_fonts/` 来自公开 npm `pdfjs-dist@4.2.67`，保留各目录
LICENSE。三端副本必须字节一致。下载包 SHA-256：
`c26bcf57ef942ba267cd7b3897a610d375428ed2e8cc223d659e6e5478b8c80c`。
资源解包前核对 npm 的 SHA-512 integrity；没有执行包脚本，也没有引入新渲染引擎。
字体和 CMap 按需同源加载，不依赖外部 CDN。升级时必须同时核对 worker、viewer、字体资源
和 `pdf-viewer-controller.ts` 使用的 application API。

第一批交付：工作区内阅读、搜索、缩放、旋转、下载原文件；文字选择和单页区域截图加入
已有 Selection Session 上下文及图片附件。文字按 PDF 文本层顺序保留逐页内容和 PDF 用户
空间坐标；CropBox、缩放、旋转通过 viewport 转换。多栏阅读顺序不保证语义重排，复杂表格
或扫描页可用截图。选区面板先展示引用内容和页码，用户确认后加入对话。

文件由既有本地文件 API / 已鉴权的云端下载地址获取；临时 Blob 和控制器在切换文件时释放。
文件字节计算 SHA-256，与页码、坐标、路径或资产身份一起进入上下文。远端下载 URL 不进入
LLM 提示；云盘 node ID 与 Desktop asset ID 分开保存。发送沿用既有附件校验和发送流程，
只有已接受的不可变快照会在成功后移除。

当前边界：最多 100 MiB 文件、文字选区最多 8 页、截图单页且最长边 1600 像素。
文件仍需完整下载后计算版本哈希；尚未接入 Range 流式读取、大文件后台解析、OCR、多栏
语义重排或任意 PDF 文本修改。截图不是 OCR。PDF 选择只提供上下文，用户要求决定任务范围；
真实文件修改由 Agent 工具生成新版本并重新打开验证，不由阅读器冒充修改成功。

验证：UI focused tests 覆盖坐标、来源版本、发送/移除竞态、资源回收及工作区入口；临时
浏览器 harness 使用实际 controller 和静态 reader 检查中文、表格、矢量图、扫描页、旋转裁剪
和多页文件。该 harness 不代表完整 Desktop/Web 真实 Agent 验收，发布前仍需外部用户路径验收。
