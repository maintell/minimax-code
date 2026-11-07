# 系统打开方式：面向留存的建议范围

建议首批重点优化 **42 个后缀** 的打开体验。这些格式均包含在当前 157 项扩展名清单中。macOS 沿用明确类型声明；Windows 安装器按清单登记应用级打开命令和 `OpenWithProgids` 候选，并在 MiniMax ProgID 上设置 `AllowSilentDefaultTakeOver`，使用户无需手动寻找 exe 即可发现候选，同时避免安装器隐式改变默认应用。目标是用户打开工作文件后，能在 MCode 继续理解、提问、修改或安装技能。

| 场景 | 首批建议后缀 | 值得注册的原因 |
| --- | --- | --- |
| 技能安装 | skill | 文件进入本地新对话，附上技能包和安装指令；用户发送后安装、继续使用 |
| 日常文档 | md, markdown, txt, pdf, docx, pptx, xlsx, csv, tsv | 阅读、总结、改写、对比与提取任务，是重复工作场景 |
| 结构化数据与配置 | json, jsonc, jsonl, yaml, yml, toml, xml | 解释、检查、转换、编辑，复用原生文本能力 |
| 网页报告 | html, htm | 阅读生成结果，再提出修改意见 |
| 高频代码 | py, js, jsx, ts, tsx, sql, sh | 用原生代码组件理解和修改；打开不自动执行脚本 |
| 常见图片 | png, jpg, jpeg, webp, svg | 查看与围绕图片提问；不宣称新增预览库具有 OCR |
| 打包交付 | zip | 浏览包内文件，已有格式复用原生预览；超限/损坏明确回退 |
| 邮件 | eml, msg | 阅读、提炼待办，显示并下载附件 |
| 数据分析 | db, sqlite, sqlite3, parquet | 浏览表格，选单元格提问；预览不是数据库写回 |
| 图形与思维导图 | xmind, drawio, excalidraw | 查看、选择可见节点/文字，复制或加入对话 |
| 长文阅读 | epub | 阅读、选段提问；不承诺 DRM 文件可用 |

**第二批按需求再加**：mdx/log、doc/xls/ppt 等旧 Office 格式、更多源码语言、tar/tgz/gz/7z/rar、mbox、ofd/xps/oxps。前提是产品入口明确、真实样例通过、反馈有需求。旧格式或系统转交不等于原生预览，不宜只因库列为支持就注册。

**暂不以留存为理由扩张**：字体、PSD/PSB/AI、PS/EPS、音视频、AVRO/WASM、冷门配置后缀。它们可以保留应用内能力，但需要更强的后续工作价值才值得占系统候选。3D/GIS/HEIC 不在本分支接入范围。可执行文件、安装包、系统文件不注册。

## 打开后的交互必须配套

当前系统接收入口普通文件仍是**聊天草稿附件**，并非直接打开阅读视图。`.skill` 本轮新增专门的本地新对话安装草稿，支持中文/空格/大小写扩展名、Mac 和 Windows 路径；不自动发送，不抢占默认应用；已有 Home 草稿保留并追加指令。

因此，“42 格式可出现在打开方式”不等于“42 格式的打开体验已交付”。建议正式面向阅读推广前，普通文件直接落到文件面板并保留“加入对话”，Office/文本/图片优先原生组件；新格式才走扩展预览。云端文件也应走相同可用的预览路由。安装、冷/热启动、登录前排队、多文件、长路径、失败回退要独立验收。

## 数量与系统规则

查阅 Apple 和 Microsoft 文件关联文档，没有找到“超过 N 种格式就惩罚应用”的公开数量阈值；这不是对所有系统版本或商店审核的保证。实际问题是无关候选干扰、打开后不能处理、误改默认应用、安装升级卸载残留与测试成本。

- Mac 明确格式使用 `Viewer` / `Alternate`；库的预览不冒充编辑。当前还保留 `Any File` / `Alternate` 的历史接收声明，所以明确后缀清单并不等于严格候选白名单。若产品决定收敛，需同时将泛类型改为仅接受拖入的 `LSHandlerRank=None`，独立验证 Finder/Dock 路径。
- Windows 由用户在系统“打开方式”主动选择应用；安装和升级按清单登记当前 App ID 的 `OpenWithProgids` 候选，ProgID 的 `AllowSilentDefaultTakeOver` 保证候选可见但不参与隐式默认选择，不写 `UserChoice` 或扩展名默认值。完整卸载只清理本应用拥有的项；本分支不负责恢复历史污染用户的默认程序或图标。
- `.skill` 没有跨应用通用的“所有文件都可安装”保证。后缀用于选择入口，安装时仍要由既有能力检查包结构和有效技能内容。注册 MCode 不会把用户已选的 Codex/其他默认应用改掉。

依据：[Apple 文档类型与候选等级](https://developer.apple.com/library/archive/documentation/General/Reference/InfoPlistKeyReference/Articles/CoreFoundationKeys.html#//apple_ref/doc/uid/TP40009249-SW1)、[Microsoft Open With 注册](https://learn.microsoft.com/en-us/windows/win32/shell/how-to-include-an-application-on-the-open-with-dialog-box)。

## 验证留存假设

建议按格式类别观察“系统打开成功 → 有效内容显示/附件接收 → 复制/提问/修改/安装 → 7 日内再次使用”；同时看失败率、主动关闭率、默认应用投诉。比较分批上线人群，不把候选曝光或打开量直接当留存收益。本轮仅提出观察口径，未新增埋点。
