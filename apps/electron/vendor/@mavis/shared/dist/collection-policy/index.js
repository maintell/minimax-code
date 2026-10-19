/**
 * Browser-safe collection policy surface: types, built-in defaults and the parser.
 *
 * `createCollectionPolicyMatcher` lives in `@mavis/shared/collection-policy/matcher` because
 * compiling a policy hashes it with `node:crypto`. Renderer and other browser bundles read and
 * validate policy documents; only runtime processes compile and apply them.
 */
export { DEFAULT_COLLECTION_POLICY } from './defaults.js';
export { isCollectionPolicy, parseCollectionPolicy } from './parse.js';
export { COLLECTION_POLICY_APOLLO_KEY, COLLECTION_POLICY_SCHEMA_VERSION, } from './types.js';
//# sourceMappingURL=index.js.map