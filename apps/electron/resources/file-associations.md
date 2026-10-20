# 系统“打开方式”文件类型

`file-associations.json` 是明确登记的扩展名清单，覆盖现有/扩展预览、常用源码与配置、Markdown 和 `.skill`。`.skill` 已有技能上传解析能力；系统选择 MCode 打开 `.skill` 后切换本地新对话页，附上文件并预填安装指令；用户点击发送后由原有对话链路处理，不自动安装或执行文件。已有 Home 草稿及富文本引用保留，安装指令只追加一次；附件未接收成功不填安装指令。

## 同步声明

修改清单后运行 `node apps/electron/scripts/sync-file-associations.mjs`。它更新全部中英文、正式/测试/内测构建的 macOS 文档声明和 Windows 历史候选清理所用的扩展名遍历宏。`--check` 校验生成文件未过期。调整清单时须保留旧版本已登记扩展名的 Windows 清理覆盖。

Mac 使用 `Viewer` / `Alternate` 登记明确扩展名，保留已有 `Any File` 的 Dock/Finder 附件接收声明，同样标为 Alternate。泛类型接收不表示所有文件都能预览；明确清单中亦包含可作为源码/附件处理的格式。已有 `open-file` 队列在单实例锁之后、异步启动之前注册。

Windows 沿用 per-user NSIS 安装。安装和升级维护应用级 `HKCU\Software\Classes\Applications\<应用名>.exe` 打开命令，并按扩展名登记 `OpenWithProgids` 候选，让用户无需手动浏览 exe 即可在系统“打开方式”中发现应用；不登记 `SupportedTypes`，不写 `UserChoice` 或扩展名默认值。MiniMax 的 ProgID 同时写入 Windows 8 起支持的 `AllowSilentDefaultTakeOver`（`REG_NONE`）：它保留“打开方式”候选，但排除 MiniMax 参与公共文件类型的隐式默认选择。应用级键由同名 exe 共享：通常只在命令为空、`MCodeAppId` 等于当前 App ID，或无标记的历史命令明确指向当前安装路径时写入；指向其他路径的无标记命令保持不变，以保留其他安装的处理命令。macOS 的 `Viewer` / `Alternate` 声明保持独立。

每次安装、升级按扩展名清单重新登记当前 `${APP_ID}.Document` 候选；完整卸载才移除当前 App ID 的候选值和空的 `OpenWithProgids` 子键，保留其他应用的登记。保留并刷新原 ProgID 的图标与打开命令，供已有用户默认选择继续引用。升级卸载阶段保留处理程序；完整卸载删除当前 App ID 的 ProgID，并在应用级处理程序的 `MCodeAppId` 与当前 App ID 一致、打开命令仍指向本安装路径时删除该处理程序。对于无标记但明确指向本安装路径的历史应用级命令，安装时会补写归属标记并迁移到带 `--open-file` 的命令；无法确认归属的历史命令保持不变。旧版本卸载器仍执行其原有清理，升级后的安装阶段会重新登记处理程序；本次不负责恢复历史污染用户的默认程序或图标。跨版本实际默认行为需在 Windows 实机验收。

依据：[Windows ProgID 默认处理程序排除标记](https://learn.microsoft.com/en-us/windows/win32/shell/fa-progids)。

Windows 打开命令为带引号的应用路径 + `--open-file` + 带引号的文件路径。冷启动与 `second-instance` 共用队列，支持盘符绝对路径和 UNC，保留中文与空格；其他 CLI 参数和深链接不作为文件。Mac/Windows 文件到达后均沿用现有聊天草稿附件入口。直接单文件预览页属于另一项产品行为，不由声明注册隐式启用。

## 验证

- `node --test apps/electron/test/scripts/file-associations.test.mjs apps/electron/test/scripts/installer-config.test.mjs`
- 使用 focused-vitest 显式运行 Electron 的 `main/modules/dock/__tests__/dock.test.ts`、`windows-file-arguments.test.ts` 和 `main/index.startup-order.test.ts`。
- 构建 Mac 应用检查 Info.plist，构建真实 Windows NSIS 安装器检查宏可编译；便携 ZIP 不执行安装关联注册。
- 两端实机验收：从“打开方式”选择 MCode 打开 `.md`、`.skill`、ZIP、PDF 和代码；覆盖未启动、已启动、多文件、中文空格路径；Windows 增补 UNC、升级、卸载。
- Windows 新装及静默升级覆盖三种初始状态：无默认应用、其他应用为默认、用户已选择 MCode。检查双击行为、图标和“打开方式”；安装后旧候选仅移除当前 App ID，已有默认选择及其他应用候选保留。通过“选择其他应用”指定 MCode 可执行文件，确认文件进入既有接收链路。完整卸载后检查自身处理程序清理及其他安装的处理程序保留。

依据：[Windows 应用级打开命令](https://learn.microsoft.com/en-us/windows/win32/shell/app-registration)、[Windows Open With 注册](https://learn.microsoft.com/en-us/windows/win32/shell/how-to-include-an-application-on-the-open-with-dialog-box)、[Electron 文件打开事件](https://www.electronjs.org/docs/latest/api/app#event-open-file-macos)。

桌面 Next.js 成品入口 `MavisContent` 在 MemoryRouter 内挂载 `useDockOpenFiles`，与 Vite 入口共用现有附件接收逻辑；系统事件到达后进入草稿；`.skill` 使用上述安装引导，其他文件仍沿用原先的附件接收行为。
