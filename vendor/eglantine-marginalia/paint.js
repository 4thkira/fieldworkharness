// Two manners for the same shapes. Taille-douce is the copperplate: paper-white forms with a fine
// outline, shade cut as hatching, stems in solid ink. Lavis is the wash: soot-brown bistre laid in
// transparent layers, darker in the shade and pooled at the edges, veins lifted out in paper.
// Colours are CSS custom properties with fallbacks (see inks.ts), so a page's stylesheet can retint them.
import { fine, num, polyPath, smoothPath } from "./geometry.js";
import { inkRef } from "./inks.js";
const idPart = (value) => value.replace(/[^A-Za-z0-9-]/gu, character => `_${character.codePointAt(0).toString(16)}_`);
/** Collects clip paths and filters for one SVG; ids carry a prefix so several gardens can share a page. */
export class Sheet {
    prefix;
    defs = [];
    #next = 0;
    #prefix;
    constructor(prefix) {
        this.prefix = prefix;
        this.#prefix = idPart(prefix);
    }
    id(kind) { this.#next += 1; return `${this.#prefix}-${idPart(kind)}${this.#next}`; }
}
const INK = inkRef("ink"), PAPER = inkRef("paper"), ACCENT = inkRef("accent"), WASH = inkRef("wash");
const rings = (list) => list.map(ring => polyPath(ring, true)).join("");
const cuts = (list) => list.map(points => polyPath(points)).join("");
const curves = (list) => list.map(points => smoothPath(points)).join("");
function dotsPath(points, radius) {
    const r = fine(radius), d = fine(radius * 2);
    return points.map(([x, y]) => `M${num(x - radius)} ${num(y)}a${r} ${r} 0 1 0 ${d} 0a${r} ${r} 0 1 0 -${d} 0`).join("");
}
/**
 * A body's outline defined once in the sheet's defs, so its fill, clip and stroke reuse it instead of
 * repeating its path data, which is most of a garden's weight. The definition carries no paint of its own,
 * since a `<use>` keeps the attributes of what it copies.
 */
function outlineOf(body, sheet) {
    const id = sheet.id("o");
    sheet.defs.push(`<path id="${id}" d="${smoothPath(body.outline, true, 0.9)}"/>`);
    return id;
}
function engraveBody(body, sheet) {
    // With nothing cut between its fill and its outline, a body is one path painting both, in that order.
    if (body.tone === "accent")
        return `<path d="${smoothPath(body.outline, true, 0.9)}" fill="${ACCENT}" fill-opacity="0.82" stroke="${INK}" stroke-width="0.011"/>`;
    const stroke = ` stroke="${INK}" stroke-width="0.012" stroke-linejoin="round"`;
    let out;
    if (body.grain.length === 0) {
        out = `<path d="${smoothPath(body.outline, true, 0.9)}" fill="${PAPER}"${stroke}/>`;
    }
    else {
        const outline = outlineOf(body, sheet);
        const clip = sheet.id("c");
        sheet.defs.push(`<clipPath id="${clip}"><use href="#${outline}"/></clipPath>`);
        let hatching = `<path d="${cuts(body.grain)}" fill="none" stroke="${INK}" stroke-width="${fine(0.006 + 0.007 * body.weight)}" stroke-linecap="round"/>`;
        if (body.shadow.length > 0) {
            const shade = sheet.id("s");
            sheet.defs.push(`<clipPath id="${shade}"><path d="${rings(body.shadow)}" clip-rule="evenodd"/></clipPath>`);
            hatching = `<g clip-path="url(#${shade})">${hatching}</g>`;
        }
        out = `<use href="#${outline}" fill="${PAPER}"/><g clip-path="url(#${clip})">${hatching}</g><use href="#${outline}" fill="none"${stroke}/>`;
    }
    if (body.veins.length > 0)
        out += `<path d="${curves(body.veins)}" fill="none" stroke="${INK}" stroke-width="0.008" stroke-linecap="round"/>`;
    return out;
}
/** A stable 0..1 value from a form's first point, so each wash lies a little lighter or darker. */
function variance(body) {
    const [x = 0, y = 0] = body.outline[0] ?? [];
    const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return v - Math.floor(v);
}
function washBody(body, sheet) {
    if (body.tone === "accent")
        return `<path d="${smoothPath(body.outline, true, 0.9)}" fill="${ACCENT}" fill-opacity="0.55"/>`;
    const depth = 0.75 + 0.5 * variance(body);
    const fill = ` fill="${WASH}" fill-opacity="${num((0.14 + 0.22 * body.weight) * depth)}"`;
    const edge = ` stroke="${WASH}" stroke-opacity="0.38" stroke-width="0.022" stroke-linejoin="round"`;
    let out;
    // With no shadow laid between its wash and its pooled edge, a body is one path painting both, in that order.
    if (body.shadow.length === 0) {
        out = `<path d="${smoothPath(body.outline, true, 0.9)}"${fill}${edge}/>`;
    }
    else {
        const outline = outlineOf(body, sheet);
        const clip = sheet.id("c");
        sheet.defs.push(`<clipPath id="${clip}"><use href="#${outline}"/></clipPath>`);
        out = `<use href="#${outline}"${fill}/>`
            + `<g clip-path="url(#${clip})"><path d="${rings(body.shadow)}" fill="${WASH}" fill-opacity="${num(0.18 + 0.2 * body.weight)}" fill-rule="evenodd"/></g>`
            + `<use href="#${outline}" fill="none"${edge}/>`;
    }
    if (body.veins.length > 0)
        out += `<path d="${curves(body.veins)}" fill="none" stroke="${PAPER}" stroke-opacity="0.75" stroke-width="0.014" stroke-linecap="round"/>`;
    return out;
}
export function paintShapes(shapes, manner, sheet) {
    let out = "";
    // Neighbouring paths with the same attributes share one group that carries them, since the attributes
    // are most of a stroke's markup. A group with no opacity or filter of its own paints its children
    // exactly as it would paint them alone, so overlapping washes still darken where they cross.
    let run = [], runAttributes = "";
    const flush = () => {
        if (run.length === 1)
            out += `<path d="${run[0]}"${runAttributes}/>`;
        else if (run.length > 1)
            out += `<g${runAttributes}>${run.map(d => `<path d="${d}"/>`).join("")}</g>`;
        run = [];
    };
    const path = (d, attributes) => {
        if (attributes !== runAttributes) {
            flush();
            runAttributes = attributes;
        }
        run.push(d);
    };
    for (const shape of shapes) {
        switch (shape.type) {
            case "body":
                flush();
                out += manner === "taille-douce" ? engraveBody(shape, sheet) : washBody(shape, sheet);
                break;
            case "solid": {
                const colour = shape.tone === "accent" ? ACCENT : manner === "taille-douce" ? INK : WASH;
                const opacity = manner === "taille-douce" || shape.tone === "accent" ? "" : ` fill-opacity="0.82"`;
                path(shape.smooth === false ? polyPath(shape.outline, true) : smoothPath(shape.outline, true, 0.9), ` fill="${colour}"${opacity}`);
                break;
            }
            case "line": {
                const colour = shape.tone === "accent" ? ACCENT : manner === "taille-douce" ? INK : WASH;
                const opacity = manner === "lavis" && shape.tone !== "accent" ? ` stroke-opacity="0.85"` : "";
                path(shape.smooth === false ? polyPath(shape.points) : smoothPath(shape.points), ` fill="none" stroke="${colour}"${opacity} stroke-width="${fine(shape.width)}" stroke-linecap="round" stroke-linejoin="round"`);
                break;
            }
            case "dots": {
                const colour = shape.tone === "accent" ? ACCENT : manner === "taille-douce" ? INK : WASH;
                path(dotsPath(shape.points, shape.radius), ` fill="${colour}"`);
                break;
            }
        }
    }
    flush();
    return out;
}
/** The wash's soft, slightly bled edge: one displacement filter per sheet. */
export function washFilter(sheet, seed) {
    const id = sheet.id("bleed");
    sheet.defs.push(`<filter id="${id}" x="-5%" y="-5%" width="110%" height="110%"><feTurbulence type="fractalNoise" baseFrequency="3.2" numOctaves="2" seed="${seed % 1000}"/><feDisplacementMap in="SourceGraphic" scale="0.05" xChannelSelector="R" yChannelSelector="G"/></filter>`);
    return id;
}
