import { normalizeDesktopTypographySnapshot } from "@mavis/shared/desktop-typography";
export { DEFAULT_DESKTOP_TYPOGRAPHY } from "@mavis/shared/desktop-typography";

export function getDesktopTypographySnapshot(config) {
    return normalizeDesktopTypographySnapshot(config);
}
export function desktopTypographyEquals(left, right) {
    return left.uiBaseFontSize === right.uiBaseFontSize && left.codeFontSize === right.codeFontSize;
}
