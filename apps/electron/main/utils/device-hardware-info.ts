import os from "node:os";
import { app } from "electron";
import { readDeviceManufacturer } from "./device-manufacturer.js";
const CPU_ARCH_ALIASES = {
    aarch64: 'arm64',
    x86_64: 'x64',
    amd64: 'x64',
    i386: 'ia32',
    i686: 'ia32',
    armv7l: 'arm',
};
export async function readDeviceHardwareInfo() {
    const info = {};
    try {
        // Electron detects Rosetta and Windows ARM emulation even for x64 builds.
        const machine = app.runningUnderARM64Translation ? 'arm64' : os.machine().trim().toLowerCase();
        if (machine)
            info.cpu_arch = CPU_ARCH_ALIASES[machine] ?? machine;
    }
    catch {
        // Do not substitute the process architecture for unavailable hardware information.
    }
    try {
        const model = os.cpus()[0]?.model.trim();
        if (model)
            info.cpu_model = model;
    }
    catch {
        // CPU information can be unavailable in restricted environments.
    }
    const manufacturer = await readDeviceManufacturer();
    if (manufacturer)
        info.manufacturer = manufacturer;
    return info;
}
