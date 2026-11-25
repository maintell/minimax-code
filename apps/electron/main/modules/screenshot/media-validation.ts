export function validateCaptureBytes(bytes, mime) {
    if (bytes.length < 16 || bytes.length > 256 * 1024 * 1024) {
        throw new Error('Capture size must be between 16 bytes and 256 MB');
    }
    if (mime === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
        return 'png';
    }
    if (mime === 'video/mp4' && bytes.toString('ascii', 4, 8) === 'ftyp') {
        const size = bytes.readUInt32BE(0);
        if (size >= 16 &&
            size <= bytes.length &&
            /^(isom|iso[2-9]|mp4[12]|avc1)$/.test(bytes.toString('ascii', 8, 12))) {
            return 'mp4';
        }
    }
    throw new Error('Capture data does not match PNG or MP4');
}
