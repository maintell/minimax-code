import { posix } from "node:path";
import jszip from "jszip";
import yauzl from "yauzl";
import { SaxesParser } from "saxes";
import { PPTX_PREVIEW_LIMITS_V1 } from "@mavis/shared/document-preview";
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const invalid = () => new Error('unsupported_package_feature');
function parse(xml) {
    if (xml.length > PPTX_PREVIEW_LIMITS_V1.maxEntryUncompressedBytes)
        throw invalid();
    const stack = [];
    let root;
    let count = 0;
    const parser = new SaxesParser({ xmlns: true });
    parser.on('doctype', () => {
        throw invalid();
    });
    parser.on('opentag', (tag) => {
        if (++count > PPTX_PREVIEW_LIMITS_V1.maxSlideNodes || stack.length > 128)
            throw invalid();
        const node = {
            name: tag.name,
            local: tag.local,
            uri: tag.uri,
            attrs: Object.fromEntries(Object.values(tag.attributes).map((attr) => [
                attr.uri ? `{${attr.uri}}${attr.local}` : attr.local,
                attr.value,
            ])),
            start: xml.lastIndexOf('<', parser.position - 1),
            end: parser.position,
            children: [],
        };
        if (stack.length)
            stack[stack.length - 1].children.push(node);
        else
            root = node;
        stack.push(node);
    });
    parser.on('closetag', () => {
        stack.pop().end = parser.position;
    });
    parser.write(xml).close();
    if (!root)
        throw invalid();
    return root;
}
function descendants(node, local) {
    return node.children.flatMap((child) => [
        ...(child.local === local ? [child] : []),
        ...descendants(child, local),
    ]);
}
function append(xml, node, content) {
    const raw = xml.slice(node.start, node.end);
    const updated = raw.endsWith('/>')
        ? `${raw.slice(0, -2)}>${content}</${node.name}>`
        : `${raw.slice(0, raw.lastIndexOf('</'))}${content}${raw.slice(raw.lastIndexOf('</'))}`;
    return xml.slice(0, node.start) + updated + xml.slice(node.end);
}
function escapeXml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
function relationshipPart(part) {
    return posix.join(posix.dirname(part), '_rels', `${posix.basename(part)}.rels`);
}
function targetPart(from, target) {
    if (!target || /[\\?#\u0000]/u.test(target) || /^[a-z]+:/iu.test(target))
        throw invalid();
    const result = posix.normalize(target.startsWith('/') ? target.slice(1) : posix.join(posix.dirname(from), target));
    if (result.startsWith('../') || result === '..')
        throw invalid();
    return result;
}
async function xmlPart(zip, part) {
    const entry = zip.file(part);
    if (!entry)
        throw invalid();
    return entry.async('string');
}
async function rels(zip, part) {
    const xml = zip.file(relationshipPart(part))
        ? await xmlPart(zip, relationshipPart(part))
        : `<Relationships xmlns="${PKG}"/>`;
    const root = parse(xml);
    if (root.local !== 'Relationships' || root.uri !== PKG)
        throw invalid();
    const rows = root.children.filter((child) => child.local === 'Relationship' && child.uri === PKG);
    if (new Set(rows.map((row) => row.attrs.Id)).size !== rows.length)
        throw invalid();
    return { xml, root, rows };
}
/** Validate central-directory budgets before JSZip is allowed to inflate anything. */
function validateArchive(bytes) {
    if (bytes.length > PPTX_PREVIEW_LIMITS_V1.maxInputBytes)
        return Promise.reject(invalid());
    return new Promise((resolve, reject) => {
        yauzl.fromBuffer(bytes, { lazyEntries: true, strictFileNames: true }, (error, zip) => {
            if (error || !zip) {
                reject(invalid());
                return;
            }
            let total = 0;
            const names = new Set();
            const fail = () => {
                zip.close();
                reject(invalid());
            };
            zip.on('error', fail);
            zip.on('entry', (entry) => {
                total += entry.uncompressedSize;
                if (names.has(entry.fileName) ||
                    names.size >= PPTX_PREVIEW_LIMITS_V1.maxEntries ||
                    entry.isEncrypted() ||
                    entry.uncompressedSize > PPTX_PREVIEW_LIMITS_V1.maxEntryUncompressedBytes ||
                    total > PPTX_PREVIEW_LIMITS_V1.maxTotalUncompressedBytes ||
                    entry.fileName.startsWith('_xmlsignatures/')) {
                    fail();
                    return;
                }
                names.add(entry.fileName);
                zip.readEntry();
            });
            zip.on('end', () => {
                zip.close();
                resolve();
            });
            zip.readEntry();
        });
    });
}
function bodyXml(text, p, a, retained = '') {
    return `<p:txBody xmlns:p="${p}" xmlns:a="${a}">${retained || '<a:bodyPr/><a:lstStyle/>'}${text
        .split('\n')
        .map((line) => `<a:p><a:r><a:t xml:space="preserve">${escapeXml(line)}</a:t></a:r></a:p>`)
        .join('')}</p:txBody>`;
}
function shapeXml(id, body, p) {
    return `<p:sp xmlns:p="${p}"><p:nvSpPr><p:cNvPr id="${id}" name="Notes"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/>${body}</p:sp>`;
}
/** Only notes body XML (and missing notes relationships/content types) may change. */
export async function updatePptxNotes(bytes, edits) {
    if (!edits.length ||
        edits.length > 100 ||
        new Set(edits.map((edit) => edit.slideIndex)).size !== edits.length)
        throw invalid();
    for (const edit of edits) {
        if (!Number.isSafeInteger(edit.slideIndex) ||
            edit.slideIndex < 0 ||
            typeof edit.text !== 'string' ||
            /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(edit.text) ||
            Buffer.byteLength(edit.text) > 1024 * 1024 ||
            edit.text.split('\n').length > 10000 ||
            edit.text.split('\n').some((line) => Buffer.byteLength(line) > 256 * 1024))
            throw invalid();
    }
    await validateArchive(bytes);
    const zip = await jszip.loadAsync(bytes);
    const presentation = parse(await xmlPart(zip, 'ppt/presentation.xml'));
    const p = presentation.uri;
    if (presentation.local !== 'presentation' ||
        ![P, 'http://purl.oclc.org/ooxml/presentationml/main'].includes(p))
        throw invalid();
    const a = p === P ? A : 'http://purl.oclc.org/ooxml/drawingml/main';
    const r = p === P ? R : 'http://purl.oclc.org/ooxml/officeDocument/relationships';
    const slides = presentation.children
        .filter((node) => node.uri === p && node.local === 'sldIdLst')
        .flatMap((node) => node.children.filter((child) => child.uri === p && child.local === 'sldId'));
    const presentationRels = await rels(zip, 'ppt/presentation.xml');
    const slideParts = slides.map((slide) => {
        const rid = slide.attrs[`{${r}}id`];
        const rel = presentationRels.rows.find((row) => row.attrs.Id === rid && row.attrs.Type === `${r}/slide`);
        if (!rel || rel.attrs.TargetMode === 'External')
            throw invalid();
        return targetPart('ppt/presentation.xml', rel.attrs.Target);
    });
    if (new Set(slideParts).size !== slideParts.length)
        throw invalid();
    const slideRelationships = await Promise.all(slideParts.map((part) => rels(zip, part)));
    const notesOwners = new Map();
    slideRelationships.forEach((relationships, index) => {
        for (const row of relationships.rows) {
            if (row.attrs.Type !== `${r}/notesSlide` || row.attrs.TargetMode === 'External')
                continue;
            const part = targetPart(slideParts[index], row.attrs.Target);
            notesOwners.set(part, (notesOwners.get(part) ?? 0) + 1);
        }
    });
    for (const edit of edits) {
        const slidePart = slideParts[edit.slideIndex];
        if (!slidePart)
            throw invalid();
        const slideRoot = parse(await xmlPart(zip, slidePart));
        if (slideRoot.local !== 'sld' || slideRoot.uri !== p)
            throw invalid();
        const slideRels = slideRelationships[edit.slideIndex];
        const notesRels = slideRels.rows.filter((row) => row.attrs.Type === `${r}/notesSlide`);
        if (notesRels.length > 1 || notesRels[0]?.attrs.TargetMode === 'External')
            throw invalid();
        let notesPart;
        if (notesRels.length) {
            notesPart = targetPart(slidePart, notesRels[0].attrs.Target);
            if (notesOwners.get(notesPart) !== 1)
                throw invalid();
            const xml = await xmlPart(zip, notesPart);
            const root = parse(xml);
            if (root.local !== 'notes' || root.uri !== p)
                throw invalid();
            const bodies = descendants(root, 'sp').filter((sp) => descendants(sp, 'ph').some((ph) => ph.uri === p && ph.attrs.type === 'body'));
            if (bodies.length > 1)
                throw invalid();
            const textBodies = bodies[0]?.children.filter((child) => child.local === 'txBody' && child.uri === p) ?? [];
            if (textBodies.length > 1)
                throw invalid();
            const textBody = textBodies[0];
            if (textBody) {
                const retained = textBody.children
                    .filter((child) => ['bodyPr', 'lstStyle'].includes(child.local))
                    .map((child) => xml.slice(child.start, child.end))
                    .join('');
                zip.file(notesPart, xml.slice(0, textBody.start) +
                    bodyXml(edit.text, p, a, retained) +
                    xml.slice(textBody.end));
            }
            else if (bodies[0]) {
                zip.file(notesPart, append(xml, bodies[0], bodyXml(edit.text, p, a)));
            }
            else {
                const tree = descendants(root, 'spTree')[0];
                if (!tree)
                    throw invalid();
                const id = Math.max(1, ...descendants(root, 'cNvPr').map((node) => Number(node.attrs.id) || 0)) + 1;
                zip.file(notesPart, append(xml, tree, shapeXml(id, bodyXml(edit.text, p, a), p)));
            }
        }
        else {
            let index = 1;
            while (zip.file(`ppt/notesSlides/notesSlide${index}.xml`) ||
                zip.file(relationshipPart(`ppt/notesSlides/notesSlide${index}.xml`)))
                index += 1;
            notesPart = `ppt/notesSlides/notesSlide${index}.xml`;
            const ids = new Set(slideRels.rows.map((row) => row.attrs.Id));
            let relId = 1;
            while (ids.has(`rId${relId}`))
                relId += 1;
            zip.file(relationshipPart(slidePart), append(slideRels.xml, slideRels.root, `<Relationship xmlns="${PKG}" Id="rId${relId}" Type="${r}/notesSlide" Target="${escapeXml(posix.relative(posix.dirname(slidePart), notesPart))}"/>`));
            zip.file(notesPart, `<p:notes xmlns:p="${p}" xmlns:a="${a}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapeXml(2, bodyXml(edit.text, p, a), p)}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`);
            const master = presentationRels.rows.find((row) => row.attrs.Type === `${r}/notesMaster` && row.attrs.TargetMode !== 'External');
            zip.file(relationshipPart(notesPart), `<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${r}/slide" Target="${escapeXml(posix.relative(posix.dirname(notesPart), slidePart))}"/>${master ? `<Relationship Id="rId2" Type="${r}/notesMaster" Target="${escapeXml(posix.relative(posix.dirname(notesPart), targetPart('ppt/presentation.xml', master.attrs.Target)))}"/>` : ''}</Relationships>`);
            const contentTypes = await xmlPart(zip, '[Content_Types].xml');
            const root = parse(contentTypes);
            if (root.uri !== CT || root.local !== 'Types')
                throw invalid();
            zip.file('[Content_Types].xml', append(contentTypes, root, `<Override xmlns="${CT}" PartName="/${notesPart}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`));
        }
        // Ensure the modified XML is well formed before returning any bytes.
        parse(await xmlPart(zip, notesPart));
    }
    const output = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    await validateArchive(output);
    return output;
}
