/**
 * `@minimax/mcode-plugin-extension/ui`: the element catalog. Elements are value imports: the
 * automatic JSX runtime only injects `jsx / jsxs`, so `<Box>` must be imported from here. The realm
 * serves the same names bound to its own handle registrar.
 */
import { defaultElementRuntime } from '../element-runtime.js';
export const { Box, Text, Markdown, Code, Tag, Button, Input, Select, Switch, Spinner } = defaultElementRuntime.ui;
export { Icon, ICON_NAMES } from '@mavis/shared/plugin-extension';
//# sourceMappingURL=ui.js.map