import { resolve } from 'node:path';
/** 通用文件保存沿用原契约；记忆摘要写入额外参加记忆系统的发布互斥。 */
export function createWorkspaceFileSaver(files, memory) {
    return (input) => {
        const save = () => files.saveFile(input);
        return memory
            ? memory.summaryEditor.withFileEdit(resolve(input.workspace, input.filePath), save)
            : save();
    };
}
//# sourceMappingURL=save-workspace-file.js.map