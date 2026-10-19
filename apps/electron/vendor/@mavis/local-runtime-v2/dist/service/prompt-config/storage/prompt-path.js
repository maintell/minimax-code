import { relative, resolve, sep } from 'node:path';
import { PromptConfigError } from '../errors.js';
export function assertPromptRelativePath(path) {
    if (!path ||
        path.includes('\0') ||
        path.includes('\\') ||
        path.startsWith('/') ||
        path.endsWith('/')) {
        throw new PromptConfigError('PROMPT_PATH_INVALID', 'Prompt path is invalid');
    }
    const segments = path.split('/');
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
        throw new PromptConfigError('PROMPT_PATH_INVALID', 'Prompt path is invalid');
    }
}
export function promptPathWithin(root, relativePath) {
    assertPromptRelativePath(relativePath);
    const resolvedRoot = resolve(root);
    const target = resolve(resolvedRoot, ...relativePath.split('/'));
    const pathFromRoot = relative(resolvedRoot, target);
    if (!pathFromRoot || pathFromRoot.startsWith(`..${sep}`) || pathFromRoot === '..') {
        throw new PromptConfigError('PROMPT_PATH_INVALID', 'Prompt path escapes its root');
    }
    return target;
}
export function promptCacheDirectoryName(cacheId) {
    const value = cacheId.startsWith('sha256:') ? cacheId.slice('sha256:'.length) : cacheId;
    if (!/^[a-f0-9]{64}$/u.test(value)) {
        throw new PromptConfigError('PROMPT_CACHE_ID_INVALID', 'Prompt cache identifier is invalid');
    }
    return value;
}
export function assertPromptScope(scopeId) {
    if (!/^[A-Za-z0-9_-]{1,160}$/u.test(scopeId)) {
        throw new PromptConfigError('PROMPT_SCOPE_INVALID', 'Prompt storage scope is invalid');
    }
}
//# sourceMappingURL=prompt-path.js.map