import { THRIFT_I64_ALIAS, emitEnum, toScreamingSnake } from './ts-type-mapper.js';
export function emitHttpService(definition, options = {}) {
    const emitRuntime = options.emitRuntime ?? true;
    const routeMetadataStyle = options.routeMetadataStyle ?? (emitRuntime ? 'full' : 'minimal');
    if (emitRuntime) {
        validateRuntimeBindings(definition, routeMetadataStyle);
    }
    return {
        typesTs: emitTypesFile(definition),
        routesTs: emitRoutesFile(definition, routeMetadataStyle, options.runtimeImportPrefix ?? '../../runtime'),
        clientTs: emitRuntime
            ? emitClientFile(definition, options)
            : emitEmptyRuntimeFile(definition.sourcePath),
        serverTs: emitRuntime
            ? emitServerFile(definition, options)
            : emitEmptyRuntimeFile(definition.sourcePath),
    };
}
function emitEmptyRuntimeFile(sourcePath) {
    return `${header(sourcePath)}\n`;
}
function emitTypesFile(definition) {
    const sections = [header(definition.sourcePath)];
    if (definition.usesThriftI64)
        sections.push(THRIFT_I64_ALIAS);
    sections.push(...definition.enums.map((model) => emitEnum(model.declaration)));
    sections.push(...definition.structs.map(emitStruct));
    return `${joinSections(sections)}\n`;
}
function emitRoutesFile(definition, routeMetadataStyle, runtimeImportPrefix) {
    // Struct schemas and binding struct-field lists are emitted once as shared module
    // constants. Inlining them per route duplicated nested structs (for example
    // BaseReq) hundreds of times, which made the generated table tens of megabytes and
    // every process that imports it retained the duplicated object graph.
    const sharedConstants = new RouteMetadataConstants(collectDeclaredNames(definition));
    const routeSections = [];
    for (const service of definition.services) {
        routeSections.push(emitRouteMetadata(service, routeMetadataStyle, sharedConstants));
        if (service.sseContracts.length > 0) {
            routeSections.push(emitSseContractTypes(service));
            routeSections.push(emitSseContractMetadata(service, sharedConstants));
        }
        routeSections.push(emitRouteMatcher(service));
    }
    const sections = [header(definition.sourcePath)];
    sections.push(emitTypeImports(definition, {
        importPath: './types.js',
        includeMethodTypes: false,
        includeSseContractTypes: true,
    }));
    sections.push(emitRouteRuntimeTypeImports(runtimeImportPrefix, hasSseContracts(definition), {
        structSchema: sharedConstants.hasStructSchemas(),
        bindingStructFields: sharedConstants.hasBindingStructFields(),
    }));
    sections.push(...sharedConstants.declarations());
    sections.push(...routeSections);
    return `${joinSections(sections)}\n`;
}
function collectDeclaredNames(definition) {
    return new Set([
        ...definition.structs.map((model) => model.name),
        ...definition.enums.map((model) => model.name),
    ]);
}
const STRUCT_SCHEMA_IDENTIFIER_PREFIX = 'STRUCT_SCHEMA__';
const BINDING_STRUCT_FIELDS_IDENTIFIER_PREFIX = 'BINDING_STRUCT_FIELDS__';
/**
 * Deduplicates emitted route metadata by structural content. Struct schema
 * declarations are appended in post-order so every referenced schema is declared
 * before use; binding struct-field lists have no dependencies.
 */
class RouteMetadataConstants {
    reservedNames;
    identifiersBySignature = new Map();
    usedIdentifiers = new Set();
    emittedDeclarations = [];
    structSchemaCount = 0;
    bindingStructFieldsCount = 0;
    constructor(reservedNames) {
        this.reservedNames = reservedNames;
    }
    structSchema(schema) {
        const signature = `schema:${JSON.stringify(schema)}`;
        const existing = this.identifiersBySignature.get(signature);
        if (existing)
            return existing;
        // Emit dependencies first so the declaration order is valid without hoisting.
        const fieldLines = schema.fields.flatMap((field) => indentLines(emitStructFieldSchema(field, this), 4));
        const identifier = this.allocateIdentifier(STRUCT_SCHEMA_IDENTIFIER_PREFIX, schema.name);
        this.identifiersBySignature.set(signature, identifier);
        this.structSchemaCount += 1;
        this.emittedDeclarations.push([
            `const ${identifier}: HttpStructSchema = {`,
            `  name: '${schema.name}',`,
            '  fields: [',
            ...fieldLines,
            '  ],',
            '};',
        ].join('\n'));
        return identifier;
    }
    bindingStructFields(tsType, fields) {
        const signature = `bindingStructFields:${JSON.stringify(fields)}`;
        const existing = this.identifiersBySignature.get(signature);
        if (existing)
            return existing;
        const identifier = this.allocateIdentifier(BINDING_STRUCT_FIELDS_IDENTIFIER_PREFIX, tsType);
        this.identifiersBySignature.set(signature, identifier);
        this.bindingStructFieldsCount += 1;
        this.emittedDeclarations.push([
            `const ${identifier}: readonly HttpFieldBindingStructField[] = [`,
            ...fields.flatMap((field) => indentLines(emitStructFieldBinding(field), 2)),
            '];',
        ].join('\n'));
        return identifier;
    }
    hasStructSchemas() {
        return this.structSchemaCount > 0;
    }
    hasBindingStructFields() {
        return this.bindingStructFieldsCount > 0;
    }
    declarations() {
        return [...this.emittedDeclarations];
    }
    allocateIdentifier(prefix, name) {
        const base = `${prefix}${name.replace(/[^A-Za-z0-9_$]/g, '_')}`;
        let candidate = base;
        for (let suffix = 2; this.isTaken(candidate); suffix += 1) {
            candidate = `${base}__${suffix}`;
        }
        this.usedIdentifiers.add(candidate);
        return candidate;
    }
    isTaken(identifier) {
        return this.usedIdentifiers.has(identifier) || this.reservedNames.has(identifier);
    }
}
function emitRouteRuntimeTypeImports(runtimeImportPrefix, includeSseRuntime, sharedConstantTypes) {
    const httpJsonTypeNames = [
        ...(sharedConstantTypes.bindingStructFields ? ['HttpFieldBindingStructField'] : []),
        'HttpJsonRoute',
        ...(sharedConstantTypes.structSchema ? ['HttpStructSchema'] : []),
    ];
    const httpJsonTypes = httpJsonTypeNames.join(', ');
    const lines = [`import type { ${httpJsonTypes} } from '${runtimeImportPrefix}/http-json.js';`];
    if (includeSseRuntime) {
        lines.push(`import type { HttpSseRoute } from '${runtimeImportPrefix}/sse.js';`);
    }
    return lines.join('\n');
}
function emitClientFile(definition, options) {
    const runtimeImportPrefix = options.runtimeImportPrefix ?? '../../runtime';
    const sections = [header(definition.sourcePath)];
    sections.push(emitClientRuntimeImports(runtimeImportPrefix, hasSseContracts(definition)));
    sections.push(emitTypeImports(definition, {
        importPath: './types.js',
        includeMethodTypes: true,
        includeSseContractTypes: true,
        includeSseResponseTypes: false,
        includeSseErrorBodyTypes: false,
    }));
    sections.push(emitRouteImports(definition));
    for (const service of definition.services) {
        sections.push(emitClientInterface(service));
        sections.push(emitClientFactory(service));
    }
    return `${joinSections(sections)}\n`;
}
function emitServerFile(definition, options) {
    const runtimeImportPrefix = options.runtimeImportPrefix ?? '../../runtime';
    const sections = [header(definition.sourcePath)];
    sections.push(emitServerRuntimeImports(runtimeImportPrefix, hasSseContracts(definition)));
    sections.push(emitTypeImports(definition, {
        importPath: './types.js',
        includeMethodTypes: true,
        includeSseContractTypes: true,
        includeSseResponseTypes: false,
    }));
    sections.push(emitRouteImports(definition));
    for (const service of definition.services) {
        sections.push(emitServiceMountInterface());
        sections.push(emitBaseClass(service));
        sections.push(emitMountFactory(service));
        sections.push(emitRouterFactory(service));
    }
    return `${joinSections(sections)}\n`;
}
function hasSseContracts(definition) {
    return definition.services.some((service) => service.sseContracts.length > 0);
}
function emitTypeImports(definition, options) {
    const typeNames = Array.from(new Set(definition.services.flatMap((service) => {
        const methodTypes = options.includeMethodTypes
            ? service.methods.flatMap((method) => [method.requestType, method.responseType])
            : [];
        const sseContractTypes = options.includeSseContractTypes
            ? service.sseContracts.flatMap((contract) => [
                contract.requestType,
                ...(options.includeSseResponseTypes === false ? [] : [contract.responseType]),
                contract.frameType,
                ...(contract.errorBodyType && options.includeSseErrorBodyTypes !== false
                    ? [contract.errorBodyType]
                    : []),
            ])
            : [];
        return [...methodTypes, ...sseContractTypes];
    })));
    if (typeNames.length === 0)
        return '';
    const singleLine = `import type { ${typeNames.join(', ')} } from '${options.importPath}';`;
    if (singleLine.length <= 80)
        return singleLine;
    return [
        'import type {',
        ...typeNames.map((typeName) => `  ${typeName},`),
        `} from '${options.importPath}';`,
    ].join('\n');
}
function emitRouteImports(definition) {
    const names = definition.services.flatMap((service) => [
        routeConstant(service.name),
        ...(service.sseContracts.length > 0 ? [sseContractConstant(service.name)] : []),
    ]);
    if (names.length === 0)
        return '';
    const singleLine = `import { ${names.join(', ')} } from './routes.js';`;
    if (singleLine.length <= 100)
        return singleLine;
    return ['import {', ...names.map((name) => `  ${name},`), "} from './routes.js';"].join('\n');
}
function joinSections(sections) {
    const nonEmpty = sections.filter((section) => section.length > 0);
    const [first, second, ...rest] = nonEmpty;
    if (!first)
        return '';
    if (!second)
        return first;
    const firstSeparator = second.startsWith('import ') ? '\n' : '\n\n';
    return `${first}${firstSeparator}${[second, ...rest].join('\n\n')}`;
}
function emitClientRuntimeImports(runtimeImportPrefix, includeSseRuntime) {
    const lines = [
        'import {',
        '  invokeHttpJson,',
        '  type HttpJsonClientOptions,',
        '  type HttpServiceCallOptions,',
        `} from '${runtimeImportPrefix}/http-json.js';`,
    ];
    if (includeSseRuntime) {
        lines.push('import {', '  invokeHttpSse,', '  type HttpServiceStream,', '  type HttpSseClientOptions,', `} from '${runtimeImportPrefix}/sse.js';`);
    }
    return lines.join('\n');
}
function emitServerRuntimeImports(runtimeImportPrefix, includeSseRuntime) {
    const lines = [
        "import { Hono } from 'hono';",
        "import { HTTPException } from 'hono/http-exception';",
        'import {',
        '  httpServiceContextFromHeaders,',
        '  responseHeadersFromHttpServiceContext,',
        '  type HttpServiceContext,',
        `} from '${runtimeImportPrefix}/context.js';`,
        'import {',
        '  encodeHttpResponse,',
        '  HttpRequestValidationError,',
        '  parseHttpRequest,',
        `} from '${runtimeImportPrefix}/http-json.js';`,
    ];
    if (includeSseRuntime) {
        lines.push(`import { createSseResponse, type SseOpenResult } from '${runtimeImportPrefix}/sse.js';`);
    }
    return lines.join('\n');
}
function emitStruct(struct) {
    const lines = [`export interface ${struct.name} {`];
    for (const field of struct.fields) {
        const optional = field.optional ? '?' : '';
        lines.push(`  ${field.fieldName}${optional}: ${field.tsType};`);
    }
    lines.push('}');
    return lines.join('\n');
}
function emitClientInterface(service) {
    return [
        `export interface ${service.name}Client {`,
        ...service.methods.flatMap((method) => indentLines(emitClientMethodSignature(method).split('\n'), 2)),
        ...service.sseContracts.flatMap((contract) => indentLines(emitSseClientSignature(contract).split('\n'), 2)),
        '}',
    ].join('\n');
}
function emitRouteMetadata(service, style, sharedConstants) {
    const routeConstantName = routeConstant(service.name);
    const routeMetadataType = `${service.name}RouteMetadata`;
    const routeMapType = `${service.name}RouteMap`;
    const lines = [
        `type ${routeMetadataType} = HttpJsonRoute & {`,
        '  serviceName?: string;',
        '  methodName?: string;',
        '  requestType?: string;',
        '  responseType?: string;',
        '};',
        '',
        `type ${routeMapType} = {`,
        ...service.methods.map((method) => `  ${method.tsName}: ${routeMetadataType};`),
        '};',
        '',
        `export const ${routeConstantName}: ${routeMapType} = {`,
    ];
    for (const method of service.methods) {
        lines.push(`  ${method.tsName}: {`);
        if (style === 'full') {
            lines.push(`    serviceName: '${method.serviceName}',`);
            lines.push(`    methodName: '${method.methodName}',`);
        }
        lines.push(`    method: '${method.method}',`);
        lines.push(`    path: '${method.path}',`);
        if (method.successStatus !== undefined)
            lines.push(`    successStatus: ${method.successStatus},`);
        if (style === 'full') {
            lines.push(`    requestType: '${method.requestType}',`);
            lines.push(`    responseType: '${method.responseType}',`);
            lines.push(`    transport: '${method.transport}',`);
            lines.push(emitStructSchemaProperty('requestSchema', method.requestSchema, 4, sharedConstants));
            lines.push(emitStructSchemaProperty('responseSchema', method.responseSchema, 4, sharedConstants));
            lines.push('    bindings: [');
            for (const binding of method.bindings)
                lines.push(emitBinding(binding, sharedConstants));
            lines.push('    ],');
        }
        lines.push('  },');
    }
    lines.push('} as const;');
    return lines.join('\n');
}
function emitSseContractTypes(service) {
    const lines = [`export interface ${serviceSseContractTypesName(service.name)} {`];
    for (const contract of service.sseContracts) {
        lines.push(`  ${contract.tsName}: {`);
        lines.push(`    request: ${contract.requestType};`);
        lines.push(`    response: ${contract.responseType};`);
        lines.push(`    frame: ${contract.frameType};`);
        if (contract.errorBodyType)
            lines.push(`    errorBody: ${contract.errorBodyType};`);
        lines.push('  };');
    }
    lines.push('}');
    return lines.join('\n');
}
function emitSseContractMetadata(service, sharedConstants) {
    const sseMetadataType = `${service.name}SseRouteMetadata`;
    const sseMapType = `${service.name}SseRouteMap`;
    const lines = [
        `type ${sseMetadataType} = HttpSseRoute & {`,
        '  serviceName?: string;',
        '  methodName?: string;',
        '  requestType?: string;',
        '  responseType?: string;',
        '  frameType?: string;',
        '  errorBodyType?: string;',
        '};',
        '',
        `type ${sseMapType} = {`,
        ...service.sseContracts.map((contract) => `  ${contract.tsName}: ${sseMetadataType};`),
        '};',
        '',
        `export const ${sseContractConstant(service.name)}: ${sseMapType} = {`,
    ];
    for (const contract of service.sseContracts) {
        lines.push(`  ${contract.tsName}: {`);
        lines.push(`    serviceName: '${contract.serviceName}',`);
        lines.push(`    methodName: '${contract.methodName}',`);
        lines.push(`    method: '${contract.method}',`);
        lines.push(`    path: '${contract.path}',`);
        lines.push(`    requestType: '${contract.requestType}',`);
        lines.push(`    responseType: '${contract.responseType}',`);
        lines.push(`    frameType: '${contract.frameType}',`);
        if (contract.errorBodyType)
            lines.push(`    errorBodyType: '${contract.errorBodyType}',`);
        lines.push("    transport: 'sse',");
        lines.push(emitStructSchemaProperty('requestSchema', contract.requestSchema, 4, sharedConstants));
        lines.push(emitStructSchemaProperty('frameSchema', contract.frameSchema, 4, sharedConstants));
        if (contract.errorBodySchema) {
            lines.push(emitStructSchemaProperty('errorBodySchema', contract.errorBodySchema, 4, sharedConstants));
        }
        lines.push('    bindings: [');
        for (const binding of contract.bindings)
            lines.push(emitBinding(binding, sharedConstants));
        lines.push('    ],');
        lines.push('  },');
    }
    lines.push('} as const;');
    return lines.join('\n');
}
function emitRouteMatcher(service) {
    const routeMatchers = `${toScreamingSnake(service.name)}_ROUTE_MATCHERS`;
    const pathMatcher = `matches${service.name}RoutePath`;
    const routeSources = [
        `...Object.values(${routeConstant(service.name)})`,
        ...(service.sseContracts.length > 0
            ? [`...Object.values(${sseContractConstant(service.name)})`]
            : []),
    ];
    return [
        `const ${routeMatchers} = [`,
        ...routeSources.map((source) => `  ${source},`),
        '] as const;',
        '',
        `export function is${service.name}Route(method: string, pathname: string): boolean {`,
        `  return ${routeMatchers}.some(`,
        `    (route) => route.method === method && ${pathMatcher}(route.path, pathname),`,
        '  );',
        '}',
        '',
        `function ${pathMatcher}(template: string, pathname: string): boolean {`,
        "  const expected = template.split('/');",
        "  const actual = pathname.split('/');",
        '  return (',
        '    expected.length === actual.length &&',
        '    expected.every(',
        '      (segment, index) =>',
        "        (segment.startsWith(':') && Boolean(actual[index])) || segment === actual[index],",
        '    )',
        '  );',
        '}',
    ].join('\n');
}
function emitServiceMountInterface() {
    return [
        'export interface ServiceMount {',
        '  tryHandle(request: Request): Promise<Response | null>;',
        '}',
    ].join('\n');
}
function emitBaseClass(service) {
    const lines = [`export abstract class ${service.name}Base {`];
    for (const method of service.methods) {
        lines.push(...indentLines(`abstract ${emitServerMethodSignature(method)}`.split('\n'), 2));
    }
    for (const contract of service.sseContracts) {
        lines.push(`  abstract ${contract.tsName}(`);
        lines.push('    ctx: HttpServiceContext,');
        lines.push(`    req: ${contract.requestType},`);
        lines.push(`  ): Promise<${sseOpenResultType(contract)}>;`);
    }
    lines.push('');
    lines.push('  createMount(): ServiceMount {');
    lines.push(`    return create${service.name}Mount(this);`);
    lines.push('  }');
    lines.push('}');
    return lines.join('\n');
}
function emitClientFactory(service) {
    const optionsType = service.sseContracts.length > 0
        ? 'HttpJsonClientOptions & HttpSseClientOptions'
        : 'HttpJsonClientOptions';
    const lines = [
        `export function create${service.name}Client(`,
        `  options: ${optionsType},`,
        `): ${service.name}Client {`,
        '  return {',
    ];
    for (const method of service.methods) {
        lines.push(`    ${method.tsName}(req, callOptions) {`);
        lines.push(...emitReturnCall('invokeHttpJson', [
            'options',
            `${routeConstant(service.name)}.${method.tsName}`,
            'req',
            'callOptions',
        ]));
        lines.push('    },');
    }
    for (const contract of service.sseContracts) {
        lines.push(`    ${contract.tsName}(req, callOptions) {`);
        lines.push(...emitReturnCall(`invokeHttpSse<${sseInvokeGenericTypes(contract)}>`, [
            'options',
            `${sseContractConstant(service.name)}.${contract.tsName}`,
            'req',
            'callOptions',
        ]));
        lines.push('    },');
    }
    lines.push('  };');
    lines.push('}');
    return lines.join('\n');
}
function emitMountFactory(service) {
    const routerFactoryName = `create${service.name}Router`;
    const missHeader = `${toScreamingSnake(service.name)}_ROUTE_MISS_HEADER`;
    return [
        `const ${missHeader} = 'x-mavis-thrift-route-miss';`,
        '',
        `export function create${service.name}Mount(service: ${service.name}Base): ServiceMount {`,
        `  const router = ${routerFactoryName}(service);`,
        '  return {',
        '    async tryHandle(request) {',
        '      const response = await router.fetch(request);',
        `      if (response.headers.get(${missHeader}) === '1') return null;`,
        '      return response;',
        '    },',
        '  };',
        '}',
    ].join('\n');
}
function emitRouterFactory(service) {
    const missHeader = `${toScreamingSnake(service.name)}_ROUTE_MISS_HEADER`;
    const lines = [
        `function create${service.name}Router(service: ${service.name}Base): Hono {`,
        '  const app = new Hono();',
        '  app.onError((error) => {',
        '    if (error instanceof HttpRequestValidationError) {',
        '      return new Response(',
        "        JSON.stringify({ error: 'Invalid HTTP request', code: error.code }),",
        "        { status: 400, headers: { 'Content-Type': 'application/json' } },",
        '      );',
        '    }',
        '    if (error instanceof HTTPException || isCompatibleHttpException(error)) {',
        '      return error.getResponse();',
        '    }',
        '    console.error(error);',
        "    return new Response('Internal Server Error', { status: 500 });",
        '  });',
    ];
    for (const method of service.methods) {
        lines.push('');
        lines.push(`  app.${honoMethod(method.method)}(${routeConstant(service.name)}.${method.tsName}.path, async (c) => {`);
        lines.push('    const ctx = httpServiceContextFromHeaders(c.req.raw.headers);');
        lines.push(`    const req = await parseHttpRequest<${method.requestType}>(`);
        lines.push(`      ${routeConstant(service.name)}.${method.tsName},`);
        lines.push('      c.req.raw,');
        lines.push('      c.req.param(),');
        lines.push('    );');
        lines.push(`    const resp = await service.${method.tsName}(ctx, req);`);
        const responseExpression = `encodeHttpResponse(${routeConstant(service.name)}.${method.tsName}, resp)`;
        const bodyLine = `    const body = JSON.stringify(${responseExpression});`;
        if (bodyLine.length <= 100) {
            lines.push(bodyLine);
        }
        else {
            lines.push('    const body = JSON.stringify(');
            lines.push(`      ${responseExpression},`);
            lines.push('    );');
        }
        lines.push('    return new Response(body, {');
        lines.push(`      status: ${method.successStatus ?? 200},`);
        lines.push('      headers: responseHeadersFromHttpServiceContext(ctx, {');
        lines.push("        'Content-Type': 'application/json',");
        lines.push('      }),');
        lines.push('    });');
        lines.push('  });');
    }
    for (const contract of service.sseContracts) {
        lines.push('');
        lines.push(`  app.${honoMethod(contract.method)}(${sseContractConstant(service.name)}.${contract.tsName}.path, async (c) => {`);
        lines.push('    const ctx = httpServiceContextFromHeaders(c.req.raw.headers, c.req.raw.signal);');
        lines.push(`    const req = await parseHttpRequest<${contract.requestType}>(`);
        lines.push(`      ${sseContractConstant(service.name)}.${contract.tsName},`);
        lines.push('      c.req.raw,');
        lines.push('      c.req.param(),');
        lines.push('    );');
        lines.push(`    const result = await service.${contract.tsName}(ctx, req);`);
        lines.push(`    return createSseResponse(${sseContractConstant(service.name)}.${contract.tsName}, ctx, result);`);
        lines.push('  });');
    }
    lines.push('');
    lines.push('  app.notFound(');
    lines.push('    () =>');
    lines.push('      new Response(null, {');
    lines.push('        status: 404,');
    lines.push(`        headers: { [${missHeader}]: '1' },`);
    lines.push('      }),');
    lines.push('  );');
    lines.push('');
    lines.push('  return app;');
    lines.push('}');
    lines.push('', 'function isCompatibleHttpException(', '  error: unknown,', '): error is { readonly status: number; getResponse(): Response } {', "  if (!(error instanceof Error) || typeof Object(error).getResponse !== 'function') return false;", '  const status = Object(error).status;', "  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599;", '}');
    return lines.join('\n');
}
function emitClientMethodSignature(method) {
    const singleLine = `${method.tsName}(req: ${method.requestType}, options?: HttpServiceCallOptions): Promise<${method.responseType}>;`;
    // The interface emitter adds two leading spaces. Keep the generated shape
    // aligned with Prettier's 100-column decision so lint-staged is idempotent.
    if (singleLine.length <= 98)
        return singleLine;
    return [
        `${method.tsName}(`,
        `  req: ${method.requestType},`,
        '  options?: HttpServiceCallOptions,',
        `): Promise<${method.responseType}>;`,
    ].join('\n');
}
function emitServerMethodSignature(method) {
    const singleLine = `${method.tsName}(ctx: HttpServiceContext, req: ${method.requestType}): Promise<${method.responseType}>;`;
    if (singleLine.length <= 89)
        return singleLine;
    return [
        `${method.tsName}(`,
        '  ctx: HttpServiceContext,',
        `  req: ${method.requestType},`,
        `): Promise<${method.responseType}>;`,
    ].join('\n');
}
function emitSseClientSignature(contract) {
    const singleLine = `${contract.tsName}(req: ${contract.requestType}, options?: HttpServiceCallOptions): HttpServiceStream<${contract.frameType}>;`;
    if (singleLine.length <= 96)
        return singleLine;
    return [
        `${contract.tsName}(`,
        `  req: ${contract.requestType},`,
        '  options?: HttpServiceCallOptions,',
        `): HttpServiceStream<${contract.frameType}>;`,
    ].join('\n');
}
function emitReturnCall(functionName, args) {
    const singleLine = `      return ${functionName}(${args.join(', ')});`;
    if (singleLine.length <= 100)
        return [singleLine];
    return [`      return ${functionName}(`, ...args.map((arg) => `        ${arg},`), '      );'];
}
function sseOpenResultType(contract) {
    return contract.errorBodyType
        ? `SseOpenResult<${contract.frameType}, ${contract.errorBodyType}>`
        : `SseOpenResult<${contract.frameType}>`;
}
function sseInvokeGenericTypes(contract) {
    return `${contract.requestType}, ${contract.frameType}`;
}
function emitBinding(binding, sharedConstants) {
    const lines = [
        '      {',
        `        thriftName: '${binding.thriftName}',`,
        `        fieldName: '${binding.fieldName}',`,
        `        wireName: '${binding.wireName}',`,
        `        jsonName: '${binding.jsonName}',`,
        `        kind: '${binding.kind}',`,
        `        fieldId: ${binding.fieldId},`,
        `        requiredness: '${binding.requiredness}',`,
        `        tsType: '${binding.tsType}',`,
        `        valueKind: '${binding.valueKind}',`,
    ];
    if (binding.structFields?.length) {
        lines.push(`        structFields: ${sharedConstants.bindingStructFields(binding.tsType, binding.structFields)},`);
    }
    lines.push('      },');
    return lines.join('\n');
}
function emitStructFieldBinding(binding) {
    return [
        '{',
        `  thriftName: '${binding.thriftName}',`,
        `  fieldName: '${binding.fieldName}',`,
        `  wireName: '${binding.wireName}',`,
        `  jsonName: '${binding.jsonName}',`,
        `  requiredness: '${binding.requiredness}',`,
        `  tsType: '${binding.tsType}',`,
        `  valueKind: '${binding.valueKind}',`,
        '},',
    ];
}
function emitStructSchemaProperty(propertyName, schema, spaces, sharedConstants) {
    return `${' '.repeat(spaces)}${propertyName}: ${sharedConstants.structSchema(schema)},`;
}
function emitStructFieldSchema(field, sharedConstants) {
    const lines = [
        '{',
        `  thriftName: '${field.thriftName}',`,
        `  fieldName: '${field.fieldName}',`,
        `  wireName: '${field.wireName}',`,
        `  jsonName: '${field.jsonName}',`,
        `  requiredness: '${field.requiredness}',`,
    ];
    lines.push(...emitObjectProperty('value', emitStructValueSchema(field.value, sharedConstants), 2));
    lines.push('},');
    return lines;
}
function emitStructValueSchema(value, sharedConstants) {
    switch (value.kind) {
        case 'scalar':
            return ["{ kind: 'scalar' }"];
        case 'struct':
            return [`{ kind: 'struct', schema: ${sharedConstants.structSchema(value.schema)} }`];
        case 'list':
        case 'set':
            return [
                '{',
                `  kind: '${value.kind}',`,
                ...emitObjectProperty('item', emitStructValueSchema(value.item, sharedConstants), 2),
                '}',
            ];
        case 'map':
            return [
                '{',
                "  kind: 'map',",
                ...emitObjectProperty('value', emitStructValueSchema(value.value, sharedConstants), 2),
                '}',
            ];
    }
}
function emitObjectProperty(propertyName, valueLines, spaces) {
    const [firstLine, ...restLines] = valueLines;
    if (firstLine === undefined) {
        throw new Error(`Cannot emit empty object property ${propertyName}`);
    }
    const prefix = ' '.repeat(spaces);
    const lines = [`${prefix}${propertyName}: ${firstLine}`, ...indentLines(restLines, spaces)];
    lines[lines.length - 1] += ',';
    return lines;
}
function indentLines(lines, spaces) {
    const prefix = ' '.repeat(spaces);
    return lines.map((line) => `${prefix}${line}`);
}
function routeConstant(serviceName) {
    return `${toScreamingSnake(serviceName)}_ROUTES`;
}
function sseContractConstant(serviceName) {
    return `${toScreamingSnake(serviceName)}_SSE_CONTRACTS`;
}
function serviceSseContractTypesName(serviceName) {
    return `${serviceName}SseContractTypes`;
}
function honoMethod(method) {
    if (method === 'ANY')
        return 'all';
    return method.toLowerCase();
}
function validateRuntimeBindings(definition, routeMetadataStyle) {
    for (const service of definition.services) {
        for (const method of service.methods) {
            validateRuntimeRouteBindings(definition.sourcePath, 'route', method);
            if (routeMetadataStyle === 'minimal' && method.transport !== 'jsonBody') {
                throw new Error(`${definition.sourcePath}: cannot emit minimal runtime route metadata for binding-aware method ${method.methodName}`);
            }
        }
        for (const contract of service.sseContracts) {
            validateRuntimeRouteBindings(definition.sourcePath, 'SSE route', contract);
        }
    }
}
function validateRuntimeRouteBindings(sourcePath, routeKind, route) {
    if (route.method === 'HEAD') {
        throw new Error(`${sourcePath}: cannot emit runtime for HEAD ${routeKind} ${route.methodName}; HEAD responses have no body`);
    }
    for (const binding of route.bindings) {
        if (binding.kind !== 'query')
            continue;
        if (binding.valueKind === 'unsupported') {
            throw new Error(`${sourcePath}: cannot emit runtime for unsupported query binding ${route.methodName}.${binding.fieldName}`);
        }
    }
}
function header(sourcePath) {
    return `// Generated by @mavis/thrift-gen from ${sourcePath}.\n// Do not edit by hand.`;
}
//# sourceMappingURL=emit-http-service.js.map