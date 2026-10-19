/**
 * desktop / cloud mavis 共用的 operation 分类器。
 *
 * 两侧 dispatcher 的命令归一化必须和 observability 的 operation label 完全
 * 一致，否则 Grafana 上会出现「命令能跑通但只落进 unknown 桶」的偏差，所以
 * `normalizeMavisCommand` 由两侧 dispatcher 和分类器共同复用。
 */
export function normalizeMavisCommand(rawCommand) {
    const tokens = rawCommand.trim().split(/\s+/).filter(Boolean);
    const aliased = tokens.map((token) => (token === '-h' || token === '--help' ? 'help' : token));
    return aliased.join(' ');
}
export function createMavisOperationClassifier(allowedValues) {
    const allowed = new Set(allowedValues);
    return {
        allowedValues,
        classify(args) {
            if (!args || typeof args !== 'object' || Array.isArray(args))
                return undefined;
            const rawCommand = args.command;
            if (typeof rawCommand !== 'string')
                return undefined;
            const command = normalizeMavisCommand(rawCommand);
            return allowed.has(command) ? command : undefined;
        },
    };
}
//# sourceMappingURL=mavis-operation-classifier.js.map