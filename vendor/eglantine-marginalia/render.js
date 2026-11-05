// A garden at one moment of the day, as one SVG.
import { num, prefix, ribbon, smoothstep } from "./geometry.js";
import { stageAt, stemShown } from "./grow.js";
import { inkRef } from "./inks.js";
import { paintShapes, Sheet, washFilter } from "./paint.js";
import { createRng } from "./random.js";
/** The foot lies under the stems. */
const FOOT_LAYER = 1.8;
const REST_LAYER = 2.6, VISITOR_LAYER = 6;
function motifShapes(item, moment) {
    const stage = stageAt(item, moment.t, moment.fullness);
    if (stage === null)
        return null;
    return item.draw(createRng(item.seed), item.size, stage);
}
const ATTRIBUTE_ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;" };
const group = (at, angle, body) => `<g transform="translate(${num(at[0])} ${num(at[1])}) rotate(${num(angle - 90)})">${body}</g>`;
export function renderGarden(garden, moment, options) {
    const sheet = new Sheet(options.id);
    const layers = new Map();
    const add = (layer, body) => { layers.set(layer, (layers.get(layer) ?? "") + body); };
    if (garden.foot) {
        const column = { width: garden.width, height: garden.height };
        add(FOOT_LAYER, paintShapes(garden.foot.draw(createRng(garden.foot.seed), column, moment.t, moment.fullness), options.manner, sheet));
    }
    for (const item of garden.items) {
        if (item.kind === "stem") {
            const shown = stemShown(item, moment.t);
            if (shown <= 0)
                continue;
            const points = prefix(item.points, shown);
            if (points.length < 2)
                continue;
            // While it grows, the stem is as thick as its grown length allows and comes to a point.
            const tip = item.w0 + (item.w1 - item.w0) * shown;
            const width = (u) => (item.w0 + (tip - item.w0) * u) * (shown < 1 ? 1 - 0.8 * smoothstep(0.8, 1, u) : 1);
            const shapes = garden.stemInk
                ? garden.stemInk(createRng(Math.imul(garden.seed, 2654435761) + item.order), points, width, item.main)
                : [{ type: "solid", outline: ribbon(points, width) }];
            add(item.layer, paintShapes(shapes, options.manner, sheet));
            continue;
        }
        const shapes = motifShapes(item, moment);
        if (shapes)
            add(item.layer, group(item.at, item.angle, paintShapes(shapes, options.manner, sheet)));
    }
    const guest = garden.guest;
    if (guest && options.guestFigure && moment.t >= guest.born) {
        const mask = sheet.id("guest");
        const figure = options.guestFigure.replace(/[&<>"']/gu, character => ATTRIBUTE_ENTITIES[character]);
        const box = `x="${num(-guest.width / 2)}" y="${num(-guest.height / 2)}" width="${num(guest.width)}" height="${num(guest.height)}"`;
        // mask-type as a presentation attribute, not a style: pages with a strict content policy refuse inline styles.
        sheet.defs.push(`<mask id="${mask}" maskUnits="userSpaceOnUse" ${box} mask-type="alpha"><image href="${figure}" ${box} preserveAspectRatio="none"/></mask>`);
        const ink = options.manner === "taille-douce" ? `fill="${inkRef("ink")}"` : `fill="${inkRef("wash")}" fill-opacity="0.85"`;
        // The page is drawn with y up; the engraving is y down, so it is flipped back, and mirrored to face the plant.
        add(guest.kind === "visitor" ? VISITOR_LAYER : REST_LAYER, `<g transform="translate(${num(guest.at[0])} ${num(guest.at[1])}) rotate(${num(guest.angle)}) scale(${guest.facing} -1)"><rect ${box} ${ink} mask="url(#${mask})"/></g>`);
    }
    const marks = options.decorate?.(garden, sheet) ?? {};
    for (const inlay of marks.inlays ?? [])
        add(inlay.layer, inlay.svg);
    let body = [...layers.entries()].sort(([a], [b]) => a - b).map(([, text]) => text).join("");
    if (options.manner === "lavis")
        body = `<g filter="url(#${washFilter(sheet, garden.seed)})">${body}</g>`;
    body = (marks.under ?? "") + body + (marks.over ?? "");
    const w = num(garden.width), h = num(garden.height);
    return `<svg xmlns="http://www.w3.org/2000/svg" class="eglantine" viewBox="0 0 ${w} ${h}" width="${num(garden.width * options.scale)}" height="${num(garden.height * options.scale)}" role="img">`
        + `<defs>${sheet.defs.join("")}</defs><g transform="translate(0 ${h}) scale(1 -1)">${body}</g></svg>`;
}
