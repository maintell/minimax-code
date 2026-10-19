import { ProcessTerminal, setKeybindings, TUI } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../core/keybindings.js";
import { ExtensionInputComponent } from "../modes/interactive/components/extension-input.js";
import { ExtensionSelectorComponent } from "../modes/interactive/components/extension-selector.js";
import { initTheme } from "../modes/interactive/theme/theme.js";
function createStartupTui(settingsManager) {
    initTheme(settingsManager.getTheme());
    setKeybindings(KeybindingsManager.create());
    const ui = new TUI(new ProcessTerminal(), settingsManager.getShowHardwareCursor());
    ui.setClearOnShrink(settingsManager.getClearOnShrink());
    return ui;
}
async function clearStartupTui(ui) {
    ui.clear();
    ui.requestRender();
    await new Promise((resolve) => setTimeout(resolve, 25));
}
export async function showStartupSelector(settingsManager, title, options) {
    return new Promise((resolve) => {
        const ui = createStartupTui(settingsManager);
        let settled = false;
        const finish = async (result) => {
            if (settled) {
                return;
            }
            settled = true;
            await clearStartupTui(ui);
            ui.stop();
            resolve(result);
        };
        const selector = new ExtensionSelectorComponent(title, options.map((option) => option.label), (option) => void finish(options.find((entry) => entry.label === option)?.value), () => void finish(undefined), { tui: ui });
        ui.addChild(selector);
        ui.setFocus(selector);
        ui.start();
    });
}
export async function showStartupInput(settingsManager, title, placeholder) {
    return new Promise((resolve) => {
        const ui = createStartupTui(settingsManager);
        let settled = false;
        const finish = async (result) => {
            if (settled) {
                return;
            }
            settled = true;
            input.dispose();
            await clearStartupTui(ui);
            ui.stop();
            resolve(result);
        };
        const input = new ExtensionInputComponent(title, placeholder, (value) => void finish(value), () => void finish(undefined), {
            tui: ui,
        });
        ui.addChild(input);
        ui.setFocus(input);
        ui.start();
    });
}
//# sourceMappingURL=startup-ui.js.map