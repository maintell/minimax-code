function asPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
/**
 * Target arguments of an `mcp_invoke` call, whichever transport the model used:
 * the `arguments` object or the `arguments_json` string that encodes it.
 */
export function readMcpInvokeArguments(args) {
    const invocation = asPlainObject(args);
    const direct = asPlainObject(invocation?.arguments);
    if (direct)
        return direct;
    if (typeof invocation?.arguments_json !== 'string')
        return undefined;
    try {
        return asPlainObject(JSON.parse(invocation.arguments_json));
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=mcp-invoke-arguments.js.map