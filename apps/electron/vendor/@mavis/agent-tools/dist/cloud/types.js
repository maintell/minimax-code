/**
 * Cloud-runtime tool 共享类型 —— 单一文件汇总所有 cloud_xxx_tool 在构造时
 * 需要注入的 deps。每个 tool class 只在 constructor 里接受它真正用到的子集
 * (`CloudBashTool(archonServer)` 只要 ShellExecutor 一项),保证测试时的
 * fake 注入面最小。
 */
export {};
//# sourceMappingURL=types.js.map