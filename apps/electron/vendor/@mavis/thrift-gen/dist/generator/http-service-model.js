import { resolveUnderlyingType, resolveType } from './resolve-types.js';
import { buildSymbolTable } from './symbol-table.js';
import { assertTsIdentifier, emitTsType, isOptionalField, thriftFieldToTsPropertyName, thriftMethodToTsName, usesThriftI64, } from './ts-type-mapper.js';
const ROUTE_ANNOTATIONS = {
    'api.get': 'GET',
    'api.post': 'POST',
    'api.put': 'PUT',
    'api.patch': 'PATCH',
    'api.delete': 'DELETE',
    'api.options': 'OPTIONS',
    'api.head': 'HEAD',
    'api.any': 'ANY',
};
const FIELD_BINDING_ANNOTATIONS = new Set([
    'api.path',
    'api.query',
    'api.body',
    'api.header',
    'api.none',
]);
const IGNORED_FIELD_API_ANNOTATIONS = new Set(['api.vd']);
const SSE_FRAME_ANNOTATION = 'sse.frame';
const SSE_ERROR_BODY_ANNOTATION = 'sse.error_body';
const DOMAIN_ANNOTATION = 'api.domain';
/** Lowercase snake_case, aligned with the api_common include-file naming. */
const DOMAIN_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
export function buildHttpServiceDefinitionFromIr(ir, options = {}) {
    const table = buildSymbolTable(ir);
    const entryPath = options.entryPath ?? ir.source.entry;
    const entryFile = getFileOrThrow(table, entryPath);
    const namespace = entryFile.namespaces.js ?? options.tsNamespaceOverride;
    const mode = options.mode ?? 'strict';
    if (!namespace) {
        throw new Error(`${entryPath}: missing namespace js; pass tsNamespaceOverride only for fixtures`);
    }
    if (options.expectedNamespace && namespace !== options.expectedNamespace) {
        throw new Error(`${entryPath}: expected namespace js ${options.expectedNamespace}, got ${String(namespace)}`);
    }
    const services = collectServices(table, entryFile, options.serviceName, mode);
    const reachable = collectReachableTypeKeys(table, services, entryFile, options.typeOnlyIncludeAliases ?? []);
    const enums = collectEnums(ir, reachable);
    const structs = collectStructs(table, ir, reachable);
    assertNoTsNameCollisions([...enums, ...structs]);
    const usedTypes = structs.flatMap((struct) => struct.fields.flatMap((field) => field.type ?? []));
    return {
        sourcePath: entryPath,
        namespace,
        structs,
        enums,
        services,
        usesThriftI64: usedTypes.some(usesThriftI64),
    };
}
export function surveyHttpServices(ir, options = {}) {
    const table = buildSymbolTable(ir);
    const entryPath = options.entryPath ?? ir.source.entry;
    const entryFile = getFileOrThrow(table, entryPath);
    const diagnostics = [];
    if (!entryFile.namespaces.js)
        diagnostics.push(`${entryPath}: missing namespace js`);
    let methodCount = 0;
    const routeCounts = {};
    for (const service of entryFile.services) {
        for (const method of service.functions) {
            methodCount += 1;
            const routeAnnotations = getRouteAnnotations(method);
            for (const annotation of routeAnnotations) {
                routeCounts[annotation.key] = (routeCounts[annotation.key] ?? 0) + annotation.values.length;
                if (!ROUTE_ANNOTATIONS[annotation.key]) {
                    diagnostics.push(`${entryPath}: unsupported route annotation ${annotation.key}`);
                }
            }
        }
    }
    return {
        entryPath,
        serviceCount: entryFile.services.length,
        methodCount,
        routeCounts,
        diagnostics,
    };
}
function collectEnums(ir, reachable) {
    const out = [];
    for (const file of ir.files) {
        for (const declaration of file.enums) {
            if (!reachable.has(typeKey(file.path, declaration.name)))
                continue;
            assertTsIdentifier(declaration.name, `enum ${declaration.name}`);
            for (const value of declaration.values) {
                assertTsIdentifier(value.name, `enum value ${value.name}`);
            }
            out.push({ name: declaration.name, declaration, filePath: file.path });
        }
    }
    return out;
}
function collectStructs(table, ir, reachable) {
    const out = [];
    for (const file of ir.files) {
        for (const declaration of file.structs) {
            if (!reachable.has(typeKey(file.path, declaration.name)))
                continue;
            assertTsIdentifier(declaration.name, `struct ${declaration.name}`);
            const fields = declaration.fields.map((field) => buildFieldModel(table, file.path, field));
            assertNoFieldNameCollisions(file.path, declaration.name, fields);
            out.push({
                name: declaration.name,
                filePath: file.path,
                fields,
            });
        }
    }
    return out;
}
function collectReachableTypeKeys(table, services, entryFile, typeOnlyIncludeAliases) {
    const keys = new Set();
    const visitSymbol = (filePath, name) => {
        const key = typeKey(filePath, name);
        if (keys.has(key))
            return;
        keys.add(key);
        const file = getFileOrThrow(table, filePath);
        const struct = file.structs.find((candidate) => candidate.name === name);
        if (!struct)
            return;
        for (const field of struct.fields) {
            if (isOpaqueBaseWrapperField(field))
                continue;
            visitType(resolveType(table, filePath, field.type));
        }
    };
    const visitType = (type) => {
        const underlying = resolveUnderlyingType(type);
        switch (underlying.kind) {
            case 'builtin':
                return;
            case 'struct':
            case 'enum':
                visitSymbol(underlying.symbol.filePath, underlying.symbol.name);
                return;
            case 'list':
            case 'set':
                visitType(underlying.valueType);
                return;
            case 'map':
                visitType(underlying.keyType);
                visitType(underlying.valueType);
                return;
            default: {
                const exhaustiveCheck = underlying;
                return exhaustiveCheck;
            }
        }
    };
    for (const service of services) {
        for (const method of service.methods) {
            visitSymbolFromTypeName(method.requestType);
            visitSymbolFromTypeName(method.responseType);
        }
        for (const contract of service.sseContracts) {
            visitSymbolFromTypeName(contract.requestType);
            visitSymbolFromTypeName(contract.responseType);
            visitSymbolFromTypeName(contract.frameType);
            if (contract.errorBodyType)
                visitSymbolFromTypeName(contract.errorBodyType);
        }
    }
    for (const alias of typeOnlyIncludeAliases) {
        const include = entryFile.includes.find((candidate) => candidate.alias === alias);
        if (!include)
            continue;
        const file = getFileOrThrow(table, include.resolvedPath);
        for (const declaration of file.enums) {
            visitSymbol(file.path, declaration.name);
        }
        for (const declaration of file.structs) {
            visitSymbol(file.path, declaration.name);
        }
    }
    return keys;
    function visitSymbolFromTypeName(name) {
        for (const file of table.files.values()) {
            if (file.structs.some((candidate) => candidate.name === name)) {
                visitSymbol(file.path, name);
                return;
            }
            if (file.enums.some((candidate) => candidate.name === name)) {
                visitSymbol(file.path, name);
                return;
            }
        }
    }
}
function typeKey(filePath, name) {
    return `${filePath}:${name}`;
}
function buildFieldModel(table, filePath, field) {
    if (field.defaultValue !== undefined) {
        throw new Error(`${filePath}: field ${field.name} has unsupported explicit default value`);
    }
    const fieldName = thriftFieldToTsPropertyName(field.name);
    if (isOpaqueBaseWrapperField(field)) {
        return {
            id: field.id,
            thriftName: field.name,
            fieldName,
            jsonName: field.name,
            requiredness: field.requiredness,
            optional: isOptionalField(field.requiredness),
            tsType: 'Record<string, unknown>',
        };
    }
    const type = resolveType(table, filePath, field.type);
    return {
        id: field.id,
        thriftName: field.name,
        fieldName,
        jsonName: field.name,
        requiredness: field.requiredness,
        optional: isOptionalField(field.requiredness),
        tsType: emitTsType(type),
        type,
    };
}
function collectServices(table, entryFile, serviceName, mode) {
    const services = serviceName
        ? entryFile.services.filter((service) => service.name === serviceName)
        : entryFile.services;
    if (serviceName && services.length === 0) {
        throw new Error(`${entryFile.path}: missing service ${serviceName} declaration`);
    }
    return services.map((service) => {
        assertTsIdentifier(service.name, `service ${service.name}`);
        if (service.extends) {
            throw new Error(`${entryFile.path}: service extends is not supported for ${service.name}`);
        }
        const methods = [];
        const sseContracts = [];
        for (const method of service.functions) {
            const sseContract = buildSseContractModel(table, entryFile.path, service, method);
            if (sseContract) {
                sseContracts.push(sseContract);
            }
            else {
                methods.push(buildRouteModel(table, entryFile.path, service, method, mode));
            }
        }
        return {
            name: service.name,
            methods,
            sseContracts,
        };
    });
}
function buildSseContractModel(table, entryPath, service, method) {
    const frameAnnotation = getSingleAnnotation(method, SSE_FRAME_ANNOTATION);
    const errorBodyAnnotation = getSingleAnnotation(method, SSE_ERROR_BODY_ANNOTATION);
    if (!frameAnnotation && !errorBodyAnnotation)
        return undefined;
    if (!frameAnnotation) {
        throw new Error(`${entryPath}: method ${method.name} ${SSE_ERROR_BODY_ANNOTATION} requires ${SSE_FRAME_ANNOTATION}`);
    }
    const base = buildMethodContractBase(table, entryPath, service, method);
    const bindings = buildFieldBindings(table, base.requestSymbol, base.method);
    const frameType = requireAnnotationStructType(table, entryPath, method, frameAnnotation, SSE_FRAME_ANNOTATION);
    const errorBodyType = errorBodyAnnotation
        ? requireAnnotationStructType(table, entryPath, method, errorBodyAnnotation, SSE_ERROR_BODY_ANNOTATION)
        : undefined;
    return {
        serviceName: base.serviceName,
        methodName: base.methodName,
        tsName: base.tsName,
        domain: base.domain,
        method: base.method,
        path: base.path,
        requestType: base.requestType,
        responseType: base.responseType,
        frameType: frameType.name,
        ...(errorBodyType ? { errorBodyType: errorBodyType.name } : {}),
        requestSchema: buildStructSchema(table, base.requestSymbol),
        frameSchema: buildStructSchema(table, frameType),
        ...(errorBodyType ? { errorBodySchema: buildStructSchema(table, errorBodyType) } : {}),
        bindings,
    };
}
function buildRouteModel(table, entryPath, service, method, mode) {
    const base = buildMethodContractBase(table, entryPath, service, method);
    const bindings = buildFieldBindings(table, base.requestSymbol, base.method);
    const transport = isWholeJsonBodyRoute(base.method, bindings) ? 'jsonBody' : 'metadataOnly';
    void mode;
    const successStatus = parseSuccessStatus(method, entryPath);
    return {
        ...(successStatus === undefined ? {} : { successStatus }),
        serviceName: base.serviceName,
        methodName: base.methodName,
        tsName: base.tsName,
        domain: base.domain,
        method: base.method,
        path: base.path,
        requestType: base.requestType,
        responseType: base.responseType,
        requestSchema: buildStructSchema(table, base.requestSymbol),
        responseSchema: buildStructSchema(table, base.responseSymbol),
        bindings,
        transport,
    };
}
function buildMethodContractBase(table, entryPath, service, method) {
    if (method.oneway)
        throw new Error(`${entryPath}: unsupported oneway method ${method.name}`);
    if (method.void || !method.returnType) {
        throw new Error(`${entryPath}: unsupported void method ${method.name}`);
    }
    if ((method.throws ?? []).length > 0) {
        throw new Error(`${entryPath}: method ${method.name} declares unsupported throws`);
    }
    if (method.arguments.length !== 1) {
        throw new Error(`${entryPath}: method ${method.name} must have exactly one request argument`);
    }
    const requestArg = method.arguments[0];
    if (!requestArg)
        throw new Error(`${entryPath}: missing request argument for ${method.name}`);
    const requestSymbol = requireStructType(table, entryPath, requestArg.type, `${method.name} request`);
    const responseSymbol = requireStructType(table, entryPath, method.returnType, `${method.name} response`);
    const route = parseRoute(method, entryPath);
    const domain = parseDomain(method, entryPath);
    return {
        serviceName: service.name,
        methodName: method.name,
        tsName: thriftMethodToTsName(method.name),
        domain,
        method: route.method,
        path: route.path,
        requestType: requestSymbol.name,
        responseType: responseSymbol.name,
        requestSymbol,
        responseSymbol,
    };
}
/**
 * Reads the optional `api.domain` annotation. Absent is allowed at the model
 * layer (generic HTTP contracts have no domain); the v2 controller emitters are
 * where a missing domain becomes a hard error (see groupServiceByDomain).
 */
function parseDomain(method, entryPath) {
    const annotation = getSingleAnnotation(method, DOMAIN_ANNOTATION);
    if (!annotation)
        return undefined;
    if (annotation.values.length !== 1) {
        throw new Error(`${entryPath}: method ${method.name} ${DOMAIN_ANNOTATION} must have exactly one value`);
    }
    const domain = annotation.values[0];
    if (!domain || !DOMAIN_NAME_PATTERN.test(domain)) {
        throw new Error(`${entryPath}: method ${method.name} ${DOMAIN_ANNOTATION} must be a lowercase snake_case identifier, got ${String(domain)}`);
    }
    return domain;
}
function requireAnnotationStructType(table, entryPath, method, annotation, annotationName) {
    if (annotation.values.length !== 1) {
        throw new Error(`${entryPath}: method ${method.name} ${annotationName} must have exactly one value`);
    }
    const typeName = annotation.values[0];
    if (!typeName) {
        throw new Error(`${entryPath}: method ${method.name} ${annotationName} requires a value`);
    }
    return requireStructType(table, entryPath, { kind: 'identifier', name: typeName }, `${method.name} ${annotationName}`);
}
function getSingleAnnotation(method, key) {
    const annotations = (method.annotations ?? []).filter((annotation) => annotation.key === key);
    if (annotations.length > 1) {
        throw new Error(`method ${method.name} has duplicate ${key} annotations`);
    }
    return annotations[0];
}
function requireStructType(table, currentFilePath, type, context) {
    const resolved = resolveUnderlyingType(resolveType(table, currentFilePath, type));
    if (resolved.kind !== 'struct') {
        throw new Error(`${currentFilePath}: ${context} must resolve to struct`);
    }
    return resolved.symbol;
}
function parseRoute(method, entryPath) {
    const routeAnnotations = getRouteAnnotations(method);
    if (routeAnnotations.length !== 1) {
        throw new Error(`${entryPath}: method ${method.name} must have exactly one api.<verb> annotation`);
    }
    const annotation = routeAnnotations[0];
    if (!annotation)
        throw new Error(`${entryPath}: method ${method.name} is missing route annotation`);
    if (annotation.values.length !== 1) {
        throw new Error(`${entryPath}: method ${method.name} route annotation must have exactly one value`);
    }
    const verb = ROUTE_ANNOTATIONS[annotation.key];
    if (!verb)
        throw new Error(`${entryPath}: unsupported HTTP method annotation ${annotation.key}`);
    const value = annotation.values[0];
    if (!value || !value.startsWith('/')) {
        throw new Error(`${entryPath}: route path must be absolute, got ${String(value)}`);
    }
    return { method: verb, path: value };
}
function getRouteAnnotations(method) {
    return (method.annotations ?? []).filter((annotation) => annotation.key in ROUTE_ANNOTATIONS);
}
function buildFieldBindings(table, requestSymbol, method) {
    const declaration = requestSymbol.declaration;
    if (!('fields' in declaration)) {
        throw new Error(`${requestSymbol.filePath}: request ${requestSymbol.name} is not a struct`);
    }
    return declaration.fields.map((field) => {
        const resolvedType = resolveType(table, requestSymbol.filePath, field.type);
        const tsType = emitTsType(resolvedType);
        const valueModel = buildBindingValueModel(table, requestSymbol.filePath, resolvedType);
        const fieldName = thriftFieldToTsPropertyName(field.name);
        const explicit = parseFieldBindingAnnotation(requestSymbol.filePath, field, fieldName, tsType, valueModel);
        if (explicit)
            return explicit;
        return {
            thriftName: field.name,
            fieldName,
            wireName: field.name,
            jsonName: field.name,
            kind: method === 'GET' ? 'query' : 'implicitBody',
            fieldId: field.id,
            requiredness: field.requiredness,
            tsType,
            ...valueModel,
        };
    });
}
function parseFieldBindingAnnotation(filePath, field, fieldName, tsType, valueModel) {
    const unsupportedApiAnnotation = (field.annotations ?? []).find((annotation) => annotation.key.startsWith('api.') &&
        !FIELD_BINDING_ANNOTATIONS.has(annotation.key) &&
        !IGNORED_FIELD_API_ANNOTATIONS.has(annotation.key));
    if (unsupportedApiAnnotation) {
        throw new Error(`${filePath}: field ${field.name} has unsupported binding annotation ${unsupportedApiAnnotation.key}`);
    }
    const annotations = (field.annotations ?? []).filter((annotation) => FIELD_BINDING_ANNOTATIONS.has(annotation.key));
    if (annotations.length === 0)
        return undefined;
    if (annotations.length !== 1) {
        throw new Error(`${filePath}: field ${field.name} must have at most one api.* binding annotation`);
    }
    const annotation = annotations[0];
    if (!annotation)
        return undefined;
    const kind = parseFieldBindingKind(annotation.key, filePath, field.name);
    if (annotation.values.length > 1) {
        throw new Error(`${filePath}: field ${field.name} binding ${annotation.key} has multiple values`);
    }
    const wireName = annotation.values[0] ?? '';
    if (kind !== 'none' && !wireName) {
        throw new Error(`${filePath}: field ${field.name} binding ${annotation.key} requires a value`);
    }
    return {
        thriftName: field.name,
        fieldName,
        wireName,
        jsonName: field.name,
        kind,
        fieldId: field.id,
        requiredness: field.requiredness,
        tsType,
        ...valueModel,
    };
}
function buildBindingValueModel(table, filePath, type) {
    const underlying = resolveUnderlyingType(type);
    if (isScalarBindingType(underlying))
        return { valueKind: 'scalar' };
    if (underlying.kind === 'list' || underlying.kind === 'set') {
        const item = resolveUnderlyingType(underlying.valueType);
        return { valueKind: isScalarBindingType(item) ? 'scalarList' : 'unsupported' };
    }
    if (underlying.kind === 'struct') {
        const declaration = underlying.symbol.declaration;
        if (!('fields' in declaration))
            return { valueKind: 'unsupported' };
        const structFields = declaration.fields.map((field) => {
            const resolvedFieldType = resolveType(table, underlying.symbol.filePath, field.type);
            return {
                thriftName: field.name,
                fieldName: thriftFieldToTsPropertyName(field.name),
                wireName: field.name,
                jsonName: field.name,
                requiredness: field.requiredness,
                tsType: emitTsType(resolvedFieldType),
                valueKind: buildBindingValueModel(table, underlying.symbol.filePath, resolvedFieldType)
                    .valueKind,
            };
        });
        return { valueKind: 'struct', structFields };
    }
    return { valueKind: 'unsupported' };
}
function buildStructSchema(table, symbol) {
    const declaration = symbol.declaration;
    if (!('fields' in declaration)) {
        throw new Error(`${symbol.filePath}: ${symbol.name} is not a struct`);
    }
    return {
        name: symbol.name,
        fields: declaration.fields.map((field) => {
            if (isOpaqueBaseWrapperField(field)) {
                return {
                    thriftName: field.name,
                    fieldName: thriftFieldToTsPropertyName(field.name),
                    wireName: field.name,
                    jsonName: field.name,
                    requiredness: field.requiredness,
                    value: { kind: 'scalar' },
                };
            }
            const resolvedType = resolveType(table, symbol.filePath, field.type);
            return {
                thriftName: field.name,
                fieldName: thriftFieldToTsPropertyName(field.name),
                wireName: field.name,
                jsonName: field.name,
                requiredness: field.requiredness,
                value: buildStructValueSchema(table, resolvedType),
            };
        }),
    };
}
function isOpaqueBaseWrapperField(field) {
    return ((field.id === 254 && field.name === 'base_req') ||
        (field.id === 255 && field.name === 'base_resp'));
}
function buildStructValueSchema(table, type) {
    const underlying = resolveUnderlyingType(type);
    if (isScalarBindingType(underlying))
        return { kind: 'scalar' };
    if (underlying.kind === 'struct')
        return { kind: 'struct', schema: buildStructSchema(table, underlying.symbol) };
    if (underlying.kind === 'list') {
        return { kind: 'list', item: buildStructValueSchema(table, underlying.valueType) };
    }
    if (underlying.kind === 'set') {
        return { kind: 'set', item: buildStructValueSchema(table, underlying.valueType) };
    }
    if (underlying.kind === 'map') {
        const keyType = resolveUnderlyingType(underlying.keyType);
        if (keyType.kind !== 'builtin' || keyType.name !== 'string') {
            throw new Error('Only map<string, V> is supported for HTTP JSON generation');
        }
        return { kind: 'map', value: buildStructValueSchema(table, underlying.valueType) };
    }
    throw new Error(`Unsupported HTTP JSON schema value type ${underlying.kind}`);
}
function isScalarBindingType(type) {
    return (type.kind === 'builtin' && type.category !== 'binary') || type.kind === 'enum';
}
function parseFieldBindingKind(key, filePath, fieldName) {
    switch (key) {
        case 'api.path':
            return 'path';
        case 'api.query':
            return 'query';
        case 'api.body':
            return 'body';
        case 'api.header':
            return 'header';
        case 'api.none':
            return 'none';
        default:
            throw new Error(`${filePath}: field ${fieldName} has unsupported binding annotation ${key}`);
    }
}
function isWholeJsonBodyRoute(method, bindings) {
    return method !== 'GET' && bindings.every((binding) => binding.kind === 'implicitBody');
}
function assertNoTsNameCollisions(models) {
    const seen = new Map();
    for (const model of models) {
        const previousFile = seen.get(model.name);
        if (previousFile && previousFile !== model.filePath) {
            throw new Error(`Duplicate TypeScript declaration name ${model.name} in ${previousFile} and ${model.filePath}`);
        }
        seen.set(model.name, model.filePath);
    }
}
function assertNoFieldNameCollisions(filePath, structName, fields) {
    const seen = new Map();
    for (const field of fields) {
        const previous = seen.get(field.fieldName);
        if (previous) {
            throw new Error(`${filePath}: struct ${structName} has duplicate TypeScript field name ${field.fieldName} from ${previous} and ${field.thriftName}`);
        }
        seen.set(field.fieldName, field.thriftName);
    }
}
function getFileOrThrow(table, entryPath) {
    const file = table.files.get(entryPath);
    if (!file)
        throw new Error(`Entry thrift file ${entryPath} is missing from IR`);
    return file;
}
function parseSuccessStatus(method, entryPath) {
    const annotation = getSingleAnnotation(method, 'api.success_status');
    if (!annotation)
        return undefined;
    const raw = annotation.values[0];
    if (annotation.values.length !== 1 ||
        !raw ||
        !/^2\d\d$/u.test(raw) ||
        raw === '204' ||
        raw === '205') {
        throw new Error(`${entryPath}: method ${method.name} api.success_status must be a JSON-body 2xx status`);
    }
    return Number(raw);
}
//# sourceMappingURL=http-service-model.js.map