// ../model-access-sdk/dist/manifest.js
var ModelAccessContractError = class extends Error {
  code;
  constructor(code) {
    super(code);
    this.code = code;
    this.name = "ModelAccessContractError";
  }
};

// src/service/model-access-extension/core/extension-validation.ts
function invalid() {
  throw new ModelAccessContractError("invalid_handlers");
}
function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !descriptors[key]?.enumerable || !("value" in descriptors[key]))
      invalid();
  }
  return value;
}
function exact(value, expected) {
  const result = object(value);
  const actual = Object.keys(result);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) invalid();
  return result;
}
function methods(value, required, optional = []) {
  const result = object(value);
  const keys = Object.keys(result);
  if (required.some((key) => !Object.hasOwn(result, key))) invalid();
  if (keys.some(
    (key) => !required.includes(key) && !optional.includes(key) || typeof result[key] !== "function"
  ))
    invalid();
  return Object.freeze({ ...result });
}
function providerHandlers(manifest, providers) {
  const result = /* @__PURE__ */ Object.create(null);
  for (const provider2 of manifest.providers) {
    const owned = provider2.credentialKinds.includes("direct-owned");
    result[provider2.id] = methods(
      providers[provider2.id],
      ["models", "bindTransport", "classifyError", ...owned ? ["resolveOwned"] : []],
      ["usage", ...owned ? ["renewOwned", "forceRenewOwned", "forget"] : []]
    );
  }
  return result;
}
function sourceHandlers(source, value) {
  const handlers = exact(value, Object.keys(source.capabilities));
  const parsed = /* @__PURE__ */ Object.create(null);
  const groups = [
    {
      capability: "login",
      entries: source.capabilities.login?.methods,
      required: ["begin"],
      optional: []
    },
    {
      capability: "subscriptionBorrow",
      entries: source.capabilities.subscriptionBorrow?.variants,
      required: ["discover", "resolve"],
      optional: ["renew", "forceRenew"]
    },
    {
      capability: "apiKeyScan",
      entries: source.capabilities.apiKeyScan?.readers,
      required: ["scan"],
      optional: []
    }
  ];
  for (const group of groups) {
    if (!group.entries) continue;
    const table = exact(
      handlers[group.capability],
      group.entries.map((entry) => entry.id)
    );
    const saved = /* @__PURE__ */ Object.create(null);
    for (const entry of group.entries)
      saved[entry.id] = methods(table[entry.id], group.required, group.optional);
    parsed[group.capability] = Object.freeze(saved);
  }
  return Object.freeze(parsed);
}
function validateModelAccessExtension(manifest, value) {
  return captureExtension(manifest, value);
}
function captureExtension(manifest, value) {
  const root = object(value);
  if (Object.keys(root).some((key) => !["providers", "sources", "dispose"].includes(key)))
    invalid();
  if (Object.hasOwn(root, "dispose") && typeof root.dispose !== "function") invalid();
  const providers = exact(
    root.providers,
    manifest.providers.map((provider2) => provider2.id)
  );
  const sources = exact(
    root.sources,
    manifest.sources.map((source) => source.id)
  );
  const parsedProviders = providerHandlers(manifest, providers);
  const parsedSources = /* @__PURE__ */ Object.create(null);
  for (const source of manifest.sources)
    parsedSources[source.id] = sourceHandlers(source, sources[source.id]);
  return Object.freeze({
    providers: Object.freeze(parsedProviders),
    sources: Object.freeze(parsedSources),
    ...root.dispose ? { dispose: root.dispose } : {}
  });
}

// src/service/model-access-extension/core/settlement.ts
var observations = /* @__PURE__ */ new Set();
function observeModelAccessWork(work) {
  const observation = { settled: Promise.resolve() };
  observation.settled = (async () => {
    try {
      await work;
    } catch {
    } finally {
      observations.delete(observation);
    }
  })();
  observations.add(observation);
}

// src/service/model-access-extension/request/validation.ts
var ModelAccessRequestError = class extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.name = "ModelAccessRequestError";
  }
};
function invalid2() {
  throw new ModelAccessRequestError("request_invalid");
}
function requestRecord(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid2();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid2();
  const result = /* @__PURE__ */ Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !keys.includes(key)) invalid2();
    result[key] = dataValue(Object.getOwnPropertyDescriptor(value, key));
  }
  return result;
}
function dataValue(descriptor) {
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid2();
  return descriptor.value;
}
function text(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 4096 || /[\u0000-\u001f]/u.test(value))
    invalid2();
  return value;
}
function captureBoundTransport(value) {
  const item = requestRecord(value, [
    "api",
    "modelId",
    "baseUrl",
    "apiKey",
    "headers",
    "fetch",
    "dispose"
  ]);
  const baseUrl = text(item.baseUrl);
  const url = new URL(baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) invalid2();
  validateOptionalTransport(item);
  const headers2 = item.headers === void 0 ? void 0 : captureHeaders(item.headers);
  return Object.freeze({
    api: text(item.api),
    modelId: text(item.modelId),
    baseUrl,
    ...item.apiKey === void 0 ? {} : { apiKey: item.apiKey },
    ...headers2 ? { headers: headers2 } : {},
    ...item.fetch ? { fetch: item.fetch } : {},
    ...item.dispose ? { dispose: item.dispose } : {}
  });
}
function validateOptionalTransport(item) {
  if (item.apiKey !== void 0 && typeof item.apiKey !== "string") invalid2();
  if (item.fetch !== void 0 && typeof item.fetch !== "function") invalid2();
  if (item.dispose !== void 0 && typeof item.dispose !== "function") invalid2();
}
function captureHeaders(value) {
  if (!value || typeof value !== "object") invalid2();
  const item = requestRecord(value, Object.getOwnPropertyNames(value));
  if (Object.keys(item).length > 128) invalid2();
  const headers2 = /* @__PURE__ */ Object.create(null);
  for (const [key, entry] of Object.entries(item)) {
    if (typeof entry !== "string" || /[\r\n]/u.test(entry) || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/iu.test(key))
      invalid2();
    headers2[key] = entry;
  }
  return Object.freeze(headers2);
}

// src/service/model-access-extension/request/admission.ts
var MODEL_ACCESS_MAX_CONCURRENCY = 1e3;
var MODEL_ACCESS_MAX_RPM = 1e4;
function limit(value, maximum) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= maximum ? value : void 0;
}
function captureProviderLimits(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return void 0;
  const item = value;
  const maxConcurrency = limit(item.maxConcurrency, MODEL_ACCESS_MAX_CONCURRENCY);
  const maxRequestsPerMinute = limit(item.maxRequestsPerMinute, MODEL_ACCESS_MAX_RPM);
  if (maxConcurrency === void 0 && maxRequestsPerMinute === void 0) return void 0;
  return Object.freeze({
    ...maxConcurrency === void 0 ? {} : { maxConcurrency },
    ...maxRequestsPerMinute === void 0 ? {} : { maxRequestsPerMinute }
  });
}
function captureModuleLimits(value, providerIds) {
  const result = /* @__PURE__ */ Object.create(null);
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const id of providerIds) {
    if (!Object.hasOwn(value, id)) continue;
    const captured = captureProviderLimits(value[id]);
    if (captured) result[id] = captured;
  }
  return result;
}

// src/service/model-access-extension/host-process/shim/host-entry.ts
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID as randomUUID3 } from "node:crypto";

// src/service/model-access-extension/host-process/contracts.ts
var MODEL_ACCESS_HOST_PROTOCOL = 1;

// src/service/model-access-extension/host-process/protocol.ts
import { StringDecoder } from "node:string_decoder";
var MODEL_ACCESS_HOST_MAX_LINE_BYTES = 32 * 1024 * 1024;
var ModelAccessHostProtocolError = class extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.name = "ModelAccessHostProtocolError";
  }
};
function encodeHostMessage(message, maxLineBytes = MODEL_ACCESS_HOST_MAX_LINE_BYTES) {
  const encoded = JSON.stringify(message);
  if (typeof encoded !== "string") throw new ModelAccessHostProtocolError("protocol_encode");
  const bytes = Buffer.byteLength(encoded, "utf8");
  if (bytes > maxLineBytes) throw new ModelAccessHostProtocolError("protocol_line_too_large");
  return `${encoded}
`;
}
function decodeHostMessage(line, maxLineBytes = MODEL_ACCESS_HOST_MAX_LINE_BYTES) {
  if (!line || Buffer.byteLength(line, "utf8") > maxLineBytes)
    throw new ModelAccessHostProtocolError("protocol_line_too_large");
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    throw new ModelAccessHostProtocolError("protocol_json");
  }
  validateMessage(value);
  return value;
}
function validateEnvelope(value) {
  if (!isRecord(value) || value.version !== MODEL_ACCESS_HOST_PROTOCOL)
    throw new ModelAccessHostProtocolError("protocol_version");
  if (typeof value.type !== "string" || typeof value.epoch !== "string")
    throw new ModelAccessHostProtocolError("protocol_envelope");
}
function validateMessage(value) {
  validateEnvelope(value);
  switch (value.type) {
    case "request":
      return validateRequest(value);
    case "cancel":
      return validateCancel(value);
    case "response":
      return validateResponse(value);
    case "event":
      return validateEvent(value);
    case "stream":
      return validateStream(value);
    case "credit":
      return validateCredit(value);
    case "flow":
      return validateFlow(value);
    default:
      throw new ModelAccessHostProtocolError("protocol_type");
  }
}
function validateRequest(value) {
  if (typeof value.id !== "string" || !value.id || typeof value.method !== "string" || !isHostMethod(value.method) || !Object.hasOwn(value, "params") || value.slot !== void 0 && !validSlot(value.slot))
    throw new ModelAccessHostProtocolError("protocol_request");
}
function validateCancel(value) {
  if (typeof value.id !== "string" || !value.id)
    throw new ModelAccessHostProtocolError("protocol_cancel");
}
function validateResponse(value) {
  if (typeof value.id !== "string" || !value.id || !validResponseShape(value))
    throw new ModelAccessHostProtocolError("protocol_response");
}
function validateEvent(value) {
  if (!["hello", "ready", "fatal"].includes(String(value.event)))
    throw new ModelAccessHostProtocolError("protocol_event");
  if (value.error !== void 0 && !validError(value.error))
    throw new ModelAccessHostProtocolError("protocol_error");
  if (value.slot !== void 0 && (value.event !== "fatal" || !validSlot(value.slot)))
    throw new ModelAccessHostProtocolError("protocol_event");
}
function validateStream(value) {
  if (typeof value.id !== "string" || !value.id || !["head", "chunk", "end", "error"].includes(String(value.event)))
    throw new ModelAccessHostProtocolError("protocol_stream");
  validateStreamPayload(value);
}
function validateStreamPayload(value) {
  if (value.event === "chunk" && typeof value.data !== "string")
    throw new ModelAccessHostProtocolError("protocol_stream_chunk");
  if (value.event === "head" && (typeof value.status !== "number" || !isHeaderMap(value.headers)))
    throw new ModelAccessHostProtocolError("protocol_stream_head");
  if (value.event === "error" && !validError(value.error))
    throw new ModelAccessHostProtocolError("protocol_stream_error");
}
function validateCredit(value) {
  if (typeof value.id !== "string" || !value.id || typeof value.n !== "number" || !Number.isSafeInteger(value.n) || value.n <= 0)
    throw new ModelAccessHostProtocolError("protocol_credit");
}
function validateFlow(value) {
  if (typeof value.flowRef !== "string" || value.flowRef.length < 1 || value.flowRef.length > 256 || !Number.isSafeInteger(value.seq) || Number(value.seq) < 1 || !["view", "result"].includes(String(value.event)))
    throw new ModelAccessHostProtocolError("protocol_flow");
  validateFlowPayload(value);
}
function validateFlowPayload(value) {
  if (value.event === "view" && !isRecord(value.view))
    throw new ModelAccessHostProtocolError("protocol_flow_view");
  if (value.event === "result" && value.view !== void 0)
    throw new ModelAccessHostProtocolError("protocol_flow_result");
  if (Object.keys(value).some(
    (key) => !["type", "version", "epoch", "flowRef", "seq", "event", "view"].includes(key)
  ))
    throw new ModelAccessHostProtocolError("protocol_flow");
}
var HostLineDecoder = class {
  constructor(maxLineBytes = MODEL_ACCESS_HOST_MAX_LINE_BYTES) {
    this.maxLineBytes = maxLineBytes;
  }
  buffer = Buffer.alloc(0);
  utf8 = new StringDecoder("utf8");
  get limit() {
    return this.maxLineBytes;
  }
  push(chunk) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    this.buffer = Buffer.concat([this.buffer, bytes]);
    if (this.buffer.length > this.maxLineBytes && !this.buffer.includes(10))
      throw new ModelAccessHostProtocolError("protocol_line_too_large");
    const messages = [];
    let newline;
    while ((newline = this.buffer.indexOf(10)) >= 0) {
      let lineBytes = this.buffer.subarray(0, newline);
      if (lineBytes.at(-1) === 13) lineBytes = lineBytes.subarray(0, lineBytes.length - 1);
      const line = this.utf8.write(lineBytes);
      this.buffer = this.buffer.subarray(newline + 1);
      messages.push(decodeHostMessage(line, this.maxLineBytes));
    }
    if (this.buffer.length > this.maxLineBytes)
      throw new ModelAccessHostProtocolError("protocol_line_too_large");
    return messages;
  }
  finish() {
    const tail = `${this.utf8.end()}${this.buffer.toString("utf8")}`;
    this.buffer = Buffer.alloc(0);
    if (tail.trim()) throw new ModelAccessHostProtocolError("protocol_truncated");
  }
};
function hostError(code, ref) {
  const safeCode = /^[a-z][a-z0-9_.-]{0,95}$/u.test(code) ? code : "host_failed";
  return ref && /^[a-f0-9-]{16,128}$/u.test(ref) ? { code: safeCode, ref } : { code: safeCode };
}
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function isHostMethod(value) {
  return [
    "init",
    "describe",
    "models",
    "usage",
    "borrow.discover",
    "apiKeyScan.scan",
    "resolveOwned",
    "renewOwned",
    "forceRenewOwned",
    "forget",
    "borrow.resolve",
    "borrow.renew",
    "borrow.forceRenew",
    "bindTransport",
    "fetch",
    "body.begin",
    "body.chunk",
    "body.end",
    "body.discard",
    "disposeTransport",
    "classifyError",
    "login.begin",
    "login.submit",
    "login.result",
    "login.cancel",
    "drain",
    "shutdown",
    "unload"
  ].includes(value);
}
function validSlot(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}
function validError(value) {
  return isRecord(value) && typeof value.code === "string" && /^[a-z][a-z0-9_.-]{0,95}$/u.test(value.code) && (value.ref === void 0 || typeof value.ref === "string" && /^[a-f0-9-]{16,128}$/u.test(value.ref));
}
function validResponseShape(value) {
  const hasResult = Object.hasOwn(value, "result");
  const hasError = Object.hasOwn(value, "error");
  return hasResult !== hasError && (!hasError || validError(value.error));
}
function isHeaderMap(value) {
  if (!isRecord(value) || Object.keys(value).length > 256) return false;
  return Object.entries(value).every(
    ([key, entry]) => key.length <= 1024 && typeof entry === "string" && entry.length <= 16 * 1024
  );
}

// src/service/model-access-extension/host-process/shim/login-flows.ts
import { randomUUID } from "node:crypto";

// src/service/model-access-extension/host-process/shim/context.ts
function captureHostContext(value, code = "host_context_invalid") {
  const invalid9 = () => {
    throw Object.assign(new Error(code), { code });
  };
  if (!value || typeof value !== "object") invalid9();
  const input = value;
  const text8 = (item, maximum = 256) => {
    if (typeof item !== "string" || !item || item.length > maximum) invalid9();
    return item;
  };
  const integer = (item, minimum) => {
    if (typeof item !== "number" || !Number.isSafeInteger(item) || item < minimum) invalid9();
    return item;
  };
  const targets = input.enabledTargets;
  if (!Array.isArray(targets) || targets.length > 128) return invalid9();
  return {
    profileId: text8(input.profileId),
    installationId: text8(input.installationId),
    operationId: text8(input.operationId),
    dataDir: text8(input.dataDir, 8192),
    hostDataDir: text8(input.hostDataDir, 8192),
    generation: integer(input.generation, 1),
    policyRevision: integer(input.policyRevision, 0),
    enabledTargets: targets.map((target) => text8(target)),
    ...input.sessionKey === void 0 ? {} : {
      sessionKey: typeof input.sessionKey === "string" && /^[0-9a-f]{16,64}$/u.test(input.sessionKey) ? input.sessionKey : invalid9()
    }
  };
}

// src/service/model-access-extension/credentials/credential-state.ts
var ModelAccessCredentialError = class extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.name = "ModelAccessCredentialError";
  }
};
var MAX_SECRET_BYTES = 128 * 1024;
function invalid3() {
  throw new ModelAccessCredentialError("credential_state_invalid");
}
function plainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid3();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) invalid3();
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) invalid3();
  const captured = /* @__PURE__ */ Object.create(null);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor) || !descriptor.enumerable) invalid3();
    captured[key] = descriptor.value;
  }
  return captured;
}
function record(value, keys) {
  const item = plainRecord(value);
  if (Object.keys(item).some((key) => !keys.includes(key))) invalid3();
  return item;
}
function text2(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\u0000-\u001f]/u.test(value))
    invalid3();
  return value;
}
function namespaceText(value) {
  if (typeof value !== "string" || value.length > 256 || /[\u0000-\u001f]/u.test(value)) invalid3();
  return value;
}
function captureSourceRef(value) {
  const item = record(value, ["installationId", "sourceId", "variant", "target", "selector"]);
  if (item.selector !== "current") invalid3();
  return Object.freeze({
    installationId: text2(item.installationId),
    sourceId: text2(item.sourceId),
    variant: text2(item.variant),
    target: text2(item.target),
    selector: "current"
  });
}
function captureIdentity(value, providerId) {
  const item = record(value, ["providerId", "region", "tenant", "subject", "accountMasked"]);
  const identity = {
    providerId: text2(item.providerId),
    region: namespaceText(item.region),
    tenant: namespaceText(item.tenant),
    subject: text2(item.subject)
  };
  if (identity.providerId !== providerId) invalid3();
  if (item.accountMasked !== void 0) text2(item.accountMasked);
  return Object.freeze(identity);
}

// src/service/model-access-extension/login/validation.ts
var ModelAccessLoginError = class extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.name = "ModelAccessLoginError";
  }
};
function invalid4() {
  throw new ModelAccessLoginError("login_invalid");
}
function record2(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid4();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid4();
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor) || !descriptor.enumerable) invalid4();
  }
  if (Object.getOwnPropertySymbols(value).length) invalid4();
  return value;
}
function text3(value, maximum = 256) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f]/u.test(value))
    invalid4();
  return value;
}
function namespaceText2(value) {
  if (typeof value !== "string" || value.length > 256 || /[\u0000-\u001f]/u.test(value)) invalid4();
  return value;
}
function captureResultIdentity(value, providerId) {
  const identity = record2(value);
  if (Object.keys(identity).some(
    (key) => !["providerId", "region", "tenant", "subject", "accountMasked"].includes(key)
  ))
    invalid4();
  if (identity.providerId !== providerId) invalid4();
  if (identity.accountMasked !== void 0) text3(identity.accountMasked);
  return Object.freeze({
    region: namespaceText2(identity.region),
    tenant: namespaceText2(identity.tenant),
    subject: text3(identity.subject)
  });
}
function https(value) {
  const url = text3(value, 8192);
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) invalid4();
  } catch {
    invalid4();
  }
  return url;
}
function captureLoginView(value, kind) {
  const view = record2(value);
  if (kind === "browser-pkce" && view.kind === "browser")
    return Object.freeze({ kind: "browser", url: https(view.url) });
  if (kind === "cli") return captureCliView(view);
  if (kind === "device-code" && view.kind === "device") {
    if (!Number.isSafeInteger(view.expiresAt) || Number(view.expiresAt) <= Date.now()) invalid4();
    return Object.freeze({
      kind: "device",
      verificationUrl: https(view.verificationUrl),
      userCode: text3(view.userCode),
      expiresAt: view.expiresAt
    });
  }
  if (kind !== "secret-form" || view.kind !== "secret-form") invalid4();
  return captureSecretForm(view);
}
function captureCliView(view) {
  if (view.kind !== "cli") invalid4();
  return Object.freeze({ kind: "cli", message: text3(view.message, 8192) });
}
function captureSecretForm(view) {
  if (!Array.isArray(view.fields) || view.fields.length < 1 || view.fields.length > 16) invalid4();
  const fields = Array.from(view.fields, (item) => {
    const field = record2(item);
    const id = text3(field.id, 64);
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/u.test(id)) invalid4();
    return Object.freeze({ id, label: text3(field.label) });
  });
  if (new Set(fields.map((field) => field.id)).size !== fields.length) invalid4();
  return Object.freeze({ kind: "secret-form", fields: Object.freeze(fields) });
}
async function observeLoginResult(value) {
  try {
    if (!value || typeof value !== "object") return;
    const descriptor = Object.getOwnPropertyDescriptor(value, "result");
    if (!descriptor || !("value" in descriptor) || !(descriptor.value instanceof Promise)) return;
    await descriptor.value;
  } catch {
  }
}
function captureLoginFlow(value) {
  const flow = record2(value);
  if (!(flow.result instanceof Promise) || typeof flow.cancel !== "function" || flow.submit !== void 0 && typeof flow.submit !== "function")
    invalid4();
  return Object.freeze({
    view: flow.view,
    result: flow.result,
    cancel: flow.cancel.bind(value),
    ...flow.submit ? { submit: flow.submit.bind(value) } : {}
  });
}
function captureLoginValues(view, value) {
  if (view?.kind !== "secret-form") invalid4();
  const values = record2(value);
  const fields = view.fields.map((field) => field.id);
  if (Object.keys(values).length !== fields.length || Object.keys(values).some((key) => !fields.includes(key)))
    invalid4();
  for (const field of fields) {
    if (typeof values[field] !== "string" || !values[field] || Buffer.byteLength(values[field]) > 16 * 1024)
      invalid4();
  }
  if (Buffer.byteLength(JSON.stringify(values)) > 64 * 1024) invalid4();
  return Object.freeze({ ...values });
}
function jsonChildren(item) {
  if (!Array.isArray(item)) {
    const object2 = record2(item);
    if (Object.keys(object2).some((key) => Buffer.byteLength(key) > 4096)) invalid4();
    return Object.values(object2);
  }
  if (Object.getPrototypeOf(item) !== Array.prototype || Object.getOwnPropertyNames(item).length !== item.length + 1)
    invalid4();
  if (item.length > 8192 || Object.keys(item).length !== item.length || Object.getOwnPropertySymbols(item).length)
    invalid4();
  return Array.from({ length: item.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
    if (!descriptor || !("value" in descriptor)) invalid4();
    return descriptor.value;
  });
}
function jsonPrimitive(value) {
  return value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value);
}
function payloadJson(value) {
  let nodes = 0;
  let bytes = 0;
  const visit = (item, depth) => {
    if (++nodes > 8192 || depth > 32) invalid4();
    if (typeof item === "string") {
      bytes += Buffer.byteLength(item);
      if (bytes > MAX_SECRET_BYTES) invalid4();
      return;
    }
    if (jsonPrimitive(item)) return;
    if (!item || typeof item !== "object") invalid4();
    for (const child of jsonChildren(item)) visit(child, depth + 1);
  };
  visit(value, 0);
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > MAX_SECRET_BYTES - 2048) invalid4();
  return serialized;
}
function captureOwnedLoginResult(value, providerId, credentialSchema) {
  const result = record2(value);
  if (result.kind !== "direct-owned" || result.providerId !== providerId || result.credentialSchema !== credentialSchema)
    invalid4();
  const identity = captureResultIdentity(result.identity, providerId);
  return {
    identity: Object.freeze({
      providerId,
      region: identity.region,
      tenant: identity.tenant,
      subject: text3(identity.subject)
    }),
    payload: payloadJson(result.payload)
  };
}
function captureNextLoginView(value) {
  const view = record2(value);
  if (view.kind === "browser") return captureLoginView(view, "browser-pkce");
  if (view.kind === "device") return captureLoginView(view, "device-code");
  if (view.kind === "secret-form") return captureLoginView(view, "secret-form");
  invalid4();
}

// src/service/model-access-extension/host-process/shim/login-flows.ts
var MAX_FLOWS = 128;
var MAX_VIEWS = 128;
var FLOW_TIMEOUT_MS = 10 * 6e4;
var ChildLoginFlows = class {
  constructor(epoch2, send2) {
    this.epoch = epoch2;
    this.send = send2;
  }
  flows = /* @__PURE__ */ new Map();
  observed = /* @__PURE__ */ new Map();
  closed = false;
  async begin(value, signal, extension, manifest) {
    const params = captureBegin(value);
    if (this.closed || this.flows.size >= MAX_FLOWS) throw error("login_busy");
    const { method, provider: provider2, handler, providerHandler } = loginHandlers(
      params,
      extension,
      manifest
    );
    signal.throwIfAborted();
    const controller = new AbortController();
    let settle;
    const settled = new Promise((resolve) => {
      settle = resolve;
    });
    const abort = () => {
      this.observe(this.cancelState(state));
    };
    const state = {
      ref: `${this.epoch}:${randomUUID()}`,
      params,
      schema: provider2.credentialSchema,
      provider: providerHandler,
      controller,
      settled,
      settle,
      context: Object.freeze({
        ...params.context,
        enabledTargets: params.context.enabledTargets ?? [],
        policyRevision: params.context.policyRevision ?? 0,
        signal: controller.signal,
        updateLoginView: (view) => this.update(state, view)
      }),
      views: [],
      seq: 0,
      subscribed: false,
      submitting: false,
      beginDone: false,
      resultDone: false,
      cleanupDone: false,
      forgetDone: false,
      delivered: false,
      cancelled: false,
      removeBeginAbort: () => signal.removeEventListener("abort", abort)
    };
    this.flows.set(state.ref, state);
    signal.addEventListener("abort", abort, { once: true });
    state.timer = setTimeout(abort, FLOW_TIMEOUT_MS);
    state.timer.unref();
    try {
      const returned = await handler.begin(
        state.context,
        Object.freeze({ ...params.input })
      );
      this.observe(observeLoginResult(returned));
      state.flow = captureLoginFlow(returned);
      state.result = this.observeResult(state, state.flow.result);
      const view = captureLoginView(state.flow.view, method.kind);
      validateSubmit(state, view);
      state.currentView ??= view;
      if (signal.aborted || state.cancelled) throw error("login_cancelled");
      return { flowRef: state.ref, seq: 0, view, hasSubmit: Boolean(state.flow.submit) };
    } catch (cause) {
      if (!state.result) state.resultDone = true;
      this.observe(this.cancelState(state));
      throw cause;
    } finally {
      state.beginDone = true;
      this.prune(state);
    }
  }
  async submit(value, signal) {
    const state = this.require(value);
    if (!isRecord2(value)) throw error("login_invalid");
    this.assertWaiting(state);
    if (!state.flow?.submit || state.submitting) throw error("login_not_waiting");
    const values = captureLoginValues(state.currentView, value.values);
    signal.throwIfAborted();
    state.submitting = true;
    const abort = () => {
      this.observe(this.cancelState(state));
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      await state.flow.submit(values);
      if (state.cancelled || signal.aborted) throw error("login_cancelled");
      return null;
    } finally {
      signal.removeEventListener("abort", abort);
      state.submitting = false;
      this.prune(state);
    }
  }
  async result(value, signal) {
    const state = this.require(value);
    if (state.cancelled || state.subscribed || !state.result) throw error("login_not_waiting");
    state.subscribed = true;
    for (const item of state.views) this.sendView(state, item);
    state.views.length = 0;
    try {
      const outcome = await untilAborted(
        state.result,
        AbortSignal.any([signal, state.controller.signal])
      );
      if (state.cancelled || signal.aborted) throw error("login_cancelled");
      if (!outcome.ok) throw outcome.error;
      captureOwnedLoginResult(outcome.value, state.params.providerId, state.schema);
      const seq = ++state.seq;
      this.send({ type: "flow", flowRef: state.ref, seq, event: "result" });
      return { seq, result: outcome.value };
    } catch (cause) {
      this.observe(this.cancelState(state));
      throw cause;
    }
  }
  async cancel(value) {
    if (!isRecord2(value) || !validRef(value.flowRef, this.epoch) || !["delivered", "discarded"].includes(String(value.disposition)))
      throw error("login_invalid");
    const state = this.flows.get(value.flowRef);
    if (!state) return null;
    if (value.disposition === "delivered") state.delivered = true;
    await this.cancelState(state);
    return null;
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.flows.values()].map((state) => this.cancelState(state)));
  }
  async settled() {
    await Promise.all([...this.flows.values()].map((state) => state.settled));
  }
  update(state, value) {
    this.assertWaiting(state);
    const view = captureNextLoginView(value);
    if (view.kind === "secret-form" && state.flow && !state.flow.submit)
      throw error("login_invalid");
    if (state.seq >= MAX_VIEWS) throw error("login_invalid");
    const item = { seq: ++state.seq, view };
    state.currentView = view;
    if (state.subscribed) this.sendView(state, item);
    else state.views.push(item);
  }
  sendView(state, item) {
    this.send({ type: "flow", flowRef: state.ref, event: "view", ...item });
  }
  resultArrived(state, outcome) {
    state.outcome = outcome;
    state.resultDone = true;
    if (state.cancelled) this.observe(this.forgetDiscarded(state));
    this.prune(state);
    return outcome;
  }
  async observeResult(state, work) {
    try {
      return this.resultArrived(state, { ok: true, value: await work });
    } catch (cause) {
      return this.resultArrived(state, { ok: false, error: cause });
    }
  }
  cancelState(state) {
    state.cancelled = true;
    state.controller.abort();
    state.removeBeginAbort();
    if (state.timer) clearTimeout(state.timer);
    state.views.length = 0;
    const flow = state.flow;
    if (!flow) return Promise.resolve();
    state.cancellation ??= (async () => {
      await Promise.resolve();
      try {
        await flow.cancel();
      } finally {
        state.cleanupDone = true;
        await this.forgetDiscarded(state);
        this.prune(state);
      }
    })();
    return state.cancellation;
  }
  async forgetDiscarded(state) {
    const forget = state.provider.forget;
    if (state.delivered || !state.outcome?.ok || !forget) return;
    const value = state.outcome.value;
    if (!isRecord2(value) || !Object.hasOwn(value, "payload")) return;
    state.forgetting ??= (async () => {
      await Promise.resolve();
      try {
        await forget.call(
          state.provider,
          Object.freeze({
            ...state.context,
            signal: AbortSignal.timeout(5e3),
            updateLoginView: void 0
          }),
          {
            kind: "direct-owned",
            providerKey: state.params.input.providerKey,
            providerId: state.params.providerId,
            installationId: state.params.context.installationId
          },
          value.payload
        );
      } finally {
        state.forgetDone = true;
        this.prune(state);
      }
    })();
    await state.forgetting;
  }
  prune(state) {
    if (state.cancelled && state.beginDone && state.resultDone && !state.submitting && (!state.forgetting || state.forgetDone) && (state.cleanupDone || !state.flow)) {
      this.flows.delete(state.ref);
      state.settle();
    }
  }
  assertWaiting(state) {
    if (state.cancelled || state.resultDone) throw error("login_not_waiting");
  }
  require(value) {
    if (!isRecord2(value) || !validRef(value.flowRef, this.epoch)) throw error("login_invalid");
    const state = this.flows.get(value.flowRef);
    if (!state) throw error("login_missing");
    return state;
  }
  observe(work) {
    this.observed.set(work, this.observeSettlement(work));
  }
  async observeSettlement(work) {
    try {
      await work;
    } catch {
    } finally {
      this.observed.delete(work);
    }
  }
};
function captureBegin(value) {
  if (!isRecord2(value) || !isRecord2(value.context) || !isRecord2(value.input))
    throw error("login_invalid");
  const kind = value.kind;
  if (kind !== "browser-pkce" && kind !== "device-code" && kind !== "secret-form" && kind !== "cli")
    throw error("login_invalid");
  return {
    kind,
    providerId: text4(value.providerId),
    sourceId: text4(value.sourceId),
    methodId: text4(value.methodId),
    input: { providerKey: text4(value.input.providerKey), target: text4(value.input.target) },
    context: captureHostContext(value.context, "login_invalid")
  };
}
function text4(value, maximum = 256) {
  if (typeof value !== "string" || !value || value.length > maximum) throw error("login_invalid");
  return value;
}
function loginHandlers(params, extension, manifest) {
  const source = manifest.sources.find((item) => item.id === params.sourceId);
  const method = source?.capabilities.login?.methods.find((item) => item.id === params.methodId);
  const provider2 = manifest.providers.find((item) => item.id === params.providerId);
  const handler = extension.sources[params.sourceId]?.login?.[params.methodId];
  const providerHandler = extension.providers[params.providerId];
  if (!method || !provider2 || !handler || !providerHandler) throw error("login_invalid");
  validateMethod(params, method, provider2);
  return { method, provider: provider2, handler, providerHandler };
}
function validateMethod(params, method, provider2) {
  if (method.kind !== params.kind || !method.targets.includes(params.input.target) || !provider2.credentialKinds.includes("direct-owned") || !params.context.enabledTargets?.includes(params.input.target))
    throw error("login_invalid");
}
function validateSubmit(state, view) {
  if ((view.kind === "secret-form" || state.views.some((item) => item.view.kind === "secret-form")) && !state.flow?.submit)
    throw error("login_invalid");
}
function validRef(value, epoch2) {
  return typeof value === "string" && value.startsWith(`${epoch2}:`) && value.length <= 256;
}
function error(code) {
  return new ModelAccessLoginError(code);
}
function isRecord2(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
async function untilAborted(work, signal) {
  let abort;
  const cancelled = new Promise((_resolve, reject) => {
    abort = () => reject(error("login_cancelled"));
  });
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    return await Promise.race([work, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

// src/service/model-access-extension/host-process/rpc/request-body.ts
var REQUEST_BODY_MAX_BYTES = 64 * 1024 * 1024;
var REQUEST_BODY_GLOBAL_BYTES = 128 * 1024 * 1024;
var REQUEST_BODY_CHUNK_BYTES = 1024 * 1024;
var REQUEST_BODY_TIMEOUT_MS = 3e4;
function requestBodyError(code) {
  const error2 = Object.assign(new Error(code), { code });
  Object.defineProperty(error2, "hostFailure", { value: true, enumerable: false });
  return error2;
}

// src/service/model-access-extension/host-process/shim/request-bodies.ts
var HostRequestBodies = class {
  constructor(hasTransport, limits = {
    maxBytes: REQUEST_BODY_MAX_BYTES,
    globalBytes: REQUEST_BODY_GLOBAL_BYTES,
    timeoutMs: REQUEST_BODY_TIMEOUT_MS
  }) {
    this.hasTransport = hasTransport;
    this.limits = limits;
  }
  bodies = /* @__PURE__ */ new Map();
  reserved = 0;
  dispatch(method, value) {
    const { input, ref, transportRef } = bodyInput(value);
    if (method === "body.discard") {
      if (this.bodies.get(ref)?.transportRef === transportRef) this.release(ref);
      return null;
    }
    if (!this.hasTransport(transportRef)) throw requestBodyError("host_transport_missing");
    if (method === "body.begin") {
      this.begin(ref, transportRef, input.maxBytes);
      return null;
    }
    const body = this.bodies.get(ref);
    if (!body || body.transportRef !== transportRef || body.ended)
      throw requestBodyError("request_body_invalid");
    try {
      this.append(method, input, body);
      return null;
    } catch (error2) {
      this.release(ref);
      throw error2;
    }
  }
  begin(ref, transportRef, capacity) {
    if (!Number.isSafeInteger(capacity) || typeof capacity !== "number" || capacity < 1 || capacity > this.limits.maxBytes)
      throw requestBodyError("request_body_too_large");
    if (this.bodies.has(ref)) throw requestBodyError("request_body_invalid");
    if (this.reserved + capacity > this.limits.globalBytes)
      throw requestBodyError("request_body_busy");
    const buffer = Buffer.alloc(capacity);
    const timer = setTimeout(() => this.release(ref), this.limits.timeoutMs);
    timer.unref?.();
    this.bodies.set(ref, {
      transportRef,
      buffer,
      bytes: 0,
      sequence: 0,
      ended: false,
      taken: false,
      timer
    });
    this.reserved += capacity;
  }
  append(method, input, body) {
    if (input.sequence !== body.sequence) throw requestBodyError("request_body_sequence");
    if (method === "body.chunk") {
      const chunk = decodeChunk(input.data);
      if (chunk.length > REQUEST_BODY_CHUNK_BYTES || body.bytes + chunk.length > body.buffer.length)
        throw requestBodyError("request_body_too_large");
      chunk.copy(body.buffer, body.bytes);
      body.bytes += chunk.length;
      body.sequence++;
    } else if (method === "body.end") {
      if (input.bytes !== body.bytes) throw requestBodyError("request_body_invalid");
      body.ended = true;
    } else throw requestBodyError("request_body_invalid");
  }
  take(ref, transportRef) {
    const body = this.bodies.get(ref);
    if (!body || body.transportRef !== transportRef || !body.ended || body.taken)
      throw requestBodyError("request_body_invalid");
    body.taken = true;
    clearTimeout(body.timer);
    return body.buffer.subarray(0, body.bytes);
  }
  release(ref, transportRef) {
    const body = this.bodies.get(ref);
    if (!body || body.taken || transportRef !== void 0 && body.transportRef !== transportRef)
      return;
    clearTimeout(body.timer);
    this.reserved -= body.buffer.length;
    this.bodies.delete(ref);
  }
  complete(ref, transportRef) {
    const body = this.bodies.get(ref);
    if (!body || body.transportRef !== transportRef) return;
    body.taken = false;
    this.release(ref, transportRef);
  }
  disposeTransport(transportRef) {
    for (const [ref, body] of this.bodies)
      if (body.transportRef === transportRef) this.release(ref);
  }
  clear() {
    for (const ref of this.bodies.keys()) this.release(ref);
  }
};
function bodyInput(value) {
  if (!value || typeof value !== "object") throw requestBodyError("request_body_invalid");
  const input = value;
  const { ref, transportRef } = input;
  if (typeof ref !== "string" || !/^[a-f0-9-]{36}$/u.test(ref) || typeof transportRef !== "string")
    throw requestBodyError("request_body_invalid");
  return { input, ref, transportRef };
}
function decodeChunk(data) {
  if (typeof data !== "string" || data.length > Math.ceil(REQUEST_BODY_CHUNK_BYTES / 3) * 4 || data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/u.test(data))
    throw requestBodyError("request_body_invalid");
  const chunk = Buffer.from(data, "base64");
  if (chunk.toString("base64") !== data) throw requestBodyError("request_body_invalid");
  return chunk;
}

// src/service/model-access-extension/core/context.ts
function errorCode(error2) {
  if (!error2 || typeof error2 !== "object") return void 0;
  const code = error2.code;
  return typeof code === "string" ? code : void 0;
}
function errorText(error2) {
  if (!error2 || typeof error2 !== "object") return "";
  const message = error2.message;
  return typeof message === "string" ? message.slice(0, 2048) : "";
}
var REVOKED_WORDS = /invalid_grant|token_revoked|refresh_token_expired|refresh token (has )?expired|revoked|unauthorized_client|invalid_refresh_token/iu;
var REVOKED_CODES = /(^|_)(auth_revoked|reauth_required|signed_out|unauthorized|invalid_credential)$/u;
function signInRevoked(error2) {
  const code = errorCode(error2);
  if (code && REVOKED_CODES.test(code)) return true;
  return REVOKED_WORDS.test(errorText(error2));
}

// src/service/model-access-extension/host-process/credentials/dispatch.ts
var CREDENTIAL_METHODS = /* @__PURE__ */ new Set([
  "resolveOwned",
  "renewOwned",
  "forceRenewOwned",
  "forget",
  "borrow.resolve",
  "borrow.renew",
  "borrow.forceRenew"
]);
async function dispatchCredential(method, value, signal, extension) {
  if (!value || typeof value !== "object") throw new Error("host_credential_invalid");
  const params = value;
  signal.throwIfAborted();
  const input = captureHostContext(params.context);
  const context = Object.freeze({
    ...input,
    enabledTargets: input.enabledTargets ?? [],
    policyRevision: input.policyRevision ?? 0,
    signal
  });
  return method.startsWith("borrow.") ? dispatchBorrow(method, params, context, extension) : dispatchOwned(method, params, context, extension);
}
function dispatchBorrow(method, params, context, extension) {
  const handler = extension.sources[params.sourceId ?? ""]?.subscriptionBorrow?.[params.variant ?? ""];
  if (!handler) throw new Error("host_credential_invalid");
  validateBorrowSource(params, context);
  if (method === "borrow.resolve") return handler.resolve(context, params.source);
  const renew = method === "borrow.renew" ? handler.renew : handler.forceRenew;
  if (!renew) throw new Error("host_method_unavailable");
  return renew.call(handler, context, params.source, params.value);
}
function validateBorrowSource(params, context) {
  if (params.source?.installationId !== context.installationId || params.source.sourceId !== params.sourceId || params.source.variant !== params.variant || !context.enabledTargets.includes(params.source.target))
    throw new Error("host_credential_invalid");
}
async function dispatchOwned(method, params, context, extension) {
  const handler = extension.providers[params.providerId ?? ""];
  if (!handler) throw new Error("host_credential_invalid");
  validateOwnedBinding(params, context);
  if (method === "resolveOwned" && handler.resolveOwned)
    return handler.resolveOwned(context, params.binding, params.value);
  if (method === "forget" && handler.forget) {
    await handler.forget(context, params.binding, params.value);
    return null;
  }
  if (method !== "renewOwned" && method !== "forceRenewOwned")
    throw new Error("host_method_unavailable");
  const renew = handler[method];
  if (!renew) throw new Error("host_method_unavailable");
  return renewOwned(renew.bind(handler), context, params);
}
async function renewOwned(renew, context, params) {
  try {
    return await renew(context, params.binding, params.value);
  } catch (error2) {
    if (signInRevoked(error2))
      throw Object.assign(new Error("auth_revoked"), { code: "auth_revoked" });
    throw error2;
  }
}
function validateOwnedBinding(params, context) {
  if (params.binding?.providerId !== params.providerId || params.binding.installationId !== context.installationId || params.binding.kind !== "direct-owned")
    throw new Error("host_credential_invalid");
}

// src/service/model-access-extension/request/catalog-validation.ts
function invalid5() {
  throw new ModelAccessRequestError("request_invalid");
}
function text5(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 1024 || /[\u0000-\u001f]/u.test(value))
    invalid5();
  return value;
}
function number(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) invalid5();
  return value;
}
function timestamp(value) {
  const result = number(value);
  if (!Number.isSafeInteger(result) || result < 1) invalid5();
  return result;
}
function optionalNumber(item, key) {
  return item[key] === void 0 ? {} : { [key]: number(item[key]) };
}
function optionalTime(item, key) {
  return item[key] === void 0 ? {} : { [key]: timestamp(item[key]) };
}
function array(value, capture, limit2) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > limit2 || Reflect.ownKeys(value).length !== value.length + 1)
    invalid5();
  const result = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid5();
    result.push(capture(descriptor.value));
  }
  return Object.freeze(result);
}
function modality(value) {
  if (value !== "text" && value !== "image" && value !== "audio" && value !== "video") invalid5();
  return value;
}
function captureRequestModel(value) {
  const item = requestRecord(value, [
    "id",
    "api",
    "name",
    "contextWindow",
    "maxOutputTokens",
    "input",
    "reasoning",
    "tools",
    "creditMultiplier"
  ]);
  if (item.tools !== void 0 && typeof item.tools !== "boolean") invalid5();
  return Object.freeze({
    id: text5(item.id),
    api: text5(item.api),
    ...item.name === void 0 ? {} : { name: text5(item.name) },
    ...optionalNumber(item, "contextWindow"),
    ...optionalNumber(item, "maxOutputTokens"),
    ...optionalNumber(item, "creditMultiplier"),
    ...item.tools === void 0 ? {} : { tools: item.tools },
    ...item.input === void 0 ? {} : { input: array(item.input, modality, 4) },
    ...item.reasoning === void 0 ? {} : { reasoning: array(item.reasoning, text5, 16) }
  });
}
function captureRequestModels(value) {
  const models2 = array(value, captureRequestModel, 4096);
  if (new Set(models2.map((model) => model.id)).size !== models2.length) invalid5();
  return models2;
}
function window(value) {
  const item = requestRecord(value, [
    "name",
    "unit",
    "used",
    "amount",
    "limit",
    "resetAt",
    "runsOutAt"
  ]);
  return Object.freeze({
    name: text5(item.name),
    unit: text5(item.unit),
    ...optionalNumber(item, "used"),
    ...optionalNumber(item, "amount"),
    ...optionalNumber(item, "limit"),
    ...optionalTime(item, "resetAt"),
    ...optionalTime(item, "runsOutAt")
  });
}
function captureRequestUsage(value) {
  const item = requestRecord(value, ["status", "queriedAt", "plan", "windows", "expiryStatus"]);
  const queriedAt = timestamp(item.queriedAt);
  if (item.status === "unsupported" || item.status === "failed" || item.status === "unknown") {
    if (item.plan !== void 0 || item.windows !== void 0 || item.expiryStatus !== void 0)
      invalid5();
    return Object.freeze({ status: item.status, queriedAt });
  }
  if (item.status !== "available") invalid5();
  return Object.freeze({
    status: item.status,
    queriedAt,
    ...item.plan === void 0 ? {} : { plan: text5(item.plan) },
    windows: array(item.windows, window, 64),
    expiryStatus: expiryStatus(item.expiryStatus)
  });
}
function expiryStatus(value) {
  if (value !== "known" && value !== "unknown" && value !== "not_applicable") invalid5();
  return value;
}

// src/service/model-access-extension/api-scan/validation.ts
var ModelAccessApiScanError = class extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.name = "ModelAccessApiScanError";
  }
};
function invalid6() {
  throw new ModelAccessApiScanError("api_scan_invalid");
}
function text6(value, limit2 = 256) {
  if (typeof value !== "string" || !value.trim() || value.length > limit2 || /[\u0000-\u001f\u007f]/u.test(value))
    invalid6();
  return value;
}
function record3(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid6();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) invalid6();
  const result = /* @__PURE__ */ Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || keys && !keys.includes(key)) invalid6();
    result[key] = ownValue(value, key);
  }
  return result;
}
function ownValue(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid6();
  return descriptor.value;
}
function array2(value, capture, limit2) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > limit2 || Reflect.ownKeys(value).length !== value.length + 1)
    invalid6();
  const result = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid6();
    result.push(capture(descriptor.value));
  }
  return Object.freeze(result);
}
function headers(value) {
  if (value === void 0) return void 0;
  const item = record3(value);
  if (Object.keys(item).length > 64) invalid6();
  const result = /* @__PURE__ */ Object.create(null);
  for (const key of Object.keys(item).sort()) {
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/iu.test(key) || Object.hasOwn(result, key.toLowerCase()))
      invalid6();
    result[key.toLowerCase()] = text6(item[key], 16384);
  }
  return Object.freeze(result);
}
function candidate(value, targets) {
  const item = record3(value, [
    "target",
    "fingerprint",
    "upstream",
    "baseUrl",
    "api",
    "apiKey",
    "headers",
    "models"
  ]);
  const target = text6(item.target);
  if (!targets.includes(target)) invalid6();
  const baseUrl = text6(item.baseUrl, 4096);
  let endpoint;
  try {
    endpoint = new URL(baseUrl);
  } catch {
    return invalid6();
  }
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    invalid6();
  const capturedHeaders = headers(item.headers);
  const api = text6(item.api);
  const models2 = captureRequestModels(item.models);
  if (models2.some((model) => model.api !== api)) invalid6();
  return Object.freeze({
    target,
    fingerprint: text6(item.fingerprint, 1024),
    upstream: text6(item.upstream),
    baseUrl,
    api,
    apiKey: text6(item.apiKey, 65536),
    ...capturedHeaders ? { headers: capturedHeaders } : {},
    models: models2
  });
}
function captureApiCandidates(value, targets) {
  try {
    const result = array2(value, (item) => candidate(item, targets), 256);
    if (new Set(result.map((item) => JSON.stringify([item.target, item.fingerprint]))).size !== result.length)
      invalid6();
    return result;
  } catch {
    return invalid6();
  }
}

// src/service/model-access-extension/borrow/validation.ts
var ModelAccessBorrowError = class extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.name = "ModelAccessBorrowError";
  }
};
function invalid7() {
  throw new ModelAccessBorrowError("borrow_invalid");
}
function dataValue2(descriptor) {
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid7();
  return descriptor.value;
}
function record4(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid7();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) invalid7();
  const result = /* @__PURE__ */ Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !keys.includes(key)) invalid7();
    result[key] = dataValue2(Object.getOwnPropertyDescriptor(value, key));
  }
  return result;
}
function text7(value, empty = false) {
  if (typeof value !== "string" || value.length > 256 || /[\u0000-\u001f]/u.test(value)) invalid7();
  if (!empty && !value.trim()) invalid7();
  return value;
}
function sameSource(left, right) {
  return left.installationId === right.installationId && left.sourceId === right.sourceId && left.variant === right.variant && left.target === right.target;
}
function discovery(value, source) {
  const item = record4(value, ["providerId", "sourceRef", "status", "accountMasked", "plan"]);
  const sourceRef = captureSourceRef(item.sourceRef);
  if (!sameSource(sourceRef, source)) invalid7();
  const status = item.status;
  if (status !== "available" && status !== "signed_out" && status !== "expired" && status !== "unavailable" && status !== "unknown")
    invalid7();
  return Object.freeze({
    providerId: text7(item.providerId),
    sourceRef,
    status,
    ...discoveryAccount(item, status)
  });
}
function discoveryAccount(item, status) {
  const accountMasked = item.accountMasked === void 0 ? void 0 : text7(item.accountMasked);
  const plan = item.plan === void 0 ? void 0 : text7(item.plan);
  if (status !== "available" && status !== "expired") return {};
  return {
    ...accountMasked === void 0 ? {} : { accountMasked },
    ...plan === void 0 ? {} : { plan }
  };
}
function captureBorrowDiscoveries(value, source) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 128)
    invalid7();
  if (Reflect.ownKeys(value).length !== value.length + 1) invalid7();
  const result = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid7();
    result.push(discovery(descriptor.value, source));
  }
  if (new Set(result.map((item) => item.providerId)).size !== result.length) invalid7();
  return Object.freeze(result);
}

// src/service/model-access-extension/host-process/rpc/dispatch.ts
var AUXILIARY_METHODS = /* @__PURE__ */ new Set([
  "usage",
  "borrow.discover",
  "apiKeyScan.scan"
]);
async function dispatchAuxiliary(method, value, signal, owner) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid8();
  const params = value;
  const captured = captureHostContext(params.context);
  const context = Object.freeze({
    ...captured,
    enabledTargets: Object.freeze([...captured.enabledTargets ?? []]),
    policyRevision: captured.policyRevision,
    signal
  });
  signal.throwIfAborted();
  if (method === "usage") return usage(params, context, owner);
  if (method !== "apiKeyScan.scan" && method !== "borrow.discover") unavailable();
  return sourceCall(method, params, context, owner);
}
async function usage(params, context, { extension, manifest }) {
  const provider2 = manifest.providers.find((entry) => entry.id === params.providerId);
  const binding = params.binding;
  if (!provider2 || !binding || binding.installationId !== context.installationId || binding.providerId !== params.providerId || !provider2.credentialKinds.includes(binding.kind))
    invalid8();
  validateCredential(params);
  const handler = extension.providers[params.providerId];
  if (!handler?.usage) unavailable();
  const result = await handler.usage(context, binding, params.credential);
  context.signal.throwIfAborted();
  return captureRequestUsage(result);
}
function validateCredential(params) {
  if (!params.credential || typeof params.credential !== "object") invalid8();
  if (params.binding.kind === "public") {
    if (!params.credential.identity || !("public" in params.credential.identity) || params.credential.identity.public !== true)
      invalid8();
    return;
  }
  captureIdentity(params.credential.identity, params.providerId);
  if (params.binding.kind === "borrowed-current") {
    const sourceRef = captureSourceRef(params.binding.sourceRef);
    if (sourceRef.installationId !== params.context.installationId) invalid8();
  }
}
function validateEntry(method, params, context, manifest) {
  const source = manifest.sources.find((entry2) => entry2.id === params.sourceId);
  const capability = method === "apiKeyScan.scan" ? "apiKeyScan" : "subscriptionBorrow";
  const entries = capability === "apiKeyScan" ? source?.capabilities.apiKeyScan?.readers : source?.capabilities.subscriptionBorrow?.variants;
  const entry = entries?.find((item) => item.id === params.entryId);
  if (!entry) invalid8();
  if (!context.enabledTargets.length || new Set(context.enabledTargets).size !== context.enabledTargets.length || context.enabledTargets.some((target) => !entry.targets.includes(target)))
    invalid8();
}
async function sourceCall(method, params, context, { extension, manifest }) {
  validateEntry(method, params, context, manifest);
  const handlers = extension.sources[params.sourceId];
  if (method === "apiKeyScan.scan") {
    const handler2 = handlers?.apiKeyScan?.[params.entryId];
    if (!handler2) unavailable();
    const result2 = await handler2.scan(context);
    context.signal.throwIfAborted();
    return captureApiCandidates(result2, context.enabledTargets);
  }
  const handler = handlers?.subscriptionBorrow?.[params.entryId];
  if (!handler) unavailable();
  const result = await handler.discover(context);
  context.signal.throwIfAborted();
  if (!Array.isArray(result) || result.length > 256) invalid8();
  return result.flatMap((item) => {
    if (!item || !context.enabledTargets.includes(item.sourceRef?.target)) invalid8();
    if (!manifest.providers.some((provider2) => provider2.id === item.providerId)) invalid8();
    return captureBorrowDiscoveries([item], {
      installationId: context.installationId,
      sourceId: params.sourceId,
      variant: params.entryId,
      target: item.sourceRef.target,
      selector: "current"
    });
  });
}
function invalid8() {
  throw Object.assign(new Error("host_rpc_invalid"), { code: "host_rpc_invalid" });
}
function unavailable() {
  throw Object.assign(new Error("host_method_unavailable"), { code: "host_method_unavailable" });
}

// src/service/model-access-extension/host-process/stream.ts
var MODEL_ACCESS_HOST_MAX_STREAM_CHUNK = 64 * 1024;
var MODEL_ACCESS_HOST_FRAME_OVERHEAD = 2048;
var MODEL_ACCESS_HOST_DEFAULT_WINDOW = 512 * 1024;
var MODEL_ACCESS_HOST_MAX_WINDOW = 64 * 1024 * 1024;
var ModelAccessHostCreditGate = class {
  free;
  stopped = false;
  waiter;
  constructor(window2) {
    if (!Number.isSafeInteger(window2) || window2 <= MODEL_ACCESS_HOST_FRAME_OVERHEAD)
      throw new Error("host_stream_window_invalid");
    this.free = Math.min(window2, MODEL_ACCESS_HOST_MAX_WINDOW);
  }
  async take(want) {
    if (this.stopped) return -1;
    const available = Math.min(want, this.free - MODEL_ACCESS_HOST_FRAME_OVERHEAD);
    if (available > 0) return available;
    return new Promise((resolve) => {
      this.waiter = (ok) => resolve(ok ? Math.min(want, this.free - MODEL_ACCESS_HOST_FRAME_OVERHEAD) : -1);
    });
  }
  spend(bytes) {
    this.free -= bytes + MODEL_ACCESS_HOST_FRAME_OVERHEAD;
    if (this.free < 0) throw new Error("host_stream_credit_overrun");
  }
  add(credit) {
    if (this.stopped || !Number.isSafeInteger(credit) || credit <= 0) return;
    this.free = Math.min(MODEL_ACCESS_HOST_MAX_WINDOW, this.free + credit);
    if (this.waiter && this.free > MODEL_ACCESS_HOST_FRAME_OVERHEAD) {
      const wake = this.waiter;
      this.waiter = void 0;
      wake(true);
    }
  }
  stop() {
    this.stopped = true;
    const wake = this.waiter;
    this.waiter = void 0;
    wake?.(false);
  }
};
function validStreamWindow(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > MODEL_ACCESS_HOST_FRAME_OVERHEAD && value <= MODEL_ACCESS_HOST_MAX_WINDOW;
}

// src/service/model-access-extension/host-process/failure-codec.ts
import { randomUUID as randomUUID2 } from "node:crypto";
var MODEL_ACCESS_HOST_MAX_FAILURE_MESSAGE = 8 * 1024;
var MODEL_ACCESS_HOST_MAX_FAILURE_HEADERS = 64;
var REF_PATTERN = /^[a-f0-9-]{16,128}$/u;
var CODE_PATTERN = /^[a-z][a-z0-9_.-]{0,95}$/u;
var ModelAccessHostFailureStore = class {
  constructor(maxEntries = 256) {
    this.maxEntries = maxEntries;
  }
  entries = /* @__PURE__ */ new Map();
  remember(error2) {
    const ref = randomUUID2();
    this.entries.set(ref, error2);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (typeof oldest !== "string") break;
      this.entries.delete(oldest);
    }
    return ref;
  }
  get(ref) {
    return this.entries.get(ref);
  }
  release(ref) {
    this.entries.delete(ref);
  }
  clear() {
    this.entries.clear();
  }
};
function attachHostFailureRef(error2, ref) {
  if (!isObject(error2)) return error2;
  try {
    Object.defineProperty(error2, "errorRef", {
      configurable: true,
      enumerable: false,
      value: ref,
      writable: false
    });
  } catch {
  }
  return error2;
}
function hostFailureRef(error2) {
  if (!isObject(error2)) return void 0;
  const value = error2.errorRef;
  return typeof value === "string" && REF_PATTERN.test(value) ? value : void 0;
}
function restoreHostFailure(value, store) {
  const dto = parseHostFailure(value);
  if (dto.ref !== void 0) return restoreOriginalFailure(dto.ref, store);
  const result = new Error(dto.message ?? dto.errorMessage ?? dto.code ?? "host_failure");
  if (dto.name) result.name = dto.name;
  if (dto.code) define(result, "code", dto.code);
  if (dto.status !== void 0) define(result, "status", dto.status);
  if (dto.headers) define(result, "headers", dto.headers);
  return result;
}
function restoreOriginalFailure(ref, store) {
  const original = store?.get(ref);
  if (original === void 0) throw new Error("host_failure_ref_missing");
  if (original instanceof Error) return original;
  throw new Error("host_failure_ref_invalid");
}
function parseHostFailure(value) {
  assertHostFailure(value);
  return value;
}
function assertHostFailure(value) {
  if (!isObject(value) || value.kind !== "error") throw new Error("host_failure_invalid");
  if (value.ref !== void 0 && !isRef(value.ref)) throw new Error("host_failure_ref_invalid");
  validateFailureText(value);
  if (value.status !== void 0 && !validStatus(value.status))
    throw new Error("host_failure_invalid");
  if (value.headers !== void 0 && boundedHeaders(value.headers) === void 0)
    throw new Error("host_failure_invalid");
}
function validateFailureText(value) {
  for (const key of ["name", "message", "errorMessage"]) {
    if (value[key] !== void 0 && boundedText(value[key]) !== value[key])
      throw new Error("host_failure_invalid");
  }
  if (value.code !== void 0 && !isCode(value.code)) throw new Error("host_failure_invalid");
}
function define(target, key, value) {
  Object.defineProperty(target, key, { configurable: true, enumerable: true, value });
}
function boundedText(value) {
  return typeof value === "string" && value.length <= MODEL_ACCESS_HOST_MAX_FAILURE_MESSAGE ? value : void 0;
}
function validStatus(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599;
}
function boundedHeaders(value) {
  if (!isObject(value) || Object.keys(value).length > MODEL_ACCESS_HOST_MAX_FAILURE_HEADERS)
    return void 0;
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key.length > 256 || typeof entry !== "string" || entry.length > 4096) return void 0;
    result[key] = entry;
  }
  return result;
}
function isRef(value) {
  return typeof value === "string" && REF_PATTERN.test(value);
}
function isCode(value) {
  return typeof value === "string" && CODE_PATTERN.test(value);
}
function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// src/service/model-access-extension/host-process/shim/host-entry.ts
var MAX_LINE_BYTES = 32 * 1024 * 1024;
var inflight = /* @__PURE__ */ new Map();
var actualWork = /* @__PURE__ */ new Set();
var slotWork = /* @__PURE__ */ new Map();
var gates = /* @__PURE__ */ new Map();
var transports = /* @__PURE__ */ new Map();
var requestBodies = new HostRequestBodies((ref) => transports.has(ref));
var failures = new ModelAccessHostFailureStore();
var DEFAULT_SLOT = "";
var MAX_SLOTS = 64;
var slots = /* @__PURE__ */ new Map();
var transportSlots = /* @__PURE__ */ new Map();
var slotScope = new AsyncLocalStorage();
var initialized = false;
var shuttingDown = false;
var crashed = false;
var epoch = process.argv.find((argument) => argument.startsWith("--model-access-epoch="))?.slice(21) ?? "";
var stdoutWrite = process.stdout.write.bind(process.stdout);
var diagnostic = (...values) => {
  process.stderr.write(`${values.map((value) => String(value)).join(" ")}
`);
};
Object.assign(console, { log: diagnostic, info: diagnostic, debug: diagnostic, warn: diagnostic });
var writeQueue = [];
var writing = false;
function send(message) {
  writeQueue.push(
    encodeHostMessage({
      ...message,
      version: MODEL_ACCESS_HOST_PROTOCOL,
      epoch
    })
  );
  pumpWrites();
}
function pumpWrites() {
  if (writing) return;
  const line = writeQueue.shift();
  if (!line) return;
  writing = true;
  let accepted = false;
  try {
    accepted = stdoutWrite(line, "utf8");
  } catch {
    process.exitCode = 1;
    return;
  }
  if (accepted) {
    writing = false;
    pumpWrites();
    return;
  }
  process.stdout.once("drain", () => {
    writing = false;
    pumpWrites();
  });
}
function contextOf(input, signal) {
  return Object.freeze({
    profileId: input.profileId,
    installationId: input.installationId,
    generation: input.generation,
    operationId: input.operationId,
    signal,
    enabledTargets: Object.freeze([...input.enabledTargets ?? []]),
    policyRevision: input.policyRevision ?? 0,
    dataDir: input.dataDir,
    hostDataDir: input.hostDataDir,
    ...input.sessionKey ? { sessionKey: input.sessionKey } : {}
  });
}
var LIFECYCLE_METHODS = /* @__PURE__ */ new Set(["init", "drain", "shutdown", "unload"]);
var BODY_METHODS = /* @__PURE__ */ new Set(["body.begin", "body.chunk", "body.end", "body.discard"]);
async function dispatch(request, signal) {
  if (shuttingDown) throw new Error("host_closed");
  const slotKey = request.slot ?? DEFAULT_SLOT;
  if (LIFECYCLE_METHODS.has(request.method)) return dispatchLifecycle(request, slotKey);
  if (!initialized) throw new Error("host_not_initialized");
  const slot = slots.get(slotKey);
  if (!slot) throw Object.assign(new Error("host_slot_missing"), { code: "host_slot_missing" });
  return dispatchSlot(request, signal, slot, slotKey);
}
async function dispatchLifecycle(request, slotKey) {
  if (request.method === "init") return init(request.params, slotKey);
  if (request.method === "shutdown") return shutdown();
  if (request.method === "unload") return unload(slotKey);
  if (request.slot === void 0) await settleWorkAndLogin();
  else await settleSlot(slotKey);
  return null;
}
function dispatchSlot(request, signal, slot, slotKey) {
  const extension = slot.extension;
  if (AUXILIARY_METHODS.has(request.method))
    return dispatchAuxiliary(request.method, request.params, signal, {
      extension,
      manifest: slot.manifest
    });
  if (CREDENTIAL_METHODS.has(request.method))
    return dispatchCredential(request.method, request.params, signal, extension);
  if (BODY_METHODS.has(request.method))
    return requestBodies.dispatch(request.method, request.params);
  return dispatchActive(request, signal, slot, slotKey);
}
function dispatchActive(request, signal, slot, slotKey) {
  const current = slot.extension;
  const loginFlows = slot.loginFlows;
  const handlers = /* @__PURE__ */ new Map([
    ["describe", () => describe(slot)],
    ["models", () => models(request.params, signal, current)],
    ["bindTransport", () => bindTransport(request.params, signal, current, slotKey)],
    ["fetch", () => fetchTransport(request.id, request.params, signal)],
    ["disposeTransport", () => disposeTransport(request.params)],
    ["classifyError", () => classifyError(request.params, current)],
    ["login.begin", () => loginFlows.begin(request.params, signal, current, slot.manifest)],
    ["login.submit", () => loginFlows.submit(request.params, signal)],
    ["login.result", () => loginFlows.result(request.params, signal)],
    ["login.cancel", () => loginFlows.cancel(request.params)]
  ]);
  const handler = handlers.get(request.method);
  if (!handler) throw new Error("host_method_unknown");
  return handler();
}
async function shutdown() {
  shuttingDown = true;
  requestBodies.clear();
  for (const controller of inflight.values()) controller.abort();
  for (const gate of gates.values()) gate.stop();
  await closeResources();
  failures.clear();
  process.exitCode = 0;
  return null;
}
async function settleWork() {
  while (actualWork.size) await Promise.all([...actualWork]);
}
async function settleSlot(slotKey) {
  for (; ; ) {
    const work = slotWork.get(slotKey);
    if (work?.size) await Promise.all([...work]);
    await slots.get(slotKey)?.loginFlows.settled();
    if (!slotWork.get(slotKey)?.size) return;
  }
}
async function settleWorkAndLogin() {
  do {
    await settleWork();
    await Promise.all([...slots.values()].map((slot) => slot.loginFlows.settled()));
  } while (actualWork.size);
}
async function disposeTransports(refs) {
  const remaining = refs.flatMap((ref) => {
    const transport = transports.get(ref);
    transports.delete(ref);
    transportSlots.delete(ref);
    requestBodies.disposeTransport(ref);
    return transport ? [transport] : [];
  });
  const disposed = await Promise.allSettled(
    remaining.map(async (transport) => transport.dispose?.())
  );
  return disposed.every((result) => result.status === "fulfilled");
}
async function closeResources() {
  await Promise.allSettled([...slots.values()].map((slot) => slot.loginFlows.close()));
  await settleWorkAndLogin();
  const clean = await disposeTransports([...transports.keys()]);
  for (const slot of slots.values()) await slot.extension.dispose?.();
  if (!clean) throw new Error("host_transport_cleanup_failed");
}
async function unload(slotKey) {
  const slot = slots.get(slotKey);
  if (!slot) return null;
  slots.delete(slotKey);
  await slot.loginFlows.close();
  await slot.loginFlows.settled();
  const refs = [...transportSlots].filter(([, key]) => key === slotKey).map(([ref]) => ref);
  const clean = await disposeTransports(refs);
  await slot.extension.dispose?.();
  if (!clean) throw new Error("host_transport_cleanup_failed");
  return null;
}
function assertSlotFree(slotKey) {
  if (slots.has(slotKey) || slotKey === DEFAULT_SLOT && initialized)
    throw new Error("host_init_invalid");
  if (slotKey !== DEFAULT_SLOT && slots.has(DEFAULT_SLOT)) throw new Error("host_init_invalid");
  if (slots.size >= MAX_SLOTS) throw new Error("host_slot_limit");
}
async function loadExtension(params) {
  if (typeof params.moduleUrl !== "string" || !params.moduleUrl.startsWith("file:"))
    throw new Error("host_init_invalid");
  const loaded = await import(params.moduleUrl);
  if (!isRecord3(loaded) || !Object.hasOwn(loaded, "default"))
    throw new Error("host_activation_failed");
  const manifest = params.manifest;
  const extension = validateModelAccessExtension(manifest, loaded.default);
  const providerLimits = captureModuleLimits(
    loaded.providerLimits,
    manifest.providers.map((entry) => entry.id)
  );
  return { manifest, extension, providerLimits };
}
async function init(value, slotKey) {
  if (!isRecord3(value)) throw new Error("host_init_invalid");
  assertSlotFree(slotKey);
  const { manifest, extension, providerLimits } = await loadExtension(
    value
  );
  if (shuttingDown) {
    await extension.dispose?.();
    throw new Error("host_closed");
  }
  slots.set(slotKey, {
    extension,
    manifest,
    providerLimits,
    loginFlows: new ChildLoginFlows(epoch, send)
  });
  if (!initialized) {
    initialized = true;
    send({ type: "event", event: "ready" });
  }
  return { ok: true };
}
function describe(slot) {
  const value = slot.extension;
  const providerLimits = slot.providerLimits;
  const providers = {};
  for (const [id, handler] of Object.entries(value.providers)) providers[id] = Object.keys(handler);
  const sources = {};
  for (const [id, handlers] of Object.entries(value.sources)) {
    const result = {};
    for (const capability of ["login", "subscriptionBorrow", "apiKeyScan"]) {
      const entries = handlers[capability];
      if (entries) {
        result[capability] = Object.fromEntries(
          Object.entries(entries).map(([entryId, handler]) => [entryId, Object.keys(handler)])
        );
      }
    }
    sources[id] = result;
  }
  return {
    providers,
    sources,
    ...Object.keys(providerLimits).length > 0 ? { limits: { ...providerLimits } } : {}
  };
}
async function models(value, signal, valueExtension) {
  const params = value;
  if (!isRecord3(value) || typeof params.providerId !== "string")
    throw new Error("host_models_invalid");
  const handler = provider(valueExtension, params.providerId);
  const result = await handler.models(
    contextOf(params.context, signal),
    params.binding,
    params.credential
  );
  if (!Array.isArray(result)) throw new Error("host_models_invalid");
  return result;
}
async function bindTransport(value, signal, valueExtension, slotKey) {
  const params = value;
  if (!isRecord3(value) || typeof params.providerId !== "string")
    throw new Error("host_bind_invalid");
  const handler = provider(valueExtension, params.providerId);
  const transport = captureBoundTransport(
    await handler.bindTransport(contextOf(params.context, signal), params.credential, params.model)
  );
  if (signal.aborted) {
    await transport.dispose?.();
    signal.throwIfAborted();
  }
  const transportRef = `${params.context.operationId}:${randomUUID3()}`;
  transports.set(transportRef, transport);
  transportSlots.set(transportRef, slotKey);
  return {
    transportRef,
    api: transport.api,
    modelId: transport.modelId,
    baseUrl: transport.baseUrl,
    ...transport.apiKey === void 0 ? {} : { apiKey: transport.apiKey },
    ...transport.headers === void 0 ? {} : { headers: transport.headers }
  };
}
async function fetchTransport(requestId, value, signal) {
  const params = value;
  validateFetchParams(value);
  const transport = transports.get(params.transportRef);
  if (!transport) throw new Error("host_transport_missing");
  if (!validStreamWindow(params.window)) throw new Error("host_stream_window_invalid");
  const combined = signal;
  const gate = new ModelAccessHostCreditGate(params.window);
  gates.set(requestId, gate);
  let bodyTaken = false;
  try {
    signal.throwIfAborted();
    const body = params.init.body ? requestBodies.take(params.init.body.ref, params.transportRef) : void 0;
    bodyTaken = body !== void 0;
    const response = await (transport.fetch ?? globalThis.fetch)(
      params.input,
      fetchInit(params, body, combined)
    );
    sendHead(requestId, response);
    await sendBody(requestId, response.body, gate);
    send({ type: "stream", id: requestId, event: "end" });
    return null;
  } catch (error2) {
    const ref = failures.remember(error2);
    if (!combined.aborted)
      send({
        type: "stream",
        id: requestId,
        event: "error",
        error: hostError(errorCode2(error2) ?? "host_fetch_failed", ref)
      });
    throw attachHostFailureRef(error2, ref);
  } finally {
    if (params.init.body && bodyTaken)
      requestBodies.complete(params.init.body.ref, params.transportRef);
    gate.stop();
    gates.delete(requestId);
  }
}
function validateFetchParams(value) {
  if (!isRecord3(value) || typeof value.transportRef !== "string" || typeof value.input !== "string")
    throw new Error("host_fetch_invalid");
}
function fetchInit(params, body, signal) {
  return {
    ...params.init.method ? { method: params.init.method } : {},
    ...params.init.headers ? { headers: params.init.headers } : {},
    ...params.init.body === void 0 ? {} : { body },
    signal
  };
}
function sendHead(requestId, response) {
  const headers2 = {};
  response.headers.forEach((entry, key) => {
    headers2[key] = entry;
  });
  if (Object.keys(headers2).length > 256 || JSON.stringify(headers2).length > 64 * 1024)
    throw new Error("host_stream_head_too_large");
  send({ type: "stream", id: requestId, event: "head", status: response.status, headers: headers2 });
}
async function sendBody(requestId, body, gate) {
  if (!body) return;
  const reader = body.getReader();
  try {
    for (; ; ) {
      const next = await reader.read();
      if (next.done) break;
      await sendChunks(requestId, next.value, gate);
    }
  } finally {
    reader.releaseLock();
  }
}
async function sendChunks(requestId, value, gate) {
  let offset = 0;
  while (offset < value.byteLength) {
    const size = await gate.take(
      Math.min(MODEL_ACCESS_HOST_MAX_STREAM_CHUNK, value.byteLength - offset)
    );
    if (size <= 0) throw new Error("host_request_cancelled");
    const chunk = value.subarray(offset, offset + size);
    gate.spend(chunk.byteLength);
    send({
      type: "stream",
      id: requestId,
      event: "chunk",
      data: Buffer.from(chunk).toString("base64")
    });
    offset += size;
  }
}
async function disposeTransport(value) {
  if (!isRecord3(value) || typeof value.transportRef !== "string")
    throw new Error("host_transport_invalid");
  const transport = transports.get(value.transportRef);
  transports.delete(value.transportRef);
  transportSlots.delete(value.transportRef);
  requestBodies.disposeTransport(value.transportRef);
  await transport?.dispose?.();
  return null;
}
async function classifyError(value, valueExtension) {
  const params = value;
  if (!isRecord3(value) || typeof params.providerId !== "string")
    throw new Error("host_classify_invalid");
  const handler = provider(valueExtension, params.providerId);
  try {
    return handler.classifyError(restoreHostFailure(params.error, failures));
  } finally {
    if (params.error?.ref) failures.release(params.error.ref);
  }
}
function provider(value, id) {
  const handler = value.providers[id];
  if (!handler) throw new Error("host_provider_missing");
  return handler;
}
function onMessage(message) {
  if (message.epoch !== epoch) {
    send({ type: "event", event: "fatal", error: hostError("host_epoch_mismatch") });
    process.exitCode = 1;
    return;
  }
  if (message.type === "cancel") {
    inflight.get(message.id)?.abort();
    gates.get(message.id)?.stop();
    return;
  }
  if (message.type === "credit") {
    gates.get(message.id)?.add(message.n);
    return;
  }
  if (message.type !== "request") return;
  const controller = new AbortController();
  inflight.set(message.id, controller);
  const work = slotScope.run(
    message.slot ?? DEFAULT_SLOT,
    () => dispatch(message, controller.signal)
  );
  if (!["drain", "shutdown", "unload"].includes(message.method)) {
    const slotKey = message.slot ?? DEFAULT_SLOT;
    let owned = slotWork.get(slotKey);
    if (!owned) {
      owned = /* @__PURE__ */ new Set();
      slotWork.set(slotKey, owned);
    }
    const bucket = owned;
    const settled = observeWork(work, () => {
      actualWork.delete(settled);
      bucket.delete(settled);
      if (bucket.size === 0 && slotWork.get(slotKey) === bucket) slotWork.delete(slotKey);
    });
    actualWork.add(settled);
    bucket.add(settled);
  }
  observeModelAccessWork(respond(message, work));
}
async function observeWork(work, release) {
  try {
    await work;
  } catch {
  } finally {
    release();
  }
}
async function respond(message, work) {
  try {
    let result;
    try {
      result = await work;
    } catch (error2) {
      reportFailure(message.id, error2);
      return;
    }
    send({ type: "response", id: message.id, result });
  } finally {
    inflight.delete(message.id);
    if (message.method === "shutdown") setImmediate(() => process.exit(0));
  }
}
function reportFailure(id, error2) {
  const ref = hostFailureRef(error2) ?? failures.remember(error2);
  send({
    type: "response",
    id,
    error: hostError(errorCode2(error2) ?? "host_failed", ref)
  });
}
var decoder = new HostLineDecoder(MAX_LINE_BYTES);
process.stdout.on("error", () => process.exit(1));
process.stdin.on("data", (chunk) => {
  try {
    for (const message of decoder.push(chunk)) onMessage(message);
  } catch (error2) {
    send({ type: "event", event: "fatal", error: hostError(errorCode2(error2) ?? "host_protocol") });
    process.exitCode = 1;
    process.stdin.pause();
  }
});
process.stdin.on("end", () => {
  try {
    decoder.finish();
  } catch {
    process.exitCode = 1;
  }
  shuttingDown = true;
  requestBodies.clear();
  for (const controller of inflight.values()) controller.abort();
  const deadline = setTimeout(() => process.exit(1), 2e3);
  observeModelAccessWork(closeLoginOnParentExit(deadline));
});
async function closeLoginOnParentExit(deadline) {
  try {
    await Promise.allSettled([...slots.values()].map((slot) => slot.loginFlows.close()));
  } finally {
    clearTimeout(deadline);
    process.exit(process.exitCode ?? 0);
  }
}
function crash(error2) {
  if (crashed) return;
  crashed = true;
  diagnostic(error2 instanceof Error ? error2.stack ?? error2.message : String(error2));
  const slot = slotScope.getStore();
  process.exitCode = 1;
  shuttingDown = true;
  send({
    type: "event",
    event: "fatal",
    error: hostError("host_extension_crashed"),
    ...slot && slots.has(slot) ? { slot } : {}
  });
  setTimeout(() => process.exit(1), 1e3).unref();
  process.stdout.write("", () => process.exit(1));
}
process.on("uncaughtException", crash);
process.on("unhandledRejection", crash);
send({ type: "event", event: "hello" });
function errorCode2(error2) {
  if (!error2 || typeof error2 !== "object") return void 0;
  const code = error2.code;
  return typeof code === "string" ? code : void 0;
}
function isRecord3(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
