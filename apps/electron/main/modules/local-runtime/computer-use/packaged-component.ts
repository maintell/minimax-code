import { prepareInstalledPackagedComponent } from "@mavis/computer-use";
import path from "node:path";
import { readDesktopDevelopmentComponent, packagedComponentRelease } from "./component-release";
/** All Desktop permission helpers and execution resolve the same component. */
export async function prepareDesktopComputerUseComponent(dataDir) {
    const development = readDesktopDevelopmentComponent();
    return {
        trustedInstalledComponent: await prepareInstalledPackagedComponent({
            dataDir,
            packagedRoot: development?.packagedRoot ?? path.join(process.resourcesPath, 'resources', 'computer-use'),
            releaseToken: development?.releaseToken ?? packagedComponentRelease,
        }),
    };
}
