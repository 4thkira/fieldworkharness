// Composite flower heads: a disc of florets ringed by strap-shaped rays over a cup of bracts, which goes
// to a clock of plumed seeds or a dry head (scorsonère, pissenlit, tournesol, camomille).
import { LAYER, numberOf, textOf, flagOf } from "../form.js";
import { lerp, normals, sample, unit } from "../geometry.js";
import { HATCH, line, pinnateLeaf, simpleLeaf, strapLeaf, toothedLeaf, turnShape } from "../kit.js";
import { bladeBody, roundBody } from "../shapes.js";
function involucre(rng, s, height, spread, reflex = 0) {
    const count = rng.int(7, 9);
    const shapes = [];
    for (let k = 0; k < count; k += 1) {
        const u = (k + 0.5) / count * 2 - 1;
        const lean = u * spread + rng.sym(0.06);
        const len = height * rng.range(0.85, 1.1) * (1 - 0.25 * Math.abs(u));
        const curl = reflex * (u === 0 ? 1 : Math.sign(u));
        const spine = (v) => [Math.sin(lean) * len * v + curl * len * 0.5 * v * v, Math.cos(lean) * len * v - Math.abs(reflex) * len * 0.9 * v * v];
        shapes.push(bladeBody({ spine, halfWidth: v => s * 0.05 * Math.sin(Math.PI * Math.min(1, v * 0.9 + 0.1)) ** 0.7 * (1 - v * 0.6),
            shade: u < 0 ? -1 : 1, spacing: HATCH * 0.8, grain: "along", reach: [0.5, 0.9], weight: 0.7, samples: 12 }, rng));
    }
    return shapes;
}
/** A ligule: a strap petal whose tip ends in five small teeth. */
function ligule(rng, from, angle, length, width, tilt, shade) {
    const dx = Math.cos(angle), dy = Math.sin(angle) * tilt;
    const bow = rng.sym(0.08) * length;
    const spine = (v) => [from[0] + dx * length * v - dy * bow * v * v, from[1] + dy * length * v + dx * bow * v * v];
    // Narrow at the base, widening a little toward the truncate tip.
    const halfWidth = (v) => width * (0.3 + 0.7 * Math.min(1, v * 2.5)) * (1 + 0.15 * v);
    const body = bladeBody({ spine, halfWidth, shade, spacing: HATCH * 0.75, grain: "along", reach: [0.2, 0.45], weight: 0.35, samples: 16 }, rng);
    const n = 16;
    const centre = sample(spine, n);
    const normal = normals(centre);
    const edgeAt = (index, q) => [centre[index][0] + normal[index][0] * halfWidth(index / n) * q, centre[index][1] + normal[index][1] * halfWidth(index / n) * q];
    const [tx, ty] = unit(centre[n][0] - centre[n - 1][0], centre[n][1] - centre[n - 1][1]);
    const teeth = Array.from({ length: 9 }, (_, k) => {
        const [x, y] = edgeAt(n, 1 - k / 4);
        const notch = k % 2 === 1 ? length * 0.022 : 0;
        return [x - tx * notch, y - ty * notch];
    });
    body.outline = [...Array.from({ length: n }, (_, index) => edgeAt(index, 1)), ...teeth, ...Array.from({ length: n - 1 }, (_, k) => edgeAt(n - 1 - k, -1))];
    return body;
}
function seedClock(rng, s) {
    const shapes = [...involucre(rng, s * 0.8, s * 0.28, 0.5, 0.35)];
    const rays = [], tufts = [];
    const radius = s * 0.52;
    const centre = [0, s * 0.55];
    const count = rng.int(34, 46);
    for (let k = 0; k < count; k += 1) {
        const z = rng.range(-1, 1), a = rng.range(0, Math.PI * 2);
        const r = Math.sqrt(1 - z * z);
        const dir = unit(r * Math.cos(a), r * Math.sin(a) * 0.95 + 0.05);
        const len = radius * Math.hypot(r * Math.cos(a), r * Math.sin(a));
        if (len < radius * 0.2 || rng.chance(0.12))
            continue;
        const end = [centre[0] + dir[0] * len, centre[1] + dir[1] * len];
        rays.push([[centre[0] + dir[0] * s * 0.06, centre[1] + dir[1] * s * 0.06], end]);
        for (const spread of [-0.5, 0, 0.5]) {
            const d = unit(dir[0] + -dir[1] * spread, dir[1] + dir[0] * spread);
            tufts.push([end, [end[0] + d[0] * s * 0.07, end[1] + d[1] * s * 0.07]]);
        }
    }
    shapes.push(...rays.map(points => line(points, s * 0.006, false)), ...tufts.map(points => line(points, s * 0.004, false)));
    shapes.push({ type: "dots", points: [centre], radius: s * 0.045 });
    // A few seeds already away on the wind.
    for (let k = 0; k < rng.int(1, 3); k += 1) {
        const at = [centre[0] + rng.range(0.55, 1.1) * s * (k % 2 ? -1 : 1), centre[1] + rng.range(0.3, 0.9) * s];
        const d = unit(rng.sym(0.6), 1);
        shapes.push(line([at, [at[0] - d[0] * s * 0.08, at[1] - d[1] * s * 0.08]], s * 0.006, false));
        for (const spread of [-0.6, 0, 0.6]) {
            const t = unit(d[0] + -d[1] * spread, d[1] + d[0] * spread);
            shapes.push(line([at, [at[0] + t[0] * s * 0.08, at[1] + t[1] * s * 0.08]], s * 0.004, false));
        }
    }
    return shapes;
}
/** A dry head: the disc swollen with seeds in spirals, the rays withered and hanging (tournesol). */
function dryHead(rng, s, head, tilt) {
    const centre = [0, s * 0.34];
    const r = s * Math.max(0.14, head.disc * 1.25);
    const shapes = [...involucre(rng, s * 0.8, s * 0.3, 0.45, 0.2)];
    shapes.push(roundBody(sample(v => [centre[0] + Math.cos(v * Math.PI * 2) * r, centre[1] + Math.sin(v * Math.PI * 2) * r * tilt], 28).slice(0, -1), centre, r, HATCH * 0.6, 0.85));
    const seeds = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let k = 0; k < 90; k += 1) {
        const rr = r * 0.92 * Math.sqrt(k / 90), a = k * golden;
        seeds.push([centre[0] + Math.cos(a) * rr, centre[1] + Math.sin(a) * rr * tilt]);
    }
    shapes.push({ type: "dots", points: seeds, radius: s * 0.008 });
    for (let k = 0; k < Math.min(10, head.rays); k += 1) {
        const a = Math.PI + (k / 9) * Math.PI;
        const from = [centre[0] + Math.cos(a) * r, centre[1] + Math.sin(a) * r * tilt];
        shapes.push(line(sample(v => [from[0] + Math.cos(a) * s * 0.1 * v, from[1] - s * 0.18 * v * v], 5), s * 0.012));
    }
    return shapes;
}
function head(rng, s, stage, shape) {
    const tilt = rng.range(0.42, 0.62);
    const lean = rng.sym(0.25);
    const shapes = [];
    const centre = [0, s * 0.34];
    const finish = (list) => list.map(item => turnShape(item, lean));
    if (stage === "bud") {
        shapes.push(...involucre(rng, s * 0.8, s * 0.55, 0.12));
        for (let k = 0; k < 4 && shape.rays > 0; k += 1)
            shapes.push(line([[s * (k - 1.5) * 0.03, s * 0.5], [s * (k - 1.5) * 0.045, s * 0.62]], s * 0.012));
        return finish(shapes);
    }
    if (stage === "seed")
        return finish(shape.seed === "dry" ? dryHead(rng, s, shape, tilt) : seedClock(rng, s));
    shapes.push(...involucre(rng, s * 0.8, s * 0.36, 0.38));
    const back = [], front = [];
    const count = Math.max(0, Math.round(shape.rays * rng.range(0.9, 1.1)));
    for (let row = 0; row < 2 && count > 0; row += 1) {
        const ring = Math.max(1, Math.round(count / (row + 1)));
        for (let k = 0; k < ring; k += 1) {
            const angle = (k + row * 0.5) / ring * Math.PI * 2 + rng.sym(0.08);
            const length = s * shape.rayLength * (row === 0 ? rng.range(0.92, 1.08) : rng.range(0.62, 0.76));
            const width = s * 0.042 * Math.min(1.4, 22 / Math.max(8, shape.rays)) ** 0.5;
            const piece = ligule(rng, [centre[0], centre[1]], angle, length, width, tilt, Math.cos(angle) > 0 ? 1 : -1);
            (Math.sin(angle) > 0 ? back : front).push(piece);
        }
    }
    const discR = s * shape.disc;
    const disc = sample(v => [centre[0] + Math.cos(v * Math.PI * 2) * discR, centre[1] + Math.sin(v * Math.PI * 2) * discR * tilt], 24).slice(0, -1);
    const florets = Array.from({ length: Math.round(22 * (shape.disc / 0.11) ** 1.5) }, () => {
        const a = rng.range(0, Math.PI * 2), r = Math.sqrt(rng.u()) * discR * 0.82;
        return [centre[0] + Math.cos(a) * r, centre[1] + Math.sin(a) * r * tilt];
    });
    const pistils = Array.from({ length: 7 }, () => {
        const a = rng.range(0, Math.PI * 2), r = Math.sqrt(rng.u()) * discR * 0.45;
        return [centre[0] + Math.cos(a) * r, centre[1] + s * 0.02 + Math.sin(a) * r * tilt];
    });
    shapes.push(...back, roundBody(disc, centre, discR, HATCH * 0.7, 0.8), ...front, { type: "dots", points: florets, radius: s * 0.009 }, { type: "dots", points: pistils, radius: s * 0.013, tone: "accent" });
    return finish(shapes);
}
function leafOf(kind) {
    switch (kind) {
        case "toothed": return (rng, length, bend) => toothedLeaf(rng, length, bend);
        case "pinnate": return (rng, length, bend) => pinnateLeaf(rng, length, bend, 5, 0.28, true);
        case "simple": return (rng, length, bend) => simpleLeaf(rng, length, bend, 0.3);
        default: return (rng, length, bend) => strapLeaf(rng, length, bend);
    }
}
export const form = {
    id: "capitule",
    name: "capitule",
    doc: "Composite flower heads: rays round a disc of florets over bracts; a clock of plumed seeds or a dry head.",
    variants: {
        rays: { doc: "Ray florets in the outer ring (0 for a head of disc florets only)", default: 22, range: [0, 44] },
        rayLength: { doc: "Ray length as a share of the head's size", default: 0.55, range: [0.2, 0.8] },
        disc: { doc: "Disc radius as a share of the head's size", default: 0.11, range: [0.05, 0.34] },
        leaf: { doc: "Leaf kind", default: "strap", values: ["strap", "toothed", "pinnate", "simple"] },
        basal: { doc: "A rosette of leaves at the root", default: true, values: [true, false] },
        seed: { doc: "What the head becomes: a clock of plumed seeds or a dry seed head", default: "clock", values: ["clock", "dry"] },
        size: { doc: "Head size relative to the scorsonère's", default: 1, range: [0.5, 1.6] },
    },
    examples: [
        { name: "scorsonère", variant: {} },
        { name: "pissenlit", variant: { rays: 40, rayLength: 0.42, disc: 0.07, leaf: "toothed" } },
        { name: "tournesol", variant: { rays: 24, rayLength: 0.4, disc: 0.3, leaf: "simple", basal: false, seed: "dry", size: 1.5 } },
        { name: "camomille", variant: { rays: 14, rayLength: 0.45, disc: 0.16, leaf: "pinnate", basal: false, size: 0.6 } },
    ],
    build(variant) {
        const shape = { rays: numberOf(variant, "rays"), rayLength: numberOf(variant, "rayLength"), disc: numberOf(variant, "disc"), seed: textOf(variant, "seed") };
        const size = numberOf(variant, "size");
        const draw = (rng, s, stage) => head(rng, s, stage, shape);
        const leaf = leafOf(textOf(variant, "leaf"));
        return {
            id: "capitule",
            stems: { count: 3, amplitude: 0.09, lambda: [6, 9], width: 0.055 * Math.max(1, size * 0.8), tops: [0.93, 0.7, 0.5] },
            basal: flagOf(variant, "basal") ? { count: [5, 7], length: [3.4, 6.2] } : null,
            nodes: { every: flagOf(variant, "basal") ? [2.4, 3.6] : [1.6, 2.4], length: height => lerp(1.8, 0.9, height), angle: [22, 38], below: flagOf(variant, "basal") ? 0.62 : 0.85 },
            leafProxy: textOf(variant, "leaf") === "strap" ? 0.14 : 0.24,
            leaf,
            leaflet: (rng, length, bend) => leaf(rng, length * 0.9, bend),
            terminal: { size: [1.25 * size, 1.5 * size], r: s => 0.6 * s, off: () => 0, draw },
            motifs: [
                { name: "bloom", w: 3, smin: 0.85 * size, smax: 1.3 * size, max: size < 0.8 ? 7 : 4, hard: true, layer: LAYER.bloom, upright: 0.9, staged: true,
                    r: s => 0.58 * s, off: s => 0.3 * s, draw },
                { name: "bud", w: 1.2, smin: 0.6 * size, smax: 0.9 * size, max: 4, layer: LAYER.bloom, upright: 0.9,
                    r: s => 0.34 * s, off: s => 0.3 * s, draw: (rng, s) => head(rng, s, "bud", shape) },
                { name: "leaf", w: 1.6, smin: 1.2, smax: 2.4, max: 6, layer: LAYER.leaf, upright: 0.5,
                    r: s => 0.28 * s, off: s => 0.5 * s, draw: (rng, s) => leaf(rng, s, rng.sym(0.25)) },
            ],
        };
    },
};
