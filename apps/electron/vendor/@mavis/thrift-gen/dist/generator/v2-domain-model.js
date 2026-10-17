import { domainControllerClassName, domainControllerFileName, domainControllerKey, } from './v2-naming.js';
export function groupServiceByDomain(service, sourcePath) {
    const order = [];
    const byDomain = new Map();
    const ensure = (domain) => {
        let group = byDomain.get(domain);
        if (!group) {
            group = { domain, jsonMethods: [], sseMethods: [] };
            byDomain.set(domain, group);
            order.push(domain);
        }
        return group;
    };
    for (const method of service.methods) {
        ensure(requireDomain(method.tsName, method.domain, sourcePath)).jsonMethods.push(method);
    }
    for (const contract of service.sseContracts) {
        ensure(requireDomain(contract.tsName, contract.domain, sourcePath)).sseMethods.push(contract);
    }
    const groups = order.map((domain) => {
        const group = byDomain.get(domain);
        if (!group)
            throw new Error(`${sourcePath}: missing domain group ${domain}`);
        return group;
    });
    assertNoDomainNameCollision(groups, sourcePath);
    return groups;
}
/** v2 requires every method to declare api.domain; a missing one fails generation (design decision 1). */
function requireDomain(tsName, domain, sourcePath) {
    if (!domain) {
        throw new Error(`${sourcePath}: method ${tsName} is missing required api.domain annotation (needed for v2 controller grouping)`);
    }
    return domain;
}
export function domainMethodSigs(group) {
    const sigs = [];
    for (const method of group.jsonMethods) {
        sigs.push({
            tsName: method.tsName,
            requestType: method.requestType,
            returnType: `Promise<${method.responseType}>`,
            sse: false,
        });
    }
    for (const contract of group.sseMethods) {
        const errorType = contract.errorBodyType ?? 'unknown';
        sigs.push({
            tsName: contract.tsName,
            requestType: contract.requestType,
            returnType: `Promise<SseOpenResult<${contract.frameType}, ${errorType}>>`,
            sse: true,
        });
    }
    return sigs;
}
/** Generated-type identifiers this domain imports, plus whether it needs `SseOpenResult`. */
export function domainImportedTypes(group) {
    const types = new Set();
    for (const method of group.jsonMethods) {
        types.add(method.requestType);
        types.add(method.responseType);
    }
    let hasSse = false;
    for (const contract of group.sseMethods) {
        hasSse = true;
        types.add(contract.requestType);
        types.add(contract.frameType);
        if (contract.errorBodyType)
            types.add(contract.errorBodyType);
    }
    return { types: [...types].sort(), hasSse };
}
function assertNoDomainNameCollision(groups, sourcePath) {
    const fileNames = new Map();
    const classNames = new Map();
    const keys = new Map();
    for (const { domain } of groups) {
        const fileName = domainControllerFileName(domain);
        const existingFile = fileNames.get(fileName);
        if (existingFile !== undefined) {
            throw new Error(`${sourcePath}: v2 controller file collision: domains '${existingFile}' and '${domain}' both map to ${fileName}`);
        }
        fileNames.set(fileName, domain);
        const className = domainControllerClassName(domain);
        const existingClass = classNames.get(className);
        if (existingClass !== undefined) {
            throw new Error(`${sourcePath}: v2 controller class collision: domains '${existingClass}' and '${domain}' both map to ${className}`);
        }
        classNames.set(className, domain);
        // The DesktopControllers map key is a separate camelCase collapsing from the
        // file/class guards above (e.g. `a1b` and `a1_b` differ on both file and
        // class name but both map to key `a1B`); guard it explicitly so two domains
        // can never silently share one map property.
        const key = domainControllerKey(domain);
        const existingKey = keys.get(key);
        if (existingKey !== undefined) {
            throw new Error(`${sourcePath}: v2 controller key collision: domains '${existingKey}' and '${domain}' both map to DesktopControllers key '${key}'`);
        }
        keys.set(key, domain);
    }
}
//# sourceMappingURL=v2-domain-model.js.map