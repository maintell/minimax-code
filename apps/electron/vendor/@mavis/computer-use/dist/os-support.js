import { release } from 'node:os';
import { ComputerUseError } from './contracts.js';
/** The standalone macOS component declares LSMinimumSystemVersion 13.0, which is Darwin 22. */
const MIN_DARWIN_MAJOR = 22;
/**
 * Whether this OS can launch the standalone component. Only macOS has a known lower bound;
 * an unparsable kernel release is treated as supported so the component launch decides.
 */
export function isComputerUseOsSupported(platform = process.platform, kernelRelease = release()) {
    if (platform !== 'darwin')
        return true;
    const major = Number.parseInt(kernelRelease, 10);
    return !Number.isSafeInteger(major) || major >= MIN_DARWIN_MAJOR;
}
export function assertComputerUseOsSupported() {
    if (!isComputerUseOsSupported())
        throw new ComputerUseError('computer_os_version_unsupported', 'MiniMax Computer Use requires macOS 13 or later.');
}
//# sourceMappingURL=os-support.js.map