/**
 * `@minimax/mcode-plugin-extension/jsx-runtime`, the automatic JSX runtime
 * (`jsxImportSource: '@minimax/mcode-plugin-extension'`). Produces plain data nodes; function props
 * become `{ plugin, handle }` through the host's registrar.
 */
import { defaultElementRuntime } from '../element-runtime.js';
export const { jsx, jsxs, Fragment } = defaultElementRuntime;
//# sourceMappingURL=jsx-runtime.js.map