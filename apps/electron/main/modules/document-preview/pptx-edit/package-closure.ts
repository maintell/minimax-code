import { posix } from "node:path";
import { SaxesParser } from "saxes";
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
/** Validate the final OPC graph before the atomic writer receives any bytes. */
export async function validatePptPackageClosure(zip) {
    const contentTypes = zip.file('[Content_Types].xml');
    if (!contentTypes)
        throw new Error('invalid_patch_plan');
    const defaults = new Map();
    const overrides = new Map();
    const parse = (xml, visit) => {
        const parser = new SaxesParser({ xmlns: true });
        parser.on('doctype', () => {
            throw new Error('invalid_patch_plan');
        });
        parser.on('opentag', visit);
        parser.write(xml).close();
    };
    parse(await contentTypes.async('string'), (tag) => {
        if (tag.uri !== CT || !['Default', 'Override'].includes(tag.local))
            return;
        const attrs = Object.fromEntries(Object.values(tag.attributes).map((attr) => [attr.local, attr.value]));
        const map = tag.local === 'Default' ? defaults : overrides;
        const key = String(attrs[tag.local === 'Default' ? 'Extension' : 'PartName']);
        if (!key || map.has(key) || !attrs.ContentType)
            throw new Error('invalid_patch_plan');
        map.set(key, String(attrs.ContentType));
    });
    for (const [name, entry] of Object.entries(zip.files)) {
        if (entry.dir || name === '[Content_Types].xml')
            continue;
        if (!overrides.has(`/${name}`) && !defaults.has(name.slice(name.lastIndexOf('.') + 1)))
            throw new Error('invalid_patch_plan');
        if (!name.endsWith('.rels'))
            continue;
        const source = name === '_rels/.rels' ? '' : name.replace(/(^|\/)_rels\//u, '$1').slice(0, -5);
        if (source && !zip.file(source))
            throw new Error('invalid_patch_plan');
        const ids = new Set();
        parse(await entry.async('string'), (tag) => {
            if (tag.uri !== PKG || tag.local !== 'Relationship')
                return;
            const attrs = Object.fromEntries(Object.values(tag.attributes).map((attr) => [attr.local, attr.value]));
            const id = String(attrs.Id ?? '');
            if (!id || ids.has(id) || !attrs.Type || !attrs.Target)
                throw new Error('invalid_patch_plan');
            ids.add(id);
            if (attrs.TargetMode === 'External')
                return;
            if (attrs.TargetMode !== undefined && attrs.TargetMode !== 'Internal')
                throw new Error('invalid_patch_plan');
            const raw = String(attrs.Target);
            if (/[\\?#\u0000]/u.test(raw) || /^[a-z]+:/iu.test(raw))
                throw new Error('invalid_patch_plan');
            let target;
            try {
                target = decodeURIComponent(raw);
            }
            catch {
                throw new Error('invalid_patch_plan');
            }
            const resolved = posix.normalize(target.startsWith('/') ? target.slice(1) : posix.join(posix.dirname(source), target));
            if (resolved === '..' || resolved.startsWith('../') || !zip.file(resolved))
                throw new Error('invalid_patch_plan');
        });
    }
}
