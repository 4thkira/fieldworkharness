// The winter garden of nivôse and the bee days, which have no plant: bare dormant twigs with their buds
// and a few dried leaves, and the day's material engraved as a specimen set in the forks of the twigs.
// Ink cannot show colour, so each material is told by its habit (lump, nodule, slabs, crystals, cubes,
// needles, ingot, beads, clod, comb) and its texture (vesicles, grains, veins, bedding, ruled metal,
// fibres, straw, cracks, drops, cells). At the end of the day the specimens take the hoarfrost: a mineral
// has no seed, and the one thing a winter day ripens is cold; a rime fringe also reads on every material.
import { LAYER, numberOf, textOf } from "../form.js";
import { clamp, lerp, ribbon, sample, smoothstep, unit } from "../geometry.js";
import { HATCH, line, side, turn, turnShape } from "../kit.js";
import { fbm1 } from "../random.js";
import { bladeBody } from "../shapes.js";
const TAU = Math.PI * 2;
/** A specimen stands level (its frame's +y is up), lit from the upper left. */
const LIGHT = unit(-0.6, 0.8);
// ---------------------------------------------------------------- plane helpers
function inside([x, y], poly) {
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
        const [xi, yi] = poly[i], [xj, yj] = poly[j];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi)
            hit = !hit;
    }
    return hit;
}
/** The parts of a polyline whose points pass a test, as separate runs. */
function runsWhere(points, keep) {
    const runs = [];
    let run = [];
    for (const p of points) {
        if (keep(p))
            run.push(p);
        else {
            if (run.length > 1)
                runs.push(run);
            run = [];
        }
    }
    if (run.length > 1)
        runs.push(run);
    return runs;
}
/** The parts of a polyline that lie inside a polygon: veins and cracks stop at the specimen's edge. */
const runsInside = (points, poly) => runsWhere(points, p => inside(p, poly));
/** A polygon (or, open, a polyline) resampled so its smoothed outline keeps straight edges and nearly sharp corners. */
function densify(poly, step, closed = true) {
    const out = [];
    poly.forEach((a, index) => {
        if (!closed && index === poly.length - 1)
            return;
        const b = poly[(index + 1) % poly.length];
        const count = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
        for (let k = 0; k < count; k += 1)
            out.push([lerp(a[0], b[0], k / count), lerp(a[1], b[1], k / count)]);
    });
    return out;
}
const centroid = (poly) => [poly.reduce((sum, p) => sum + p[0], 0) / poly.length, poly.reduce((sum, p) => sum + p[1], 0) / poly.length];
const area = (poly) => poly.reduce((sum, p, index) => { const q = poly[(index + 1) % poly.length]; return sum + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;
/** Parallel cuts across a polygon's bounds at `angle`; the painter clips them to the outline. */
function cuts(poly, angle, spacing, gap) {
    const [cx, cy] = centroid(poly);
    const reach = Math.max(...poly.map(p => Math.hypot(p[0] - cx, p[1] - cy))) * 1.1;
    const dx = Math.cos(angle), dy = Math.sin(angle);
    const out = [];
    for (let o = -reach; o <= reach; o += spacing) {
        // A bright band left uncut across a ruled face is the engraver's sign for polished metal.
        if (gap && Math.abs(o / reach - gap.at) < gap.width)
            continue;
        const ox = cx - dy * o, oy = cy + dx * o;
        out.push([[ox - dx * reach, oy - dy * reach], [ox + dx * reach, oy + dy * reach]]);
    }
    return out;
}
/** A sharp ink edge round a polygon, laid over a face whose own outline the painter smooths. */
const edge = (poly, width) => line([...poly, poly[0]], width, false);
/** A flat face of a specimen: paper where lit, cut more closely as it turns from the light. */
function face(poly, shade, angle, step, ruled = false, gap) {
    const grain = shade < 0.12 && !ruled ? [] : cuts(poly, angle, HATCH * (ruled ? 0.95 - 0.5 * shade : 1.35 - 0.85 * shade), gap);
    return { type: "body", outline: densify(poly, step), shadow: [], grain, veins: [], weight: 0.35 + 0.55 * shade };
}
/** The shade of a face whose outer edge runs from a to b round a counter-clockwise outline. */
function shadeOf(a, b, tone) {
    const [nx, ny] = unit(b[1] - a[1], a[0] - b[0]);
    return Math.min(1, Math.max(0, 0.34 - 0.55 * (nx * LIGHT[0] + ny * LIGHT[1]) + (tone - 0.45)));
}
/** A closed outline round a centre at angles from +x, flattened where it would dip below the ground line. */
function blob(centre, rx, ry, k, n, floor = 0) {
    return Array.from({ length: n }, (_, index) => {
        const a = index / n * TAU;
        const r = k(a);
        return [centre[0] + Math.cos(a) * rx * r, Math.max(floor, centre[1] + Math.sin(a) * ry * r)];
    });
}
/** A rounded body shaded by a crescent; `dark` shrinks the lit part, and highlights can be left uncut. */
function rounded(outline, centre, rx, ry, weight, dark, highlights = []) {
    const share = 1.05 - 0.7 * dark;
    const lit = sample(v => [centre[0] + LIGHT[0] * rx * 0.4 + Math.cos(v * TAU) * rx * share, centre[1] + LIGHT[1] * ry * 0.4 + Math.sin(v * TAU) * ry * share], 16);
    const big = Math.max(rx, ry);
    const frame = [[centre[0] - big * 3, centre[1] - big * 3], [centre[0] + big * 3, centre[1] - big * 3], [centre[0] + big * 3, centre[1] + big * 3], [centre[0] - big * 3, centre[1] + big * 3]];
    const box = [[centre[0] - big, centre[1] - big], [centre[0] + big, centre[1] - big], [centre[0] + big, centre[1] + big], [centre[0] - big, centre[1] + big]];
    const spacing = HATCH * (0.9 - 0.45 * dark);
    const grain = cuts(box, Math.atan2(LIGHT[1], LIGHT[0]) + Math.PI / 2 + 0.35, spacing);
    if (dark > 0.6)
        grain.push(...cuts(box, Math.atan2(LIGHT[1], LIGHT[0]) - 0.35, spacing * 1.2));
    return { type: "body", outline, shadow: [frame, dark > 0.75 ? highlights[0] ?? lit : lit, ...highlights.slice(dark > 0.75 ? 1 : 0)], grain, veins: [], weight };
}
const ringAt = (at, rx, ry = rx, n = 8) => sample(v => [at[0] + Math.cos(v * TAU) * rx, at[1] + Math.sin(v * TAU) * ry], n);
/** Points scattered inside a polygon. */
function scatter(rng, poly, count) {
    const xs = poly.map(p => p[0]), ys = poly.map(p => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const out = [];
    for (let attempt = 0; attempt < count * 8 && out.length < count; attempt += 1) {
        const p = [rng.range(x0, x1), rng.range(y0, y1)];
        if (inside(p, poly))
            out.push(p);
    }
    return out;
}
/** The upper edges of an outline, where frost settles: runs whose outward side faces the sky. */
function topsOf(poly) {
    const ccw = area(poly) > 0;
    const runs = [];
    let run = [];
    poly.forEach((a, index) => {
        const b = poly[(index + 1) % poly.length];
        const ny = ccw ? a[0] - b[0] : b[0] - a[0];
        if (ny / (Math.hypot(b[0] - a[0], b[1] - a[1]) || 1) > 0.35) {
            if (run.length === 0)
                run.push(a);
            run.push(b);
        }
        else if (run.length > 0) {
            runs.push(run);
            run = [];
        }
    });
    if (run.length > 0)
        runs.push(run);
    return runs;
}
/** An irregular stone outline on a flat base, counter-clockwise. */
function stoneOutline(rng, w, h, n, jag = 0.12) {
    const phase = rng.range(0, TAU);
    const points = Array.from({ length: n }, (_, index) => {
        const a = phase + index / n * TAU + rng.sym(0.3 * TAU / n);
        const r = 1 - jag + rng.u() * jag * 1.4;
        return { a: ((a % TAU) + TAU) % TAU, p: [Math.cos(a) * w * 0.5 * r, Math.max(0, h * 0.5 + Math.sin(a) * h * 0.5 * r)] };
    });
    return points.sort((x, y) => x.a - y.a).map(entry => entry.p);
}
/** A fractured lump cut into three or four faces round a ridge (granit, lave, houille, marbre, fer, zinc). */
function lump(rng, w, h, m, metal, detail) {
    const rough = m.texture === "vesicles";
    const outline = stoneOutline(rng, w, h, rough ? 11 : 7, rough ? 0.18 : 0.12);
    const ridge = [-w * 0.1 + rng.sym(0.05) * w, h * 0.58];
    const count = outline.length;
    const splits = [0, 1, 2, 3].map(k => Math.floor(k * count / 4 + rng.u() * 0.6));
    const shapes = [];
    const step = Math.max(w, h) / 10;
    splits.forEach((start, k) => {
        const end = k === splits.length - 1 ? splits[0] + count : splits[k + 1];
        const poly = [ridge];
        for (let index = start; index <= end; index += 1)
            poly.push(outline[index % count]);
        const a = outline[start % count], b = outline[end % count];
        const shade = shadeOf(a, b, m.tone);
        const along = Math.atan2(b[1] - a[1], b[0] - a[0]);
        if (metal && m.texture === "spangle") {
            // Zinc breaks in flat crystal spangles, each ruled its own way.
            const mid = [lerp(ridge[0], centroid(poly)[0], 1.6), lerp(ridge[1], centroid(poly)[1], 1.6)];
            const half = Math.floor(poly.length / 2);
            for (const part of [[...poly.slice(0, half + 1), mid], [mid, ...poly.slice(half), poly[0]]]) {
                if (part.length < 3)
                    continue;
                shapes.push(face(part, shade, along + rng.sym(1.2), step, true, { at: rng.sym(0.4), width: 0.12 }));
            }
        }
        else if (metal)
            shapes.push(face(poly, shade, along, step, true, { at: rng.range(-0.3, 0.3), width: 0.14 }));
        else if (shade > 0.6 && m.tone > 0.85) {
            // Coal: the faces turned from the light cut across and across, nearly black but still showing their bedding.
            const dark = face(poly, shade, along + 0.7, step);
            dark.grain.push(...cuts(poly, along - 0.6, HATCH * 0.55));
            shapes.push(dark);
        }
        else
            shapes.push(face(poly, shade, along + 0.7, step));
    });
    const ink = [edge(outline, 0.014), ...splits.map(index => line([ridge, outline[index % count]], 0.008, false))];
    if (detail)
        shapes.push(...surface(rng, outline, m, w, h));
    return { shapes: [...shapes, ...ink], tops: topsOf(outline) };
}
/** Marks laid over a specimen's outline: its texture. */
function surface(rng, outline, m, w, h) {
    const size = Math.max(w, h);
    switch (m.texture) {
        case "vesicles": {
            // Lava's gas holes: dark pits of three sizes, the larger ones rimmed.
            const pits = scatter(rng, outline, 40);
            const rims = pits.slice(0, 9).map(p => ringAt(p, size * 0.05, size * 0.036));
            return [{ type: "dots", points: pits.slice(0, 9), radius: size * 0.032 }, { type: "dots", points: pits.slice(9, 22), radius: size * 0.018 },
                { type: "dots", points: pits.slice(18), radius: size * 0.007 }, ...rims.map(r => line(r, 0.006))];
        }
        case "grains": {
            // Granite's interlocking crystals: dark mica and hornblende filled, feldspar outlined.
            const out = [];
            for (const [index, p] of scatter(rng, outline, 44).entries()) {
                const r = size * rng.range(0.015, 0.035), a = rng.range(0, TAU);
                const grain = [0, 1, 2, 3, 4].map(k => [p[0] + Math.cos(a + k * 1.26 + rng.sym(0.3)) * r * rng.range(0.6, 1.1), p[1] + Math.sin(a + k * 1.26) * r * rng.range(0.6, 1.1)]);
                out.push(index % 3 === 0 ? { type: "solid", outline: grain, smooth: false } : edge(grain, 0.006));
            }
            return out;
        }
        case "veins": {
            // Marble: meandering veins with branches, over a sugary grain.
            const out = [];
            for (let k = 0; k < 3; k += 1) {
                const y0 = h * rng.range(0.15, 0.85), y1 = h * rng.range(0.15, 0.85), phase = rng.range(0, TAU);
                const path = sample(t => [lerp(-w * 0.6, w * 0.6, t), lerp(y0, y1, t) + Math.sin(t * 7 + phase) * h * 0.06 + Math.sin(t * 17) * h * 0.02], 24);
                for (const run of runsInside(path, outline))
                    out.push(line(run, k === 0 ? 0.016 : 0.009));
                const from = path[rng.int(6, 16)];
                for (const run of runsInside(sample(t => [from[0] + t * w * 0.25, from[1] - t * h * 0.25 + Math.sin(t * 9) * h * 0.02], 8), outline))
                    out.push(line(run, 0.005));
            }
            out.push({ type: "dots", points: scatter(rng, outline, 30), radius: size * 0.004 });
            return out;
        }
        case "bedding": {
            // Coal's bedding planes, and the bright cleat across them.
            const out = [];
            for (let y = h * 0.12; y < h; y += h * rng.range(0.1, 0.16)) {
                const path = sample(t => [lerp(-w * 0.6, w * 0.6, t), y + (t - 0.5) * h * 0.12 + Math.sin(t * 5) * h * 0.015], 12);
                for (const run of runsInside(path, outline))
                    out.push(line(run, 0.009));
            }
            return out;
        }
        case "pitted": {
            // Wrought iron's pitted, scaly skin.
            const pits = scatter(rng, outline, 22);
            return [{ type: "dots", points: pits, radius: size * 0.01 }, ...pits.slice(0, 8).map(p => line(sample(t => [p[0] + Math.cos(t * 3) * size * 0.03, p[1] + Math.sin(t * 3) * size * 0.02], 4), 0.006))];
        }
        case "sand": return [{ type: "dots", points: scatter(rng, outline, 90), radius: size * 0.0045 }];
        case "shells": {
            // Limestone's shell fragments: a little coiled shell and a ribbed valve.
            const out = [];
            const [a, b] = scatter(rng, outline.map(p => [p[0] * 0.7, p[1] * 0.8 + h * 0.1]), 2);
            if (a)
                out.push(line(sample(t => { const r = size * 0.07 * (1 - t * 0.85); return [a[0] + Math.cos(t * 14) * r, a[1] + Math.sin(t * 14) * r]; }, 22), 0.007));
            if (b) {
                for (let k = -2; k <= 2; k += 1)
                    out.push(line([b, [b[0] + Math.sin(k * 0.3) * size * 0.08, b[1] + Math.cos(k * 0.3) * size * 0.08]], 0.005));
                out.push(line(sample(t => [b[0] + Math.sin(-0.7 + 1.4 * t) * size * 0.085, b[1] + Math.cos(-0.7 + 1.4 * t) * size * 0.085], 6), 0.007));
            }
            out.push({ type: "dots", points: scatter(rng, outline, 24), radius: size * 0.005 });
            return out;
        }
        default: return [];
    }
}
/** A flint nodule: a pale chalky cortex broken open on a dark glassy face rippled with conchoidal rings. */
function nodule(rng, w, h, m, detail) {
    const phase = rng.range(0, TAU);
    const centre = [0, h * 0.5];
    const outline = blob(centre, w * 0.5, h * 0.5, a => 1 + 0.09 * Math.sin(3 * a + phase) + 0.05 * Math.sin(5 * a), 26);
    const cortex = rounded(outline, centre, w * 0.5, h * 0.5, 0.45, 0.1);
    const shapes = [cortex, { type: "dots", points: scatter(rng, outline, 40), radius: Math.max(w, h) * 0.006 }];
    const at = [w * 0.08, h * 0.45];
    const scar = blob(at, w * 0.34, h * 0.36, a => 1 + 0.1 * Math.sin(4 * a + phase) + 0.05 * Math.sin(9 * a), 22);
    const fracture = { type: "body", outline: scar, shadow: [], grain: cuts(scar, 0.6, HATCH * (0.8 - 0.4 * m.tone)), veins: [], weight: 0.6 + 0.3 * m.tone };
    if (detail) {
        // Ripples of the blow spread from its point on the rim.
        const origin = scar[Math.floor(scar.length * 0.62)];
        for (let k = 1; k <= 4; k += 1)
            fracture.veins.push(...runsInside(sample(t => [origin[0] + Math.cos(-0.3 + t * 2.2) * w * 0.12 * k, origin[1] + Math.sin(-0.3 + t * 2.2) * h * 0.12 * k], 10), scar));
    }
    shapes.push(fracture);
    return { shapes, tops: topsOf(outline) };
}
/** Thin cleaved slabs of slate stacked aslant, each a pale top and a dark edge. */
function slabs(rng, w, h, m, detail) {
    const shapes = [];
    const tops = [];
    let y = 0;
    for (let k = 0; k < 4; k += 1) {
        const sw = w * rng.range(0.78, 1), shift = rng.sym(0.08) * w, thick = h * rng.range(0.07, 0.1), depth = h * rng.range(0.18, 0.26);
        const tilt = rng.sym(0.06) * h;
        const x0 = -sw / 2 + shift, x1 = sw / 2 + shift, skew = sw * 0.18;
        const front = [[x0, y], [x1, y + tilt], [x1, y + tilt + thick], [x0, y + thick]];
        const top = [[x0, y + thick], [x1, y + tilt + thick], [x1 + skew, y + tilt + thick + depth], [x0 + skew, y + thick + depth]];
        // A broken corner on some slabs.
        if (rng.chance(0.5))
            top.splice(3, 0, [x0 + skew + sw * 0.15, y + thick + depth], [x0 + skew * 0.4, y + thick + depth * 0.4]);
        const end = [[x1, y + tilt], [x1 + skew, y + tilt + depth], [x1 + skew, y + tilt + thick + depth], [x1, y + tilt + thick]];
        shapes.push(face(front, Math.min(1, 0.75 + m.tone * 0.25), 0, w / 10), face(end, 0.9, 1.2, w / 10), face(top, Math.max(0, m.tone - 0.55), 0.2, w / 10));
        if (detail) {
            const lines = [0.35, 0.7].map(q => [[x0 + skew * q * 0.2, y + thick + depth * q], [x1 + skew * q * 0.2 - sw * 0.1, y + tilt + thick + depth * q]]);
            shapes.push(...lines.map(l => line(l, 0.005)));
        }
        shapes.push(edge(top, 0.012), edge(front, 0.012));
        tops.push(...topsOf(top));
        y += thick + depth * rng.range(0.25, 0.5);
    }
    return { shapes, tops: tops.slice(-3) };
}
/** A bedded block (grès, pierre à chaux): front, side and top, the beds banding its faces. */
function bedded(rng, w, h, m, detail) {
    const j = (v) => v * rng.range(0.9, 1.1);
    const xf = w * 0.22;
    const front = [[-w / 2, 0], [xf, 0], [xf, j(h * 0.72)], [-w / 2 + w * 0.12, j(h * 0.74)], [-w / 2, j(h * 0.6)]];
    const sideFace = [[xf, 0], [w / 2, h * 0.14], [w / 2, j(h * 0.86)], [xf, front[2][1]]];
    const top = [front[3], front[2], sideFace[2], [-w * 0.18, j(h * 0.95)], [-w * 0.34, h * 0.86]];
    const step = w / 10;
    const frontFace = face(front, Math.min(1, 0.25 + m.tone * 0.5), 0.3, step);
    const shapes = [frontFace, face(sideFace, Math.min(1, 0.6 + m.tone * 0.4), 1.1, step), face(top, Math.max(0, m.tone - 0.2), -0.2, step)];
    // The beds run round the block; alternate beds are cut more closely.
    const beds = [];
    for (let y = h * rng.range(0.1, 0.16); y < h * 0.7; y += h * rng.range(0.12, 0.2))
        beds.push(y);
    for (const y of beds) {
        for (const run of runsInside(sample(t => [lerp(-w / 2, xf, t), y + Math.sin(t * 6) * h * 0.012], 10), front))
            shapes.push(line(run, 0.008));
        for (const run of runsInside(sample(t => [lerp(xf, w / 2, t), y + t * h * 0.14], 6), sideFace))
            shapes.push(line(run, 0.008));
    }
    for (let k = 0; k + 1 < beds.length; k += 2) {
        // Ruled into the front face itself, so the painter keeps the band inside it.
        for (let y = beds[k] + HATCH * 0.5; y < beds[k + 1]; y += HATCH * 0.8)
            frontFace.grain.push([[-w * 0.6, y], [xf, y + h * 0.01]]);
    }
    if (detail)
        shapes.push(...surface(rng, front, m, w, h), ...surface(rng, sideFace, { ...m, texture: m.texture === "shells" ? "sand" : m.texture }, w * 0.5, h));
    shapes.push(edge(front, 0.013), edge(sideFace, 0.013), edge(top, 0.013));
    return { shapes, tops: [[top[4], top[3], top[2]]] };
}
/** Sulphur's druse: sharp bipyramids rising from a little matrix, lit on one flank and cut on the other. */
function crystals(rng, w, h, m, detail) {
    const base = stoneOutline(rng, w * 0.9, h * 0.28, 7, 0.1);
    const shapes = [face(base, 0.65, 0.5, w / 10), edge(base, 0.012)];
    const tops = [];
    const count = detail ? 6 : 4;
    const order = Array.from({ length: count }, (_, k) => k).sort((a, b) => Math.abs(b - (count - 1) / 2) - Math.abs(a - (count - 1) / 2));
    for (const k of order) {
        const x = lerp(-w * 0.32, w * 0.32, k / (count - 1)) + rng.sym(0.04) * w;
        const tall = h * rng.range(0.5, 0.9) * (1 - 0.35 * Math.abs(k - (count - 1) / 2) / count);
        const half = tall * rng.range(0.22, 0.3);
        const tilt = (k - (count - 1) / 2) * 0.16 + rng.sym(0.12);
        const local = [[0, 0], [half, tall * 0.42], [0, tall], [-half, tall * 0.42]];
        const at = [x, h * 0.16];
        const poly = local.map(([px, py]) => [at[0] + px * Math.cos(tilt) - py * Math.sin(tilt), at[1] + px * Math.sin(tilt) + py * Math.cos(tilt)]);
        const lit = [poly[0], poly[2], poly[3]];
        const dark = [poly[0], poly[1], poly[2]];
        shapes.push(face(lit, Math.max(0, m.tone - 0.2), 0.4, w / 12), face(dark, Math.min(1, 0.55 + m.tone * 0.3), -0.9, w / 12));
        // The girdle seen a little from above: a shallow V across the crystal's waist.
        const front = [lerp(poly[1][0], poly[3][0], 0.5), lerp(poly[1][1], poly[3][1], 0.5) - tall * 0.06];
        shapes.push(edge(poly, 0.012), line([poly[3], front, poly[1]], 0.007, false), line([front, poly[2]], 0.006, false));
        tops.push([poly[3], poly[2]]);
    }
    return { shapes, tops };
}
/** Gypsum's tabular crystals splayed like a fan, one a swallowtail twin, striated along their length. */
function tablets(rng, w, h, m, detail) {
    const shapes = [];
    const tops = [];
    const count = 4;
    for (let k = 0; k < count; k += 1) {
        const tilt = lerp(-0.55, 0.55, k / (count - 1)) + rng.sym(0.1);
        const length = h * rng.range(0.75, 1.0), wide = length * rng.range(0.24, 0.3), bevel = wide * 0.5;
        const swallow = k === 1;
        const local = swallow
            ? [[-wide / 2, bevel * 0.4], [0, 0], [wide / 2, bevel * 0.4], [wide / 2, length], [wide * 0.1, length - bevel * 1.4], [-wide / 2, length]]
            : [[-wide / 2, bevel * 0.4], [0, 0], [wide / 2, bevel * 0.4], [wide / 2, length - bevel], [0, length], [-wide / 2, length - bevel]];
        const turn = (p) => [p[0] * Math.cos(tilt) - p[1] * Math.sin(tilt), p[0] * Math.sin(tilt) + p[1] * Math.cos(tilt)];
        const poly = local.map(turn);
        const rim = [local[2], local[3], [local[3][0] + wide * 0.14, local[3][1] - wide * 0.1], [local[2][0] + wide * 0.14, local[2][1] + wide * 0.05]].map(p => turn(p));
        shapes.push(face(rim, Math.min(1, 0.55 + m.tone), 0.2, w / 12), face(poly, m.tone * 0.6, 0.9, w / 12));
        if (detail)
            for (const q of [-0.22, 0.12, 0.3])
                shapes.push(line([turn([q * wide, bevel * 0.6]), turn([q * wide, length - bevel * 1.2])], 0.005));
        shapes.push(edge(poly, 0.012));
        tops.push([poly[poly.length - 1], poly[poly.length - 2], poly[3]]);
    }
    return { shapes, tops };
}
/** Rock salt's cubes in a little heap, three faces each, the largest stepped like a hopper on top. */
function cubes(rng, w, h, m, detail) {
    const shapes = [];
    const tops = [];
    const heap = [{ at: [w * 0.02, h * 0.12], a: w * 0.36 }, { at: [-w * 0.26, 0], a: w * 0.24 }, { at: [w * 0.28, 0], a: w * 0.2 }];
    if (detail)
        heap.push({ at: [-w * 0.02, -h * 0.02], a: w * 0.14 });
    for (const [index, { at, a }] of heap.entries()) {
        const turn = rng.sym(0.12);
        const X = [Math.cos(0.5 + turn) * a * 0.9, Math.sin(0.5 + turn) * a * 0.5];
        const Y = [-Math.cos(0.5 - turn) * a * 0.9, Math.sin(0.5 - turn) * a * 0.5];
        const Z = [0, a * 0.95];
        const add = (...vs) => vs.reduce((p, v) => [p[0] + v[0], p[1] + v[1]], at);
        const left = [add(), add(Z), add(Y, Z), add(Y)];
        const right = [add(), add(X), add(X, Z), add(Z)];
        const top = [add(Z), add(X, Z), add(X, Y, Z), add(Y, Z)];
        shapes.push(face(left, Math.min(1, 0.3 + m.tone * 0.4), 1.4, a / 6), face(right, Math.min(1, 0.65 + m.tone * 0.3), 0.3, a / 6), face(top, m.tone * 0.3, 0, a / 6));
        if (index === 0 && detail) {
            // The hopper: the top face stepped down in nested squares.
            const c = centroid(top);
            for (const q of [0.66, 0.36])
                shapes.push(edge(top.map(p => [c[0] + (p[0] - c[0]) * q, c[1] + (p[1] - c[1]) * q]), 0.006));
        }
        shapes.push(edge(left, 0.012), edge(right, 0.012), edge(top, 0.012));
        tops.push([top[3], top[0], top[1]], [top[3], top[2], top[1]]);
    }
    return { shapes, tops };
}
/** Saltpetre: a low crust bristling with fine needles in tufts. */
function needles(rng, w, h, m, detail) {
    const crust = stoneOutline(rng, w * 0.95, h * 0.42, 9, 0.1);
    const base = face(crust, 0.4 + m.tone * 0.4, 0.6, w / 10);
    const tufts = detail ? 7 : 4;
    for (let t = 0; t < tufts; t += 1) {
        const x = lerp(-w * 0.38, w * 0.38, (t + 0.5) / tufts) + rng.sym(0.03) * w;
        const foot = [x, h * 0.36 * (1 - (2 * x / w) ** 2) + h * 0.04];
        const count = rng.int(9, 15);
        for (let k = 0; k < count; k += 1) {
            const a = Math.PI / 2 + rng.sym(0.75), l = h * rng.range(0.18, 0.55) * (1 - 0.4 * Math.abs(a - Math.PI / 2));
            base.veins.push([foot, [foot[0] + Math.cos(a) * l, foot[1] + Math.sin(a) * l]]);
        }
    }
    return { shapes: [base, edge(crust, 0.012), { type: "dots", points: scatter(rng, crust, 16), radius: w * 0.005 }], tops: topsOf(crust) };
}
/** A tin ingot's broken end: bright ruled faces, the break ragged. */
function ingot(rng, w, h, m) {
    const hh = h * 0.42, t = w * 0.07, d = w * 0.16, dd = h * 0.24;
    const x0 = -w / 2, x1 = w / 2 - d;
    const jagged = (from, to) => [1, 2, 3].map(k => [lerp(from[0], to[0], k / 4) + rng.sym(0.04) * w, lerp(from[1], to[1], k / 4)]);
    const front = [[x0, 0], [x1, 0], [x1 - t, hh], [x0 + t * 0.5, hh], ...jagged([x0 + t * 0.5, hh], [x0, 0])];
    const top = [[x0 + t * 0.5, hh], [x1 - t, hh], [x1 - t + d, hh + dd], [x0 + t * 0.5 + d, hh + dd], ...jagged([x0 + t * 0.5 + d, hh + dd], [x0 + t * 0.5, hh])];
    const end = [[x1, 0], [x1 + d, dd], [x1 - t + d, hh + dd], [x1 - t, hh]];
    const step = w / 12;
    const shapes = [face(front, 0.45 + m.tone * 0.3, 0, step, true, { at: 0.15, width: 0.16 }), face(top, m.tone * 0.4, 0.02, step, true, { at: -0.2, width: 0.25 }),
        face(end, 0.85, 1.3, step), edge(front, 0.013), edge(top, 0.013), edge(end, 0.013)];
    return { shapes, tops: [[top[3], top[2]]] };
}
/** A dented, folded lump of lead: dull ruling, soft dents, a lip turned over. */
function sheet(rng, w, h, m, detail) {
    const phase = rng.range(0, TAU);
    const centre = [0, h * 0.32];
    const outline = blob(centre, w * 0.5, h * 0.34, a => 1 + 0.06 * Math.sin(4 * a + phase) + 0.04 * Math.cos(7 * a), 22);
    const main = { type: "body", outline, shadow: [], grain: cuts(outline, 0.05, HATCH * (0.8 - 0.3 * m.tone)), veins: [], weight: 0.75 };
    const lip = [[w * 0.05, h * 0.6], [w * 0.42, h * 0.45], [w * 0.3, h * 0.7]];
    const shapes = [main, face(lip, 0.9, 1.2, w / 10), edge(lip, 0.012)];
    if (detail) {
        for (const p of scatter(rng, outline.map(q => [q[0] * 0.75, centre[1] + (q[1] - centre[1]) * 0.7]), 4)) {
            const dent = blob(p, w * 0.07, h * 0.04, () => 1, 10, -1);
            shapes.push({ type: "body", outline: dent, shadow: [], grain: cuts(dent, 1.2, HATCH * 0.45), veins: [], weight: 0.8 });
        }
    }
    return { shapes, tops: topsOf(outline) };
}
/**
 * Native copper: a compact crystalline arborescence on a scrap of matrix. Its rays are ruled like
 * metal, set with short spikes at sixty degrees and tipped with little crystals, so it never reads
 * as one of the garden's twigs.
 */
function dendrite(rng, w, h, m, detail) {
    const base = stoneOutline(rng, w * 0.75, h * 0.24, 7, 0.1);
    const shapes = [face(base, 0.55, 0.5, w / 10), edge(base, 0.012)];
    const tops = [];
    const rays = detail ? [-0.75, -0.25, 0.3, 0.8] : [-0.4, 0.4];
    for (const offset of rays) {
        const angle = Math.PI / 2 + offset + rng.sym(0.1);
        const length = h * rng.range(0.5, 0.7) * (1 - 0.3 * Math.abs(offset));
        const from = [offset * w * 0.12, h * 0.18];
        const dir = [Math.cos(angle), Math.sin(angle)];
        const at = (v) => [from[0] + dir[0] * length * v, from[1] + dir[1] * length * v];
        const width = w * 0.045;
        const ray = [[from[0] - dir[1] * width, from[1] + dir[0] * width], [at(1)[0] - dir[1] * width * 0.4, at(1)[1] + dir[0] * width * 0.4],
            [at(1)[0] + dir[1] * width * 0.4, at(1)[1] - dir[0] * width * 0.4], [from[0] + dir[1] * width, from[1] - dir[0] * width]];
        shapes.push(face(ray, 0.5 + m.tone * 0.3, angle, w / 14, true, { at: 0.2, width: 0.25 }), edge(ray, 0.01));
        for (const [index, v] of [0.3, 0.48, 0.64, 0.8].entries()) {
            // Spikes pair at alternate points and stand single, on alternating sides, between them.
            for (const sd of index % 2 === 0 ? [1, -1] : [index % 4 === 1 ? 1 : -1]) {
                const a = angle + sd * Math.PI / 3;
                const l = length * 0.26 * (1 - 0.5 * v);
                const root = at(v);
                const n = [-Math.sin(a) * width * 0.5, Math.cos(a) * width * 0.5];
                shapes.push({ type: "solid", outline: [[root[0] + n[0], root[1] + n[1]], [root[0] + Math.cos(a) * l, root[1] + Math.sin(a) * l], [root[0] - n[0], root[1] - n[1]]], smooth: false });
            }
        }
        // A crystal at the tip: an octahedron's two lit and shaded halves.
        const tip = at(1), c = width * 1.8;
        const crystal = [[tip[0] - dir[1] * c, tip[1] + dir[0] * c], [tip[0] + dir[0] * c * 1.6, tip[1] + dir[1] * c * 1.6], [tip[0] + dir[1] * c, tip[1] - dir[0] * c], [tip[0] - dir[0] * c * 0.4, tip[1] - dir[1] * c * 0.4]];
        shapes.push(face([crystal[0], crystal[1], crystal[3]], 0.1, 0, w / 20), face([crystal[1], crystal[2], crystal[3]], 0.8, angle, w / 20), edge(crystal, 0.009));
        tops.push([crystal[0], crystal[1]]);
    }
    return { shapes, tops };
}
/** Mercury: a big flattened drop and loose beads in the hollow of a stone, and a few run off beside it. */
function beads(rng, w, h, m, detail) {
    const phase = rng.range(0, TAU);
    const centre = [0, h * 0.22];
    const stone = blob(centre, w * 0.5, h * 0.24, a => 1 + 0.07 * Math.sin(3 * a + phase), 22);
    const shapes = [rounded(stone, centre, w * 0.5, h * 0.24, 0.45, 0.25), edge(stone, 0.01)];
    // The hollow: its far wall falls in shadow under the rim.
    const hollowAt = [w * 0.02, h * 0.34];
    const hollow = blob(hollowAt, w * 0.3, h * 0.09, () => 1, 18, -1);
    const far = blob([hollowAt[0], hollowAt[1] - h * 0.04], w * 0.32, h * 0.09, () => 1, 18, -1);
    shapes.push({ type: "body", outline: hollow, shadow: [far.map(([x, y]) => [x, y + h * 0.5]).concat(far.slice().reverse())], grain: cuts(hollow, 0.3, HATCH * 0.55), veins: [], weight: 0.6 });
    const bead = (at, rx, ry) => {
        const outline = blob(at, rx, ry, () => 1, Math.max(10, Math.round(rx * 120)), -1);
        // A bright point and a reflection along the lower rim: a liquid metal shows almost nothing else.
        const spark = blob([at[0] - rx * 0.35, at[1] + ry * 0.35], rx * 0.22, ry * 0.2, () => 1, 8, -1);
        const glint = blob([at[0] + rx * 0.25, at[1] - ry * 0.55], rx * 0.45, ry * 0.12, () => 1, 8, -1);
        return [rounded(outline, at, rx, ry, 0.85, 0.85, [spark, glint])];
    };
    shapes.push(...bead([hollowAt[0] - w * 0.03, hollowAt[1] + h * 0.01], w * 0.2, h * 0.085));
    const loose = detail
        ? [[0.2, 0.36, 0.06], [-0.22, 0.34, 0.045], [0.32, 0.02, 0.055], [0.44, 0.03, 0.035], [-0.44, 0.02, 0.04], [-0.06, 0.46, 0.03]]
        : [[0.2, 0.36, 0.055], [0.34, 0.02, 0.05]];
    for (const [x, y, r] of loose)
        shapes.push(...bead([x * w, y * h + r * w * 0.8], r * w, r * w * 0.85));
    return { shapes, tops: topsOf(stone) };
}
/** A low clod of earth or fuel on its flat base; the texture tells peat, topsoil, manure, clay and marl apart. */
function clod(rng, w, h, m, detail) {
    const phase = rng.range(0, TAU);
    const smooth = m.texture === "cracks";
    const centre = [0, h * 0.3];
    const outline = blob(centre, w * 0.5, h * 0.36, a => 1 + (smooth ? 0.03 : 0.07) * Math.sin(7 * a + phase) + (smooth ? 0.015 : 0.045) * Math.sin(13 * a + phase * 2), 30);
    const body = rounded(outline, centre, w * 0.5, h * 0.36, 0.6, m.tone);
    const shapes = [body];
    const size = Math.max(w, h);
    if (!detail)
        return { shapes, tops: topsOf(outline) };
    switch (m.texture) {
        case "fibres": {
            // Peat: layered, matted fibres, some sticking out of the broken edge.
            for (let k = 0; k < 16; k += 1) {
                const y0 = h * rng.range(0.05, 0.6), x0 = rng.range(-0.6, 0.2) * w, length = w * rng.range(0.3, 0.7), sag = rng.sym(0.05) * h;
                const path = sample(t => [x0 + length * t, y0 + sag * Math.sin(Math.PI * t) + t * rng.sym(0.02) * h], 6);
                body.veins.push(k % 4 === 0 ? path : path.filter(p => inside(p, outline)));
            }
            break;
        }
        case "roots": {
            // Topsoil: crumbs, and fine roots hanging from its underside.
            shapes.push({ type: "dots", points: scatter(rng, outline, 40), radius: size * 0.008 }, { type: "dots", points: scatter(rng, outline, 30), radius: size * 0.004 });
            for (let k = 0; k < 5; k += 1) {
                const from = [lerp(-w * 0.4, w * 0.4, k / 4) + rng.sym(0.04) * w, h * 0.05];
                const root = sample(t => [from[0] + Math.sin(t * 4 + k) * w * 0.05 + t * rng.sym(0.1) * w, from[1] - t * h * rng.range(0.3, 0.5)], 6);
                shapes.push(line(root, 0.008));
                const fork = root[3];
                shapes.push(line([fork, [fork[0] + rng.sym(0.08) * w, fork[1] - h * 0.15]], 0.005));
            }
            break;
        }
        case "straw": {
            // Manure: straws, hollow and jointed, sticking out of the dark mass.
            for (let k = 0; k < 7; k += 1) {
                const at = scatter(rng, outline, 1)[0] ?? centre;
                const a = rng.range(-0.6, 0.6) + (k % 2 === 0 ? 0 : Math.PI), length = w * rng.range(0.25, 0.5);
                const dir = [Math.cos(a), Math.sin(a) * 0.5 + 0.15];
                const nx = -dir[1] * size * 0.012, ny = dir[0] * size * 0.012;
                const end = [at[0] + dir[0] * length, at[1] + dir[1] * length];
                const straw = [[at[0] + nx, at[1] + ny], [end[0] + nx, end[1] + ny], [end[0] - nx, end[1] - ny], [at[0] - nx, at[1] - ny]];
                shapes.push({ type: "body", outline: straw, shadow: [], grain: [], veins: [[[lerp(at[0], end[0], 0.5) + nx, lerp(at[1], end[1], 0.5) + ny], [lerp(at[0], end[0], 0.5) - nx, lerp(at[1], end[1], 0.5) - ny]]], weight: 0.3 });
            }
            shapes.push({ type: "dots", points: scatter(rng, outline, 30), radius: size * 0.006 });
            break;
        }
        case "cracks": {
            // Clay: a smooth skin parted by a net of drying cracks, in cells like a dried pond bed.
            const cols = 5, rows = 3;
            const node = Array.from({ length: rows + 1 }, (_, r) => Array.from({ length: cols + 1 }, (_, c) => [lerp(-w * 0.5, w * 0.5, c / cols) + rng.sym(0.06) * w, lerp(h * 0.08, h * 0.62, r / rows) + rng.sym(0.05) * h]));
            const crack = (a, b) => {
                const mid = [lerp(a[0], b[0], 0.5) + rng.sym(0.025) * w, lerp(a[1], b[1], 0.5) + rng.sym(0.025) * h];
                body.veins.push(...runsInside(sample(t => t < 0.5 ? [lerp(a[0], mid[0], t * 2), lerp(a[1], mid[1], t * 2)] : [lerp(mid[0], b[0], t * 2 - 1), lerp(mid[1], b[1], t * 2 - 1)], 6), outline));
            };
            for (let r = 0; r <= rows; r += 1)
                for (let c = 0; c <= cols; c += 1) {
                    const p = node[r][c];
                    if (c < cols && r > 0)
                        crack(p, node[r][c + 1]);
                    if (r < rows && rng.chance(0.85))
                        crack(p, node[r + 1][c]);
                }
            break;
        }
        case "crumbs": {
            // Marl: pale and flaky, crumbling into fragments round its foot.
            for (let k = 0; k < 9; k += 1) {
                const at = scatter(rng, outline, 1)[0] ?? centre;
                body.veins.push([at, [at[0] + rng.range(0.04, 0.09) * w, at[1] + rng.sym(0.02) * h]]);
            }
            for (const x of [-0.58, -0.48, 0.52, 0.6, 0.44]) {
                const at = [x * w, size * 0.025];
                const crumb = blob(at, size * rng.range(0.02, 0.035), size * rng.range(0.015, 0.025), () => 1, 6);
                shapes.push(face(crumb, 0.3, 0.8, size / 30), edge(crumb, 0.008));
            }
            shapes.push({ type: "dots", points: scatter(rng, outline, 26), radius: size * 0.005 });
            break;
        }
        default: break;
    }
    return { shapes, tops: topsOf(outline) };
}
/** Bitumen: a black, sagging lump with glossy breaks left as bright curves in its cutting. */
function pitch(rng, w, h, m, detail) {
    const phase = rng.range(0, TAU);
    const centre = [0, h * 0.36];
    const outline = blob(centre, w * 0.5, h * 0.4, a => 1 + 0.08 * Math.sin(3 * a + phase) + 0.14 * Math.max(0, -Math.sin(a)) * Math.max(0, Math.sin(5 * a + phase)), 30, -h * 0.12);
    const glint = (at, rx, ry, bend) => [
        ...sample(t => [at[0] + (t - 0.5) * rx * 2, at[1] + Math.sin(Math.PI * t) * ry + bend * (t - 0.5)], 6),
        ...sample(t => [at[0] + (0.5 - t) * rx * 2, at[1] + Math.sin(Math.PI * (1 - t)) * ry * 0.4 + bend * (0.5 - t)], 6).slice(1, -1)
    ];
    const highlights = [glint([-w * 0.15, h * 0.55], w * 0.18, h * 0.08, h * 0.04), glint([w * 0.12, h * 0.3], w * 0.12, h * 0.05, -h * 0.03)];
    if (detail)
        highlights.push(glint([-w * 0.28, h * 0.25], w * 0.07, h * 0.03, 0));
    const body = rounded(outline, centre, w * 0.5, h * 0.4, 0.9, Math.max(0.8, m.tone), highlights);
    if (detail)
        body.veins.push(sample(t => [w * (0.05 + 0.25 * t), h * (0.65 - 0.4 * t) + Math.sin(t * 3) * h * 0.04], 6));
    return { shapes: [body], tops: topsOf(outline) };
}
/** A fragment of comb: hexagonal cells in a broken outline; honey brims and drips from it, or the wax lies empty and broken. */
function comb(rng, w, h, m, detail) {
    const honey = m.texture === "drops";
    const phase = rng.range(0, TAU);
    const centre = [0, h * 0.5];
    const outline = blob(centre, w * 0.48, h * 0.48, a => 1 + 0.1 * Math.sin(3 * a + phase) + 0.07 * Math.sin(7 * a + phase) * (honey ? 0.5 : 1.4), 26);
    const body = { type: "body", outline, shadow: [], grain: honey ? cuts(outline, 0.6, HATCH * 1.4) : [], veins: [], weight: 0.4 + 0.3 * m.tone };
    const cell = w * (detail ? 0.075 : 0.1);
    const capped = [];
    const shapes = [body];
    for (let row = -8; row <= 8; row += 1) {
        for (let col = -8; col <= 8; col += 1) {
            const c = [col * cell * 1.73 + (row % 2 === 0 ? 0 : cell * 0.87), centre[1] + row * cell * 1.5];
            const hex = Array.from({ length: 7 }, (_, k) => [c[0] + Math.cos(Math.PI / 6 + k * Math.PI / 3) * cell, c[1] + Math.sin(Math.PI / 6 + k * Math.PI / 3) * cell]);
            if (!inside(c, outline))
                continue;
            const whole = hex.every(p => inside(p, outline));
            // Cells cut by the break stay open; whole ones show their depth, and in honey many are capped full.
            if (!whole) {
                body.veins.push(...runsInside(hex, outline));
                continue;
            }
            body.veins.push(hex);
            if (honey && rng.chance(0.5))
                capped.push(c);
            else if (!honey || rng.chance(0.5))
                body.veins.push(hex.map(([x, y]) => [c[0] + (x - c[0]) * 0.55 + cell * 0.12, c[1] + (y - c[1]) * 0.55 - cell * 0.1]));
        }
    }
    if (capped.length > 0)
        shapes.push({ type: "dots", points: capped, radius: cell * 0.45 });
    shapes.push(edge(outline, 0.012));
    if (honey) {
        // Honey runs from the lower edge in drops, and has dripped beside the comb.
        const lows = outline.filter(p => p[1] < h * 0.22);
        const picks = [lows[0], lows[Math.floor(lows.length / 2)], lows[lows.length - 1]].filter((p) => p !== undefined);
        for (const [index, p] of (detail ? picks : picks.slice(0, 1)).entries())
            shapes.push(drop([p[0], p[1] - h * 0.02], w * (0.05 + 0.015 * index), h * (0.12 + 0.05 * index), true));
        if (detail)
            shapes.push(drop([w * 0.56, h * 0.02], w * 0.05, h * 0.06, false), drop([w * 0.66, h * 0.01], w * 0.03, h * 0.035, false));
    }
    else if (detail) {
        for (const x of [-0.5, 0.55, 0.62]) {
            const at = [x * w, w * 0.02];
            shapes.push(edge(blob(at, w * 0.025, w * 0.015, () => 1, 6), 0.008));
        }
    }
    return { shapes, tops: topsOf(outline) };
}
/** A drop of honey: hanging from the comb as a tear, or lying round on the ground. */
function drop(at, rx, ry, hanging) {
    const centre = hanging ? [at[0], at[1] - ry * 0.6] : [at[0], at[1] + ry * 0.5];
    const outline = hanging
        ? sample(v => { const a = v * TAU; const k = 1 + 0.9 * Math.max(0, Math.sin(a)) ** 3; return [centre[0] + Math.cos(a) * rx / k, centre[1] + Math.sin(a) * ry * (Math.sin(a) > 0 ? 1.4 : 0.6)]; }, 14).slice(0, -1)
        : blob(centre, rx, ry * 0.5, () => 1, 12, -1);
    const spark = blob([centre[0] - rx * 0.3, centre[1] + ry * 0.1], rx * 0.25, ry * 0.12, () => 1, 8, -1);
    return rounded(outline, centre, rx, ry, 0.7, 0.55, [spark]);
}
const HABITS = {
    lump: (rng, w, h, m, detail) => lump(rng, w, h, m, false, detail),
    fragment: (rng, w, h, m, detail) => lump(rng, w, h, m, true, detail),
    nodule, slabs, bedded, crystals, tablets, cubes, needles,
    ingot: (rng, w, h, m) => ingot(rng, w, h, m),
    sheet, dendrite, beads, clod, pitch, comb,
};
/** Hoarfrost on the upper edges: a white crust with a fringe of rime needles. */
function frost(rng, tops, s) {
    const shapes = [];
    for (const run of tops) {
        const pts = densify(run, s * 0.03, false).concat([run[run.length - 1]]);
        if (pts.length < 2)
            continue;
        const outer = [], inner = [];
        const veins = [];
        pts.forEach((p, index) => {
            const a = pts[Math.max(0, index - 1)], b = pts[Math.min(pts.length - 1, index + 1)];
            const [tx, ty] = unit(b[0] - a[0], b[1] - a[1]);
            // The upward side of the edge, whichever way the run goes.
            const [nx, ny] = tx <= 0 ? [ty, -tx] : [-ty, tx];
            const crust = s * rng.range(0.018, 0.035);
            outer.push([p[0] + nx * crust, p[1] + ny * crust]);
            inner.push([p[0] - nx * s * 0.006, p[1] - ny * s * 0.006]);
            const needle = s * rng.range(0.008, 0.028);
            const lean = rng.sym(0.35);
            veins.push([[p[0] + nx * crust, p[1] + ny * crust], [p[0] + (nx + tx * lean) * (crust + needle), p[1] + (ny + ty * lean) * (crust + needle)]]);
        });
        shapes.push({ type: "body", outline: [...outer, ...inner.reverse()], shadow: [], grain: [], veins, weight: 0.2 });
    }
    return shapes;
}
/** The fork of a bare twig in which a specimen rests, origin at the twig's base. */
function cradle(rng, s, seat, reach) {
    // A Y: the twig forks under the specimen and its two tips rise behind it on either side.
    const fork = [rng.sym(0.02) * s, seat * 0.5];
    const tips = [-1, 1].map(sd => [sd * reach * (0.34 + rng.u() * 0.06), seat + s * (0.16 + rng.u() * 0.06)]);
    return [line([[0, 0], fork], s * 0.04), ...tips.map(tip => line([fork, [Math.sign(tip[0]) * reach * 0.24, seat * 0.95], tip], s * 0.026)),
        ...tips.flatMap(tip => bud(rng, tip, [Math.sign(tip[0]) * 0.3, 1], s * 0.07, false))];
}
/** One specimen of the day's material in its fork: small and plain when it first appears, frosted at the end. */
function specimen(m, scale) {
    return (rng, s, stage) => {
        const grown = (stage === "bud" ? 0.62 : 1) * scale;
        const w = s * 0.86 * grown, h = s * 0.62 * grown;
        const seat = s * 0.14;
        const drawn = HABITS[m.habit](rng, w, h, m, stage !== "bud");
        const lifted = (shape) => turnShape(shape, 0, [0, seat]);
        const shapes = [...cradle(rng, s, seat, w), ...drawn.shapes.map(lifted)];
        if (stage === "seed")
            shapes.push(...frost(rng, drawn.tops.map(run => run.map(([x, y]) => [x, y + seat])), s));
        return shapes;
    };
}
// ---------------------------------------------------------------- the winter twigs
/** A dried leaf still hanging: curled at one margin, holed, its veins standing out. */
function driedLeaf(rng, length, bend) {
    const petiole = length * 0.15;
    const blade = length - petiole;
    const lobed = rng.chance(0.5);
    const lobes = rng.int(4, 6);
    const curl = side(rng);
    const twist = bend * 1.6 + rng.sym(0.25);
    const spine = (v) => [twist * blade * v * v, petiole + blade * v * (1 - 0.08 * v)];
    const halfWidth = (v) => blade * 0.3 * 2 * v ** 0.6 * (1 - v) ** 0.7 * (lobed ? 0.7 + 0.3 * Math.abs(Math.sin(v * lobes * Math.PI)) : 1);
    // The curled margin rolls under: that side is narrower and its edge shows as a second line.
    const leaf = bladeBody({ spine, halfWidth, edge: (v, sd) => sd === curl ? -halfWidth(v) * 0.45 * smoothstep(0.2, 0.6, v) : 0.004 * blade * Math.sin(v * 40),
        shade: curl, spacing: HATCH * 0.75, grain: "across", weight: 0.7, midrib: true, samples: 22 }, rng);
    for (let k = 1; k <= 4; k += 1) {
        const v = 0.15 + 0.17 * k;
        const [x, y] = spine(v);
        leaf.veins.push([[x, y], [x - curl * halfWidth(v + 0.08) * 0.8, y + blade * 0.08]]);
    }
    leaf.veins.push(sample(v => { const [x, y] = spine(v); return [x + curl * halfWidth(v) * 0.5, y]; }, 6, 0.3, 0.9));
    if (rng.chance(0.6)) {
        const [x, y] = spine(rng.range(0.4, 0.7));
        leaf.veins.push(ringAt([x - curl * blade * 0.06, y], blade * 0.03, blade * 0.02, 7));
    }
    return [line([[0, 0], [twist * blade * 0.02, petiole]], length * 0.025), leaf];
}
/** A dormant bud: a pointed cone of overlapping scales. */
function bud(rng, at, dir, length, fat) {
    const [dx, dy] = unit(dir[0], dir[1]);
    const spine = (v) => [at[0] + dx * length * v, at[1] + dy * length * v];
    const body = bladeBody({ spine, halfWidth: v => length * (fat ? 0.36 : 0.24) * Math.sin(Math.PI * Math.min(1, v * 1.05) ** 0.75) ** 0.8, shade: side(rng),
        spacing: HATCH * (fat ? 0.55 : 0.75), grain: "across", weight: fat ? 0.85 : 0.65, samples: 10 }, rng);
    for (const v of [0.3, 0.55, 0.78]) {
        const [x, y] = spine(v);
        const w = length * (fat ? 0.3 : 0.2) * Math.sin(Math.PI * v ** 0.75);
        body.veins.push([[x - dy * w, y + dx * w], [x + dx * length * 0.12, y + dy * length * 0.12], [x + dy * w, y - dx * w]]);
    }
    return [body];
}
/** A short bare spur with alternate buds above their leaf scars, and a terminal bud. */
function budSpur(rng, length, bend, fat) {
    const twig = (v) => [bend * length * v * v + (Math.floor(v * 3.5) % 2 === 0 ? 1 : -1) * length * 0.02 * Math.sin(Math.PI * v), length * v];
    const shapes = [line(sample(twig, 7), length * 0.035, false)];
    for (const [index, v] of [0.35, 0.62].entries()) {
        const sd = index % 2 === 0 ? 1 : -1;
        const p = twig(v);
        shapes.push(line(sample(t => [p[0] + sd * length * 0.03 * Math.cos(t * Math.PI), p[1] - length * 0.02 - length * 0.015 * Math.sin(t * Math.PI)], 4), length * 0.01));
        shapes.push(...bud(rng, p, [sd * 0.8, 0.9], length * (fat ? 0.2 : 0.14), fat));
    }
    shapes.push(...bud(rng, twig(1), [bend * 0.5, 1], length * (fat ? 0.3 : 0.2), fat));
    return shapes;
}
// ---------------------------------------------------------------- the geological section
// The integrated mode: the column's foot is cut as a section through the ground, after the plates of
// eighteenth-century mineralogy. The day's material lies in its beds among the company it keeps, under a
// thin soil from which the winter twigs rise, and is told by its texture: granite's interlocking grains,
// slate's cleavage, clay's drying cracks, the black coal seam, marble's veins, flint in chalk, basalt's
// columns, an ore vein for a metal. An engraved cartouche carries its chemical sign, drawn with the signs
// of the eighteenth-century affinity tables. As the day fills, veins, druses and crystals come into
// the rock; at the end of the day the ground takes the rime.
/** The section's cut sides inset from the column's edges, its floor, and the ground at the crown, in centimetres. */
const CUT = 0.2, FLOOR = 0.4, GROUND = 4.9, CROWN_X = 0.47;
/** How far the ground rises or falls about the crown's height. */
const RELIEF = 0.14;
/** The room the section fills: the ground's highest reach, with its tufts and stones. */
const SECTION_TOP = GROUND + 0.7;
/** Abscissa step of the beds' boundaries. */
const STEP = 0.2;
const piece = (shapes, full = 0, late = 0) => ({ shapes, full, late });
const bedOf = (top, bottom) => ({ top, bottom, poly: [...top, ...bottom.slice().reverse()] });
const spanOf = (bed) => [bed.top[0][0], bed.top[bed.top.length - 1][0]];
function heightAt(row, x) {
    const f = clamp((x - row[0][0]) / (row[1][0] - row[0][0]), 0, row.length - 1.0001);
    const index = Math.floor(f);
    return lerp(row[index][1], row[index + 1][1], f - index);
}
/** The height at share q of a bed's thickness above x: 0 its floor, 1 its roof. */
const within = (bed, x, q) => lerp(heightAt(bed.bottom, x), heightAt(bed.top, x), q);
function inBed(bed, [x, y], margin = 0) {
    const [x0, x1] = spanOf(bed);
    return x > x0 + margin && x < x1 - margin && y > heightAt(bed.bottom, x) + margin && y < heightAt(bed.top, x) - margin;
}
/** The part of a bed between shares q0 and q1 of its thickness. */
const slice = (bed, q0, q1) => bedOf(bed.top.map(([x]) => [x, within(bed, x, q1)]), bed.top.map(([x]) => [x, within(bed, x, q0)]));
const thickness = (bed) => bed.top.reduce((sum, p, index) => sum + p[1] - bed.bottom[index][1], 0) / bed.top.length;
/** A line across a bed at share q of its thickness, waving a little. */
function across(bed, q, wave = 0, phase = 0) {
    const [x0, x1] = spanOf(bed);
    return sample(v => { const x = lerp(x0, x1, v); return [x, within(bed, x, q) + wave * Math.sin(x * 2.3 + phase) * Math.sin(Math.PI * v)]; }, Math.ceil((x1 - x0) / 0.15));
}
/** Lines following a bed's own shape, one for every `spacing` of its thickness. */
function laminae(bed, spacing, wave = 0, rng) {
    const count = Math.max(1, Math.round(thickness(bed) / spacing));
    return Array.from({ length: count }, (_, k) => across(bed, (k + 0.5) / count, wave, rng ? rng.range(0, 10) : k * 1.7));
}
const bedBody = (bed, weight, grain = []) => ({ type: "body", outline: densify(bed.poly, 0.15), shadow: [], grain, veins: [], weight });
const speckle = (rng, bed, density, radius) => ({ type: "dots", points: scatter(rng, bed.poly, Math.round(Math.abs(area(bed.poly)) * density)), radius });
/** The parts of a path that lie in a bed, inked. */
const inkIn = (bed, path, width, margin = 0) => runsWhere(path, p => inBed(bed, p, margin)).map(run => line(run, width));
/** A path broken into dashes, as an engraver cuts a faint bedding plane. */
function dashed(rng, path, on, off) {
    const out = [];
    let run = [path[0]], drawing = true, left = rng.range(...on);
    for (let index = 1; index < path.length; index += 1) {
        let from = path[index - 1];
        const to = path[index];
        let d = Math.hypot(to[0] - from[0], to[1] - from[1]);
        while (d > left) {
            const f = left / d;
            const p = [lerp(from[0], to[0], f), lerp(from[1], to[1], f)];
            if (drawing) {
                run.push(p);
                if (run.length > 1)
                    out.push(run);
                run = [];
            }
            else
                run = [p];
            drawing = !drawing;
            d -= left;
            from = p;
            left = drawing ? rng.range(...on) : rng.range(...off);
        }
        left -= d;
        if (drawing)
            run.push(to);
    }
    if (drawing && run.length > 1)
        out.push(run);
    return out;
}
/** Points on a jittered grid inside a bed, `margin` clear of its edges: grains and crystals laid evenly. */
function strew(rng, bed, spacing, margin) {
    const [x0, x1] = spanOf(bed);
    const y0 = Math.min(...bed.bottom.map(p => p[1])), y1 = Math.max(...bed.top.map(p => p[1]));
    const out = [];
    for (let y = y0 + spacing / 2; y < y1; y += spacing * 0.87) {
        for (let x = x0 + spacing / 2; x < x1; x += spacing) {
            const p = [x + rng.sym(spacing * 0.4), y + rng.sym(spacing * 0.35)];
            if (inBed(bed, p, margin))
                out.push(p);
        }
    }
    return out;
}
const closed = (points) => [...points, points[0]];
const polygonAt = (at, r, n, phase, rng, stretch = 1) => Array.from({ length: n }, (_, k) => { const a = phase + k * TAU / n + rng.sym(0.5 / n * TAU); const rr = r * rng.range(0.7, 1.1); return [at[0] + Math.cos(a) * rr * stretch, at[1] + Math.sin(a) * rr]; });
// ---------------------------------------------------------------- small things in the rock
/** A fern frond pressed flat in shale, laid along the bedding. */
function fern(rng, at, length, angle) {
    const dir = [Math.cos(angle), Math.sin(angle)], n = [-dir[1], dir[0]];
    const bend = rng.sym(0.2);
    const spine = (v) => [at[0] + dir[0] * length * v + n[0] * bend * length * v * v, at[1] + dir[1] * length * v + n[1] * bend * length * v * v];
    const out = [line(sample(spine, 8), 0.007)];
    for (let k = 1; k < 12; k += 1) {
        const v = k / 12, p = spine(v), l = length * 0.15 * (1 - v * 0.7);
        for (const sd of [1, -1]) {
            const a = angle + sd * 1.05 + bend * v;
            out.push(line([p, [p[0] + Math.cos(a) * l * 0.5 + dir[0] * l * 0.15, p[1] + Math.sin(a) * l * 0.5 + dir[1] * l * 0.15], [p[0] + Math.cos(a) * l, p[1] + Math.sin(a) * l]], 0.005));
        }
    }
    return out;
}
/** A coiled shell in section: an ammonite's spiral, ribbed on its outer whorl when large. */
function coil(at, r, ribs) {
    const turns = 2.6;
    const spiral = (v) => { const a = v * turns * TAU, rr = r * (0.12 + 0.88 * v); return [at[0] + Math.cos(a) * rr, at[1] + Math.sin(a) * rr]; };
    const out = [line(sample(spiral, Math.round(18 + r * 160)), r > 0.1 ? 0.008 : 0.006)];
    if (ribs) {
        for (let k = 0; k < 22; k += 1) {
            const v = 1 - k / 22 * (1 / turns);
            const a = v * turns * TAU, outer = r * (0.12 + 0.88 * v), inner = r * (0.12 + 0.88 * (v - 1 / turns));
            out.push(line([[at[0] + Math.cos(a) * outer, at[1] + Math.sin(a) * outer], [at[0] + Math.cos(a) * lerp(outer, inner, 0.8), at[1] + Math.sin(a) * lerp(outer, inner, 0.8)]], 0.004));
        }
    }
    return out;
}
/** A ribbed bivalve lying in the bed. */
function valve(at, r, angle) {
    const out = [line(sample(v => { const a = angle + Math.PI / 2 + (v - 0.5) * 2.4; return [at[0] + Math.cos(a) * r, at[1] + Math.sin(a) * r]; }, 10), 0.006),
        line([[at[0] + Math.cos(angle + Math.PI / 2 - 1.2) * r, at[1] + Math.sin(angle + Math.PI / 2 - 1.2) * r], at, [at[0] + Math.cos(angle + Math.PI / 2 + 1.2) * r, at[1] + Math.sin(angle + Math.PI / 2 + 1.2) * r]], 0.006, false)];
    for (const f of [-0.6, -0.2, 0.2, 0.6]) {
        const a = angle + Math.PI / 2 + f * 1.2;
        out.push(line([at, [at[0] + Math.cos(a) * r * 0.95, at[1] + Math.sin(a) * r * 0.95]], 0.004));
    }
    return out;
}
/** Crystal points rising from a cavity's wall toward its centre, each lit on one flank: a druse. */
function druse(rng, wall, size, every) {
    const c = centroid(wall);
    const out = [];
    const rim = densify(wall, every);
    for (const p of rim) {
        const [ix, iy] = unit(c[0] - p[0], c[1] - p[1]);
        const l = size * rng.range(0.6, 1.2), b = l * 0.32;
        const tip = [p[0] + ix * l, p[1] + iy * l];
        const left = [p[0] - iy * b, p[1] + ix * b], right = [p[0] + iy * b, p[1] - ix * b];
        out.push({ type: "solid", outline: [p, right, tip], smooth: false }, line([left, tip, right], 0.004, false));
    }
    return out;
}
/** An almond-shaped cavity in the rock, its hollow shaded so the crystals lining it stand out. */
function cavity(rng, at, rx, ry) {
    const phase = rng.range(0, TAU);
    const wall = blob(at, rx, ry, a => 1 + 0.1 * Math.sin(3 * a + phase) - 0.18 * Math.max(0, Math.sin(a)) ** 2, 18, -9);
    return { wall, body: { type: "body", outline: wall, shadow: [], grain: cuts(wall, 0.5, HATCH * 1.3), veins: [], weight: 0.35 } };
}
/** A sharp bipyramid, lit on one flank (sulphur, tin stone). */
function bipyramid(at, size, angle, tone) {
    const local = [[0, 0], [size * 0.28, size * 0.45], [0, size], [-size * 0.28, size * 0.45]];
    const poly = turn(local, angle - Math.PI / 2, at);
    return [face([poly[0], poly[2], poly[3]], Math.max(0, tone - 0.3), 0.4, size / 6), face([poly[0], poly[1], poly[2]], Math.min(1, tone + 0.25), -0.9, size / 6),
        edge(poly, 0.006), line([poly[3], poly[1]], 0.004, false)];
}
/** A cube seen a little from above, three faces shaded. */
function isoCube(at, a, spin, tone) {
    const X = [Math.cos(0.5 + spin) * a * 0.9, Math.sin(0.5 + spin) * a * 0.5];
    const Y = [-Math.cos(0.5 - spin) * a * 0.9, Math.sin(0.5 - spin) * a * 0.5];
    const Z = [0, a * 0.95];
    const add = (...vs) => vs.reduce((p, v) => [p[0] + v[0], p[1] + v[1]], at);
    const left = [add(), add(Z), add(Y, Z), add(Y)], right = [add(), add(X), add(X, Z), add(Z)], top = [add(Z), add(X, Z), add(X, Y, Z), add(Y, Z)];
    return [face(left, Math.min(1, 0.3 + tone * 0.5), 1.4, a / 5), face(right, Math.min(1, 0.6 + tone * 0.4), 0.3, a / 5), face(top, tone * 0.3, 0, a / 5),
        edge(left, 0.006), edge(right, 0.006), edge(top, 0.006)];
}
/** Gypsum's swallowtail twin, the iron-of-a-lance crystal, striated along its length. */
function lanceTwin(at, length, angle) {
    const w = length * 0.3;
    const local = [[0, 0], [w * 0.5, length * 0.12], [w * 0.5, length * 0.82], [w * 0.12, length * 0.62], [0, length], [-w * 0.12, length * 0.62], [-w * 0.5, length * 0.82], [-w * 0.5, length * 0.12]];
    const poly = turn(local, angle - Math.PI / 2, at);
    return [{ type: "body", outline: densify(poly, length / 8), shadow: [], grain: [], veins: [], weight: 0.05 }, edge(poly, 0.007),
        line(turn([[0, length * 0.08], [0, length * 0.95]], angle - Math.PI / 2, at), 0.005), line(turn([[-w * 0.25, length * 0.15], [-w * 0.25, length * 0.7]], angle - Math.PI / 2, at), 0.004)];
}
/** A lens of white vein stuff lying in the rock. */
function lens(at, length, wide, angle) {
    const outline = turn(sample(v => { const a = v * TAU; return [Math.cos(a) * length / 2, Math.sin(a) * wide / 2 * (0.6 + 0.4 * Math.abs(Math.cos(a)))]; }, 16).slice(0, -1), angle, at);
    return [{ type: "body", outline, shadow: [], grain: [], veins: [], weight: 0.02 }];
}
/** Fullness thresholds spread over fullness, for `count` things that come in one after another. */
const comings = (count, from = 0.2, to = 0.95) => Array.from({ length: count }, (_, k) => lerp(from, to, count === 1 ? 0.5 : k / (count - 1)));
const BED_TEXTURES = {
    // The thin dark soil under the ground line.
    soil: (rng, bed) => [piece([bedBody(bed, 0.55, cuts(bed.poly, 0.7, HATCH * 1.15)), speckle(rng, bed, 30, 0.007)])],
    // Plain sand: stippled, with faint bedding.
    sand: (rng, bed) => [piece([bedBody(bed, 0.14), speckle(rng, bed, 16, 0.0075),
            ...laminae(bed, 0.32).flatMap(path => dashed(rng, path, [0.2, 0.6], [0.1, 0.3]).map(run => line(run, 0.005)))])],
    // Sandstone: stippled sets of cross-bedding, each cut off by the erosion surface above it.
    sandstone: (rng, bed, main) => {
        const splits = [0, rng.range(0.28, 0.38), rng.range(0.6, 0.72), 1];
        const shapes = [bedBody(bed, 0.2), speckle(rng, bed, 24, 0.0075)];
        const [x0, x1] = spanOf(bed);
        for (let k = 0; k + 1 < splits.length; k += 1) {
            const set = slice(bed, splits[k], splits[k + 1]);
            const h = thickness(set), sd = k % 2 === 0 ? 1 : -1, reach = h * 2.4;
            for (let s = x0 - reach; s < x1 + reach; s += 0.13) {
                const path = sample(u => { const x = s + sd * u * reach; return [x, within(set, x, (1 - u) ** 2 * 0.98)]; }, 8);
                shapes.push(...inkIn(set, path, 0.005, 0.005));
            }
            if (k > 0)
                shapes.push(line(across(bed, splits[k]), 0.011));
        }
        const out = [piece(shapes)];
        if (main) {
            // Ironstone concretions, ringed like agates, come out of the sandstone.
            comings(3, 0.3, 0.9).forEach((full, k) => {
                const at = [lerp(x0 + 0.8, x1 - 0.8, (k + rng.range(0.2, 0.8)) / 3), 0];
                at[1] = within(bed, at[0], rng.range(0.25, 0.75));
                const r = rng.range(0.12, 0.2);
                const rings = [1, 0.7, 0.42].map(f => closed(blob(at, r * f * 1.3, r * f, a => 1 + 0.06 * Math.sin(3 * a + k), 14, -9)));
                out.push(piece([{ type: "body", outline: rings[0].slice(0, -1), shadow: [], grain: cuts(rings[0], 0.6, HATCH * 0.8), veins: [], weight: 0.5 }, ...rings.slice(1).map(ring => line(ring, 0.006))], full));
            });
        }
        return out;
    },
    // Shale: close laminae, the coal's roof and floor.
    shale: (rng, bed) => [piece([bedBody(bed, 0.42, laminae(bed, 0.045)), ...laminae(bed, 0.15, 0.01, rng).flatMap(path => dashed(rng, path, [0.15, 0.5], [0.05, 0.2]).map(run => line(run, 0.005)))])],
    // The coal's roof: shale with a thin rider seam, and fern fronds pressed in it as the day fills.
    roof: (rng, bed) => {
        const out = BED_TEXTURES.shale(rng, bed, false);
        out.push(piece([{ type: "solid", outline: slice(bed, 0.3, 0.34).poly }]));
        const [x0, x1] = spanOf(bed);
        comings(3, 0.25, 0.85).forEach((full, k) => {
            const x = lerp(x0 + 0.4, x1 - 1.2, (k + rng.range(0.1, 0.6)) / 3);
            out.push(piece(fern(rng, [x, within(bed, x, k % 2 === 0 ? 0.6 : 0.2)], rng.range(1.0, 1.3), rng.sym(0.2)), full));
        });
        return out;
    },
    // The coal seam: solid black, as the plates ink it.
    coal: (_rng, bed) => [piece([{ type: "solid", outline: densify(bed.poly, 0.15) }])],
    // The seat earth under a coal seam, threaded with the fossil rootlets of the coal forest.
    underclay: (rng, bed) => {
        const shapes = [bedBody(bed, 0.22, laminae(bed, 0.12))];
        const [x0, x1] = spanOf(bed);
        for (let k = 0; k < 14; k += 1) {
            const x = rng.range(x0 + 0.1, x1 - 0.1), top = within(bed, x, 0.96), len = rng.range(0.2, 0.55), lean = rng.sym(0.3);
            shapes.push(...inkIn(bed, sample(v => [x + lean * len * v + 0.02 * Math.sin(v * 9), top - len * v], 5), 0.005));
        }
        return [piece(shapes)];
    },
    // Quiet clay: smooth, finely laminated.
    mud: (rng, bed) => [piece([bedBody(bed, 0.3, laminae(bed, 0.09)), ...laminae(bed, 0.3, 0.008, rng).flatMap(path => dashed(rng, path, [0.3, 0.8], [0.1, 0.3]).map(run => line(run, 0.005)))])],
    // Clay: smooth beds whose top dried and parted in wedge cracks; septarian nodules come in as the day fills.
    clay: (rng, bed, main) => {
        const out = BED_TEXTURES.mud(rng, bed, false);
        const [x0, x1] = spanOf(bed);
        const cracks = [];
        for (let x = x0 + rng.range(0.2, 0.5); x < x1 - 0.15; x += rng.range(0.32, 0.62)) {
            const top = heightAt(bed.top, x), depth = Math.min(rng.range(0.25, 0.55), thickness(bed) * 0.5), w = rng.range(0.018, 0.034), kink = rng.sym(0.04);
            cracks.push({ type: "solid", outline: [[x - w, top + 0.01], [x + w, top + 0.01], [x + kink + w * 0.3, top - depth * 0.5], [x + kink * 0.5, top - depth], [x + kink - w * 0.3, top - depth * 0.5]], smooth: false });
        }
        out.push(piece(cracks));
        if (main) {
            comings(3, 0.3, 0.85).forEach((full, k) => {
                const at = [lerp(x0 + 0.6, x1 - 0.6, (k + rng.range(0.2, 0.8)) / 3), 0];
                at[1] = within(bed, at[0], rng.range(0.2, 0.5));
                const rx = rng.range(0.28, 0.4), ry = rx * rng.range(0.35, 0.45);
                const outline = blob(at, rx, ry, a => 1 + 0.04 * Math.sin(5 * a + k), 18, -9);
                const veins = [];
                for (let j = 0; j < 7; j += 1) {
                    const a = j / 7 * TAU + rng.sym(0.3);
                    veins.push([[at[0] + Math.cos(a) * rx * 0.15, at[1] + Math.sin(a) * ry * 0.15], [at[0] + Math.cos(a) * rx * 0.8, at[1] + Math.sin(a) * ry * 0.75]]);
                }
                out.push(piece([{ type: "body", outline, shadow: [], grain: cuts(outline, 0.2, HATCH * 1.1), veins, weight: 0.35 }], full));
            });
        }
        return out;
    },
    // Limestone: thick beds parted by bedding planes and joints, like courses of masonry, with shells.
    limestone: (rng, bed, main) => {
        const shapes = [bedBody(bed, 0.16, cuts(bed.poly, 0.02, HATCH * 1.7))];
        const count = Math.max(1, Math.round(thickness(bed) / rng.range(0.55, 0.75)));
        const planes = Array.from({ length: count + 1 }, (_, k) => k === 0 ? 0 : k === count ? 1 : (k + rng.sym(0.2)) / count);
        const [x0, x1] = spanOf(bed);
        for (let k = 0; k < count; k += 1) {
            if (k > 0)
                shapes.push(line(across(bed, planes[k], 0.02, rng.range(0, 9)), 0.011));
            for (let x = x0 + rng.range(0.2, 0.9); x < x1 - 0.1; x += rng.range(0.7, 1.2)) {
                const lean = rng.sym(0.06);
                shapes.push(line([[x, within(bed, x, planes[k] + 0.01)], [x + lean, within(bed, x + lean, planes[k + 1] - 0.01)]], 0.009));
            }
        }
        for (const p of scatter(rng, bed.poly, Math.round(Math.abs(area(bed.poly)) * 0.5))) {
            if (!inBed(bed, p, 0.08))
                continue;
            shapes.push(...(rng.chance(0.35) ? coil(p, rng.range(0.04, 0.07), false) : valve(p, rng.range(0.035, 0.06), rng.sym(0.6))));
        }
        const out = [piece(shapes)];
        if (main) {
            // White calcite veins and a large ammonite come in as the day fills.
            comings(2, 0.25, 0.6).forEach((full, k) => {
                const x = lerp(x0 + 0.8, x1 - 0.8, k + rng.range(-0.1, 0.1)), q = rng.range(0.3, 0.7);
                out.push(piece(lens([x, within(bed, x, q)], rng.range(0.8, 1.3), 0.06, rng.sym(0.9) + (k === 0 ? 0.6 : -0.6)), full));
            });
            const at = [lerp(x0, x1, rng.range(0.3, 0.7)), 0];
            at[1] = within(bed, at[0], rng.range(0.3, 0.6));
            out.push(piece(coil(at, 0.2, true), 0.85));
        }
        return out;
    },
    // Chalk: almost bare paper, faint bedding, and rows of black flint nodules along its planes.
    chalk: (rng, bed, main) => {
        const shapes = [bedBody(bed, 0.04), speckle(rng, bed, 5, 0.006)];
        const rows = rng.int(3, 4);
        const [x0, x1] = spanOf(bed);
        const big = [];
        for (let k = 0; k < rows; k += 1) {
            const q = (k + 0.5 + rng.sym(0.15)) / rows;
            shapes.push(...dashed(rng, across(bed, q + 0.5 / rows, 0.02), [0.3, 0.9], [0.15, 0.4]).map(run => line(run, 0.005)));
            for (let x = x0 + rng.range(0.15, 0.5); x < x1 - 0.2; x += rng.range(0.45, 0.85)) {
                const rx = rng.range(0.09, 0.2), ry = rx * rng.range(0.45, 0.7), at = [x + rx, within(bed, x + rx, q)];
                if (!inBed(bed, at, ry + 0.05) || at[0] + rx > x1 - 0.05)
                    continue;
                const phase = rng.range(0, TAU);
                const knob = (a) => 1 + 0.16 * Math.sin(3 * a + phase) + 0.1 * Math.sin(5 * a + phase * 2);
                shapes.push({ type: "body", outline: blob(at, rx, ry, knob, 16, -9), shadow: [], grain: [], veins: [], weight: 0.12 }, { type: "solid", outline: blob([at[0] + rx * 0.05, at[1] - ry * 0.05], rx * 0.78, ry * 0.72, knob, 16, -9) });
                if (rx > 0.16)
                    big.push({ at, rx, ry });
            }
        }
        const out = [piece(shapes)];
        if (main) {
            // Broken nodules show a hollow lined with quartz crystals.
            big.slice(0, 3).forEach(({ at, rx, ry }, k) => {
                const hollow = blob(at, rx * 0.5, ry * 0.42, a => 1 + 0.08 * Math.sin(4 * a + k), 14, -9);
                out.push(piece([{ type: "body", outline: hollow, shadow: [], grain: [], veins: [], weight: 0.02 }, ...druse(rng, hollow, rx * 0.12, rx * 0.07)], comings(3, 0.3, 0.9)[k]));
            });
            const q = rng.range(0.1, 0.2);
            out.push(piece([{ type: "solid", outline: slice(bed, q, q + 0.012).poly }], 0.5));
        }
        return out;
    },
    // Marble: massive and pale, veined in long meanders that branch; crackle and a calcite druse come in.
    marble: (rng, bed, main) => {
        const [x0, x1] = spanOf(bed);
        const vein = (q0, q1, w) => {
            const phase = rng.range(0, TAU), wobble = rng.range(0.05, 0.12);
            const path = sample(v => { const x = lerp(x0 - 0.1, x1 + 0.1, v); return [x, within(bed, clamp(x, x0, x1), lerp(q0, q1, v)) + Math.sin(v * 9 + phase) * wobble + Math.sin(v * 23 + phase) * wobble * 0.3]; }, 40);
            const runs = runsWhere(path, p => inBed(bed, p, 0.02));
            const out = runs.filter(run => run.length > 2).map(run => ({ type: "solid", outline: ribbon(run, u => w * (0.4 + 0.6 * Math.sin(Math.PI * u) ** 0.5) * (0.7 + 0.3 * Math.sin(u * 17 + phase))) }));
            // Branches split from the vein, and a cloud of fine grain gathers along it.
            for (let k = 0; k < 5; k += 1) {
                const from = path[rng.int(4, 36)], a = rng.sym(1.2) + (rng.chance(0.5) ? 0 : Math.PI), len = rng.range(0.3, 0.9);
                out.push(...inkIn(bed, sample(v => [from[0] + Math.cos(a) * len * v, from[1] + Math.sin(a) * len * v * 0.5 + Math.sin(v * 7) * 0.03], 6), w * 0.3, 0.02));
            }
            out.push({ type: "dots", points: Array.from({ length: 40 }, () => { const p = path[rng.int(0, 40)]; return [p[0] + rng.sym(0.08), p[1] + rng.sym(0.1)]; }).filter(p => inBed(bed, p, 0.02)), radius: 0.005 });
            return out;
        };
        const out = [piece([bedBody(bed, 0.06), speckle(rng, bed, 6, 0.005), ...vein(rng.range(0.7, 0.9), rng.range(0.35, 0.55), 0.042),
                ...vein(rng.range(0.15, 0.35), rng.range(0.45, 0.65), 0.026), ...vein(rng.range(0.45, 0.6), rng.range(0.05, 0.2), 0.018)])];
        if (main) {
            out.push(piece(vein(rng.range(0.7, 0.9), rng.range(0.6, 0.8), 0.012), 0.3));
            const crackle = [];
            for (let k = 0; k < 16; k += 1) {
                const p = scatter(rng, bed.poly, 1)[0];
                if (p)
                    crackle.push(...inkIn(bed, [p, [p[0] + rng.sym(0.25), p[1] + rng.sym(0.2)], [p[0] + rng.sym(0.4), p[1] + rng.sym(0.3)]], 0.004, 0.03));
            }
            out.push(piece(crackle, 0.55));
            const at = [lerp(x0, x1, rng.range(0.3, 0.7)), 0];
            at[1] = within(bed, at[0], rng.range(0.2, 0.4));
            const hole = cavity(rng, at, 0.32, 0.17);
            out.push(piece([hole.body, ...druse(rng, hole.wall, 0.07, 0.04)], 0.8));
        }
        return out;
    },
    // Granite: no beds, a mosaic of interlocking crystals, felspar cleaved, mica black, quartz clear;
    // joints part it, and a quartz vein and felspar megacrysts come in as the day fills.
    granite: (rng, bed, main) => {
        const shapes = [bedBody(bed, 0.12)];
        const [x0, x1] = spanOf(bed);
        const g = 0.17, top = Math.max(...bed.top.map(p => p[1]));
        const cols = Math.ceil((x1 - x0) / g) + 2, rows = Math.ceil((top - FLOOR) / (g * 0.9)) + 2;
        // A jittered lattice whose cells are the crystals: neighbours share their edges, so the grains interlock.
        const node = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => [x0 - g + c * g + (r % 2) * g * 0.5 + rng.sym(g * 0.38), FLOOR - g * 0.5 + r * g * 0.9 + rng.sym(g * 0.32)]));
        // Edges run as long polylines along the lattice's rows and columns, broken where an edge is left out,
        // so that a few crystals are larger, twinned felspars.
        const chain = (points, skip) => {
            let run = [points[0]];
            const flush = () => {
                if (run.length > 1)
                    for (const part of runsWhere(densify(run, g / 2, false).concat([run[run.length - 1]]), p => inBed(bed, p, 0.01)))
                        shapes.push(line(part, 0.005, false));
            };
            for (const p of points.slice(1)) {
                if (rng.chance(skip)) {
                    flush();
                    run = [p];
                }
                else
                    run.push(p);
            }
            flush();
        };
        for (const row of node)
            chain(row, 0.22);
        for (let c = 0; c < cols; c += 1)
            chain(node.map(row => row[c]), 0.2);
        for (let r = 0; r + 1 < rows; r += 1) {
            for (let c = 0; c + 1 < cols; c += 1) {
                const cell = [node[r][c], node[r][c + 1], node[r + 1][c + 1], node[r + 1][c]];
                const [cx, cy] = centroid(cell);
                const kind = rng.u();
                if (!inBed(bed, [cx, cy], g * 0.6))
                    continue;
                // Mica: a black flake turned its own way within the crystal's place.
                if (kind < 0.2)
                    shapes.push({ type: "solid", outline: polygonAt([cx, cy], rng.range(0.025, 0.04), 6, rng.range(0, TAU), rng, rng.range(1.1, 1.6)), smooth: false });
                else if (kind < 0.5) {
                    // Felspar's cleavage: two short parallel cuts across the crystal.
                    const angle = rng.range(0, Math.PI), dx = Math.cos(angle) * g * 0.28, dy = Math.sin(angle) * g * 0.28, ox = -dy * 0.45, oy = dx * 0.45;
                    for (const sd of [1, -1])
                        shapes.push(line([[cx - dx + ox * sd, cy - dy + oy * sd], [cx + dx + ox * sd, cy + dy + oy * sd]], 0.004, false));
                }
            }
        }
        for (const q of [0.78, 0.5])
            shapes.push(...inkIn(bed, across(bed, q + rng.sym(0.06), 0.06, rng.range(0, 9)), 0.009, 0.01));
        for (let k = 0; k < 2; k += 1) {
            const x = lerp(x0, x1, (k + rng.range(0.3, 0.7)) / 2), lean = rng.sym(0.3);
            shapes.push(...inkIn(bed, sample(v => [x + lean * v + 0.05 * Math.sin(v * 6), lerp(FLOOR, GROUND, v)], 10), 0.009, 0.01));
        }
        const out = [piece(shapes)];
        if (main) {
            const a = rng.range(0.25, 0.5) * (rng.chance(0.5) ? 1 : -1), xm = lerp(x0, x1, rng.range(0.35, 0.65)), ym = lerp(FLOOR, GROUND, 0.45);
            const band = (o) => sample(v => { const s = (v - 0.5) * 7; return [xm + Math.cos(a) * s - Math.sin(a) * o, ym + Math.sin(a) * s + Math.cos(a) * o + 0.03 * Math.sin(s * 3)]; }, 40);
            const lower = band(-0.07), upper = band(0.07);
            const poly = [...lower, ...upper.slice().reverse()].filter(p => inBed(bed, p, 0.01));
            if (poly.length > 6)
                out.push(piece([{ type: "body", outline: poly, shadow: [], grain: [], veins: [], weight: 0.02 }, ...inkIn(bed, lower, 0.008, 0.01), ...inkIn(bed, upper, 0.008, 0.01)], 0.35));
            comings(3, 0.5, 0.9).forEach(full => {
                const p = scatter(rng, bed.poly, 1)[0];
                if (!p || !inBed(bed, p, 0.2))
                    return;
                const r = rng.range(0.1, 0.14), spin = rng.sym(0.5);
                const rect = turn([[-r * 1.6, -r * 0.7], [r * 1.6, -r * 0.7], [r * 1.6, r * 0.7], [-r * 1.6, r * 0.7]], spin, p);
                out.push(piece([{ type: "body", outline: densify(rect, r / 2), shadow: [], grain: cuts(rect, spin + 0.8, HATCH * 1.3), veins: [], weight: 0.2 }, edge(rect, 0.008), line(turn([[-r * 1.6, 0], [r * 1.6, 0]], spin, p), 0.006)], full));
            });
        }
        return out;
    },
    // Slate: steep cleavage cutting across its faint beds; quartz lenses and pyrite cubes come in.
    slate: (rng, bed, main) => {
        const cleave = Math.PI / 2 - rng.range(0.25, 0.45);
        const shapes = [bedBody(bed, 0.5, cuts(bed.poly, cleave, HATCH * 1.05))];
        for (const path of cuts(bed.poly, cleave, 0.17))
            shapes.push(...inkIn(bed, densify(path, 0.15, false).concat([path[1]]), 0.006));
        for (const path of laminae(bed, 0.4, 0.02, rng))
            shapes.push(...dashed(rng, path, [0.1, 0.35], [0.1, 0.3]).map(run => line(run, 0.009)));
        const out = [piece(shapes)];
        if (main) {
            comings(3, 0.25, 0.65).forEach(full => {
                const p = scatter(rng, bed.poly, 1)[0];
                if (p && inBed(bed, p, 0.2))
                    out.push(piece(lens(p, rng.range(0.4, 0.8), rng.range(0.07, 0.11), rng.sym(0.15)), full));
            });
            comings(4, 0.5, 0.95).forEach(full => {
                const p = scatter(rng, bed.poly, 1)[0];
                if (p && inBed(bed, p, 0.15))
                    out.push(piece(isoCube(p, rng.range(0.06, 0.09), rng.sym(0.2), 0.7), full));
            });
        }
        return out;
    },
    // Basalt: the lava's prismatic columns, each lit on one face and cut across by cupped joints, under
    // the flow's rubbly crust blown with gas holes; zeolite amygdales fill some holes as the day fills.
    basalt: (rng, bed, main) => {
        const [x0, x1] = spanOf(bed);
        const columns = slice(bed, 0, 0.8), crust = slice(bed, 0.8, 1);
        const shapes = [];
        const xc = (x0 + x1) / 2;
        const joints = [x0];
        for (let x = x0 + rng.range(0.3, 0.5); x < x1 - 0.25; x += rng.range(0.38, 0.52))
            joints.push(x);
        joints.push(x1);
        const jointAt = (k, q) => {
            const x = joints[k];
            if (k === 0 || k === joints.length - 1)
                return [x, within(columns, x, q)];
            const xx = x + (x - xc) * 0.05 * (q - 0.5) + 0.025 * Math.sin(q * 7 + k);
            return [xx, within(columns, xx, q)];
        };
        const qs = Array.from({ length: 13 }, (_, k) => k / 12);
        for (let k = 0; k + 1 < joints.length; k += 1) {
            const left = qs.map(q => jointAt(k, q)), right = qs.map(q => jointAt(k + 1, q));
            const mid = qs.map((q, j) => { const x = lerp(left[j][0], right[j][0], 0.42); return [x, within(columns, x, q)]; });
            const lit = [...left, ...mid.slice().reverse()], dark = [...mid, ...right.slice().reverse()];
            shapes.push({ type: "body", outline: densify(lit, 0.12), shadow: [], grain: cuts(lit, Math.PI / 2, HATCH * 2.3), veins: [], weight: 0.25 }, { type: "body", outline: densify(dark, 0.12), shadow: [], grain: cuts(dark, Math.PI / 2, HATCH * 0.95), veins: [], weight: 0.6 });
            for (let q = rng.range(0.12, 0.3); q < 0.9; q += rng.range(0.18, 0.32)) {
                const a = jointAt(k, q), b = jointAt(k + 1, q), m = [lerp(a[0], b[0], 0.5), lerp(a[1], b[1], 0.5) + 0.05];
                shapes.push(line([a, m, b], 0.008));
            }
        }
        const pits = scatter(rng, crust.poly, Math.round(Math.abs(area(crust.poly)) * 34)).filter(p => inBed(crust, p, 0.025));
        const half = Math.floor(pits.length / 2);
        shapes.push(bedBody(crust, 0.28, cuts(crust.poly, 0.7, HATCH * 2.8)), { type: "dots", points: pits.slice(0, half), radius: 0.024 }, { type: "dots", points: pits.slice(half), radius: 0.011 }, ...pits.slice(0, 16).map(p => line(closed(polygonAt(p, 0.04, 7, 0, rng)), 0.006)));
        const out = [piece(shapes)];
        if (main) {
            comings(5, 0.2, 0.95).forEach(full => {
                const p = scatter(rng, crust.poly, 1)[0];
                if (!p || !inBed(crust, p, 0.07))
                    return;
                const rx = rng.range(0.05, 0.075), ry = rx * 0.6;
                const outline = blob(p, rx, ry, a => 1 + 0.15 * Math.max(0, Math.sin(a)) ** 3, 12, -9);
                const veins = Array.from({ length: 6 }, (_, j) => { const a = Math.PI * (0.15 + 0.7 * j / 5) + Math.PI; return [[p[0], p[1] + ry * 0.9], [p[0] + Math.cos(a) * rx * 0.9, p[1] + ry * 0.9 + Math.sin(a) * ry * 1.6]]; });
                out.push(piece([{ type: "body", outline, shadow: [], grain: [], veins, weight: 0.02 }, edge(outline, 0.008)], full));
            });
        }
        return out;
    },
    // Volcanic tuff under the flow: ash with angular fragments.
    tuff: (rng, bed) => {
        const shapes = [bedBody(bed, 0.26, cuts(bed.poly, 0.7, HATCH * 1.6)), speckle(rng, bed, 26, 0.007)];
        for (const p of strew(rng, bed, 0.42, 0.08))
            shapes.push(edge(polygonAt(p, rng.range(0.035, 0.08), rng.int(3, 5), rng.range(0, TAU), rng, 1.3), 0.006));
        return [piece(shapes)];
    },
    // Marl: thin beds, alternately grey and pale and crumbling; small selenite crystals come in.
    marl: (rng, bed, main) => {
        const shapes = [];
        const count = Math.max(2, Math.round(thickness(bed) / rng.range(0.14, 0.22)));
        for (let k = 0; k < count; k += 1) {
            const part = slice(bed, k / count, (k + 1) / count);
            if (k % 2 === 0)
                shapes.push(bedBody(part, 0.36, laminae(part, 0.04)));
            else {
                shapes.push(bedBody(part, 0.08));
                for (const p of scatter(rng, part.poly, Math.round(Math.abs(area(part.poly)) * 12)))
                    shapes.push(line([p, [p[0] + rng.range(0.03, 0.07), p[1] + rng.sym(0.01)]], 0.005));
            }
        }
        const out = [piece(shapes)];
        if (main) {
            const [x0, x1] = spanOf(bed);
            comings(4, 0.25, 0.9).forEach((full, k) => {
                const x = lerp(x0 + 0.4, x1 - 0.4, (k + rng.range(0.2, 0.8)) / 4);
                out.push(piece(lanceTwin([x, within(bed, x, rng.range(0.2, 0.7))], rng.range(0.22, 0.32), Math.PI / 2 + rng.sym(0.6)), full));
            });
            for (const p of scatter(rng, bed.poly, 4))
                if (inBed(bed, p, 0.08))
                    out[0].shapes.push(...valve(p, rng.range(0.04, 0.06), rng.sym(0.4)));
        }
        return out;
    },
    // Gypsum, the plaster stone: massive, split in tall prisms, banded with satin-spar veins of fibres;
    // the swallowtail crystals come in as the day fills.
    gypsum: (rng, bed, main) => {
        const shapes = [bedBody(bed, 0.08), speckle(rng, bed, 10, 0.006)];
        const [x0, x1] = spanOf(bed);
        const veins = [rng.range(0.2, 0.3), rng.range(0.62, 0.72)];
        for (let x = x0 + rng.range(0.1, 0.3); x < x1 - 0.1; x += rng.range(0.22, 0.4)) {
            const lean = rng.sym(0.04);
            shapes.push(...inkIn(bed, sample(v => [x + lean * v + 0.012 * Math.sin(v * 11 + x), within(bed, x, lerp(veins[1] + 0.05, 0.98, v))], 6), 0.006));
            if (rng.chance(0.5))
                shapes.push(...inkIn(bed, sample(v => [x + lean * v, within(bed, x, lerp(veins[0] + 0.05, veins[1] - 0.02, v))], 5), 0.005));
        }
        for (const q of veins) {
            const band = slice(bed, q, q + 0.045);
            shapes.push(bedBody(band, 0.02));
            for (let x = x0 + 0.02; x < x1 - 0.02; x += 0.03)
                shapes.push(line([[x, within(band, x, 0.08)], [x + 0.008, within(band, x + 0.008, 0.92)]], 0.003, false));
        }
        const out = [piece(shapes)];
        if (main) {
            comings(5, 0.2, 0.95).forEach((full, k) => {
                const x = lerp(x0 + 0.4, x1 - 0.4, (k + rng.range(0.2, 0.8)) / 5);
                out.push(piece(lanceTwin([x, within(bed, x, rng.range(0.3, 0.45))], rng.range(0.4, 0.55), Math.PI / 2 + rng.sym(0.5)), full));
            });
        }
        return out;
    },
    // Rock salt: a grey bed full of cubes, parted by clay; hopper cubes come in as the day fills.
    salt: (rng, bed, main) => {
        const shapes = [bedBody(bed, 0.16)];
        for (const p of strew(rng, bed, 0.24, 0.1)) {
            const a = rng.range(0.05, 0.1), spin = rng.sym(0.25);
            const square = turn([[-a, -a], [a, -a], [a, a], [-a, a]], spin, p);
            shapes.push(line(closed(square), 0.007, false));
            if (rng.chance(0.35))
                shapes.push(line(closed(turn([[-a * 0.5, -a * 0.5], [a * 0.5, -a * 0.5], [a * 0.5, a * 0.5], [-a * 0.5, a * 0.5]], spin, p)), 0.004, false));
        }
        for (const q of [rng.range(0.3, 0.4), rng.range(0.65, 0.75)])
            shapes.push(line(across(bed, q, 0.03, rng.range(0, 9)), 0.012));
        const out = [piece(shapes)];
        if (main) {
            comings(3, 0.3, 0.9).forEach(full => {
                const p = scatter(rng, bed.poly, 1)[0];
                if (!p || !inBed(bed, p, 0.22))
                    return;
                const a = rng.range(0.13, 0.18), spin = rng.sym(0.2);
                const square = turn([[-a, -a], [a, -a], [a, a], [-a, a]], spin, p);
                out.push(piece([{ type: "body", outline: densify(square, a / 3), shadow: [], grain: [], veins: [], weight: 0.02 }, edge(square, 0.01),
                    ...[0.7, 0.45, 0.22].map(f => line(closed(turn([[-a * f, -a * f], [a * f, -a * f], [a * f, a * f], [-a * f, a * f]], spin, p)), 0.005, false))], full));
            });
        }
        return out;
    },
    // Sulphur in its limestone: stippled seams and nodules, and cavities that grow lined with
    // bipyramids as the day fills.
    sulphur: (rng, bed, main) => {
        const shapes = [bedBody(bed, 0.2, cuts(bed.poly, 0.3, HATCH * 2.4))];
        for (const q of [rng.range(0.12, 0.2), rng.range(0.82, 0.9)]) {
            const seam = slice(bed, q, q + 0.08);
            shapes.push(bedBody(seam, 0.04), speckle(rng, seam, 140, 0.006));
        }
        const [x0, x1] = spanOf(bed);
        const out = [piece(shapes)];
        const holes = [0, 1, 2].map(k => {
            const at = [lerp(x0 + 0.7, x1 - 0.7, (k + rng.range(0.3, 0.7)) / 3), 0];
            at[1] = within(bed, at[0], rng.range(0.38, 0.62));
            return { at, rx: rng.range(0.4, 0.52), ry: rng.range(0.2, 0.26) };
        });
        for (const { at, rx, ry } of holes) {
            const hole = cavity(rng, at, rx, ry);
            out[0].shapes.push(hole.body, { type: "dots", points: scatter(rng, blob(at, rx * 1.25, ry * 1.4, () => 1, 14, -9), 26).filter(p => !inside(p, hole.wall)), radius: 0.006 });
            if (!main)
                continue;
            // The crystals rise from the cavity's floor, the tallest in the middle; the first is there from the start.
            const floor = hole.wall.filter(p => p[1] < at[1] - ry * 0.3).slice(1, -1);
            floor.forEach((p, j) => {
                const taper = 1 - Math.abs(j - (floor.length - 1) / 2) / floor.length;
                const first = j === Math.floor(floor.length / 2);
                out.push(piece(bipyramid([p[0], p[1] - 0.01], Math.min(ry * 1.7, rng.range(0.26, 0.36)) * taper, Math.PI / 2 + (j - (floor.length - 1) / 2) * 0.18 + rng.sym(0.15), 0.2), first ? 0 : lerp(0.2, 0.95, rng.u())));
            });
        }
        return out;
    },
    // Saltpetre: a soft stone face on which nitre blooms in tufts of needles, more as the day fills.
    nitre: (rng, bed, main) => {
        const shapes = [bedBody(bed, 0.1), speckle(rng, bed, 8, 0.006)];
        const planes = laminae(bed, 0.45, 0.02, rng);
        for (const path of planes)
            shapes.push(...dashed(rng, path, [0.3, 0.9], [0.1, 0.3]).map(run => line(run, 0.006)));
        const out = [piece(shapes)];
        const [x0, x1] = spanOf(bed);
        const tufts = [];
        for (const path of planes)
            for (let x = x0 + rng.range(0.2, 0.5); x < x1 - 0.2; x += rng.range(0.45, 0.8))
                tufts.push([x, heightAt(path, x)]);
        tufts.forEach((foot, k) => {
            const needles = [];
            const count = rng.int(8, 14);
            for (let j = 0; j < count; j += 1) {
                const a = Math.PI / 2 + rng.sym(1.1), l = rng.range(0.06, 0.16) * (1 - 0.35 * Math.abs(a - Math.PI / 2));
                needles.push([foot, [foot[0] + Math.cos(a) * l, foot[1] + Math.sin(a) * l]]);
            }
            const crust = { type: "dots", points: Array.from({ length: 6 }, () => [foot[0] + rng.sym(0.08), foot[1] + rng.range(-0.02, 0.03)]), radius: 0.008 };
            const shapesOf = [crust, ...needles.map(n => line(n, 0.004, false))];
            out.push(piece(shapesOf, main ? (k % 3 === 0 ? 0 : lerp(0.15, 0.95, rng.u())) : 0));
        });
        return out;
    },
    // Peat: dark, matted, fibrous layers with plant remains; a bog-oak log comes in as the day fills.
    peat: (rng, bed, main) => {
        const [x0, x1] = spanOf(bed);
        // A pale reed or sedge stem pressed flat into the peat, jointed at its nodes.
        const reed = () => {
            const x = rng.range(x0 + 0.2, x1 - 0.2), q = rng.range(0.15, 0.85), a = rng.sym(0.35), len = rng.range(0.4, 0.9), w = rng.range(0.016, 0.026);
            const path = sample(v => { const px = x + Math.cos(a) * len * (v - 0.5); return [px, within(bed, clamp(px, x0, x1), q) + Math.sin(a) * len * (v - 0.5) * 0.4 + 0.02 * Math.sin(v * 5)]; }, 6);
            if (!path.every(p => inBed(bed, p, w + 0.01)))
                return [];
            const nodes = [0.3, 0.65].map(f => { const p = path[Math.round(f * 6)]; return [[p[0], p[1] - w], [p[0], p[1] + w]]; });
            return [{ type: "body", outline: ribbon(path, u => w * 2 * (1 - 0.4 * u)), shadow: [], grain: [], veins: nodes, weight: 0.05 }];
        };
        const shapes = [bedBody(bed, 0.85, [...laminae(bed, 0.045, 0.012, rng), ...cuts(bed.poly, 0.9, HATCH * 1.2)])];
        for (let k = 0; k < 9; k += 1)
            shapes.push(...reed());
        const out = [piece(shapes)];
        if (main) {
            const more = [];
            for (let k = 0; k < 6; k += 1)
                more.push(...reed());
            out.push(piece(more, 0.35));
            const xa = lerp(x0, x1, rng.range(0.1, 0.35)), length = rng.range(1.6, 2.2), q = rng.range(0.35, 0.55), half = 0.13;
            const lower = sample(v => { const x = xa + length * v; return [x, within(bed, x, q) - half]; }, 10), upper = sample(v => { const x = xa + length * v; return [x, within(bed, x, q) + half]; }, 10);
            const log = [...lower, ...upper.slice().reverse()];
            const end = upper[upper.length - 1], endAt = [end[0], end[1] - half];
            const rings = [1, 0.66, 0.33].map(f => closed(blob(endAt, half * 0.45 * f, half * f, () => 1, 14, -9)));
            const grain = Array.from({ length: 6 }, (_, j) => sample(v => { const x = xa + length * v; return [x, within(bed, x, q) - half + (j + 0.5) / 6 * half * 2 + 0.01 * Math.sin(v * 13 + j)]; }, 10));
            out.push(piece([{ type: "body", outline: densify(log, 0.12), shadow: [], grain, veins: [], weight: 0.2 },
                { type: "body", outline: rings[0].slice(0, -1), shadow: [], grain: [], veins: rings.slice(1), weight: 0.1 }], 0.7));
        }
        return out;
    },
    // Topsoil: dark and crumbly, threaded with roots; worm burrows come in as the day fills.
    loam: (rng, bed, main) => {
        const shapes = [bedBody(bed, 0.5, cuts(bed.poly, 0.6, HATCH * 1.2)), speckle(rng, bed, 40, 0.008), speckle(rng, bed, 40, 0.004)];
        const [x0, x1] = spanOf(bed);
        for (let k = 0; k < 7; k += 1) {
            const x = lerp(x0 + 0.2, x1 - 0.2, (k + rng.range(0.2, 0.8)) / 7), top = heightAt(bed.top, x), len = thickness(bed) * rng.range(0.5, 0.9);
            const root = sample(v => [x + 0.06 * Math.sin(v * 5 + k) + rng.sym(0.01), top - len * v], 7);
            shapes.push(...inkIn(bed, root, 0.007));
            const fork = root[3];
            shapes.push(...inkIn(bed, [fork, [fork[0] + rng.sym(0.2), fork[1] - len * 0.3]], 0.004));
        }
        const out = [piece(shapes)];
        if (main) {
            comings(3, 0.3, 0.9).forEach(full => {
                const x = rng.range(x0 + 0.4, x1 - 0.4), q = rng.range(0.2, 0.7), phase = rng.range(0, TAU);
                const path = sample(v => [x + (v - 0.5) * 0.8, within(bed, x, q) + 0.08 * Math.sin(v * 6 + phase)], 12);
                out.push(piece([...inkIn(bed, path.map(([px, py]) => [px, py + 0.018]), 0.005), ...inkIn(bed, path.map(([px, py]) => [px, py - 0.018]), 0.005)], full));
            });
        }
        return out;
    },
    // Subsoil: paler, with water-worn pebbles.
    subsoil: (rng, bed) => {
        const shapes = [bedBody(bed, 0.22, cuts(bed.poly, 0.6, HATCH * 2)), speckle(rng, bed, 18, 0.006)];
        for (const p of strew(rng, bed, 0.55, 0.12)) {
            const rx = rng.range(0.05, 0.12), ry = rx * rng.range(0.55, 0.8);
            shapes.push(rounded(blob(p, rx, ry, () => 1, 12, -9), p, rx, ry, 0.45, 0.3), edge(blob(p, rx, ry, () => 1, 12, -9), 0.006));
        }
        return [piece(shapes)];
    },
    // Manure spread over the field: a dark bed full of straws, hollow and jointed.
    manure: (rng, bed) => {
        const shapes = [bedBody(bed, 0.7, [...cuts(bed.poly, 0.5, HATCH * 0.9), ...cuts(bed.poly, -0.6, HATCH * 1.3)])];
        for (const p of scatter(rng, bed.poly, 34)) {
            const a = rng.sym(0.5), len = rng.range(0.25, 0.55), w = rng.range(0.012, 0.018);
            const strip = turn([[-len / 2, -w], [len / 2, -w], [len / 2, w], [-len / 2, w]], a, p);
            if (!strip.every(q => inBed(bed, q, 0.01)))
                continue;
            shapes.push({ type: "body", outline: densify(strip, len / 6), shadow: [], grain: [], veins: [turn([[rng.sym(len * 0.3), -w], [0, w]], a, p)], weight: 0.05 });
        }
        return [piece(shapes)];
    },
    // Bituminous sand with a lens of pitch; pitch seeps along a fault in drops as the day fills.
    bitumen: (rng, bed, main) => {
        const [x0, x1] = spanOf(bed);
        const shapes = [bedBody(bed, 0.55, cuts(bed.poly, 0.4, HATCH * 0.8)), speckle(rng, bed, 20, 0.007)];
        const xm = lerp(x0, x1, rng.range(0.3, 0.6)), length = rng.range(1.6, 2.2), q = rng.range(0.35, 0.6), h = Math.min(0.2, thickness(bed) * 0.3);
        const lower = sample(v => { const x = xm + (v - 0.5) * length; return [x, within(bed, x, q) - h * Math.sin(Math.PI * v) ** 0.7]; }, 12);
        const upper = sample(v => { const x = xm + (v - 0.5) * length; return [x, within(bed, x, q) + h * 0.7 * Math.sin(Math.PI * v) ** 0.7]; }, 12);
        shapes.push({ type: "solid", outline: [...lower, ...upper.slice(1, -1).reverse()] });
        for (const [f, s] of [[0.3, 0.16], [0.62, 0.1]]) {
            const at = [xm + (f - 0.5) * length, within(bed, xm + (f - 0.5) * length, q) + h * 0.15];
            shapes.push({ type: "body", outline: blob(at, s, 0.018, a => 1 + 0.3 * Math.sin(a), 10, -9), shadow: [], grain: [], veins: [], weight: 0.02 });
        }
        const fx = lerp(x0, x1, rng.range(0.6, 0.8)), lean = rng.range(0.25, 0.45) * (rng.chance(0.5) ? 1 : -1);
        const fault = sample(v => [fx + lean * (v - 0.5) * 4 + 0.03 * Math.sin(v * 9), lerp(FLOOR, GROUND, v)], 12);
        shapes.push(...inkIn(bed, fault, 0.011), ...inkIn(bed, fault.map(([x, y]) => [x + 0.025, y]), 0.005));
        const out = [piece(shapes)];
        if (main) {
            comings(4, 0.25, 0.9).forEach((full, k) => {
                const y = within(bed, fx, lerp(0.85, 0.2, k / 3)), at = [fx + lean * ((y - FLOOR) / (GROUND - FLOOR) - 0.5) * 4 + 0.012, y];
                const r = rng.range(0.025, 0.04);
                out.push(piece([{ type: "solid", outline: sample(v => { const a = v * TAU; const k2 = 1 + 0.9 * Math.max(0, Math.sin(a)) ** 3; return [at[0] + Math.cos(a) * r / k2, at[1] + Math.sin(a) * r * (Math.sin(a) > 0 ? 1.6 : 0.8)]; }, 12).slice(0, -1) }], full));
            });
        }
        return out;
    },
};
// ---------------------------------------------------------------- ore veins
/** What a metal's vein carries, drawn at a point in the vein, `s` across. */
const ORES = {
    // Galena: lead-grey cubes.
    galena: (rng, at, s) => [...isoCube([at[0] - s * 0.22, at[1] - s * 0.4], s * 0.6, rng.sym(0.2), 0.75), ...isoCube([at[0] + s * 0.3, at[1] - s * 0.45], s * 0.38, rng.sym(0.2), 0.75)],
    // Tin stone: small dark bipyramids.
    cassiterite: (rng, at, s) => [-1, 1].flatMap(sd => bipyramid([at[0] + sd * s * 0.22, at[1] - s * 0.4], s * rng.range(0.7, 0.9), Math.PI / 2 + sd * 0.4 + rng.sym(0.2), 0.75)),
    // Native copper: branching wire with sixty-degree spikes, each tipped with a little crystal.
    copper: (rng, at, s) => {
        const out = [];
        const a = Math.PI / 2 + rng.sym(0.4), l = s * 1.7;
        const from = [at[0] - Math.cos(a) * l / 2, at[1] - Math.sin(a) * l / 2];
        const tip = (p, d, r) => ({ type: "solid", outline: [[p[0] + Math.cos(d) * r * 1.6, p[1] + Math.sin(d) * r * 1.6], [p[0] - Math.sin(d) * r, p[1] + Math.cos(d) * r], [p[0] - Math.cos(d) * r * 0.5, p[1] - Math.sin(d) * r * 0.5], [p[0] + Math.sin(d) * r, p[1] - Math.cos(d) * r]], smooth: false });
        const end = [from[0] + Math.cos(a) * l, from[1] + Math.sin(a) * l];
        out.push(line([from, end], 0.02, false), tip(end, a, 0.025));
        for (const [k, v] of [0.25, 0.45, 0.65, 0.85].entries()) {
            const p = [from[0] + Math.cos(a) * l * v, from[1] + Math.sin(a) * l * v];
            const b = a + (k % 2 === 0 ? 1 : -1) * Math.PI / 3, bl = l * 0.34 * (1 - v * 0.5);
            const q = [p[0] + Math.cos(b) * bl, p[1] + Math.sin(b) * bl];
            out.push(line([p, q], 0.013, false), tip(q, b, 0.018));
        }
        return out;
    },
    // Kidney ore: hematite in clustered hemispheres.
    hematite: (rng, at, s) => [0, 1, 2].map(k => {
        const r = s * rng.range(0.22, 0.32), c = [at[0] + (k - 1) * s * 0.32, at[1] - s * 0.3 + (k === 1 ? s * 0.1 : 0)];
        return rounded(blob(c, r, r, () => 1, 14, c[1] - r * 0.25), c, r, r, 0.75, 0.65);
    }),
    // Zinc blende: dark rhombs, each with a bright cleavage spangle.
    blende: (rng, at, s) => [-1, 1].flatMap(sd => {
        const c = [at[0] + sd * s * 0.22, at[1] + rng.sym(s * 0.2)], r = s * rng.range(0.25, 0.35), spin = rng.sym(0.5);
        const rhomb = turn([[0, -r], [r * 0.7, 0], [0, r], [-r * 0.7, 0]], spin, c);
        return [{ type: "solid", outline: rhomb, smooth: false }, { type: "body", outline: turn([[0, r * 0.75], [-r * 0.45, 0.05 * r], [-r * 0.05, 0.1 * r]], spin, c), shadow: [], grain: [], veins: [], weight: 0.02 }];
    }),
    // Cinnabar in grains, and the quicksilver it sweats in bright beads.
    cinnabar: (rng, at, s) => {
        const r = s * 0.22, c = [at[0] + rng.sym(s * 0.15), at[1]];
        const spark = blob([c[0] - r * 0.35, c[1] + r * 0.35], r * 0.22, r * 0.2, () => 1, 8, -9);
        const glint = blob([c[0] + r * 0.25, c[1] - r * 0.55], r * 0.45, r * 0.12, () => 1, 8, -9);
        return [{ type: "dots", points: Array.from({ length: 9 }, () => [at[0] + rng.sym(s * 0.45), at[1] + rng.sym(s * 0.4)]), radius: 0.011 },
            rounded(blob(c, r, r * 0.88, () => 1, 14, -9), c, r, r * 0.88, 0.85, 0.85, [spark, glint])];
    },
};
/** A vein crossing the beds from the section's floor to the soil, its walls lined with comb quartz, its ore and druses coming in as the day fills. */
function oreVein(rng, soil, ore, xr) {
    const xv = rng.range(...xr), half = rng.range(0.2, 0.27), phase = rng.range(0, TAU);
    // The vein leans a little, but its outcrop stays within the same reach as its foot.
    const slope = (clamp(xv + rng.sym(0.2) * (GROUND - FLOOR), ...xr) - xv) / (GROUND - FLOOR);
    const centre = (y) => xv + slope * (y - FLOOR) + 0.06 * Math.sin(y * 1.7 + phase);
    const width = (y) => half * (1 + 0.3 * Math.sin(y * 1.3 + phase * 2));
    const ys = [];
    for (let y = FLOOR; y < heightAt(soil.bottom, centre(y)) - 0.05; y += 0.1)
        ys.push(y);
    const end = heightAt(soil.bottom, centre(ys[ys.length - 1]));
    const left = ys.map(y => [centre(y) - width(y), y]), right = ys.map(y => [centre(y) + width(y), y]);
    left.push([centre(end) - width(end), heightAt(soil.bottom, centre(end) - width(end)) - 0.01]);
    right.push([centre(end) + width(end), heightAt(soil.bottom, centre(end) + width(end)) - 0.01]);
    const poly = [...left, ...right.slice().reverse()];
    const shapes = [{ type: "body", outline: densify(poly, 0.12), shadow: [], grain: [], veins: [], weight: 0.05 }];
    for (const [wall, sd] of [[left, 1], [right, -1]]) {
        for (const p of densify(wall, 0.06, false)) {
            const l = rng.range(0.04, 0.08);
            shapes.push(line([[p[0], p[1] - 0.018], [p[0] + sd * l, p[1] + rng.sym(0.01)], [p[0], p[1] + 0.018]], 0.004, false));
        }
        shapes.push(line(wall, 0.016));
    }
    // The iron hat: the vein's rusted outcrop under the soil.
    const cap = [centre(end), end];
    shapes.push({ type: "body", outline: blob(cap, half * 1.6, 0.09, a => 1 + 0.15 * Math.sin(5 * a + phase), 14, -9), shadow: [], grain: cuts(blob(cap, half * 1.6, 0.09, () => 1, 14, -9), 0.9, HATCH * 0.7), veins: [], weight: 0.6 }, { type: "dots", points: Array.from({ length: 14 }, () => [cap[0] + rng.sym(half * 1.8), cap[1] + rng.sym(0.1)]), radius: 0.008 });
    const out = [piece(shapes)];
    const draw = ORES[ore];
    const stations = [];
    for (let y = FLOOR + rng.range(0.25, 0.4); y < end - 0.35; y += rng.range(0.42, 0.6))
        stations.push(y);
    stations.forEach((y, k) => out.push(piece(draw(rng, [centre(y), y], Math.min(0.3, width(y) * 1.5)), k % 2 === 0 ? 0 : lerp(0.15, 0.9, rng.u()))));
    // Druses: open cavities in the vein between its ore, their crystals pointing inward.
    comings(2, 0.45, 0.85).forEach((full, k) => {
        const j = Math.min(stations.length - 2, Math.floor((k + 0.5) * (stations.length - 1) / 2));
        if (j < 0)
            return;
        const y = (stations[j] + stations[j + 1]) / 2, at = [centre(y), y], w = width(y);
        const hole = cavity(rng, at, w * 0.65, Math.min(0.2, w * 0.9));
        out.push(piece([hole.body, ...druse(rng, hole.wall, w * 0.35, w * 0.16)], full));
    });
    return out;
}
// ---------------------------------------------------------------- the chemical signs
const ring = (cx, cy, r, n = 20) => sample(v => [cx + Math.cos(v * TAU) * r, cy + Math.sin(v * TAU) * r], n);
/** The signs as stroked paths in a unit box centred on the origin, +y up; never a font's glyph. */
const GLYPHS = {
    // Lead: a cross whose shaft curls into a hook below.
    lead: [[[-0.32, 0.3], [0.06, 0.3]], [[-0.13, 0.5], [-0.13, -0.46]], [[-0.13, -0.02], [0.02, 0.1], [0.18, 0.05], [0.2, -0.12], [0.1, -0.3], [0.12, -0.44], [0.24, -0.46]]],
    // Tin: a looped stroke running out into a bar, crossed by an upright.
    tin: [[[-0.34, 0.26], [-0.26, 0.42], [-0.12, 0.46], [-0.02, 0.36], [-0.08, 0.16], [-0.36, -0.12], [0.38, -0.12]], [[0.18, 0.4], [0.18, -0.46]]],
    // Copper: a circle over a cross.
    copper: [ring(0, 0.2, 0.22), [[0, -0.02], [0, -0.48]], [[-0.18, -0.27], [0.18, -0.27]]],
    // Iron: a circle with an arrow rising from it.
    iron: [ring(-0.1, -0.12, 0.25), [[0.08, 0.06], [0.4, 0.38]], [[0.16, 0.38], [0.4, 0.38], [0.4, 0.14]]],
    // Quicksilver: horns over a circle over a cross.
    mercury: [sample(v => [Math.cos(Math.PI + v * Math.PI) * 0.16, 0.5 + Math.sin(Math.PI + v * Math.PI) * 0.14], 8), ring(0, 0.18, 0.15, 16), [[0, 0.03], [0, -0.48]], [[-0.15, -0.28], [0.15, -0.28]]],
    // Zinc: a circle under a chevron.
    zinc: [ring(0, -0.12, 0.29), [[-0.2, 0.3], [0, 0.48], [0.2, 0.3]]],
    // Sulphur: a triangle over a cross.
    sulphur: [closed([[-0.26, 0], [0.26, 0], [0, 0.46]]), [[0, 0], [0, -0.48]], [[-0.17, -0.24], [0.17, -0.24]]],
    // Salt: a circle barred across.
    salt: [ring(0, 0, 0.38), [[-0.38, 0], [0.38, 0]]],
    // Nitre: a circle barred upright.
    nitre: [ring(0, 0, 0.38), [[0, -0.38], [0, 0.38]]],
    // Vitriolic acid, which with lime makes gypsum.
    vitriol: [ring(0, 0, 0.36), [[0, -0.36], [0, 0.36]], [[-0.36, 0], [0.36, 0]]],
    // Earth: the downward triangle barred.
    earth: [closed([[-0.38, 0.34], [0.38, 0.34], [0, -0.4]]), [[-0.22, 0.06], [0.22, 0.06]]],
    // Fire, the matter of heat, for lava.
    fire: [closed([[-0.38, -0.34], [0.38, -0.34], [0, 0.42]])],
    // Calcareous earth, lime: a trident with a bar across its shaft.
    lime: [sample(v => { const x = (v - 0.5) * 0.6; return [x, 0.06 + 0.36 * (x / 0.3) ** 2]; }, 10), [[0, 0.48], [0, -0.46]], [[-0.17, -0.2], [0.17, -0.2]]],
    // Argillaceous earth, clay: a barred downward triangle with a ring at the bar's end.
    clay: [ring(-0.37, 0.36, 0.07, 10), [[-0.3, 0.36], [0.38, 0.36]], closed([[-0.3, 0.24], [0.3, 0.24], [0, -0.38]])],
    // Siliceous earth: the barred downward triangle crossed by its rising twin.
    silica: [[[-0.38, 0.4], [0.38, 0.4]], closed([[-0.32, 0.28], [0.32, 0.28], [0, -0.4]]), closed([[-0.32, -0.3], [0.32, -0.3], [0, 0.28]])],
    // Phlogiston, for the burning earths: a triangle of rings over a cross.
    phlogiston: [ring(0, 0.38, 0.12, 12), ring(-0.25, -0.06, 0.12, 12), ring(0.25, -0.06, 0.12, 12), [[0.19, 0.05], [0.06, 0.27]], [[-0.19, 0.05], [-0.06, 0.27]], [[-0.13, -0.06], [0.13, -0.06]], [[0, -0.06], [0, -0.5]], [[-0.25, -0.32], [0.25, -0.32]]],
};
/** A small engraved cartouche, its corners cut in, carrying the material's sign: one glyph, or two side by side for a compound. */
function cartouche(at, signs) {
    const w = signs.length > 1 ? 1.5 : 1.05, h = 0.95, r = 0.13;
    // The incurved corners of the outer edge and the inner rule share their centres, at the frame's corners.
    const shape = (inset) => {
        const hw = w / 2, hh = h / 2, rr = r + inset, trim = Math.asin(inset / rr);
        const corner = (cx, cy, from) => sample(v => { const a = from - trim - v * (Math.PI / 2 - 2 * trim); return [at[0] + cx + Math.cos(a) * rr, at[1] + cy + Math.sin(a) * rr]; }, 4);
        return [...corner(hw, -hh, Math.PI), ...corner(hw, hh, Math.PI * 1.5), ...corner(-hw, hh, 0), ...corner(-hw, -hh, Math.PI / 2)];
    };
    const outer = shape(0), inner = shape(0.06);
    const shapes = [{ type: "body", outline: densify(outer, 0.08), shadow: [], grain: [], veins: [], weight: 0.03 }, edge(outer, 0.016), line(closed(inner), 0.006, false)];
    const size = 0.58;
    signs.forEach((sign, k) => {
        const cx = at[0] + (signs.length > 1 ? (k - 0.5) * 0.62 : 0);
        // Curves are drawn smooth; a triangle's or a bar's few points keep their corners.
        for (const stroke of GLYPHS[sign])
            shapes.push(line(stroke.map(([x, y]) => [cx + x * size, at[1] + y * size]), 0.022, stroke.length > 4));
    });
    return shapes;
}
const SECTIONS = {
    tourbe: { beds: [["soil", 0.04], ["peat", 0.5], ["mud", 0.46]], main: "peat", dip: 0.02, sign: ["phlogiston"] },
    houille: { beds: [["soil", 0.05], ["sand", 0.2], ["roof", 0.26], ["coal", 0.13], ["underclay", 0.14], ["sandstone", 0.22]], main: "coal", dip: 0.1, sign: ["phlogiston"] },
    bitume: { beds: [["soil", 0.05], ["sand", 0.27], ["bitumen", 0.33], ["shale", 0.35]], main: "bitumen", dip: 0.06, sign: ["phlogiston"] },
    soufre: { beds: [["soil", 0.05], ["marl", 0.22], ["sulphur", 0.48], ["gypsum", 0.25]], main: "sulphur", dip: 0.04, sign: ["sulphur"] },
    lave: { beds: [["soil", 0.05], ["basalt", 0.64], ["tuff", 0.31]], main: "basalt", dip: 0, sign: ["fire"] },
    "terre végétale": { beds: [["loam", 0.32], ["subsoil", 0.3], ["limestone", 0.38]], main: "loam", dip: 0.03, sign: ["earth"] },
    fumier: { beds: [["manure", 0.16], ["loam", 0.3], ["subsoil", 0.54]], main: "manure", dip: 0.02, sign: ["earth"] },
    salpêtre: { beds: [["soil", 0.05], ["nitre", 0.6], ["marl", 0.35]], main: "nitre", dip: 0.04, sign: ["nitre"] },
    granit: { beds: [["soil", 0.05], ["granite", 0.95]], main: "granite", dip: 0, sign: ["silica"], outcrop: "boulders" },
    argile: { beds: [["soil", 0.05], ["clay", 0.55], ["sand", 0.4]], main: "clay", dip: 0.05, sign: ["clay"] },
    ardoise: { beds: [["soil", 0.05], ["slate", 0.95]], main: "slate", dip: 0.22, sign: ["clay"], outcrop: "teeth" },
    grès: { beds: [["soil", 0.05], ["sandstone", 0.6], ["shale", 0.35]], main: "sandstone", dip: 0.08, sign: ["silica"] },
    silex: { beds: [["soil", 0.05], ["chalk", 0.95]], main: "chalk", dip: 0.03, sign: ["silica"] },
    marne: { beds: [["soil", 0.05], ["marl", 0.6], ["limestone", 0.35]], main: "marl", dip: 0.06, sign: ["clay", "lime"] },
    "pierre à chaux": { beds: [["soil", 0.05], ["limestone", 0.95]], main: "limestone", dip: 0.07, sign: ["lime"] },
    marbre: { beds: [["soil", 0.05], ["marble", 0.95]], main: "marble", dip: 0, sign: ["lime"] },
    "pierre à plâtre": { beds: [["soil", 0.05], ["marl", 0.2], ["gypsum", 0.5], ["marl", 0.25]], main: "gypsum", dip: 0.03, sign: ["vitriol", "lime"] },
    sel: { beds: [["soil", 0.05], ["mud", 0.27], ["salt", 0.43], ["mud", 0.25]], main: "salt", dip: 0.03, sign: ["salt"] },
    fer: { beds: [["soil", 0.05], ["limestone", 0.95]], main: "", dip: 0.05, sign: ["iron"], ore: "hematite" },
    cuivre: { beds: [["soil", 0.05], ["slate", 0.95]], main: "", dip: 0.2, sign: ["copper"], ore: "copper" },
    étain: { beds: [["soil", 0.05], ["granite", 0.95]], main: "", dip: 0, sign: ["tin"], ore: "cassiterite" },
    plomb: { beds: [["soil", 0.05], ["shale", 0.3], ["limestone", 0.65]], main: "", dip: 0.06, sign: ["lead"], ore: "galena" },
    zinc: { beds: [["soil", 0.05], ["limestone", 0.6], ["shale", 0.35]], main: "", dip: 0.06, sign: ["zinc"], ore: "blende" },
    mercure: { beds: [["soil", 0.05], ["sandstone", 0.42], ["shale", 0.53]], main: "", dip: 0.05, sign: ["mercury"], ore: "cinnabar" },
};
const BEDS = Object.keys(SECTIONS);
/** Dry winter grass along the ground: tufts of thin blades, a few bent over. */
function tuft(rng, foot) {
    const shapes = [], tips = [];
    const count = rng.int(5, 8);
    for (let k = 0; k < count; k += 1) {
        const lean = (k / (count - 1) - 0.5) * 1.1 + rng.sym(0.2), h = rng.range(0.14, 0.4), droop = rng.chance(0.25);
        const blade = sample(v => [foot[0] + Math.sin(lean) * h * v + (droop ? Math.sign(lean || 1) * h * 0.4 * v ** 3 : 0), foot[1] + Math.cos(lean) * h * v - (droop ? h * 0.35 * v ** 3 : 0)], 5);
        shapes.push(line(blade, 0.007));
        tips.push(blade[blade.length - 1]);
    }
    return { shapes, tips };
}
/** The whole section, every part drawn whether or not it is yet shown, so the moment never moves the rest. */
function sectionPieces(rng, W, plan) {
    const x0 = CUT, x1 = W - CUT, xc = W * CROWN_X;
    const steps = Math.round((x1 - x0) / STEP);
    const xs = Array.from({ length: steps + 1 }, (_, index) => lerp(x0, x1, index / steps));
    const relief = fbm1(rng.fork(), 2), phase = rng.range(0, 10);
    const groundAt = (x) => GROUND + RELIEF * (relief(x / 1.6 + phase) - relief(xc / 1.6 + phase)) * smoothstep(0, 0.6, Math.abs(x - xc));
    const ground = xs.map(x => [x, groundAt(x)]);
    const dip = plan.dip * (rng.chance(0.5) ? 1 : -1) * rng.range(0.7, 1.2);
    let depth = 0, above = ground;
    const beds = [];
    plan.beds.forEach(([texture, share], index) => {
        depth += share;
        const last = index === plan.beds.length - 1;
        const wave = fbm1(rng.fork(), 2), wp = rng.range(0, 10), amp = index === 0 ? 0.03 : rng.range(0.03, 0.09);
        const s = depth;
        const bottom = xs.map((x, i) => [x, last ? FLOOR : Math.max(FLOOR, Math.min(above[i][1] - 0.06, lerp(groundAt(x), FLOOR, s) + dip * (x - xc) * Math.min(1, s * 3) + amp * wave(x / 1.3 + wp)))]);
        beds.push({ texture, bed: bedOf(above, bottom) });
        above = bottom;
    });
    const soil = beds[0].bed;
    const left = rng.chance(0.5);
    const pieces = [];
    for (const { texture, bed } of beds)
        pieces.push(...BED_TEXTURES[texture](rng.fork(), bed, texture === plan.main));
    if (plan.ore)
        pieces.push(...oreVein(rng.fork(), soil, plan.ore, left ? [xc + 0.75, x1 - 0.55] : [x0 + 0.55, xc - 0.75]));
    // Where the twigs rise, their roots grip the soil.
    const roots = [];
    const rootRng = rng.fork();
    for (let k = 0; k < 5; k += 1) {
        const a = -Math.PI / 2 + (k - 2) * 0.45 + rootRng.sym(0.15), len = rootRng.range(0.3, 0.6) * (k === 2 ? 1.4 : 1);
        const from = [xc + (k - 2) * 0.05, groundAt(xc) - 0.01];
        roots.push(line(sample(v => [from[0] + Math.cos(a) * len * v + 0.03 * Math.sin(v * 7 + k), from[1] + Math.sin(a) * len * v * 0.8], 6), 0.022 * (1 - k % 2 * 0.3)));
    }
    pieces.push(piece(roots));
    // What breaks through the ground.
    const tops = [];
    const outcropRng = rng.fork();
    if (plan.outcrop === "boulders") {
        const stones = [];
        for (const f of [0.12, 0.7, 0.9]) {
            const x = lerp(x0, x1, f + outcropRng.sym(0.03)), rx = outcropRng.range(0.28, 0.42), ry = rx * outcropRng.range(0.55, 0.68), c = [x, groundAt(x) + ry * 0.25];
            const outline = blob(c, rx, ry, a => 1 + 0.07 * Math.sin(3 * a + f * 9), 18, groundAt(x) - 0.06);
            const body = rounded(outline, c, rx, ry, 0.35, 0.25);
            body.veins.push(...scatter(outcropRng, outline, 10).map(p => closed(polygonAt(p, 0.025, 4, 0, outcropRng, 1.4))));
            stones.push(body, { type: "dots", points: scatter(outcropRng, outline, 12), radius: 0.012 });
            tops.push(...topsOf(outline));
        }
        pieces.push(piece(stones));
    }
    else if (plan.outcrop === "teeth") {
        const teeth = [];
        const lean = dip > 0 ? -0.35 : 0.35;
        for (let x = x0 + 0.15; x < x1 - 0.2; x += outcropRng.range(0.16, 0.3)) {
            if (Math.abs(x - xc) < 0.35 || outcropRng.chance(0.3))
                continue;
            const h = outcropRng.range(0.1, 0.3), w = outcropRng.range(0.06, 0.1), g = groundAt(x) - 0.04;
            const slab = [[x, g], [x + w, g], [x + w + Math.sin(lean) * h, g + h * 0.85], [x + Math.sin(lean) * h, g + h]];
            teeth.push(face(slab, 0.55, Math.PI / 2 - lean, 0.05), edge(slab, 0.008));
            tops.push([slab[3], slab[2]]);
        }
        pieces.push(piece(teeth));
    }
    // The tufts of dry grass along the ground, clear of the crown and the section's sides.
    const grass = rng.fork();
    const tufts = [];
    for (let x = x0 + grass.range(0.15, 0.35); x < x1 - 0.1; x += grass.range(0.42, 0.75)) {
        if (Math.abs(x - xc) < 0.3)
            continue;
        tufts.push(tuft(grass, [x, groundAt(x) - 0.01]));
    }
    pieces.push(piece(tufts.flatMap(t => t.shapes)));
    // The cartouche, in a lower corner clear of the vein.
    const w = plan.sign.length > 1 ? 1.5 : 1.05;
    pieces.push(piece(cartouche([left ? x0 + 0.14 + w / 2 : x1 - 0.14 - w / 2, FLOOR + 0.62], plan.sign)));
    // A double rule under the section, as a plate's border.
    pieces.push(piece([line([[x0, FLOOR - 0.07], [x1, FLOOR - 0.07]], 0.006, false)]));
    // The rime, in runs along the ground, on the stones and on the grass, arriving through the day's end.
    const frostRng = rng.fork();
    const runs = [];
    for (let i = 0; i < ground.length - 1; i += 4)
        runs.push(ground.slice(i, Math.min(ground.length, i + 5)));
    // Each run of rime has its own moment between 0.8 and 0.96, scattered by the golden ratio so it settles here and there.
    const late = (k) => 0.8 + 0.16 * ((k * 0.618) % 1);
    runs.forEach((run, k) => pieces.push(piece(frost(frostRng, [run], 1.6), 0, late(k))));
    tops.forEach((run, k) => pieces.push(piece(frost(frostRng, [run], 1.1), 0, late(k + 3))));
    tufts.forEach((t, k) => {
        const needles = [{ type: "dots", points: t.tips, radius: 0.012 }];
        for (const tip of t.tips)
            for (const a of [0.4, 1.6, 2.8])
                needles.push(line([tip, [tip[0] + Math.cos(a + frostRng.sym(0.3)) * 0.03, tip[1] + Math.sin(a) * 0.03]], 0.004, false));
        pieces.push(piece(needles, 0, late(k + 5)));
    });
    return pieces;
}
// ---------------------------------------------------------------- the twigs over a section
/** A twig's end with its terminal bud and a pair of side buds over their leaf scars, swelling through the day and frosted at its end. */
function budHead(fat) {
    return (rng, s, stage) => {
        const swell = stage === "bud" ? 0.7 : 1;
        const stalk = s * 0.4;
        const shapes = [line([[0, 0], [rng.sym(0.02) * s, stalk]], s * 0.035)];
        const tips = [];
        const terminal = [0, stalk], length = s * 0.42 * swell;
        shapes.push(...bud(rng, terminal, [0, 1], length, fat));
        tips.push([[terminal[0] - length * 0.25, terminal[1] + length * 0.4], [terminal[0], terminal[1] + length]]);
        for (const sd of [-1, 1]) {
            const at = [0, stalk * 0.62], l = s * 0.22 * swell;
            shapes.push(line(sample(t => [sd * s * 0.04 * Math.cos(t * Math.PI), at[1] - s * 0.03 - s * 0.02 * Math.sin(t * Math.PI)], 4), s * 0.012));
            shapes.push(...bud(rng, at, [sd * 0.8, 1], l, fat));
            tips.push([[at[0] + sd * l * 0.1, at[1] + l * 0.5], [at[0] + sd * l * 0.62, at[1] + l * 0.78]]);
        }
        if (stage === "bloom" || stage === "seed") {
            // The scales part at the terminal bud's tip.
            const tip = [terminal[0], terminal[1] + length];
            shapes.push(line([[tip[0] - s * 0.05, tip[1] - s * 0.07], [tip[0] - s * 0.075, tip[1] + s * 0.01]], s * 0.008), line([[tip[0] + s * 0.05, tip[1] - s * 0.07], [tip[0] + s * 0.075, tip[1] + s * 0.01]], s * 0.008));
        }
        if (stage === "seed")
            shapes.push(...frost(rng, tips, s * 0.7));
        return shapes;
    };
}
// ---------------------------------------------------------------- the form
const MATERIAL_HABITS = ["lump", "fragment", "nodule", "slabs", "bedded", "crystals", "tablets", "cubes", "needles", "ingot", "sheet", "dendrite", "beads", "clod", "pitch", "comb"];
const TEXTURES = ["plain", "vesicles", "grains", "veins", "bedding", "sand", "shells", "conchoidal", "pitted", "spangle", "fibres", "roots", "straw", "cracks", "crumbs", "glossy", "drops", "cells"];
/** The section at the column's foot: the ground at the crown, the room it fills, and its drawing at each moment. */
function sectionFoot(plan) {
    return {
        crown: [CROWN_X, GROUND],
        room: [[0, 0, 1, SECTION_TOP]],
        scroll: false,
        draw: (rng, column, t, fullness) => sectionPieces(rng, column.width, plan).filter(p => p.full <= fullness && p.late <= t).flatMap(p => p.shapes),
    };
}
export const form = {
    id: "hiver",
    name: "hiver",
    doc: "A bare winter garden of dormant twigs and dried leaves for the day's material: an engraved geological section at its foot with the material's chemical sign, or the material set in the twigs' forks as specimens that frost at the end.",
    variants: {
        mode: { doc: "How the material is shown: a geological section through its beds at the column's foot, the twigs rising from its soil, or specimens set in the twigs' forks", default: "section", values: ["section", "specimens"] },
        bed: { doc: "For a section, the material it is cut through: its beds, texture, ore and chemical sign", default: "granit", values: BEDS },
        habit: { doc: "The specimen's habit: fractured lump, metal fragment, flint nodule, cleaved slabs, bedded block, crystal druse, tabular crystals, cubes, needle crust, ingot, dented sheet, native dendrite, beads in a hollow, clod, pitch, or comb", default: "lump", values: MATERIAL_HABITS },
        texture: { doc: "What a specimen's surface shows: gas holes, interlocking grains, marble veins, bedding, sand, shells, conchoidal rings, pits, zinc spangles, peat fibres, roots, straw, drying cracks, crumbs, glossy breaks, honey drops, or empty cells", default: "plain", values: TEXTURES },
        tone: { doc: "How dark a specimen engraves: salt, plaster and marble pale, coal and pitch black", default: 0.5, range: [0, 1] },
        size: { doc: "Specimen size against the fork that holds it", default: 1, range: [0.6, 1.3] },
        twig: { doc: "The winter twigs: bare with small buds, budded with fat scaled buds, or marcescent, still holding their dried leaves", default: "bare", values: ["bare", "budded", "marcescent"] },
    },
    examples: [
        { name: "granit en coupe", variant: { mode: "section", bed: "granit", twig: "bare" } },
        { name: "ardoise en coupe", variant: { mode: "section", bed: "ardoise", twig: "bare" } },
        { name: "argile en coupe", variant: { mode: "section", bed: "argile", twig: "marcescent" } },
        { name: "houille en coupe", variant: { mode: "section", bed: "houille", twig: "marcescent" } },
        { name: "marbre en coupe", variant: { mode: "section", bed: "marbre", twig: "bare" } },
        { name: "silex en coupe", variant: { mode: "section", bed: "silex", twig: "bare" } },
        { name: "lave en coupe", variant: { mode: "section", bed: "lave", twig: "bare" } },
        { name: "soufre en coupe", variant: { mode: "section", bed: "soufre", twig: "bare" } },
        { name: "pierre à plâtre en coupe", variant: { mode: "section", bed: "pierre à plâtre", twig: "bare" } },
        { name: "plomb en coupe", variant: { mode: "section", bed: "plomb", twig: "budded" } },
        { name: "granit", variant: { mode: "specimens", habit: "lump", texture: "grains", tone: 0.45, twig: "bare" } },
        { name: "lave", variant: { mode: "specimens", habit: "lump", texture: "vesicles", tone: 0.8, twig: "bare" } },
        { name: "silex", variant: { mode: "specimens", habit: "nodule", texture: "conchoidal", tone: 0.85, twig: "bare" } },
        { name: "ardoise", variant: { mode: "specimens", habit: "slabs", tone: 0.75, twig: "bare" } },
        { name: "soufre", variant: { mode: "specimens", habit: "crystals", tone: 0.25, twig: "bare" } },
        { name: "sel", variant: { mode: "specimens", habit: "cubes", tone: 0.1, twig: "bare" } },
        { name: "salpêtre", variant: { mode: "specimens", habit: "needles", tone: 0.2, twig: "bare" } },
        { name: "étain", variant: { mode: "specimens", habit: "ingot", tone: 0.3, twig: "budded" } },
        { name: "cuivre", variant: { mode: "specimens", habit: "dendrite", tone: 0.5, twig: "budded" } },
        { name: "mercure", variant: { mode: "specimens", habit: "beads", tone: 0.4, twig: "budded" } },
        { name: "houille", variant: { mode: "specimens", habit: "lump", texture: "bedding", tone: 0.95, twig: "marcescent" } },
        { name: "fumier", variant: { mode: "specimens", habit: "clod", texture: "straw", tone: 0.6, twig: "marcescent" } },
        { name: "argile", variant: { mode: "specimens", habit: "clod", texture: "cracks", tone: 0.35, twig: "marcescent" } },
        { name: "bitume", variant: { mode: "specimens", habit: "pitch", texture: "glossy", tone: 0.95, twig: "marcescent" } },
        { name: "miel", variant: { mode: "specimens", habit: "comb", texture: "drops", tone: 0.4, twig: "budded" } },
        { name: "cire", variant: { mode: "specimens", habit: "comb", texture: "cells", tone: 0.15, twig: "budded" } },
    ],
    build(variant) {
        const twig = textOf(variant, "twig");
        const fat = twig === "budded";
        const dried = twig === "marcescent" ? 0.55 : twig === "bare" ? 0.22 : 0.12;
        // Each node holds a dried leaf or a bare spur with its buds, in the proportion the twigs keep.
        const leaf = (rng, length, bend) => rng.u() < dried ? driedLeaf(rng, length, bend) : budSpur(rng, length * 0.8, bend, fat);
        // Few leaves and spurs, and no more: a winter garden keeps its air.
        const foliage = [
            { name: "leaf", w: 1.5, smin: 0.85, smax: 1.3, max: 4, hard: true, layer: LAYER.leaf, upright: -0.6,
                r: s => 0.42 * s, off: s => 0.5 * s, draw: (rng, s) => driedLeaf(rng, s, rng.sym(0.3)) },
            { name: "spur", w: 2, smin: 0.8, smax: 1.2, max: 6, hard: true, layer: LAYER.leaf, upright: 0.8,
                r: s => 0.45 * s, off: s => 0.5 * s, draw: (rng, s) => budSpur(rng, s, rng.sym(0.2), fat) },
        ];
        const twigs = { id: "hiver", basal: null, leafProxy: 0.3, leaf, leaflet: (rng, length, bend) => budSpur(rng, length, bend, fat) };
        if (textOf(variant, "mode") === "section") {
            // The twigs rise from the section's soil, shorter than over bare ground, their buds the only blooms.
            const head = budHead(fat);
            return {
                ...twigs,
                stems: { count: 3, amplitude: 0.1, lambda: [2.5, 4], width: 0.065, tops: [0.82, 0.66, 0.52] },
                foot: sectionFoot(SECTIONS[textOf(variant, "bed")]),
                nodes: { every: [1.8, 2.6], length: height => lerp(1.3, 0.9, height), angle: [35, 60], below: 1 },
                terminal: { size: [1.0, 1.2], r: s => 0.5 * s, off: () => 0, draw: head },
                motifs: [
                    { name: "buds", w: 3, smin: 0.7, smax: 1.0, max: 7, hard: true, layer: LAYER.bloom, upright: 4, staged: true,
                        r: s => 0.45 * s, off: s => 0.3 * s, draw: head },
                    ...foliage,
                ],
            };
        }
        const material = { habit: textOf(variant, "habit"), texture: textOf(variant, "texture"), tone: numberOf(variant, "tone") };
        const scale = numberOf(variant, "size");
        const stone = specimen(material, scale);
        const chip = specimen(material, scale * 0.8);
        return {
            ...twigs,
            stems: { count: 3, amplitude: 0.12, lambda: [2.5, 4], width: 0.07, tops: [0.84, 0.64, 0.46] },
            nodes: { every: [2.3, 3.3], length: height => lerp(1.4, 0.9, height), angle: [35, 60], below: 1 },
            terminal: { size: [1.35, 1.6], r: s => 0.55 * s, off: () => 0, draw: stone },
            motifs: [
                { name: "specimen", w: 3, smin: 1.0, smax: 1.45, max: 4, hard: true, layer: LAYER.bloom, upright: 6, staged: true,
                    r: s => 0.5 * s, off: s => 0.32 * s, draw: stone },
                { name: "chip", w: 1.4, smin: 0.7, smax: 0.9, max: 4, hard: true, layer: LAYER.bloom, upright: 6, staged: true,
                    r: s => 0.55 * s, off: s => 0.3 * s, draw: chip },
                ...foliage,
            ],
        };
    },
};
