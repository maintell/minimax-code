/** `@minimax/mcode-plugin-extension/jsx-dev-runtime`: the development build entry of the JSX runtime. */
import { Fragment, jsx, jsxs } from './jsx-runtime.js';
export { Fragment, jsx, jsxs };
/** Development build entry; source location arguments are ignored. */
export function jsxDEV(type, props, key) {
    return jsx(type, props, key);
}
//# sourceMappingURL=jsx-dev-runtime.js.map