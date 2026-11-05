// Plants shown by their leaves: broadleaf trees and shrubs, leaf vegetables and a few odd stems. The
// leaf carries the plant: its outline and division (ovate, heart, triangle, spoon, arrow, oak-lobed,
// maple- or plane-palmate, pinnate, digitate, hemp's narrow fingers, lettuce, chard, rhubarb, cabbage),
// its margin (entire, wavy, crenate, serrate, doubly serrate), its symmetry and arrangement. The staged
// motif is the secondary mark that names the tree or crop: catkins that become hazelnuts, cotton,
// seed catkins or strobiles; acorns, beechnuts, hornbeam bracts, maple pairs, elm wafers, ash keys, the
// lime's bract, plane balls, the chestnut's candle and conker, bay drupes, box capsules; for herbs a
// panicle, a raceme of crosses, small heads, umbels, cymes, a curd or a broccoli head, asparagus spears
// and berries, glasswort joints or knotgrass's axillary flowers.
import { LAYER, flagOf, numberOf, textOf } from "../form.js";
import { bezier3, lerp, sample, smoothstep, unit } from "../geometry.js";
import { HATCH, circle, line, turnShape } from "../kit.js";
import { bladeBody, roundBody } from "../shapes.js";
const DEG = Math.PI / 180;
const rot = (d, a) => [d[0] * Math.cos(a) - d[1] * Math.sin(a), d[0] * Math.sin(a) + d[1] * Math.cos(a)];
const add = (p, d, k = 1) => [p[0] + d[0] * k, p[1] + d[1] * k];
const dirOf = (a) => [Math.sin(a), Math.cos(a)];
function tangent(c, v) {
    const a = c(Math.max(0, v - 0.01)), b = c(Math.min(1, v + 0.01));
    return unit(b[0] - a[0], b[1] - a[1]);
}
/** A closed outline symmetric about the axis, from its half-width along the length. */
function profile(len, hw, base = 0, n = 24) {
    const right = sample(v => [hw(v), base + len * v], n);
    const left = right.slice().reverse().map(([x, y]) => [-x, y]);
    return [...right, ...left].filter((p, i, all) => i === 0 || Math.hypot(p[0] - all[i - 1][0], p[1] - all[i - 1][1]) > 1e-4);
}
/** An ellipse turned by `angle` (radians, from +y), for nuts, seeds and berries. */
const oval = (at, rx, ry, angle = 0, n = 14) => circle([0, 0], rx, ry, n).map(p => add(at, rot(p, -angle)));
/** A dark ripe fruit: cut all over but for a small highlight. */
function darkBody(outline, at, r) {
    const body = roundBody(outline, at, r, HATCH * 0.42, 0.95);
    body.shadow = [body.shadow[0], circle([at[0] - r * 0.35, at[1] + r * 0.35], r * 0.2, r * 0.15, 10)];
    return body;
}
const nut = (at, rx, ry, angle, weight) => roundBody(oval(at, rx, ry, angle), at, Math.max(rx, ry), HATCH * 0.55, weight);
const dots = (points, radius) => ({ type: "dots", points, radius });
/** The margin as a perturbation of the half-width: teeth lean toward the tip. */
function marginEdge(margin, length, asymmetric, width) {
    const n = Math.max(7, Math.round(length / 0.075));
    const d = length * 0.022;
    const tooth = (v) => {
        const f = (v * n) % 1;
        switch (margin) {
            case "serrate": return -d * f;
            case "double": return -d * 1.2 * f - d * 0.5 * ((v * n * 3) % 1);
            case "crenate": return -d * (1 - Math.sin(Math.PI * f));
            case "wavy": return d * 0.7 * Math.sin(Math.PI * 2 * v * n / 2);
            default: return 0;
        }
    };
    return (v, side) => {
        const fade = Math.min(1, v / 0.1) * Math.min(1, (1 - v) / 0.06);
        // An elm's leaf is lopsided at the base: one side starts lower and wider.
        const lop = asymmetric ? side * length * width * 0.12 * (1 - v) ** 4 : 0;
        return tooth(v) * fade + lop;
    };
}
/** The half-width envelopes of the simple leaf outlines, roughly 1 at their widest; `drop` lets the base reach below the petiole. */
const OUTLINES = {
    ovate: { o: v => Math.sin(Math.PI * v ** 0.75) ** 0.85, drop: 0, petiole: 0.12 },
    elliptic: { o: v => Math.sin(Math.PI * v) ** 0.85, drop: 0, petiole: 0.1 },
    round: { o: v => v ** 0.35 * (1 - v ** 4) ** 0.5, drop: 0, petiole: 0.14 },
    heart: { o: v => v < 0.16 ? 0.12 + 0.83 * Math.sqrt(v / 0.16) : 0.95 * Math.sin(Math.PI * (0.5 + 0.5 * (v - 0.16) / 0.84)) ** 0.75 * (1 - 0.2 * smoothstep(0.8, 1, v)) + 0.05 * (1 - v), drop: 0.2, petiole: 0.2 },
    triangle: { o: v => Math.sin(Math.PI / 2 * Math.min(1, v / 0.24)) ** 0.8 * (1 - v) ** 1.1 * 1.15, drop: 0.03, petiole: 0.22 },
    spoon: { o: v => Math.max(0.12, Math.sqrt(Math.max(0, 1 - ((v - 0.7) / 0.3) ** 2))), drop: 0, petiole: 0.05 },
    arrow: { o: v => v < 0.2 ? Math.min(1, v / 0.03) * 0.85 * (1 - 0.35 * (0.2 - v) / 0.2) : 0.85 * ((1 - v) / 0.8) ** 0.8, drop: 0.2, petiole: 0.3 },
    lanceolate: { o: v => Math.sin(Math.PI * v ** 0.9), drop: 0, petiole: 0.06 },
    oblong: { o: v => (1 - (2 * v - 1) ** 8) ** 0.35 * Math.min(1, v / 0.12) ** 0.5, drop: 0, petiole: 0.02 },
    lettuce: { o: v => v ** 0.4 * (1 - v ** 3) ** 0.5, drop: 0, petiole: 0.02 },
    chard: { o: v => Math.sin(Math.PI * v ** 0.8) ** 0.7, drop: 0.02, petiole: 0.28 },
    rhubarb: { o: v => Math.sin(Math.PI * (0.12 + 0.88 * v) ** 0.85) ** 0.55, drop: 0.14, petiole: 0.34 },
    brassica: { o: v => (0.3 + 0.7 * v ** 0.7) * (1 - v ** 4) ** 0.5 * (v < 0.45 ? 0.45 + 0.55 * Math.abs(Math.sin(Math.PI * v * 5)) ** 0.7 : 1), drop: 0, petiole: 0.12 },
    oak: { o: v => Math.sin(Math.PI * v ** 0.8) ** 0.7 * (0.52 + 0.48 * Math.abs(Math.sin(Math.PI * (v * 5 + 0.15))) ** 0.6) * (v < 0.07 ? 1.6 : 1), drop: 0.02, petiole: 0.05 },
    cut: { o: v => (0.3 + 0.9 * v ** 1.5) * (1 - v) ** 0.35 * (v < 0.72 ? 0.22 + 0.78 * (1 - (v * 5) % 1) ** 1.6 : 1), drop: 0, petiole: 0.04 },
};
/** A simple leaf: an outlined blade on its petiole, with midrib and straight secondary veins; a `light` leaflet keeps only its midrib. */
function bladeLeaf(rng, length, bend, spec, weight = 0.5, light = false) {
    const shape = OUTLINES[spec.leaf] ?? OUTLINES.ovate;
    const petiole = length * shape.petiole;
    const L = length - petiole;
    const y0 = petiole - shape.drop * L;
    const spine = (v) => [bend * L * v * v, y0 + L * v];
    const halfWidth = (v) => Math.max(0.004, shape.o(v) * spec.width * 0.5 * L);
    const edge = marginEdge(spec.margin, L, spec.asymmetric, spec.width);
    const veins = [];
    // Small leaflets keep only their midrib, so a compound leaf stays light.
    const crinkled = ["lettuce", "brassica", "rhubarb", "chard"].includes(spec.leaf);
    const count = light || L < 0.6 ? 0 : Math.max(3, Math.round(L / (crinkled ? 0.28 : 0.2)));
    for (let k = 1; k < count; k += 1) {
        const v = k / count * 0.88 + 0.04;
        const reach = Math.min(0.98, v + 0.09);
        const t = tangent(spine, reach);
        for (const side of [1, -1]) {
            const end = add(spine(reach), [-t[1] * side, t[0] * side], (halfWidth(reach) + Math.min(0, edge(reach, side))) * 0.85);
            veins.push(crinkled
                ? sample(bezier3(spine(v), add(spine(v), [-t[1] * side, t[0] * side], halfWidth(v) * 0.4), add(end, [0, -L * 0.04]), end), 3)
                : [spine(v), end]);
        }
    }
    const body = bladeBody({ spine, halfWidth, edge, shade: bend >= 0 ? 1 : -1, spacing: HATCH * (L < 0.6 ? 1.4 : 1), grain: "across", weight, midrib: true, veins,
        samples: Math.round(Math.min(48, Math.max(light ? 10 : 14, L * 26))) }, rng);
    // A leaflet of a compound leaf is too small to be worth cutting in shade.
    if (light) {
        body.grain = [];
        body.shadow = [];
    }
    const shapes = [line([[0, 0], [0, Math.max(petiole, y0 + L * 0.05)]], Math.max(0.012, length * 0.016))];
    if (spec.leaf === "chard" || spec.leaf === "rhubarb" || spec.leaf === "brassica") {
        // The thick pale midrib and stalk the crop is grown for.
        const rib = bladeBody({ spine: v => [bend * L * (v * 0.7) ** 2, (y0 + L * 0.7) * v], halfWidth: v => length * 0.03 * (1 - 0.6 * v), shade: 1, spacing: HATCH, grain: "along", reach: [0.2, 0.5], weight: 0.25, samples: 14 }, rng);
        return [shapes[0], body, rib];
    }
    shapes.push(body);
    return shapes;
}
/** A palmate leaf by its outline in polar terms: pointed lobes (maple) or deep toothed lobes (plane). */
function palmLeaf(rng, length, deep, toothed) {
    const petiole = length * 0.3;
    const centre = [0, petiole];
    const L = length - petiole;
    const lobes = [-82, -42, 0, 42, 82].map(a => (a + rng.sym(5)) * DEG);
    const reach = [0.5, 0.85, 1, 0.85, 0.5].map(r => r * L * rng.range(0.92, 1.04));
    const half = (deep ? 19 : 24) * DEG;
    const sinus = deep ? 0.28 : 0.38;
    const radius = (theta) => {
        let best = Math.abs(theta) > 2.3 ? 0.18 * L : sinus * L;
        lobes.forEach((angle, i) => {
            const x = Math.abs(theta - angle) / half;
            if (x < 1)
                best = Math.max(best, reach[i] * (1 - x ** 1.25) ** 0.6);
        });
        const teeth = toothed ? 0.05 : deep ? 0.015 : 0.035;
        return best * (1 - teeth * Math.abs(Math.sin(theta * (toothed ? 18 : 7))));
    };
    const outline = sample(v => {
        const theta = -Math.PI + 2 * Math.PI * v;
        return add(centre, dirOf(theta), radius(theta));
    }, 90).slice(0, -1);
    const shade = bend(rng);
    const grain = [];
    for (let k = -40; k <= 40; k += 1) {
        const y = centre[1] + k * HATCH * 1.05;
        grain.push([[-length, y - length * 0.35 * shade], [length, y + length * 0.35 * shade]]);
    }
    const veins = lobes.map((angle, i) => [centre, add(centre, dirOf(angle), reach[i] * 0.9)]);
    for (const [i, angle] of lobes.entries()) {
        for (const t of [0.35, 0.6]) {
            const start = add(centre, dirOf(angle), reach[i] * t * 0.9);
            for (const sd of [1, -1])
                veins.push([start, add(start, dirOf(angle + sd * 0.75), reach[i] * 0.2)]);
        }
    }
    const body = { type: "body", outline, shadow: [[[0, -length], [shade * length * 2, -length], [shade * length * 2, length * 2], [0, length * 2]]], grain, veins, weight: 0.55 };
    return [line([[0, 0], centre], length * 0.018), body];
}
const bend = (rng) => rng.chance(0.5) ? 1 : -1;
/** Leaflets in pairs along a rachis with one at the tip (frêne, cresson, céleri). */
function pinnateOf(rng, length, bendBy, pairs, share, leaflet, ribbed = false) {
    const rachis = v => [bendBy * length * v * v, length * v];
    const shapes = [];
    if (ribbed) {
        // Céleri's stalk: a broad grooved rib.
        shapes.push(bladeBody({ spine: v => rachis(v * 0.6), halfWidth: v => length * 0.03 * (1 - 0.5 * v), shade: 1, spacing: HATCH, grain: "along", reach: [0.3, 0.8], weight: 0.3,
            veins: [-0.4, 0.4].map(q => sample(v => add(rachis(v * 0.6), [length * 0.03 * q * (1 - 0.5 * v), 0]), 6, 0.05, 0.95)), samples: 14 }, rng));
        shapes.push(line(sample(v => rachis(0.6 + 0.4 * v), 5), length * 0.014));
    }
    else
        shapes.push(line(sample(rachis, 10), length * 0.016));
    for (let k = 0; k < pairs; k += 1) {
        const v = (ribbed ? 0.62 : 0.22) + (ribbed ? 0.3 : 0.66) * k / pairs;
        const p = rachis(v), t = tangent(rachis, v);
        const size = length * share * (1 - 0.3 * v);
        for (const side of [1, -1])
            shapes.push(...leaflet(rng, size, -side * 0.08).map(shape => turnShape(shape, Math.atan2(t[0], t[1]) * -1 + side * -1.0, p)));
    }
    const tip = rachis(1), t = tangent(rachis, 1);
    shapes.push(...leaflet(rng, length * share * (ribbed ? 1 : 1.05), 0).map(shape => turnShape(shape, -Math.atan2(t[0], t[1]), tip)));
    return shapes;
}
/** Leaflets spread like fingers from the top of a long petiole (marronnier's broad ones, chanvre's narrow ones). */
function digitateOf(rng, length, count, spread, leaflet, petiole) {
    const top = [0, length * petiole];
    const shapes = [line([[0, 0], top], length * 0.02)];
    for (let k = 0; k < count; k += 1) {
        const u = (k / (count - 1)) * 2 - 1;
        const a = u * spread + rng.sym(0.05);
        const size = length * (1 - petiole) * (1 - 0.45 * u * u) * rng.range(0.95, 1.05);
        shapes.push(...leaflet(rng, size, u * 0.06).map(shape => turnShape(shape, -a, top)));
    }
    return shapes;
}
/** Asparagus foliage: a feathery branch whose fine cladodes stand in little tufts. */
function cladodes(rng, length, bendBy) {
    const axis = v => [bendBy * length * v * v, length * v];
    const comb = [axis(0)];
    const twigs = Math.max(3, Math.round(length / 0.22));
    for (let k = 0; k <= twigs; k += 1) {
        const v = 0.15 + 0.85 * k / twigs;
        const p = axis(v), t = tangent(axis, v);
        comb.push(p);
        const side = k % 2 ? 1 : -1;
        const twigLen = length * 0.28 * (1 - 0.6 * v);
        const tip = add(p, rot(t, side * 0.7), twigLen);
        comb.push(tip);
        for (const f of [0.35, 0.7, 1]) {
            const q = add(p, rot(t, side * 0.7), twigLen * f);
            for (let j = 0; j < 4; j += 1)
                comb.push(add(q, rot(t, side * 0.7 + lerp(-0.9, 0.9, j / 3)), 0.07), q);
        }
        comb.push(p);
    }
    return [line(comb, 0.007, false)];
}
/**
 * A glasswort branchlet: a fleshy stem pinched at each joint, drawn as one body per chain, with smaller
 * chains at alternate joints; `marks` sets the size of the flowers or seeds sunk in the joints.
 */
function joints(rng, length, bendBy, marks = 0) {
    const shapes = [];
    const sunk = [];
    const w0 = Math.max(0.035, length * 0.045);
    const chain = (base, angle, len, w, depth) => {
        const count = Math.max(2, Math.round(len / (w * 1.7)));
        const curl = bendBy * 0.4 + rng.sym(0.1);
        const spine = v => add(base, rot([curl * len * v * v, len * v], -angle));
        const halfWidth = (v) => w * (1 - 0.35 * v) * (0.6 + 0.4 * Math.abs(Math.sin(Math.PI * v * count)) ** 0.35) * Math.min(1, (1 - v) * 10) ** 0.4;
        const body = bladeBody({ spine, halfWidth, shade: 1, spacing: HATCH * 0.8, grain: "along", reach: [0.5, 0.9], weight: 0.45, samples: count * 3 }, rng);
        body.veins = [];
        // Only the main chain is cut in shade; the side chains stay as outlines.
        if (depth > 0) {
            body.grain = [];
            body.shadow = [];
        }
        shapes.push(body);
        for (let k = 1; k < count; k += 1) {
            const v = k / count, p = spine(v), t = tangent(spine, v);
            if (marks > 0 && k % 2 === 0)
                for (const q of [-0.45, 0, 0.45])
                    sunk.push(add(add(p, [-t[1], t[0]], q * halfWidth(v)), t, -w * 0.4));
            if (depth === 0 && k < count - 1 && k % 4 === 1)
                for (const sd of [1, -1])
                    chain(p, Math.atan2(t[0], t[1]) + sd * 0.8, len * 0.38, w * 0.75, 1);
        }
    };
    chain([0, 0], 0, length, w0, 0);
    if (sunk.length > 0)
        shapes.push(dots(sunk, w0 * 0.16 * marks));
    return shapes;
}
/** The leaf a variant names, and the part of it used for small fillers (a leaflet of a compound leaf). */
function leafOf(spec) {
    const simple = (over, weight = 0.5, light = false) => (rng, length, b) => bladeLeaf(rng, length, b, { ...spec, ...over }, weight, light);
    const compound = (leaf, part) => ({ leaf, part });
    switch (spec.leaf) {
        case "maple": return compound((rng, length) => palmLeaf(rng, length, false, spec.margin !== "entire"), (rng, length) => palmLeaf(rng, length, false, false));
        case "plane": return compound((rng, length) => palmLeaf(rng, length, true, true), (rng, length) => palmLeaf(rng, length, true, false));
        case "pinnate": {
            const part = simple({ leaf: "lanceolate", width: 0.32 }, 0.5, true);
            return compound((rng, length, b) => pinnateOf(rng, length, b, 5, 0.3, part), part);
        }
        case "cress": {
            const part = simple({ leaf: "elliptic", width: 0.8 }, 0.5, true);
            return compound((rng, length, b) => pinnateOf(rng, length, b, 2, 0.28, part), part);
        }
        case "celery": {
            const part = simple({ leaf: "cut", width: 0.75, margin: "serrate" }, 0.5, true);
            return compound((rng, length, b) => pinnateOf(rng, length, b, 3, 0.26, part, true), part);
        }
        case "digitate": {
            const part = simple({ leaf: "round", width: 0.42 }, 0.5, true);
            return compound((rng, length) => digitateOf(rng, length, 7, 1.25, part, 0.4), part);
        }
        case "hemp": {
            const part = simple({ leaf: "lanceolate", width: 0.17 }, 0.5, true);
            return compound((rng, length) => digitateOf(rng, length, 7, 1.35, part, 0.3), part);
        }
        case "cladode": return compound(cladodes, cladodes);
        case "jointed": return compound((rng, length, b) => joints(rng, length, b), (rng, length, b) => joints(rng, length, b));
        default: {
            const leaf = simple({}, ["elliptic", "chard"].includes(spec.leaf) && spec.width < 0.45 ? 0.65 : 0.5);
            return compound(leaf, leaf);
        }
    }
}
// ---------------------------------------------------------------- catkins, nuts and keys
/** A catkin along +y: a slim cylinder of overlapping scales, its edge beaded by them. */
function catkin(rng, len, w, weight, fluffy = false) {
    const sway = rng.sym(0.25);
    const spine = (v) => [sway * len * v * v, len * v];
    const hw = (v) => w * Math.min(1, (v + 0.05) / 0.15) ** 0.5 * (1 - v ** 6) ** 0.5;
    const body = bladeBody({ spine, halfWidth: hw, edge: v => w * (fluffy ? 0.3 : 0.18) * Math.abs(Math.sin(v * len / (w * 0.9) * Math.PI)), shade: 1,
        spacing: HATCH * 0.6, grain: "across", weight, samples: Math.max(16, Math.round(len / (w * 0.4))) }, rng);
    const rows = Math.floor(len / (w * 0.9));
    body.veins = Array.from({ length: rows }, (_, i) => {
        const v = (i + 0.5) / rows, p = spine(v), t = tangent(spine, v);
        return [add(p, [-t[1], t[0]], hw(v) * 0.8), add(p, t, w * 0.35), add(p, [t[1], -t[0]], hw(v) * 0.8)];
    });
    const shapes = [body];
    if (fluffy)
        shapes.push(dots(Array.from({ length: Math.round(len / 0.02) }, (_, i) => {
            const v = (i + 0.5) / Math.round(len / 0.02), p = spine(v), t = tangent(spine, v);
            return add(p, [-t[1], t[0]], (i % 2 ? 1 : -1) * hw(v) * rng.range(1.0, 1.25));
        }), w * 0.08));
    return shapes;
}
/** Catkins hanging from one point. */
function catkins(rng, s, count, len, w, weight, fluffy = false) {
    const shapes = [];
    for (let k = 0; k < count; k += 1) {
        const a = (k - (count - 1) / 2) * 0.35 + rng.sym(0.08);
        shapes.push(...catkin(rng, s * len * rng.range(0.85, 1.05), s * w, weight, fluffy).map(shape => turnShape(shape, -a, [0, s * 0.05])));
    }
    return [line([[0, 0], [0, s * 0.06]], s * 0.02), ...shapes];
}
/** A winged seed: the nutlet at the stalk end and a veined wing beyond it. */
function wingSeed(rng, at, angle, len, wide, weight, round = false) {
    const wing = round
        ? roundBody(circle([0, len * 0.5], len * 0.5, len * 0.5, 16), [0, len * 0.5], len * 0.5, HATCH * 0.7, weight * 0.6)
        : bladeBody({ spine: v => [0, len * v], halfWidth: v => wide * Math.sin(Math.PI * Math.min(1, v * 0.85 + 0.12)) ** 0.6 * (0.6 + 0.4 * v),
            shade: 1, spacing: HATCH * 0.7, grain: "along", reach: [0.2, 0.6], weight, samples: 14 }, rng);
    if (!round)
        wing.veins = [-0.5, 0, 0.5].map(q => sample(v => [wide * q * v * 0.8, len * (0.2 + 0.75 * v)], 4));
    const seedAt = round ? [0, len * 0.5] : [0, len * 0.14];
    return [turnShape(wing, -angle, at), turnShape(nut(seedAt, len * (round ? 0.14 : 0.1), len * (round ? 0.16 : 0.16), 0, Math.min(0.9, weight + 0.25)), -angle, at)];
}
/** A cup of overlapping scales with a nut seated in it (chêne, liège). */
function acorn(rng, at, angle, r, stage, shaggy, fallen = false) {
    const ripe = stage === "seed";
    const shapes = [];
    const nutLen = r * (ripe ? 1.5 : 1.25);
    if (!fallen) {
        const cup = roundBody(profile(r * 0.75, v => r * 0.62 * (0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, v * 0.7 + 0.3))), 0, 12), [0, r * 0.4], r * 0.6, HATCH * 0.5, 0.75);
        cup.veins = [0.25, 0.5, 0.75].map(f => sample(u => [(u * 2 - 1) * r * 0.58, r * 0.75 * f + Math.abs(Math.sin(u * Math.PI * 4)) * r * 0.08], 12));
        if (shaggy)
            shapes.push(...[-1, -0.5, 0, 0.5, 1].map(q => line([[q * r * 0.6, r * 0.7], [q * r * 0.95, r * 0.95]], r * 0.06)));
        shapes.push(turnShape(cup, -angle, at));
    }
    const body = nut([0, r * 0.55 + nutLen * 0.45], r * 0.5, nutLen * 0.5, 0, ripe ? 0.75 : 0.4);
    shapes.unshift(turnShape(body, -angle, at), turnShape(dots([[0, r * 0.55 + nutLen * 0.95]], r * 0.07), -angle, at));
    return shapes;
}
/** A spiny husk: green and bristling, then split to show its fruit (hêtre's nuts, marronnier's conker). */
function spinyHusk(rng, at, r, open, inside) {
    const shapes = [];
    if (!open) {
        const body = roundBody(circle(at, r, r * 1.05, 18), at, r, HATCH * 0.6, 0.45);
        const spines = [];
        for (let k = 0; k < 26; k += 1) {
            const a = k / 26 * Math.PI * 2;
            const p = add(at, [Math.cos(a), Math.sin(a) * 1.05], r);
            spines.push(p, add(p, [Math.cos(a), Math.sin(a)], r * (inside === "conker" ? 0.3 : 0.22)), p);
        }
        const inner = Array.from({ length: 14 }, () => { const a = rng.range(0, Math.PI * 2), d = Math.sqrt(rng.u()) * r * 0.8; return add(at, [Math.cos(a), Math.sin(a)], d); });
        return [line(spines, r * 0.05, false), body, dots(inner, r * 0.045)];
    }
    // Split into reflexed valves.
    for (const a of inside === "conker" ? [-2.2, 0, 2.2] : [-2.5, -0.8, 0.8, 2.5]) {
        const valve = bladeBody({ spine: v => [0, r * 1.05 * v], halfWidth: v => r * 0.42 * Math.sin(Math.PI * Math.min(1, v * 0.9 + 0.1)) ** 0.7, shade: 1, spacing: HATCH * 0.6, grain: "along", reach: [0.3, 0.7], weight: 0.55, samples: 10 }, rng);
        const spines = Array.from({ length: 6 }, (_, k) => { const v = 0.2 + 0.13 * k; return [[r * 0.4 * Math.sin(Math.PI * v), r * v], [r * 0.62 * Math.sin(Math.PI * v), r * v + r * 0.08]]; }).flat();
        shapes.push(turnShape(valve, a, at), turnShape(line(spines, r * 0.04, false), a, at));
    }
    if (inside === "conker") {
        const c = add(at, [0, r * 0.2]);
        const conker = darkBody(circle(c, r * 0.72, r * 0.68, 18), c, r * 0.72);
        shapes.push(conker, roundBody(oval(add(c, [0, -r * 0.35]), r * 0.35, r * 0.18), add(c, [0, -r * 0.35]), r * 0.3, HATCH, 0.15));
    }
    else {
        for (const sd of [-1, 1]) {
            const c = add(at, [sd * r * 0.28, r * 0.35]);
            const tri = [add(c, [-r * 0.28, -r * 0.3]), add(c, [r * 0.28, -r * 0.3]), add(c, [0, r * 0.5])];
            shapes.push(roundBody(tri, c, r * 0.35, HATCH * 0.5, 0.8));
        }
    }
    return shapes;
}
// ---------------------------------------------------------------- flowers and inflorescences
/** A small open flower of `n` pale petals, seen face on. */
function flower(rng, at, r, n, accent = false) {
    const start = rng.range(0, Math.PI * 2);
    const shapes = Array.from({ length: n }, (_, k) => {
        const d = dirOf(start + k / n * Math.PI * 2);
        return bladeBody({ spine: v => add(at, d, r * v), halfWidth: v => r * (n === 4 ? 0.42 : 0.36) * Math.sin(Math.PI * Math.min(1, v * 0.85 + 0.15)) ** 0.6,
            shade: 1, spacing: HATCH * 0.6, grain: "along", reach: [0.1, 0.25], weight: 0.2, samples: 8 }, rng);
    });
    shapes.push(dots([at], r * 0.16));
    if (accent)
        shapes.push({ type: "dots", points: [add(at, [r * 0.2, r * 0.25])], radius: r * 0.12, tone: "accent" });
    return shapes;
}
/** An axis with side branches, each ending at a point the caller draws on; `upright` racemes open from the bottom. */
function branched(rng, s, count, spread, lengthShare, stalk) {
    const axis = v => [s * 0.04 * Math.sin(v * 3 + 1), s * lengthShare * v];
    const shapes = [line(sample(axis, 8), s * 0.022)];
    const tips = [];
    for (let k = 0; k < count; k += 1) {
        const v = 0.15 + 0.8 * k / Math.max(1, count - 1);
        const p = axis(v), side = k % 2 ? 1 : -1;
        const d = rot(tangent(axis, v), side * spread * (1 - 0.5 * v));
        const len = s * stalk * (1 - 0.6 * v);
        const at = add(p, d, len);
        if (len > 0.01)
            shapes.push(line([p, at], s * 0.01));
        tips.push({ at, dir: d, v });
    }
    tips.push({ at: axis(1), dir: [0, 1], v: 1 });
    return { shapes, tips };
}
/** A cluster of tiny florets or seeds round a point, as dots. */
const clusterAt = (rng, at, r, count) => Array.from({ length: count }, () => {
    const a = rng.range(0, Math.PI * 2), d = Math.sqrt(rng.u()) * r;
    return add(at, [Math.cos(a), Math.sin(a)], d);
});
/** A four-petalled cross flower's raceme: buds at the tip, crosses below them, pods lower still (cresson, roquette, cochléaria). */
function crossRaceme(rng, s, stage, roundPods) {
    const { shapes, tips } = branched(rng, s, 8, 0.9, 0.85, 0.16);
    tips.forEach(({ at, dir, v }, k) => {
        const open = stage === "bloom" ? v > 0.55 : stage === "seed" ? v > 0.85 : false;
        const pod = stage === "seed" ? v <= 0.85 : stage === "bloom" ? v <= 0.55 && k % 2 === 0 : false;
        if (pod) {
            if (roundPods)
                shapes.push(nut(add(at, dir, s * 0.05), s * 0.045, s * 0.05, 0, 0.45));
            else
                shapes.push(line([at, add(at, rot(dir, 0.35), s * 0.18), add(at, rot(dir, 0.25), s * 0.24)], s * 0.022));
        }
        else if (open)
            shapes.push(...flower(rng, at, s * 0.07, 4));
        else
            shapes.push(nut(at, s * 0.022, s * 0.032, Math.atan2(dir[0], dir[1]), 0.4));
    });
    return shapes;
}
/** A branched panicle of minute florets that become small seeds (épinards, blette, rhubarbe, chanvre), rusty valves (oseille) or paired round bracts (arroche). */
function panicle(rng, s, stage, seed) {
    const { shapes, tips } = branched(rng, s, 9, 0.75, 0.95, 0.22);
    const small = [];
    for (const { at, dir } of tips) {
        const cluster = [at, add(at, dir, -s * 0.05), add(at, rot(dir, 0.6), -s * 0.04)];
        if (stage !== "seed") {
            for (const c of cluster)
                small.push(...clusterAt(rng, c, s * 0.03, stage === "bud" ? 3 : 6));
            continue;
        }
        for (const c of cluster.slice(0, seed === "seeds" ? 3 : 2)) {
            if (seed === "valves")
                shapes.push(roundBody([add(c, [0, s * 0.05]), add(c, [s * 0.04, s * 0.01]), add(c, [0, -s * 0.04]), add(c, [-s * 0.04, s * 0.01])], c, s * 0.045, HATCH * 0.45, 0.75));
            else if (seed === "discs") {
                shapes.push(nut(c, s * 0.045, s * 0.05, 0, 0.35), line([add(c, [0, -s * 0.045]), add(c, [0, s * 0.045])], s * 0.006));
            }
            else
                small.push(...clusterAt(rng, c, s * 0.03, 4));
        }
    }
    if (small.length > 0)
        shapes.push(dots(small, s * (stage === "seed" ? 0.014 : 0.011)));
    return shapes;
}
/** Small composite heads on a branched stalk: closed, open with strap rays, then little clocks (laitue, romaine, endive). */
function heads(rng, s, stage) {
    const { shapes, tips } = branched(rng, s, 6, 0.7, 0.8, 0.2);
    for (const { at, dir } of tips) {
        const a = Math.atan2(dir[0], dir[1]);
        if (stage === "bud") {
            shapes.push(roundBody(oval(at, s * 0.03, s * 0.05, a), at, s * 0.05, HATCH * 0.5, 0.45));
            continue;
        }
        if (stage === "seed") {
            const centre = add(at, dir, s * 0.04);
            const rays = [];
            for (let k = 0; k < 9; k += 1)
                rays.push(centre, add(centre, dirOf(a + lerp(-1.3, 1.3, k / 8)), s * 0.08));
            shapes.push(line(rays, s * 0.005, false));
            continue;
        }
        const ligules = [];
        for (let k = 0; k < 12; k += 1) {
            const d = dirOf(k / 12 * Math.PI * 2);
            ligules.push(at, add(at, [d[0], d[1] * 0.6], s * 0.08));
        }
        shapes.push(line(ligules, s * 0.009, false), dots([at], s * 0.018));
    }
    return shapes;
}
/** Small compound umbels: tiny florets, then ribbed seeds (céleri). */
function umbels(rng, s, stage) {
    const shapes = [line([[0, 0], [0, s * 0.35]], s * 0.02)];
    const hub = [0, s * 0.35];
    for (let k = 0; k < 6; k += 1) {
        const a = lerp(-1, 1, k / 5);
        const tip = add(hub, dirOf(a), s * 0.32);
        shapes.push(line([hub, tip], s * 0.008));
        const florets = Array.from({ length: 6 }, (_, j) => add(tip, dirOf(lerp(-1.1, 1.1, j / 5)), s * 0.06));
        if (stage === "seed")
            shapes.push(...florets.map(p => nut(p, s * 0.014, s * 0.022, 0, 0.6)));
        else
            shapes.push(dots(florets, s * (stage === "bud" ? 0.008 : 0.013)));
    }
    return shapes;
}
/** Forked cymes crowded with minute flowers, then nutlets (mâche). */
function cymes(rng, s, stage) {
    const shapes = [];
    const ends = [];
    const fork = (p, a, len, depth) => {
        const q = add(p, dirOf(a), len);
        shapes.push(line([p, q], s * (0.02 - depth * 0.004)));
        if (depth >= 3) {
            ends.push(q);
            return;
        }
        for (const sd of [-1, 1])
            fork(q, a + sd * 0.5, len * 0.62, depth + 1);
    };
    fork([0, 0], 0, s * 0.35, 0);
    const points = ends.flatMap(e => clusterAt(rng, e, s * 0.035, stage === "bud" ? 3 : 5));
    shapes.push(stage === "seed" ? dots(points.filter((_, i) => i % 2 === 0), s * 0.016) : dots(points, s * 0.011));
    return shapes;
}
/** A cauliflower curd: a dome of tight rounded florets cupped in wrapper leaves; at the end it loosens and bolts. */
function curd(rng, s, stage) {
    const r = s * (stage === "bud" ? 0.24 : 0.4);
    const c = [0, s * 0.3 + r * 0.4];
    const shapes = [];
    const wrapper = (sd) => bladeLeaf(rng, s * (stage === "bud" ? 0.8 : 0.95), sd * 0.2, { leaf: "brassica", width: 0.55, margin: "wavy", asymmetric: false }, 0.45)
        .map(shape => turnShape(shape, sd * -0.75, [0, 0]));
    shapes.push(...wrapper(-1), ...wrapper(1));
    if (stage === "seed") {
        // Bolting: the curd breaks into stalks of cross flowers and pods.
        const { shapes: stalks, tips } = branched(rng, s, 6, 0.8, 0.9, 0.25);
        shapes.push(...stalks.map(shape => turnShape(shape, 0, [0, s * 0.3])));
        for (const { at, dir } of tips)
            shapes.push(line([add(at, [0, s * 0.3]), add(add(at, [0, s * 0.3]), dir, s * 0.15)], s * 0.018), ...flower(rng, add(at, [0, s * 0.3]), s * 0.05, 4));
        shapes.push(roundBody(profile(r * 0.5, v => r * 0.8 * Math.sqrt(Math.max(0, 1 - v * v)), c[1] - r * 0.3), c, r * 0.6, HATCH * 0.6, 0.35));
        return shapes;
    }
    const dome = profile(r * 0.9, v => r * Math.sqrt(Math.max(0, 1 - v * v)) * (1 + 0.04 * Math.abs(Math.sin(v * 20))), c[1] - r * 0.3, 20);
    const body = roundBody(dome, c, r, HATCH * 0.7, 0.3);
    body.veins = [];
    for (let k = 0; k < (stage === "bud" ? 8 : 18); k += 1) {
        const a = rng.range(0.15, Math.PI - 0.15), d = rng.range(0.2, 0.85) * r;
        const p = add(c, [Math.cos(a) * d, -r * 0.3 + Math.sin(a) * d * 0.9 + r * 0.3 * (1 - d / r)]);
        body.veins.push(sample(t => add(p, [Math.cos(Math.PI * t) * r * 0.1, Math.sin(Math.PI * t) * r * 0.07]), 5));
    }
    shapes.push(body);
    return shapes;
}
/** A broccoli head: thick branching stalks ending in knobbed clusters of buds; at the end they open as small crosses. */
function broccoli(rng, s, stage) {
    const shapes = [];
    const trunk = bladeBody({ spine: v => [0, s * 0.35 * v], halfWidth: v => s * 0.06 * (1 - 0.3 * v), shade: 1, spacing: HATCH, grain: "along", reach: [0.3, 0.7], weight: 0.35, samples: 10 }, rng);
    shapes.push(trunk);
    const top = [0, s * 0.35];
    const count = stage === "bud" ? 3 : 5;
    for (let k = 0; k < count; k += 1) {
        const a = lerp(-0.8, 0.8, k / (count - 1));
        const end = add(top, dirOf(a), s * (0.18 + 0.06 * (1 - Math.abs(a))));
        shapes.push(line([top, end], s * 0.04));
        const r = s * (stage === "bud" ? 0.09 : 0.13);
        const c = add(end, dirOf(a), r * 0.6);
        if (stage === "seed") {
            for (let j = 0; j < 3; j += 1)
                shapes.push(...flower(rng, add(c, dirOf(a + lerp(-0.8, 0.8, j / 2)), r * 0.8), s * 0.04, 4));
            shapes.push(dots(clusterAt(rng, c, r * 0.8, 10), s * 0.012));
        }
        else {
            shapes.push(roundBody(circle(c, r, r * 0.85, 14), c, r, HATCH * 0.5, 0.65), dots(clusterAt(rng, c, r * 0.85, 16), s * 0.014));
        }
    }
    return shapes;
}
function fruitOf(name, catkinKind) {
    const male = (rng, s, stage) => {
        const [len, w, count] = catkinKind === "fat" ? [0.3, 0.1, 2] : catkinKind === "long" ? [0.8, 0.06, 2] : [0.7, 0.035, 3];
        return catkins(rng, s, count, len * (stage === "bud" ? 0.35 : 1), w * (stage === "bud" ? 0.8 : 1), stage === "bud" ? 0.6 : 0.45, catkinKind === "fat");
    };
    // Hanging fruit is drawn pointing down from an arched stalk, so it hangs whether it ends a stem or a branch.
    const hangs = (draw, size = 1) => ({ upright: 1.4, off: -0.15, size, draw: (rng, s, stage) => {
            const end = [s * 0.14, s * 0.2];
            return [line(sample(bezier3([0, 0], [0, s * 0.16], [s * 0.08, s * 0.24], end), 6), s * 0.02), ...draw(rng, s, stage).map(shape => turnShape(shape, Math.PI, end))];
        } });
    const stands = (draw, size = 1) => ({ draw, upright: 1.2, off: 0.45, size });
    switch (name) {
        case "hazelnut": return hangs((rng, s, stage) => {
            if (stage !== "seed") {
                const shapes = male(rng, s, stage);
                if (stage === "bloom")
                    shapes.push({ type: "dots", points: clusterAt(rng, [s * 0.1, s * 0.02], s * 0.025, 5), radius: s * 0.01, tone: "accent" });
                return shapes;
            }
            const shapes = [line([[0, 0], [0, s * 0.12]], s * 0.02)];
            for (const [x, a] of [[-0.12, 0.4], [0.12, -0.4], [0, 0]]) {
                const at = [x * s, s * 0.12];
                shapes.push(nut(add(at, dirOf(-a), s * 0.27), s * 0.12, s * 0.15, -a, 0.7));
                const husk = bladeBody({ spine: v => [0, s * 0.18 * v], halfWidth: v => s * 0.13 * Math.sin(Math.PI * Math.min(1, v * 0.8 + 0.2)) ** 0.5,
                    edge: v => s * 0.025 * Math.abs(Math.sin(v * 14)) * v, shade: 1, spacing: HATCH * 0.7, grain: "along", reach: [0.3, 0.7], weight: 0.4, samples: 16 }, rng);
                shapes.push(turnShape(husk, a, at));
            }
            return shapes;
        });
        case "cotton": return (catkinKind === "fat" ? stands : hangs)((rng, s, stage) => {
            if (stage === "bud" && catkinKind === "fat")
                return [line([[0, 0], [0, s * 0.08]], s * 0.02), roundBody(oval([0, s * 0.18], s * 0.06, s * 0.11), [0, s * 0.18], s * 0.1, HATCH * 0.5, 0.55)];
            if (stage !== "seed") {
                const shapes = male(rng, s, stage);
                // Poplar's anthers are red in the catkin.
                if (stage === "bloom" && catkinKind !== "fat")
                    shapes.push({ type: "dots", points: clusterAt(rng, [0, s * 0.45], s * 0.08, 6), radius: s * 0.011, tone: "accent" });
                return shapes;
            }
            const shapes = [line([[0, 0], [0, s * 0.06]], s * 0.02)];
            const len = s * (catkinKind === "fat" ? 0.45 : 0.75);
            const tufts = [];
            const capsules = [];
            for (let k = 0; k < 9; k += 1) {
                const p = [rng.sym(0.02) * s, s * 0.06 + len * (k + 0.5) / 9];
                capsules.push(p);
                if (k % 2 === 0)
                    for (let j = 0; j < 6; j += 1)
                        tufts.push(p, add(p, dirOf(rng.range(0, Math.PI * 2)), s * rng.range(0.08, 0.15)), p);
            }
            shapes.push(line([[0, s * 0.06], [0, s * 0.06 + len]], s * 0.012), ...capsules.map(p => nut(p, s * 0.028, s * 0.04, 0, 0.5)), line(tufts, s * 0.004, false));
            return shapes;
        });
        case "seedcatkin": return hangs((rng, s, stage) => stage !== "seed" ? male(rng, s, stage) : [
            ...catkins(rng, s, 1, 0.42, 0.065, 0.7),
            ...wingSeed(rng, [s * 0.25, s * 0.35], 0.6, s * 0.06, s * 0.05, 0.4, true), ...wingSeed(rng, [-s * 0.2, s * 0.55], -0.4, s * 0.06, s * 0.05, 0.4, true),
        ]);
        case "strobile": return hangs((rng, s, stage) => {
            if (stage !== "seed")
                return male(rng, s, stage);
            const shapes = [line([[0, 0], [0, s * 0.15]], s * 0.02)];
            for (const a of [-0.45, 0, 0.45]) {
                const stalkEnd = add([0, s * 0.15], dirOf(a), s * 0.12);
                const c = add(stalkEnd, dirOf(a), s * 0.1);
                const cone = darkBody(oval(c, s * 0.07, s * 0.1, a), c, s * 0.09);
                cone.veins = [-0.5, 0, 0.5].map(q => [add(c, rot([-s * 0.06, q * s * 0.08], -a)), add(c, rot([s * 0.06, q * s * 0.08 + s * 0.02], -a))]);
                shapes.push(line([[0, s * 0.15], stalkEnd], s * 0.012), cone);
            }
            return shapes;
        });
        case "acorn": return hangs((rng, s, stage) => {
            const stalked = catkinKind !== "shaggy";
            if (stage === "bud")
                return male(rng, s, "bloom");
            const stalk = stalked ? s * 0.35 : s * 0.06;
            const shapes = [line([[0, 0], [rng.sym(0.03) * s, stalk * 0.5], [0, stalk]], s * 0.018)];
            const r = s * 0.17;
            const count = stage === "seed" ? 2 : 3;
            for (let k = 0; k < count; k += 1) {
                const a = (k - (count - 1) / 2) * 0.7;
                shapes.push(...acorn(rng, add([0, stalk], dirOf(a), r * 0.3), a, r, stage, catkinKind === "shaggy"));
            }
            if (stage === "seed")
                shapes.push(...acorn(rng, [s * 0.32, stalk * 0.4], 2.6, r, stage, false, true));
            return shapes;
        });
        case "beechnut": return hangs((rng, s, stage) => {
            const stalk = line([[0, 0], [0, s * 0.25]], s * 0.016);
            if (stage === "bud")
                return [stalk, roundBody(circle([0, s * 0.3], s * 0.07, s * 0.07, 12), [0, s * 0.3], s * 0.07, HATCH * 0.5, 0.4), dots(clusterAt(rng, [0, s * 0.3], s * 0.09, 12), s * 0.01)];
            return [stalk, ...spinyHusk(rng, [0, s * 0.25 + s * 0.17], s * 0.17, stage === "seed", "beechnuts")];
        });
        case "hopbract": return hangs((rng, s, stage) => {
            if (stage === "bud")
                return male(rng, s, stage);
            const shapes = [line([[0, 0], [0, s * 0.75]], s * 0.012)];
            for (let k = 0; k < 6; k += 1) {
                const v = 0.15 + 0.13 * k;
                for (const sd of [1, -1]) {
                    const at = [0, s * 0.75 * v];
                    const a = sd * 0.9;
                    const bract = bladeBody({ spine: u => [0, s * 0.22 * u], halfWidth: u => s * 0.035 * Math.sin(Math.PI * Math.min(1, u * 0.9 + 0.1)) ** 0.5, shade: 1, spacing: HATCH * 0.8, grain: "along", reach: [0.2, 0.5], weight: stage === "seed" ? 0.6 : 0.3, midrib: true, samples: 10 }, rng);
                    const side1 = bladeBody({ spine: u => [s * 0.025 * u, s * 0.08 * u], halfWidth: u => s * 0.018 * Math.sin(Math.PI * u), shade: 1, spacing: HATCH, grain: "along", weight: 0.3, samples: 6 }, rng);
                    shapes.push(turnShape(bract, a, at), turnShape(side1, a + 0.5, at), turnShape(dots([[0, s * 0.02]], s * 0.022), a, at));
                }
            }
            return shapes;
        });
        case "samaras": return hangs((rng, s, stage) => {
            if (stage === "bud") {
                const { shapes, tips } = branched(rng, s * 0.6, 5, 0.7, 0.6, 0.3);
                return [...shapes, dots(tips.map(t => t.at), s * 0.02)];
            }
            const shapes = [];
            for (const a of [-0.35, 0.35]) {
                const end = add([0, 0], dirOf(a), s * 0.35);
                shapes.push(line([[0, 0], end], s * 0.012));
                const spread = stage === "seed" ? 1.0 : 0.5;
                for (const sd of [1, -1])
                    shapes.push(...wingSeed(rng, end, a + sd * spread, s * 0.42, s * 0.09, stage === "seed" ? 0.65 : 0.3));
            }
            return shapes;
        });
        case "wafer": return stands((rng, s, stage) => {
            const shapes = [line([[0, 0], [0, s * 0.5]], s * 0.02)];
            if (stage === "bud")
                return [...shapes, dots([0.15, 0.3, 0.45].flatMap(f => clusterAt(rng, [0, s * f], s * 0.05, 6)), s * 0.014)];
            for (let k = 0; k < 8; k += 1) {
                const at = [0, s * (0.1 + 0.055 * k)];
                const a = (k % 2 ? 1 : -1) * rng.range(0.5, 1.2);
                shapes.push(line([at, add(at, dirOf(a), s * 0.05)], s * 0.008), ...wingSeed(rng, add(at, dirOf(a), s * 0.05), a, s * 0.2, 0, stage === "seed" ? 0.6 : 0.3, true));
            }
            return shapes;
        });
        case "keys": return hangs((rng, s, stage) => {
            const shapes = [line([[0, 0], [0, s * 0.15]], s * 0.02)];
            if (stage === "bud")
                return [...shapes, dots(clusterAt(rng, [0, s * 0.2], s * 0.08, 14), s * 0.014)];
            for (let k = 0; k < 8; k += 1) {
                const a = lerp(-0.6, 0.6, k / 7) + rng.sym(0.08);
                const at = add([0, s * 0.15], dirOf(a), s * 0.06);
                shapes.push(line([[0, s * 0.15], at], s * 0.008), ...wingSeed(rng, at, a + (stage === "seed" ? rng.sym(0.3) : 0), s * 0.42, s * 0.045, stage === "seed" ? 0.65 : 0.3));
            }
            return shapes;
        });
        case "bract": return hangs((rng, s, stage) => {
            const shapes = [];
            // The long pale bract the stalk runs along for half its length.
            const bract = bladeBody({ spine: v => [s * 0.12 * v, s * 0.6 * v], halfWidth: v => s * 0.055 * Math.sin(Math.PI * Math.min(1, v * 0.9 + 0.08)) ** 0.5, shade: 1, spacing: HATCH, grain: "across", weight: 0.3, midrib: true, samples: 14 }, rng);
            shapes.push(bract, line([[0, 0], [s * 0.06, s * 0.3], [-s * 0.02, s * 0.5]], s * 0.014));
            const hub = [-s * 0.02, s * 0.5];
            for (let k = 0; k < 5; k += 1) {
                const a = lerp(-1, 1, k / 4);
                const at = add(hub, dirOf(a), s * 0.16);
                shapes.push(line([hub, at], s * 0.008));
                if (stage === "bud")
                    shapes.push(nut(at, s * 0.025, s * 0.025, 0, 0.4));
                else if (stage === "bloom")
                    shapes.push(...flower(rng, at, s * 0.055, 5), dots(clusterAt(rng, at, s * 0.05, 5), s * 0.006));
                else
                    shapes.push(nut(add(at, dirOf(a), s * 0.035), s * 0.045, s * 0.045, 0, 0.55));
            }
            return shapes;
        });
        case "seedball": return hangs((rng, s, stage) => {
            const shapes = [line([[0, 0], [s * 0.03, s * 0.35], [0, s * 0.7]], s * 0.01)];
            for (const f of stage === "bud" ? [0.35, 0.7] : [0.3, 0.62, 0.9]) {
                const c = [0, s * f * 0.85];
                const r = s * (stage === "bud" ? 0.06 : 0.11);
                if (stage === "seed" && f > 0.5) {
                    // Breaking up into tufted achenes.
                    const tufts = [];
                    for (let k = 0; k < 14; k += 1) {
                        const d = dirOf(rng.range(0, Math.PI * 2));
                        const p = add(c, d, r * rng.range(0.9, 1.8));
                        tufts.push(p, add(p, d, r * 0.4), p);
                    }
                    shapes.push(roundBody(circle(c, r * 0.8, r * 0.8, 14), c, r * 0.8, HATCH * 0.5, 0.75), line(tufts, s * 0.004, false));
                }
                else
                    shapes.push(roundBody(circle(c, r, r, 14), c, r, HATCH * 0.5, stage === "seed" ? 0.8 : 0.5), dots(clusterAt(rng, c, r * 0.9, 18), s * 0.008));
            }
            return shapes;
        });
        case "candle": return stands((rng, s, stage) => {
            if (stage === "seed")
                return [line([[0, 0], [0, s * 0.18]], s * 0.03), ...spinyHusk(rng, [0, s * 0.38], s * 0.2, true, "conker")];
            if (stage === "bud") {
                const bud = roundBody(profile(s * 0.35, v => s * 0.08 * Math.sin(Math.PI * Math.min(1, v * 0.85 + 0.15)) ** 0.7), [0, s * 0.15], s * 0.1, HATCH * 0.5, 0.7);
                bud.veins = [0.25, 0.45, 0.65].map(f => sample(u => [(u * 2 - 1) * s * 0.07, s * 0.35 * f + Math.sin(u * Math.PI) * s * 0.04], 6));
                return [bud];
            }
            const { shapes, tips } = branched(rng, s, 9, 1.1, 0.95, 0.24);
            for (const { at, v } of tips)
                shapes.push(...flower(rng, at, s * 0.055 * (1.1 - 0.4 * v), 5, rng.chance(0.3)));
            return shapes;
        });
        case "drupes": return stands((rng, s, stage) => {
            const shapes = [line([[0, 0], [0, s * 0.2]], s * 0.016)];
            const ends = [-0.6, 0, 0.6].map(a => add([0, s * 0.2], dirOf(a), s * 0.15));
            for (const e of ends)
                shapes.push(line([[0, s * 0.2], e], s * 0.01));
            if (stage === "bud")
                return [...shapes, dots(ends.flatMap(e => clusterAt(rng, e, s * 0.04, 3)), s * 0.018)];
            if (stage === "bloom")
                return [...shapes, ...ends.flatMap(e => flower(rng, e, s * 0.06, 4))];
            return [...shapes, ...ends.map((e, k) => { const c = add(e, dirOf(lerp(-0.6, 0.6, k / 2)), s * 0.07); return darkBody(oval(c, s * 0.075, s * 0.1, lerp(-0.6, 0.6, k / 2)), c, s * 0.09); })];
        });
        case "capsule": return stands((rng, s, stage) => {
            const shapes = [];
            const ends = [-0.5, 0.5].map(a => add([0, 0], dirOf(a), s * 0.12));
            if (stage !== "seed")
                return ends.flatMap(e => [line([[0, 0], e], s * 0.012), dots(clusterAt(rng, e, s * 0.05, stage === "bud" ? 4 : 8), s * (stage === "bud" ? 0.014 : 0.016))]);
            for (const e of ends) {
                const c = add(e, [0, s * 0.1]);
                shapes.push(line([[0, 0], e], s * 0.012), roundBody(circle(c, s * 0.08, s * 0.085, 14), c, s * 0.08, HATCH * 0.5, 0.6));
                for (const a of [-0.6, 0, 0.6])
                    shapes.push(line([add(c, dirOf(a), s * 0.07), add(c, dirOf(a), s * 0.15)], s * 0.016));
            }
            return shapes;
        });
        case "valves": return stands((rng, s, stage) => panicle(rng, s, stage, "valves"));
        case "discs": return stands((rng, s, stage) => panicle(rng, s, stage, "discs"));
        case "cross": return stands((rng, s, stage) => crossRaceme(rng, s, stage, false));
        case "crossround": return stands((rng, s, stage) => crossRaceme(rng, s, stage, true));
        case "head": return stands(heads);
        case "umbel": return stands(umbels);
        case "cyme": return stands(cymes, 0.85);
        case "curd": return stands(curd, 1.35);
        case "broccoli": return stands(broccoli, 1.25);
        case "spear": return stands((rng, s, stage) => {
            if (stage === "bud") {
                const spear = bladeBody({ spine: v => [0, s * 0.75 * v], halfWidth: v => s * 0.045 * (1 - v ** 6) ** 0.4, shade: 1, spacing: HATCH, grain: "along", reach: [0.3, 0.8], weight: 0.45, samples: 16 }, rng);
                const scales = [0.3, 0.45, 0.58, 0.7, 0.8, 0.88].map((f, k) => { const y = s * 0.75 * f, sd = k % 2 ? 1 : -1; return [[sd * s * 0.045, y - s * 0.03], [sd * s * 0.005, y + s * 0.025]]; });
                spear.veins = scales;
                return [spear];
            }
            const shapes = cladodes(rng, s * 0.9, 0.1);
            const hangPoints = [[-s * 0.12, s * 0.35], [s * 0.15, s * 0.5], [-s * 0.08, s * 0.65]];
            for (const p of hangPoints) {
                const end = add(p, [0, -s * 0.07]);
                shapes.push(line([p, end], s * 0.006));
                if (stage === "bloom")
                    shapes.push(roundBody(profile(s * 0.06, v => s * 0.03 * Math.sin(Math.PI * Math.min(1, 0.3 + v * 0.7)) ** 0.5, end[1] - s * 0.06).map(([x, y]) => [x + end[0], y]), end, s * 0.03, HATCH * 0.5, 0.25));
                else
                    shapes.push(roundBody(circle(add(end, [0, -s * 0.04]), s * 0.045, s * 0.045, 14), add(end, [0, -s * 0.04]), s * 0.045, HATCH, 0.6, [-0.6, 0.8], "accent"));
            }
            return shapes;
        });
        case "joints": return stands((rng, s, stage) => joints(rng, s * 0.8, 0.1, stage === "bud" ? 0 : stage === "bloom" ? 1 : 1.6));
        case "axil": return stands((rng, s, stage) => {
            const stem = v => [s * 0.08 * Math.sin(v * 4), s * 0.8 * v];
            const shapes = [line(sample(stem, 8), s * 0.016)];
            for (let k = 0; k < 4; k += 1) {
                const v = 0.2 + 0.2 * k, p = stem(v), sd = k % 2 ? 1 : -1;
                shapes.push(line([add(p, [-s * 0.025, 0]), add(p, [s * 0.025, s * 0.02])], s * 0.01));
                shapes.push(...bladeLeaf(rng, s * 0.22, sd * 0.1, { leaf: "elliptic", width: 0.35, margin: "entire", asymmetric: false }).map(shape => turnShape(shape, sd * -0.9, p)));
                const at = add(p, [-sd * s * 0.04, s * 0.02]);
                if (stage === "seed")
                    shapes.push(...[0, 1].map(j => roundBody([add(at, [j * s * 0.03, s * 0.03]), add(at, [j * s * 0.03 + s * 0.02, -s * 0.01]), add(at, [j * s * 0.03 - s * 0.02, -s * 0.01])], at, s * 0.025, HATCH * 0.4, 0.85)));
                else
                    shapes.push(dots(clusterAt(rng, at, s * 0.03, stage === "bud" ? 2 : 4), s * (stage === "bud" ? 0.01 : 0.015)));
            }
            return shapes;
        });
        default: return stands((rng, s, stage) => panicle(rng, s, stage, "seeds"));
    }
}
const HABITS = {
    tree: { stems: { count: 2, amplitude: 0.13, lambda: [4, 7], width: 0.12, tops: [0.92, 0.7] }, basal: null, twig: true,
        nodes: k => ({ every: [1.3 * k, 2.0 * k], length: h => lerp(2.1, 1.5, h) * k, below: 1 }) },
    shrub: { stems: { count: 3, amplitude: 0.15, lambda: [4, 6], width: 0.08, tops: [0.9, 0.72, 0.55] }, basal: null, twig: true,
        nodes: k => ({ every: [1.0 * k, 1.5 * k], length: h => lerp(1.8, 1.3, h) * k, below: 1 }) },
    herb: { stems: { count: 3, amplitude: 0.1, lambda: [5, 8], width: 0.06, tops: [0.9, 0.7, 0.52] }, basal: null, twig: false,
        nodes: k => ({ every: [1.4 * k, 2.0 * k], length: h => lerp(2.2, 1.3, h) * k, below: 0.9 }) },
    rosette: { stems: { count: 2, amplitude: 0.08, lambda: [5, 8], width: 0.06, tops: [0.86, 0.62] }, basal: { count: [6, 9], length: [3.2, 5.0] }, twig: false,
        nodes: k => ({ every: [2.0, 2.8], length: h => lerp(1.6, 0.9, h) * Math.min(1.2, k), below: 0.6 }) },
    creeping: { stems: { count: 3, amplitude: 0.26, lambda: [2.5, 4], width: 0.04, tops: [0.85, 0.7, 0.55] }, basal: null, twig: false,
        nodes: k => ({ every: [0.7 * k, 1.0 * k], length: h => lerp(1.4, 1.0, h) * k, below: 1 }) },
    jointed: { stems: { count: 3, amplitude: 0.06, lambda: [5, 8], width: 0.07, tops: [0.88, 0.72, 0.56] }, basal: null, twig: false,
        nodes: () => ({ every: [0.9, 1.3], length: h => lerp(1.8, 1.1, h), below: 1 }) },
};
/** A twig of several leaves, opposite or alternate, for trees and shrubs. */
function leafyTwig(rng, s, leaf, opposite, leafLength) {
    const twig = v => [s * 0.06 * Math.sin(v * 2.5), s * v];
    const shapes = [line(sample(twig, 6), 0.022)];
    const count = Math.max(2, Math.round(s / (leafLength * 0.7)));
    for (let k = 0; k < count; k += 1) {
        const v = 0.25 + 0.65 * k / Math.max(1, count - 1);
        const p = twig(v), t = tangent(twig, v);
        const len = leafLength * (1 - 0.25 * v) * rng.range(0.85, 1.05);
        for (const sd of opposite ? [1, -1] : [k % 2 ? 1 : -1])
            shapes.push(...leaf(rng, len, -sd * 0.12).map(shape => turnShape(shape, -Math.atan2(t[0], t[1]) + sd * -0.85, p)));
    }
    shapes.push(...leaf(rng, leafLength * 0.75, 0).map(shape => turnShape(shape, -Math.atan2(...tangent(twig, 1)), twig(1))));
    return shapes;
}
export const form = {
    id: "feuillage",
    name: "feuillage",
    doc: "Plants shown by their leaves (outline, division, margin, arrangement) with a secondary mark: catkins, nuts, keys, curds, racemes.",
    variants: {
        habit: { doc: "How the plant stands: tree, shrub, leafy herb, basal rosette, creeping stems, or jointed fleshy stems", default: "tree", values: Object.keys(HABITS) },
        leaf: { doc: "Leaf outline or division", default: "ovate",
            values: [...Object.keys(OUTLINES), "maple", "plane", "pinnate", "cress", "celery", "digitate", "hemp", "cladode", "jointed"] },
        width: { doc: "Breadth of a simple leaf or leaflet as a share of its length", default: 0.55, range: [0.15, 1.1] },
        margin: { doc: "Leaf margin", default: "serrate", values: ["entire", "wavy", "crenate", "serrate", "double"] },
        asymmetric: { doc: "Leaf base lopsided, one side starting lower (orme)", default: false, values: [true, false] },
        arrangement: { doc: "Leaves alternate, or in opposite pairs at each node", default: "alternate", values: ["alternate", "opposite"] },
        leafSize: { doc: "Leaf length relative to the habit's usual", default: 1, range: [0.4, 1.6] },
        fruit: { doc: "The staged secondary mark", default: "hazelnut",
            values: ["hazelnut", "cotton", "seedcatkin", "strobile", "acorn", "beechnut", "hopbract", "samaras", "wafer", "keys", "bract", "seedball", "candle", "drupes", "capsule",
                "panicle", "valves", "discs", "cross", "crossround", "head", "umbel", "cyme", "curd", "broccoli", "spear", "joints", "axil"] },
        catkin: { doc: "Male catkins before the fruit: long and hanging, slender, or fat and silky (marceau); shaggy means slender catkins and short-stalked acorns in scaly cups (liège)", default: "long", values: ["long", "slender", "fat", "shaggy"] },
    },
    examples: [
        { name: "noisetier", variant: { habit: "shrub", leaf: "heart", width: 0.85, margin: "double" } },
        { name: "chêne", variant: { leaf: "oak", width: 0.6, margin: "entire", fruit: "acorn", catkin: "slender" } },
        { name: "érable-sucre", variant: { leaf: "maple", margin: "entire", arrangement: "opposite", fruit: "samaras" } },
        { name: "frêne", variant: { leaf: "pinnate", arrangement: "opposite", fruit: "keys" } },
        { name: "tilleul", variant: { leaf: "heart", width: 0.9, fruit: "bract" } },
        { name: "marronnier", variant: { leaf: "digitate", arrangement: "opposite", fruit: "candle", leafSize: 1.2 } },
        { name: "laitue", variant: { habit: "rosette", leaf: "lettuce", width: 0.95, margin: "wavy", fruit: "head" } },
        { name: "chou-fleur", variant: { habit: "rosette", leaf: "brassica", width: 0.6, margin: "wavy", fruit: "curd", leafSize: 1.2 } },
        { name: "oseille", variant: { habit: "rosette", leaf: "arrow", width: 0.4, margin: "entire", fruit: "valves" } },
        { name: "chanvre", variant: { habit: "herb", leaf: "hemp", arrangement: "opposite", fruit: "panicle" } },
        { name: "asperge", variant: { habit: "herb", leaf: "cladode", fruit: "spear" } },
        { name: "salicorne", variant: { habit: "jointed", leaf: "jointed", fruit: "joints" } },
        { name: "platane", variant: { leaf: "plane", fruit: "seedball", leafSize: 1.1 } },
        { name: "peuplier", variant: { leaf: "triangle", width: 0.95, margin: "crenate", fruit: "cotton", catkin: "long" } },
        { name: "hêtre", variant: { leaf: "elliptic", width: 0.55, margin: "wavy", fruit: "beechnut" } },
        { name: "bouleau", variant: { leaf: "triangle", width: 0.7, margin: "double", fruit: "seedcatkin", catkin: "slender", leafSize: 0.8 } },
        { name: "aulne", variant: { leaf: "round", width: 0.85, margin: "double", fruit: "strobile", catkin: "long" } },
        { name: "charme", variant: { leaf: "ovate", width: 0.5, margin: "double", fruit: "hopbract", catkin: "slender" } },
        { name: "marceau", variant: { leaf: "elliptic", width: 0.6, margin: "wavy", fruit: "cotton", catkin: "fat" } },
        { name: "brocoli", variant: { habit: "rosette", leaf: "brassica", width: 0.55, margin: "wavy", fruit: "broccoli", leafSize: 1.2 } },
    ],
    build(variant) {
        const spec = { leaf: textOf(variant, "leaf"), width: numberOf(variant, "width"), margin: textOf(variant, "margin"), asymmetric: flagOf(variant, "asymmetric") };
        const habit = HABITS[textOf(variant, "habit")];
        const opposite = textOf(variant, "arrangement") === "opposite";
        const scale = numberOf(variant, "leafSize");
        const fruiting = fruitOf(textOf(variant, "fruit"), textOf(variant, "catkin"));
        const { leaf: single, part } = leafOf(spec);
        const angle = 50;
        // Opposite leaves come in pairs: the node's angle is fixed so the second leaf can be set across the stem.
        const leaf = opposite
            ? (rng, length, b) => {
                const sd = b >= 0 ? 1 : -1;
                return [...single(rng, length, b), ...single(rng, length * 0.97, -b).map(shape => turnShape(shape, -sd * 2 * angle * DEG))];
            }
            : single;
        const low = ["curd", "broccoli"].includes(textOf(variant, "fruit"));
        const stems = low ? { ...habit.stems, tops: habit.stems.tops.map(t => t * 0.62) } : habit.stems;
        const basal = habit.basal && { count: habit.basal.count, length: [habit.basal.length[0] * scale, habit.basal.length[1] * scale] };
        const nodes = habit.nodes(scale);
        const leafLength = (habit.twig ? 1.1 : 1.6) * scale;
        const size = fruiting.size;
        const compound = ["pinnate", "digitate", "hemp", "celery", "cress", "maple", "plane"].includes(spec.leaf);
        return {
            id: "feuillage",
            stems,
            basal,
            nodes: { ...nodes, angle: opposite ? [angle, angle] : [35, 60] },
            leafProxy: compound ? 0.36 : 0.28,
            leaf,
            leaflet: part,
            terminal: { size: [1.2 * size, 1.4 * size], r: s => 0.5 * s, off: () => 0, draw: fruiting.draw },
            motifs: [
                { name: "fruit", w: 2.4, smin: 0.85 * size, smax: 1.15 * size, max: 6, hard: true, layer: LAYER.bloom, upright: fruiting.upright, staged: true,
                    r: s => 0.42 * s, off: s => fruiting.off * s, draw: fruiting.draw },
                { name: "leaf", w: 3, smin: 1.2 * scale, smax: 2.0 * scale, max: 9, hard: true, layer: LAYER.leaf, upright: 0.3,
                    r: s => (compound ? 0.42 : 0.34) * s, off: s => 0.5 * s,
                    draw: habit.twig && !compound ? (rng, s) => leafyTwig(rng, s, single, opposite, leafLength * 0.75) : (rng, s) => single(rng, s, rng.sym(0.25)) },
            ],
        };
    },
};
