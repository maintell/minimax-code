# 系统“打开方式”文件类型

`file-associations.json` 是明确登记的扩展名清单，覆盖现有/扩展预览、常用源码与配置、Markdown 和 `.skill`。`.skill` 已有技能上传解析能力；系统选择 MCode 打开 `.skill` 后切换本地新对话页，附上文件并预填安装指令；用户点击发送后由原有对话链路处理，不自动安装或执行文件。已有 Home 草稿及富文本引用保留，安装指令只追加一次；附件未接收成功不填安装指令。

## 同步声明

修改清单后运行 `node apps/electron/scripts/sync-file-associations.mjs`。它更新全部中英文、正式/测试/内测构建的 macOS 文档声明、Windows 安装器遍历宏，以及 Windows “打开方式”增强登记使用的文本类扩展名清单 `main/modules/file-open-with/text-file-types.generated.ts`。`--check` 校验生成文件未过期。调整清单时须保留旧版本已登记扩展名的 Windows 清理覆盖。

Mac 使用 `Viewer` / `Alternate` 登记明确扩展名，使 MCode 出现在 Finder“打开方式”中但不抢默认。保留 `Any File` 的 Dock/Finder 拖放接收声明，但其 rank 为 `None`：按 Apple 定义，该 rank 永远不会被选来打开文件，只接受拖放，避免某类型没有其他程序时回退为 MCode 默认打开。泛类型接收不表示所有文件都能预览；明确清单中亦包含可作为源码/附件处理的格式。已有 `open-file` 队列在单实例锁之后、异步启动之前注册。

Windows 沿用 per-user NSIS 安装，目标是“打开方式”可发现但永不自动成为默认。实测只要某扩展名的 `OpenWithProgids` 里只有一个候选，即使 ProgID 带 `AllowSilentDefaultTakeOver`，Windows 也会把它当作隐式默认；因此安装器不再登记 `OpenWithProgids`，改为在应用级 `HKCU\Software\Classes\Applications\<应用名>.exe\SupportedTypes` 列出清单扩展名。MCode 由此出现在“选择其他应用”/“更多应用”中，不参与隐式默认选择；代价是新装后首次需从“选择其他应用”里选一次 MCode，之后由系统列入该类型的常用列表。不写 `UserChoice`、扩展名默认值或 Explorer MRU。应用级键由同名 exe 共享：通常只在命令为空、`MCodeAppId` 等于当前 App ID，或无标记的历史命令明确指向当前安装路径时写入（同时重建 `SupportedTypes`，移除已从清单删去的扩展名）；指向其他路径的无标记命令保持不变，以保留其他安装的处理命令。

每次安装、升级都按扩展名清单移除当前 `${APP_ID}.Document` 的历史 `OpenWithProgids` 候选，并删除旧版本写入的 `AllowSilentDefaultTakeOver`。NSIS `DeleteRegKey /ifempty` 只检查子键、不检查值，所以只有 `EnumRegValue` 确认 `OpenWithProgids` 已无任何值时才删除该键，保留其他应用的候选。保留并刷新原 ProgID 的图标与打开命令，供用户已选择的默认继续引用。升级卸载阶段保留处理程序；完整卸载同样移除候选，删除当前 App ID 的 ProgID，并在应用级处理程序的 `MCodeAppId` 与当前 App ID 一致、打开命令仍指向本安装路径时删除该处理程序（连同 `SupportedTypes`）。对于无标记但明确指向本安装路径的历史应用级命令，安装时会补写归属标记并迁移到带 `--open-file` 的命令；无法确认归属的历史命令保持不变。本次不负责恢复历史版本已造成的默认程序或图标变化，用户已选择的默认保持不变。跨版本实际默认行为需在 Windows 实机验收。

## Windows “打开方式”增强登记（可选）

设置 → 文件中的“在‘打开方式’中显示 MCode”仅在 Windows 设置页显示（安装版才能开启），默认关闭。开启后主进程通过 PowerShell 为文本类扩展名（Markdown/文本/CSV/TSV、全部代码、配置和 `.skill`，不含 PDF、RTF、Office、Keynote、图片、媒体、压缩包和扩展预览格式）在 `HKCU\Software\Classes\.<ext>\OpenWithProgids` 写入 `<APP_ID>.Document`（`REG_NONE`，不带任何排除标记），效果同 VS Code：MCode 直接出现在“打开方式”菜单里。副作用如设置描述所述：未关联其他应用的文件类型，Windows 可能默认用 MCode 打开。关闭时只删除自身候选，键内已无其他值才删除空键。

ProgID 取自安装器写入的应用级 `MCodeAppId`，且只在该 ProgID 的打开命令指向当前 exe 时生效（内部包的 builder appId 与运行时 App ID 不同；便携/开发包返回未安装）。注册表更新成功后才保存偏好。安装和升级会清掉候选，因此偏好开启时每次启动重新登记；完整卸载由安装器清理。

依据：[Windows 应用级 SupportedTypes](https://learn.microsoft.com/en-us/windows/win32/shell/app-registration)、[Windows ProgID 与 OpenWithProgids](https://learn.microsoft.com/en-us/windows/win32/shell/fa-progids)、[NSIS DeleteRegKey](https://nsis.sourceforge.io/Reference/DeleteRegKey)、[VS Code 安装器](https://github.com/microsoft/vscode/blob/main/build/win32/code.iss)。

Windows 打开命令为带引号的应用路径 + `--open-file` + 带引号的文件路径。冷启动与 `second-instance` 共用队列，支持盘符绝对路径和 UNC，保留中文与空格；其他 CLI 参数和深链接不作为文件。Mac/Windows 文件到达后均沿用现有聊天草稿附件入口。直接单文件预览页属于另一项产品行为，不由声明注册隐式启用。

## 验证

- `node --test apps/electron/test/scripts/file-associations.test.mjs apps/electron/test/scripts/installer-config.test.mjs`
- 使用 focused-vitest 显式运行 Electron 的 `main/modules/dock/__tests__/dock.test.ts`、`windows-file-arguments.test.ts`、`main/index.startup-order.test.ts`、`main/modules/file-open-with/index.test.ts`（Windows 上含真实 HKCU 往返）和 `main/ipc/__tests__/settings.ipc.test.ts`，以及 UI 的 `SettingsModal/GeneralSettings.test.tsx`。
- 构建 Mac 应用检查 Info.plist，构建真实 Windows NSIS 安装器检查宏可编译；便携 ZIP 不执行安装关联注册。
- 两端实机验收：从“打开方式”选择 MCode 打开 `.md`、`.skill`、ZIP、PDF 和代码；覆盖未启动、已启动、多文件、中文空格路径；Windows 增补 UNC、升级、卸载。
- Windows 新装及静默升级覆盖三种初始状态：无默认应用、其他应用为默认、用户已选择 MCode。确认安装后双击行为与图标不变、MCode 不成为任何类型的默认，且可在“选择其他应用”中找到 MCode；旧版本留下的候选被移除，其他应用候选保留。开启增强登记后 MCode 直接出现在文本类“打开方式”菜单，关闭后消失；升级后偏好仍生效。完整卸载后检查自身处理程序清理及其他安装的处理程序保留。

依据：[Windows 应用级打开命令](https://learn.microsoft.com/en-us/windows/win32/shell/app-registration)、[Windows Open With 注册](https://learn.microsoft.com/en-us/windows/win32/shell/how-to-include-an-application-on-the-open-with-dialog-box)、[Electron 文件打开事件](https://www.electronjs.org/docs/latest/api/app#event-open-file-macos)。

桌面 Next.js 成品入口 `MavisContent` 在 MemoryRouter 内挂载 `useDockOpenFiles`，与 Vite 入口共用现有附件接收逻辑；系统事件到达后进入草稿；`.skill` 使用上述安装引导，其他文件仍沿用原先的附件接收行为。
