import { buildHttpServiceDefinitionFromIr, } from './http-service-model.js';
export const DESKTOP_SERVICE_NAMESPACE = 'matrix.desktop_service';
export const DESKTOP_SERVICE_NAME = 'DesktopService';
export function buildDesktopServiceDefinitionFromIr(ir, sourcePath = ir.source.entry) {
    const httpDefinition = buildHttpServiceDefinitionFromIr(ir, {
        entryPath: sourcePath,
        expectedNamespace: DESKTOP_SERVICE_NAMESPACE,
        serviceName: DESKTOP_SERVICE_NAME,
        mode: 'strict',
        typeOnlyIncludeAliases: ['feedback'],
    });
    const service = httpDefinition.services.find((candidate) => candidate.name === DESKTOP_SERVICE_NAME);
    if (!service) {
        throw new Error(`${sourcePath}: missing service ${DESKTOP_SERVICE_NAME} declaration`);
    }
    const structs = httpDefinition.structs.map((struct) => ({
        name: struct.name,
        fields: struct.fields.map((field) => parseDesktopField(field, `${sourcePath}: struct ${struct.name}`)),
    }));
    const methods = service.methods.map(parseDesktopMethod);
    assertDesktopServiceReferences(structs, methods, sourcePath);
    return {
        sourcePath,
        namespace: DESKTOP_SERVICE_NAMESPACE,
        serviceName: DESKTOP_SERVICE_NAME,
        structs,
        methods,
        httpDefinition,
    };
}
function parseDesktopField(field, context) {
    void context;
    return {
        id: field.id,
        name: field.fieldName,
        type: field.tsType,
        requiredness: field.requiredness,
    };
}
function parseDesktopMethod(method) {
    return {
        thriftName: method.methodName,
        tsName: method.tsName,
        requestType: method.requestType,
        responseType: method.responseType,
        route: {
            method: method.method,
            path: method.path,
        },
    };
}
function assertDesktopServiceReferences(structs, methods, sourcePath) {
    const structNames = new Set(structs.map((struct) => struct.name));
    for (const methodDef of methods) {
        if (!structNames.has(methodDef.requestType)) {
            throw new Error(`${sourcePath}: missing request struct ${methodDef.requestType}`);
        }
        if (!structNames.has(methodDef.responseType)) {
            throw new Error(`${sourcePath}: missing response struct ${methodDef.responseType}`);
        }
    }
}
//# sourceMappingURL=desktop-service-model.js.map