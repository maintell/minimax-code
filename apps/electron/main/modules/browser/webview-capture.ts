import { nativeImage } from "electron";
/** Guest captures omit the host element's opaque canvas. Match native page captures without changing page CSS. */
export function opaqueWebviewCapture(image) {
    if (image.isEmpty())
        return image;
    const { width, height } = image.getSize();
    const pixels = image.toBitmap({ scaleFactor: 1 });
    if (pixels.length !== width * height * 4)
        throw new Error('BROWSER_CAPTURE_INVALID_BITMAP');
    let changed = false;
    // Electron uses premultiplied BGRA on supported macOS/Windows targets.
    // White compositing treats RGB/BGR identically and keeps opaque pixels exact.
    for (let offset = 0; offset < pixels.length; offset += 4) {
        const alpha = pixels[offset + 3];
        if (alpha === 255)
            continue;
        changed = true;
        const white = 255 - alpha;
        pixels[offset] = Math.min(255, pixels[offset] + white);
        pixels[offset + 1] = Math.min(255, pixels[offset + 1] + white);
        pixels[offset + 2] = Math.min(255, pixels[offset + 2] + white);
        pixels[offset + 3] = 255;
    }
    return changed ? nativeImage.createFromBitmap(pixels, { width, height, scaleFactor: 1 }) : image;
}
