const MAX_CAUSE_DEPTH = 4;
export function describeMcpCallError(error) {
    const chain = errorChain(error);
    const innermost = chain.at(-1);
    if (innermost === undefined)
        return undefined;
    const rpc = chain.find((entry) => Number.isInteger(Reflect.get(entry, 'code')));
    if (rpc) {
        const code = Reflect.get(rpc, 'code');
        const message = stringField(rpc, 'message') ?? '';
        const data = Reflect.get(rpc, 'data');
        return {
            code,
            message: message.startsWith(`MCP error ${code}: `)
                ? message.slice(`MCP error ${code}: `.length)
                : message,
            ...(data === undefined ? {} : { data }),
        };
    }
    const code = chain.map((entry) => stringField(entry, 'code')).find((value) => value);
    const name = stringField(innermost, 'name');
    const message = stringField(innermost, 'message');
    return {
        ...(name ? { name } : {}),
        ...(message !== undefined ? { message } : {}),
        ...(code ? { code } : {}),
    };
}
function errorChain(error) {
    const chain = [];
    let current = error;
    while (current !== null && typeof current === 'object' && chain.length < MAX_CAUSE_DEPTH) {
        if (chain.includes(current))
            break;
        chain.push(current);
        current = Reflect.get(current, 'cause');
    }
    return chain;
}
function stringField(value, key) {
    const field = Reflect.get(value, key);
    return typeof field === 'string' ? field : undefined;
}
//# sourceMappingURL=call-error.js.map