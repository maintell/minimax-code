/**
 * Compiled form of a collection policy.
 *
 * Every pattern is turned into a regular expression once per policy object and cached, so hot
 * scan loops only run pre-compiled tests. Matching is case-insensitive and slash-normalised, and
 * deny rules can only ever remove data: there is no positive override.
 */
import { createHash } from 'node:crypto';
import { canonicalPolicyJson, canonicalWorkspaceJson } from './canonical.js';
import { BUILT_IN_NOISY_COMMAND_NAME_PATTERNS } from './defaults.js';
import { MAX_GLOB_MATCH_INPUT_LENGTH, compileGlob, subtreeDirectoryPattern } from './glob.js';
const matcherCache = new WeakMap();
/**
 * Returns the compiled matcher for a policy. Policies are immutable, so the matcher is compiled
 * once per policy object and reused for every later call.
 */
export function createCollectionPolicyMatcher(policy) {
    const cached = matcherCache.get(policy);
    if (cached)
        return cached;
    const matcher = compilePolicyMatcher(policy);
    matcherCache.set(policy, matcher);
    return matcher;
}
function compilePolicyMatcher(policy) {
    const workspace = compileWorkspaceGlobs(policy.workspace.exclude_globs);
    const excludedExtensions = toLookup(policy.path_commands.exclude_extensions);
    const excludedEnvironmentKeys = toLookup(policy.environment.exclude_keys);
    const excludedMetadataFields = toLookup(policy.metadata.exclude_fields);
    const hasMetadataExclusions = policy.metadata.exclude_fields.length > 0;
    const namePatterns = [];
    for (const pattern of policy.path_commands.exclude_name_globs) {
        const compiled = compileGlob(pattern);
        if (compiled)
            namePatterns.push(compiled);
    }
    return Object.freeze({
        version: createHash('sha256').update(canonicalPolicyJson(policy), 'utf8').digest('hex'),
        workspaceVersion: createHash('sha256')
            .update(canonicalWorkspaceJson(policy), 'utf8')
            .digest('hex'),
        excludesWorkspacePath(path) {
            if (workspace.segmentPatterns.length === 0 && workspace.pathPatterns.length === 0) {
                return false;
            }
            const normalized = normalizeRelativePath(path);
            if (normalized === undefined)
                return false;
            if (workspace.segmentPatterns.length > 0) {
                for (const segment of normalized.split('/')) {
                    for (const pattern of workspace.segmentPatterns) {
                        if (pattern.test(segment))
                            return true;
                    }
                }
            }
            for (const pattern of workspace.pathPatterns) {
                if (pattern.test(normalized))
                    return true;
            }
            return false;
        },
        excludesEnvironmentKey(key) {
            if (typeof key !== 'string' || key.length === 0 || key.length > 128)
                return false;
            return Object.hasOwn(excludedEnvironmentKeys, key.trim().toUpperCase());
        },
        excludesMetadataField(field) {
            if (!hasMetadataExclusions || typeof field !== 'string')
                return false;
            const normalized = field.trim().toLowerCase();
            if (normalized.length === 0)
                return false;
            if (Object.hasOwn(excludedMetadataFields, normalized))
                return true;
            for (let index = normalized.indexOf('.'); index > 0; index = normalized.indexOf('.', index + 1)) {
                if (Object.hasOwn(excludedMetadataFields, normalized.slice(0, index)))
                    return true;
            }
            return false;
        },
        excludesPathCommand(filename) {
            if (typeof filename !== 'string')
                return true;
            if (filename.length === 0 || filename.length > MAX_GLOB_MATCH_INPUT_LENGTH)
                return true;
            const normalized = filename.toLowerCase();
            const dot = normalized.lastIndexOf('.');
            // A GUID payload or a bare version number is noise whether or not it carries an
            // executable extension, so the baseline sees the stem as well as the whole name.
            const stem = dot > 0 ? normalized.slice(0, dot) : undefined;
            for (const pattern of BUILT_IN_NOISY_COMMAND_NAME_PATTERNS) {
                if (pattern.test(normalized))
                    return true;
                if (stem !== undefined && pattern.test(stem))
                    return true;
            }
            if (dot > 0 && Object.hasOwn(excludedExtensions, normalized.slice(dot)))
                return true;
            for (const pattern of namePatterns) {
                if (pattern.test(normalized))
                    return true;
            }
            return false;
        },
    });
}
function compileWorkspaceGlobs(patterns) {
    const segmentPatterns = [];
    const pathPatterns = [];
    for (const pattern of patterns) {
        const compiled = compileGlob(pattern);
        // Unsupported patterns cannot reach a parsed policy; a hand-built one just loses the rule
        // rather than throwing inside a scan.
        if (!compiled)
            continue;
        if (!pattern.includes('/')) {
            segmentPatterns.push(compiled);
            continue;
        }
        pathPatterns.push(compiled);
        // `docs/**` also excludes `docs` itself, which is what lets the scanner prune the subtree
        // instead of walking it. `docs/*` deliberately does not: it only covers direct children.
        const directoryPattern = subtreeDirectoryPattern(pattern);
        const compiledDirectory = directoryPattern ? compileGlob(directoryPattern) : undefined;
        if (compiledDirectory)
            pathPatterns.push(compiledDirectory);
    }
    return { segmentPatterns, pathPatterns };
}
function normalizeRelativePath(path) {
    if (typeof path !== 'string' || path.length === 0 || path.length > MAX_GLOB_MATCH_INPUT_LENGTH) {
        return undefined;
    }
    const normalized = path
        .replaceAll('\\', '/')
        .replace(/\/{2,}/gu, '/')
        .replace(/^\.\//u, '')
        .replace(/^\/+|\/+$/gu, '');
    return normalized.length > 0 ? normalized : undefined;
}
function toLookup(values) {
    const lookup = Object.create(null);
    for (const value of values)
        lookup[value] = true;
    return lookup;
}
//# sourceMappingURL=matcher.js.map