export function readPermissionCommand(input) {
    if (typeof input.command === 'string')
        return input.command;
    return typeof input.cmd === 'string' ? input.cmd : undefined;
}
//# sourceMappingURL=checker-input.js.map