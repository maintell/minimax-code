/** Name shown to users and the model for the built-in default space. */
export const DEFAULT_SPACE_NAME = 'Bunny 的空间';
export function spaceDisplayName(space) {
    return space.id === 'default' ? DEFAULT_SPACE_NAME : space.name;
}
//# sourceMappingURL=space-name.js.map