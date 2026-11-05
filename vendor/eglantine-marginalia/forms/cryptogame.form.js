// Spore-bearing plants and fungi, each in its own mode, since a mushroom cap cannot stand for a fern:
// the gilled field mushroom (champignon), the honeycombed morel (morille), the pear-shaped puffball with
// its apical pore (lycoperdon), the hoof bracket on a dead stub (amadouvier), the warty truffle on oak
// roots with its marbled section (truffe), the moss cushion whose setae lift capsules (mousse), the
// foliose lichen on a twig (lichen), the male fern's pinnae, crozier and sori (fougère), the maidenhair's
// fans on wiry black stalks (capillaire) and the jointed, whorled horsetail with its spore cone (prêle).
// A fungus grows in one of two habits: on the ground, fruiting from soil, litter and dead wood over its
// mycelium (see "the ground habit" below), or like a plant, its fruit bodies at the tips of mycelial cords
// among moss, grass and fallen leaves. Either way, what it becomes at the end of a day is the shedding of
// its spores.
import { LAYER, numberOf, textOf } from "../form.js";
import { bezier3, clamp, lerp, normals, ribbon, sample, unit } from "../geometry.js";
import { HATCH, circle, line, lobedLeaf, turnShape } from "../kit.js";
import { createRng } from "../random.js";
import { bladeBody, roundBody } from "../shapes.js";
const DEG = Math.PI / 180;
const rot = (d, a) => [d[0] * Math.cos(a) - d[1] * Math.sin(a), d[0] * Math.sin(a) + d[1] * Math.cos(a)];
const add = (p, d, k = 1) => [p[0] + d[0] * k, p[1] + d[1] * k];
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
/** Parallel diagonal cuts across a region's bounds, for bodies shaded all over. */
function hatchAcross(outline, spacing, slope = 0.7) {
    const xs = outline.map(p => p[0]), ys = outline.map(p => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const cuts = [];
    for (let c = y0 - (x1 - x0) * slope; c <= y1; c += spacing)
        cuts.push([[x0, c], [x1, c + (x1 - x0) * slope]]);
    return cuts;
}
/** A dark body cut all over but for a small highlight (ripe truffle). */
function darkBody(outline, at, r, weight = 0.95) {
    const body = roundBody(outline, at, r, HATCH * 0.42, weight);
    body.shadow = [body.shadow[0], circle([at[0] - r * 0.4, at[1] + r * 0.42], r * 0.15, r * 0.1, 10)];
    return body;
}
/** A drift of spores: fine dots scattered in a plume from `from` along `dir`. */
function spores(rng, from, dir, reach, spread, count, radius) {
    const points = Array.from({ length: count }, () => {
        const t = rng.u() ** 0.8;
        return add(add(from, dir, reach * t), [-dir[1], dir[0]], rng.sym(spread * (0.25 + t)));
    });
    return { type: "dots", points, radius };
}
// ---------------------------------------------------------------- ground foliage
/** A low cushion of moss: many short leafy shoots in a dome, as one comb stroke. */
function mossCushion(rng, s) {
    const comb = [];
    const shoots = Math.max(5, Math.round(s * 13));
    for (let i = 0; i < shoots; i += 1) {
        const u = (i + 0.5) / shoots * 2 - 1;
        const base = [u * s * 0.42 + rng.sym(0.02), 0];
        const h = s * 0.38 * Math.sqrt(1 - u * u) * rng.range(0.7, 1.05) + s * 0.05;
        const lean = u * 0.7 + rng.sym(0.15);
        const dir = [Math.sin(lean), Math.cos(lean)];
        const leaves = Math.max(2, Math.round(h / 0.05));
        comb.push(base);
        for (let k = 1; k <= leaves; k += 1) {
            const p = add(base, dir, h * k / leaves);
            comb.push(p);
            for (const side of [1, -1])
                comb.push(add(p, rot(dir, side * 0.75), 0.05 * (1 - 0.45 * k / leaves)), p);
        }
        comb.push(base);
    }
    return [line(comb, 0.008, false)];
}
/** A tuft of grass blades, out and back as one stroke. */
function grassTuft(rng, s) {
    const comb = [[0, 0]];
    for (let i = 0; i < 6; i += 1) {
        const lean = lerp(-0.6, 0.6, i / 5) + rng.sym(0.12);
        const len = s * rng.range(0.6, 1);
        const blade = sample(v => [Math.sin(lean) * len * v + lean * len * 0.35 * v * v, Math.cos(lean) * len * v * (1 - 0.15 * v)], 5);
        comb.push(...blade, ...blade.slice(0, -1).reverse());
    }
    return [line(comb, 0.011, false)];
}
/** The litter fungi rise through: moss, grass, a fallen leaf. */
function litter(rng, length, bend) {
    const roll = rng.u();
    if (roll < 0.4)
        return mossCushion(rng, length * 0.8);
    if (roll < 0.7)
        return grassTuft(rng, length * 0.7);
    return lobedLeaf(rng, length * 0.75, bend);
}
/** Fine branching rootlets with swollen mycorrhizal tips, as one stroke (truffe's oak roots). */
function rootlet(rng, length, bend) {
    const tips = [];
    const tour = (base, dir, len, depth) => {
        const curve = v => [base[0] + dir[0] * len * v - dir[1] * bend * len * v * v, base[1] + dir[1] * len * v + dir[0] * bend * len * v * v];
        const out = [];
        const back = [];
        const children = depth >= 2 ? 0 : rng.int(2, 3);
        const at = Array.from({ length: children }, (_, j) => 0.25 + 0.6 * (j + rng.u() * 0.6) / children);
        let next = 0;
        for (let i = 0; i <= 6; i += 1) {
            const v = i / 6;
            while (next < at.length && at[next] <= v) {
                const u = at[next], p = curve(u);
                out.push(p, ...tour(p, rot(tangent(curve, u), (next % 2 ? 1 : -1) * rng.range(0.5, 1)), len * rng.range(0.35, 0.55), depth + 1), p);
                next += 1;
            }
            out.push(curve(v));
            back.push(curve(v));
        }
        tips.push(curve(1));
        return [...out, ...back.reverse()];
    };
    return [line(tour([0, 0], [0, 1], length, 0), 0.01, false), { type: "dots", points: tips, radius: 0.018 }];
}
// ---------------------------------------------------------------- fungi
/** A field mushroom: white cap over gills on a short ringed stalk; a closed button while young. */
function agaric(rng, s, stage) {
    if (stage === "bud") {
        const r = s * 0.2, stalk = s * 0.16;
        const stipe = bladeBody({ spine: v => [0, stalk * v], halfWidth: v => s * 0.07 * (1 + 0.3 * (1 - v)), shade: 1, spacing: HATCH, grain: "along", reach: [0.3, 0.6], weight: 0.25, samples: 8 }, rng);
        const cap = profile(r * 1.7, v => r * Math.sin(Math.PI * Math.min(1, 0.22 + v * 0.78)) ** 0.7 * (v < 0.1 ? 0.9 : 1), stalk);
        return [stipe, roundBody(cap, [0, stalk + r * 0.9], r, HATCH * 0.7, 0.35)];
    }
    const old = stage === "seed";
    const capR = s * (old ? 0.46 : 0.4), stipeH = s * (old ? 0.5 : 0.44);
    const ry = capR * (old ? 0.3 : 0.24);
    const rimY = stipeH + ry * 0.35;
    const domeH = capR * (old ? 0.3 : 0.62);
    const lift = old ? capR * 0.08 : 0;
    const top = sample(t => [capR * Math.cos(t), rimY + lift * Math.cos(t) ** 2 + domeH * Math.sin(t) ** 0.85], 20, Math.PI, 0);
    const far = sample(t => [capR * Math.cos(t), rimY + lift * Math.cos(t) ** 2 + ry * Math.sin(t)], 12, 0, Math.PI);
    const domeOutline = [...top, ...far.slice(1, -1)];
    const dome = roundBody(domeOutline, [0, rimY + domeH * 0.45], capR, HATCH * 0.8, 0.4);
    dome.veins = [-0.5, -0.15, 0.25, 0.6].map(q => sample(v => [capR * q * (0.4 + 0.5 * v), rimY + domeH * (1 - 0.55 * v) * (1 - q * q * 0.6)], 4));
    const underside = circle([0, rimY], capR * 0.98, ry, 28);
    const hub = [0, rimY + ry * 0.15];
    const gills = Array.from({ length: 30 }, (_, k) => {
        const t = k / 30 * Math.PI * 2;
        return [hub, [capR * 0.96 * Math.cos(t), rimY + ry * 0.95 * Math.sin(t)]];
    });
    // Pink young gills read light; at the end they are chocolate with spores and the cut goes dark.
    const under = { type: "body", outline: underside, shadow: [], grain: old ? hatchAcross(underside, HATCH * 0.5) : [], veins: gills, weight: old ? 0.85 : 0.45 };
    const stipe = bladeBody({ spine: v => [0, stipeH * v], halfWidth: v => s * 0.06 * (1 + 0.35 * (1 - v) ** 3), shade: 1, spacing: HATCH * 0.8, grain: "along", reach: [0.3, 0.7], weight: 0.3, samples: 14 }, rng);
    const ringY = stipeH * 0.74, w = s * 0.06;
    const ring = line(sample(t => [w * 1.7 * Math.cos(t), ringY - s * 0.04 + w * 0.45 * Math.sin(t)], 10, Math.PI, 2 * Math.PI), s * 0.014);
    const flare = [line([[-w, ringY], [-w * 1.7, ringY - s * 0.04]], s * 0.01), line([[w, ringY], [w * 1.7, ringY - s * 0.04]], s * 0.01)];
    const shapes = [dome, under, stipe, ring, ...flare];
    if (old)
        shapes.push(spores(rng, [0, rimY - ry], [0, -1], s * 0.5, capR * 0.9, 34, s * 0.006));
    return shapes;
}
/** A morel: a conical cap of dark honeycomb pits over a pale hollow stalk. */
function morel(rng, s, stage) {
    const scale = stage === "bud" ? 0.55 : 1;
    const old = stage === "seed";
    const stipeH = s * 0.32 * scale, stipeW = s * 0.1 * scale;
    const capLen = s * 0.6 * scale, capR = s * 0.21 * scale;
    const stipe = bladeBody({ spine: v => [0, stipeH * v], halfWidth: v => stipeW * (1 + 0.3 * (1 - v) ** 2), shade: 1, spacing: HATCH, grain: "along", reach: [0.3, 0.6], weight: 0.25, samples: 12 }, rng);
    stipe.veins = [-0.5, 0.1, 0.55].map(q => sample(v => [stipeW * q + stipeW * 0.15 * Math.sin(v * 9 + q * 5), stipeH * v], 6, 0.05, 0.6));
    const base = stipeH * 0.85;
    const hw = (v) => capR * (1 - v ** 1.7) ** 0.6 * Math.min(1, (v + 0.12) / 0.22);
    const cap = roundBody(profile(capLen, hw, base, 26), [0, base + capLen * 0.4], capR * 1.2, HATCH * 0.7, old ? 0.8 : 0.5);
    const shapes = [stipe, cap];
    const rows = 6, cols = 4.5;
    for (let i = 0; i < rows; i += 1) {
        const v = (i + 0.55) / (rows + 0.2);
        for (let j = 0; j < 5; j += 1) {
            const theta = ((j + 0.5 * (i % 2) + rng.sym(0.15)) / cols - 0.5) * Math.PI;
            if (Math.abs(theta) > 1.35)
                continue;
            const cx = hw(v) * 0.92 * Math.sin(theta), cy = base + capLen * v;
            const pw = hw(v) * Math.PI / cols * Math.cos(theta) * (old ? 0.5 : 0.43);
            const ph = capLen / rows * (old ? 0.48 : 0.42);
            // Angular pits, so the pale ridges between them make a honeycomb rather than spots.
            const pit = sample(t => {
                const k = rng.range(0.8, 1.12);
                return [cx + Math.cos(t * Math.PI * 2 + 0.5) * pw * k, cy + Math.sin(t * Math.PI * 2 + 0.5) * ph * k];
            }, 6).slice(0, -1);
            shapes.push({ type: "solid", outline: pit, smooth: false });
        }
    }
    if (old)
        shapes.push(spores(rng, [capR * 0.8, base + capLen * 0.5], unit(1, 0.4), s * 0.45, s * 0.12, 26, s * 0.006));
    return old ? shapes.map(shape => turnShape(shape, -0.12)) : shapes;
}
/** A pear-shaped puffball studded with warts; ripe, it browns and breathes spores from a pore at its top. */
function puffball(rng, s, stage, at) {
    const scale = stage === "bud" ? 0.5 : 1;
    const old = stage === "seed";
    const h = s * 0.62 * scale, headR = s * 0.25 * scale;
    const cy = h - headR, foot = s * 0.08 * scale;
    const hw = (v) => {
        const y = h * v;
        return y > cy ? Math.sqrt(Math.max(0, headR * headR - (y - cy) ** 2)) : lerp(foot, headR, (y / cy) ** 1.6);
    };
    const outline = profile(h, hw, 0, 28).map(([x, y]) => [at[0] + x, at[1] + y]);
    const body = roundBody(outline, [at[0], at[1] + cy], headR, HATCH * (old ? 0.5 : 0.75), stage === "bud" ? 0.25 : old ? 0.85 : 0.35);
    body.veins = [-0.5, 0, 0.5].map(q => sample(v => [at[0] + q * hw(v) * 0.8, at[1] + h * v], 4, 0.05, 0.35));
    const warts = [], big = [];
    for (let k = 0; k < (old ? 14 : 46) * scale; k += 1) {
        const a = rng.range(0, Math.PI * 2), r = Math.sqrt(rng.u()) * headR * 0.9;
        const p = [at[0] + Math.cos(a) * r, at[1] + cy + Math.sin(a) * r * 0.95];
        (p[1] > at[1] + cy + headR * 0.35 && !old ? big : warts).push(p);
    }
    const shapes = [body, { type: "dots", points: warts, radius: s * 0.008 }];
    if (big.length > 0)
        shapes.push({ type: "dots", points: big, radius: s * 0.014 });
    if (old) {
        const pore = [at[0], at[1] + h - headR * 0.1];
        shapes.push({ type: "solid", outline: circle(pore, headR * 0.2, headR * 0.09, 10) });
        shapes.push(spores(rng, [pore[0], pore[1] + headR * 0.05], unit(rng.sym(0.3), 1), s * 0.55, s * 0.18, 44, s * 0.007));
    }
    return shapes;
}
/** A small group of puffballs on one mycelial thread. */
function puffballs(rng, s, stage, cluster) {
    const shapes = [];
    const offsets = [[0, 1], [-0.34, 0.68], [0.36, 0.6]];
    for (const [x, scale] of offsets.slice(0, cluster).reverse()) {
        if (x !== 0)
            shapes.push(line([[0, 0], [x * s * 0.5, s * 0.02], [x * s, 0]], s * 0.012));
        shapes.push(...puffball(rng, s * scale, stage, [x * s, 0]));
    }
    return shapes;
}
/**
 * Tinder fungus on a broken stub: hoof-shaped brackets banded with growth ridges, pale at the growing
 * margin, flat beneath where the pores are; at the end they drop a dust of spores.
 */
function brackets(rng, s, stage, cluster) {
    const w = s * 0.2, len = s * 1.15;
    // The stub's broken top is ragged.
    const stubOutline = [...sample(v => [w / 2, len * v], 6), ...sample(u => [w / 2 - w * u, len * (1 - 0.1 * Math.abs(Math.sin(u * 9.5)))], 8), ...sample(v => [-w / 2, len * (1 - v)], 6)];
    const stub = { type: "body", outline: stubOutline, shadow: [[[0, -1], [w, -1], [w, len + 1], [0, len + 1]]], grain: Array.from({ length: Math.floor(w / (HATCH * 0.9)) + 1 }, (_, i) => {
            const x = -w / 2 + i * HATCH * 0.9;
            return [[x, 0], [x, len]];
        }), veins: Array.from({ length: 6 }, (_, i) => {
            const y = len * (0.12 + 0.13 * i), x = rng.range(-w * 0.35, w * 0.1);
            return [[x, y], [x + w * 0.25, y + 0.005]];
        }), weight: 0.55 };
    const shapes = [stub];
    const count = stage === "bud" ? 1 : cluster;
    for (let i = 0; i < count; i += 1) {
        const side = i % 2 ? -1 : 1;
        const y = len * (0.8 - 0.28 * i);
        const d = s * (stage === "bud" ? 0.2 : 0.46 - 0.06 * i), t = d * (stage === "bud" ? 0.85 : 0.72);
        shapes.push(...hoof(rng, side * w * 0.48, y, side, d, t, stage, s));
    }
    return shapes;
}
/**
 * One hoof bracket jutting from its wood at (x0, y) toward `side`, `d` deep and `t` thick: banded with
 * growth ridges, pale at the growing margin, flat beneath where the pores are; `s` sets its line weights.
 */
function hoof(rng, x0, y, side, d, t, stage, s) {
    const margin = (u) => u < 0.6
        ? bezier3([x0, y], [x0 + side * d * 0.4, y + t * 0.18], [x0 + side * d * 0.95, y - t * 0.02], [x0 + side * d, y - t * 0.5])(u / 0.6)
        : bezier3([x0 + side * d, y - t * 0.5], [x0 + side * d * 1.02, y - t * 0.78], [x0 + side * d * 0.96, y - t * 0.92], [x0 + side * d * 0.84, y - t * 0.93])((u - 0.6) / 0.4);
    const rim = sample(margin, 20);
    const outline = [...rim, [x0, y - t * 0.86]];
    const body = roundBody(outline, [x0 + side * d * 0.5, y - t * 0.45], d * 0.6, HATCH * 0.7, stage === "bud" ? 0.35 : 0.65);
    const anchor = [x0, y - t * 0.48];
    body.veins = stage === "bud" ? [] : [0.18, 0.34, 0.5, 0.66, 0.8].map(f => sample(u => {
        const m = margin(u);
        return [anchor[0] + (m[0] - anchor[0]) * (1 - f), anchor[1] + (m[1] - anchor[1]) * (1 - f)];
    }, 10, 0.18, 1));
    const shapes = [body, line([[x0 + side * d * 0.82, y - t * 0.97], [x0, y - t * 0.9]], s * 0.008)];
    if (stage === "seed")
        shapes.push(spores(rng, [x0 + side * d * 0.45, y - t], [0, -1], s * 0.45, d * 0.5, 22, s * 0.006));
    return shapes;
}
/** A black truffle's warty outline: low pyramids all round. */
function truffleOutline(rng, at, r) {
    const warts = rng.int(10, 13);
    const jitter = Array.from({ length: warts }, () => rng.range(0.9, 1.1));
    return sample(v => {
        const f = (v * warts) % 1, k = Math.floor(v * warts) % warts;
        const rr = r * (0.93 + 0.1 * (1 - Math.abs(2 * f - 1)) * jitter[k]);
        return [at[0] + Math.cos(v * Math.PI * 2) * rr, at[1] + Math.sin(v * Math.PI * 2) * rr * 0.92];
    }, warts * 4).slice(0, -1);
}
/** A truffle cut through: dark flesh run with pale marbling veins, left as gaps in the hatching. */
function truffleSection(rng, at, r) {
    const outline = truffleOutline(rng, at, r);
    const veins = Array.from({ length: 8 }, () => {
        let a = rng.range(0, Math.PI * 2), p = [at[0] + Math.cos(a) * r * 0.85, at[1] + Math.sin(a) * r * 0.8];
        const out = [p];
        let heading = a + Math.PI + rng.sym(0.6);
        for (let k = 0; k < 9; k += 1) {
            heading += rng.sym(0.9);
            p = add(p, [Math.cos(heading), Math.sin(heading)], r * 0.16);
            if (Math.hypot(p[0] - at[0], p[1] - at[1]) > r * 0.88)
                break;
            out.push(p);
            a = heading;
        }
        return out;
    });
    const near = (p) => veins.some(vein => vein.some((q, i) => {
        const b = vein[i + 1];
        if (!b)
            return Math.hypot(p[0] - q[0], p[1] - q[1]) < r * 0.09;
        const dx = b[0] - q[0], dy = b[1] - q[1];
        const t = clamp(((p[0] - q[0]) * dx + (p[1] - q[1]) * dy) / (dx * dx + dy * dy), 0, 1);
        return Math.hypot(p[0] - q[0] - dx * t, p[1] - q[1] - dy * t) < r * 0.09;
    }));
    const grain = [];
    for (const [a, b] of hatchAcross(outline, HATCH * 0.45, 0.5)) {
        let run = [];
        for (let k = 0; k <= 40; k += 1) {
            const p = [lerp(a[0], b[0], k / 40), lerp(a[1], b[1], k / 40)];
            if (near(p)) {
                if (run.length > 1)
                    grain.push(run);
                run = [];
            }
            else
                run.push(p);
        }
        if (run.length > 1)
            grain.push(run);
    }
    return [{ type: "body", outline, shadow: [], grain, veins: [], weight: 0.9 }];
}
/** A truffle on its rootlet: young and pale, then black and warty; ripe, one is shown cut beside a whole one. */
function truffle(rng, s, stage) {
    const r = s * (stage === "bud" ? 0.13 : 0.24);
    const at = [0, s * 0.1 + r];
    const shapes = [line([[0, 0], [0, s * 0.06], [rng.sym(0.02), s * 0.1]], s * 0.012)];
    if (stage === "bud")
        return [...shapes, roundBody(truffleOutline(rng, at, r), at, r, HATCH * 0.6, 0.4)];
    shapes.push(darkBody(truffleOutline(rng, at, r), at, r));
    if (stage === "seed")
        shapes.push(...truffleSection(rng, [at[0] + r * 1.75, at[1] - r * 0.5], r * 0.82));
    return shapes;
}
// ---------------------------------------------------------------- moss and lichen
/** A moss capsule at the tip of its seta: hooded, then lidded and leaning, then open-mouthed and shedding. */
function capsule(rng, s, stage) {
    const seta = s * 0.45;
    const lean = stage === "bud" ? 0 : stage === "bloom" ? 0.5 : 1.1;
    const shapes = [line(sample(v => [Math.sin(lean) * s * 0.08 * v * v, seta * v], 5), s * 0.014)];
    const len = s * (stage === "bud" ? 0.24 : 0.3), r = s * (stage === "bud" ? 0.045 : 0.07);
    const parts = [];
    const pod = profile(len, v => r * Math.sin(Math.PI * Math.min(1, 0.12 + v * 0.88)) ** 0.6 * (v < 0.2 ? 0.6 + 2 * v : 1));
    parts.push(roundBody(pod, [0, len * 0.5], r, HATCH * 0.5, stage === "seed" ? 0.75 : 0.5));
    if (stage === "bud") {
        // The calyptra: a pale pointed hood over the young capsule.
        parts.push(roundBody(profile(len * 0.75, v => r * 1.15 * (1 - v) ** 0.8, len * 0.45), [0, len * 0.75], r, HATCH * 0.7, 0.25));
    }
    else if (stage === "bloom") {
        parts.push(roundBody(profile(r * 0.9, v => r * 0.85 * Math.cos(v * Math.PI / 2) ** 0.6, len * 0.96), [0, len], r * 0.6, HATCH * 0.6, 0.4));
    }
    else {
        // Lid gone: a fringe of peristome teeth, and spores on the air.
        const mouth = [0, len];
        parts.push(...[-0.8, -0.4, 0, 0.4, 0.8].map(q => line([[mouth[0] + q * r * 0.8, mouth[1] - r * 0.05], [mouth[0] + q * r * 1.1, mouth[1] + r * 0.32]], s * 0.006, false)));
        parts.push(spores(rng, [0, len + r * 0.4], [0, 1], s * 0.3, s * 0.06, 16, s * 0.005));
    }
    shapes.push(...parts.map(shape => turnShape(shape, -lean, [Math.sin(lean) * s * 0.08, seta])));
    return shapes;
}
/** A leafy moss shoot: a stem clothed in narrow spreading leaves, ending in a little star. */
function mossShoot(rng, length, bend) {
    const stem = v => [bend * length * v * v, length * v];
    const comb = [stem(0)];
    const n = Math.max(4, Math.round(length / 0.06));
    for (let i = 1; i <= n; i += 1) {
        const v = i / n, p = stem(v), t = tangent(stem, v);
        comb.push(p);
        const leaf = 0.15 * (0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, v * 1.2)));
        for (const side of [1, -1])
            comb.push(add(p, rot(t, side * rng.range(0.45, 0.75)), leaf * rng.range(0.8, 1.1)), p);
    }
    const tip = stem(1), t = tangent(stem, 1);
    for (let j = 0; j < 7; j += 1)
        comb.push(add(tip, rot(t, lerp(-1.2, 1.2, j / 6)), 0.11), tip);
    return [line(comb, 0.01, false)];
}
/** A dense tuft of moss shoots standing close together from one point. */
function mossTuft(rng, s) {
    const count = rng.int(7, 10);
    return Array.from({ length: count }, (_, k) => {
        const a = lerp(-0.4, 0.4, k / (count - 1)) + rng.sym(0.06);
        return mossShoot(rng, s * rng.range(0.45, 0.8) * (1 - 0.4 * Math.abs(a)), -a * 0.3).map(shape => turnShape(shape, a, [a * s * 0.15, 0]));
    }).flat();
}
/** One lobe of a foliose lichen: broad, flat, ruffled at its rounded end. */
function lichenLobe(rng, at, dir, len, wide) {
    const phase = rng.range(0, 6);
    return bladeBody({ spine: v => add(at, dir, len * v), halfWidth: v => wide * (0.45 + 0.75 * v ** 0.7) * Math.min(1, (1 - v) * 5) ** 0.5,
        edge: v => wide * 0.14 * Math.sin(v * 26 + phase) * v, shade: rng.chance(0.5) ? 1 : -1, spacing: HATCH * 1.2, grain: "across", weight: 0.4, samples: 11 }, rng);
}
/** A small patch of lichen lobes, overlapping and uneven, spreading from one point. */
function lichenPatch(rng, length) {
    const count = rng.int(3, 5);
    return Array.from({ length: count }, (_, k) => {
        const a = lerp(-1.1, 1.1, k / (count - 1)) + rng.sym(0.25);
        const len = length * rng.range(0.25, 0.48);
        return lichenLobe(rng, [rng.sym(0.04), rng.sym(0.04)], [Math.sin(a), Math.cos(a)], len, len * rng.range(0.32, 0.48));
    });
}
/**
 * A twig crusted with foliose lichen: overlapping ruffled lobes hug it on both sides; at the end of the
 * day the lobes bear small cup apothecia.
 */
function lichenTwig(rng, s, stage) {
    const len = s * 1.1;
    const twig = v => [s * 0.04 * Math.sin(v * 3), len * v];
    const forkAt = twig(0.55);
    const shapes = [line(sample(twig, 8), s * 0.06), line([forkAt, add(forkAt, [0.5, 0.86], s * 0.2), add(forkAt, [0.45, 0.9], s * 0.42)], s * 0.035)];
    const count = stage === "bud" ? 4 : rng.int(9, 11);
    const cups = [];
    for (let k = 0; k < count; k += 1) {
        const v = 0.08 + 0.85 * (k + rng.u() * 0.6) / count;
        const side = k % 2 ? 1 : -1;
        const t = tangent(twig, v);
        const lobeLen = s * rng.range(0.2, 0.32) * (stage === "bud" ? 0.6 : 1);
        const dir = rot(t, side * rng.range(0.9, 1.7));
        const at = add(twig(v), [-t[1], t[0]], side * s * 0.02);
        shapes.push(lichenLobe(rng, at, dir, lobeLen, lobeLen * 0.42));
        if (k % 3 === 1)
            cups.push(add(at, dir, lobeLen * 0.6));
    }
    if (stage === "seed") {
        for (const p of cups) {
            const r = s * 0.035;
            shapes.push(line(circle(p, r * 1.35, r * 1.1, 12).concat([[p[0] + r * 1.35, p[1]]]), s * 0.008), roundBody(circle(p, r, r * 0.8, 12), p, r, HATCH * 0.4, 0.9));
        }
    }
    return shapes;
}
// ---------------------------------------------------------------- ferns and horsetail
/** A fern pinna: pinnules cut almost to the midrib, rounded and blunt; fertile, two rows of sori under each. */
function pinna(rng, length, bend, fertile) {
    const n = Math.max(3, Math.round(length / 0.11));
    const spine = (v) => [bend * length * v * v, length * v];
    const envelope = (v) => length * 0.12 * (1 - v) ** 0.7 * Math.min(1, (v + 0.05) / 0.15);
    const lobe = (v) => Math.sin(Math.PI * ((v * n + 0.5) % 1)) ** 0.55;
    const halfWidth = (v) => envelope(v) * (0.12 + 0.88 * lobe(v));
    const centre = (k) => spine(k / n);
    const veins = [];
    const sori = [];
    for (let k = 1; k < n; k += 1) {
        const v = k / n, p = centre(k), t = tangent(spine, v);
        for (const side of [1, -1]) {
            const out = rot(t, side * 1.25);
            if (length > 1)
                veins.push([p, add(p, out, envelope(v) * 0.7)]);
            if (fertile)
                for (const f of [0.35, 0.62])
                    for (const q of [-1, 1])
                        sori.push(add(add(p, out, envelope(v) * f), t, q * envelope(v) * 0.16));
        }
    }
    const body = bladeBody({ spine, halfWidth, shade: bend >= 0 ? 1 : -1, spacing: HATCH * 1.5, grain: "across", weight: 0.45, midrib: true, veins, samples: n * 4 }, rng);
    return fertile ? [body, { type: "dots", points: sori, radius: Math.max(0.01, length * 0.011) }] : [body];
}
/** A fern's crozier: a tight scaly coil, unrolling, and at the end a fertile frond tip brown with sori. */
function crozier(rng, s, stage) {
    if (stage === "seed") {
        const len = s * 1.05;
        const rachis = v => [s * 0.05 * Math.sin(v * 2), len * v];
        const shapes = [line(sample(rachis, 8), s * 0.03)];
        const pairs = 6;
        for (let k = 0; k < pairs; k += 1) {
            const v = 0.12 + 0.8 * k / pairs;
            for (const side of [1, -1]) {
                const size = s * 0.42 * (1 - v) ** 0.8 + s * 0.06;
                shapes.push(...pinna(rng, size, -side * 0.08, true).map(shape => turnShape(shape, side * -1.0, rachis(v + side * 0.02))));
            }
        }
        return shapes;
    }
    const h = s * (stage === "bud" ? 0.45 : 0.6);
    const R0 = s * (stage === "bud" ? 0.16 : 0.13);
    const turns = stage === "bud" ? 1.7 : 1.1;
    const centre = [R0, h];
    const coil = sample(t => {
        const theta = Math.PI - t * turns * 2 * Math.PI;
        const r = R0 * (1 - 0.82 * t);
        return [centre[0] + r * Math.cos(theta), centre[1] + r * Math.sin(theta)];
    }, 36);
    const stalk = sample(v => [-s * 0.02 * Math.sin(v * Math.PI), h * v], 8);
    const shapes = [line([...stalk, ...coil.slice(1)], s * 0.045)];
    // Brown scales clothing the stalk and coil.
    shapes.push({ type: "dots", points: [...stalk, ...coil.slice(0, 24)].filter((_, i) => i % 2 === 0).map(([x, y], i) => [x + (i % 2 ? 1 : -1) * s * 0.022, y]), radius: s * 0.012 });
    if (stage === "bloom") {
        // Young pinnae unfold from the lower stalk.
        for (let k = 0; k < 3; k += 1) {
            const v = 0.45 + 0.17 * k;
            for (const side of [1, -1])
                shapes.push(...pinna(rng, s * (0.34 - 0.07 * k), side * 0.15, false).map(shape => turnShape(shape, side * -0.9, stalk[Math.round(v * 8)])));
        }
    }
    return shapes;
}
/** A maidenhair fan: a wedge on a hair-thin stalk, veins forking to a crenate edge; fertile, its lobes fold over the sori. */
function fan(rng, at, angle, R, fertile) {
    const lobes = rng.int(2, 4);
    const spread = 55 * DEG;
    const edge = (phi) => R * (0.86 + 0.14 * Math.abs(Math.sin((phi + spread) / (2 * spread) * lobes * Math.PI)));
    const arc = sample(v => {
        const phi = -spread + 2 * spread * v;
        return add(at, [Math.sin(angle + phi), Math.cos(angle + phi)], edge(phi));
    }, 24);
    const veins = Array.from({ length: 8 }, (_, k) => {
        const phi = -spread * 0.85 + 1.7 * spread * k / 7;
        return [add(at, [Math.sin(angle + phi * 0.5), Math.cos(angle + phi * 0.5)], R * 0.25), add(at, [Math.sin(angle + phi), Math.cos(angle + phi)], edge(phi) * 0.88)];
    });
    const shapes = [{ type: "body", outline: [at, ...arc], shadow: [], grain: [], veins, weight: 0.3 }];
    if (fertile) {
        for (let k = 0; k < lobes; k += 1) {
            const band = sample(v => {
                const phi = -spread + 2 * spread * (k + 0.15 + 0.7 * v) / lobes;
                return add(at, [Math.sin(angle + phi), Math.cos(angle + phi)], edge(phi) * 0.97);
            }, 6);
            const inner = band.slice().reverse().map(p => add(at, [p[0] - at[0], p[1] - at[1]], 0.86));
            shapes.push({ type: "solid", outline: [...band, ...inner] });
        }
    }
    return shapes;
}
/** A maidenhair frond: fans alternating on a dark wiry stalk, one at its tip. */
function maidenFrond(rng, length, bend, fertile) {
    const spine = v => [bend * length * v * v, length * v];
    const shapes = [line(sample(spine, 8), 0.014)];
    const count = Math.max(2, Math.round(length / 0.32));
    for (let k = 0; k < count; k += 1) {
        const v = 0.3 + 0.6 * k / count;
        const side = k % 2 ? 1 : -1;
        const p = spine(v), d = rot(tangent(spine, v), side * 0.9);
        const end = add(p, d, length * 0.08);
        shapes.push(line([p, end], 0.009), ...fan(rng, end, Math.atan2(d[0], d[1]), length * 0.17 * (1 - 0.35 * v), fertile));
    }
    const tip = spine(1), t = tangent(spine, 1);
    shapes.push(...fan(rng, tip, Math.atan2(t[0], t[1]), length * 0.15, fertile));
    return shapes;
}
/** A cluster of maidenhair fans: a small crozier first, then fans, then fans fringed with sori. */
function fans(rng, s, stage) {
    if (stage === "bud")
        return crozier(rng, s * 0.7, "bud");
    return maidenFrond(rng, s, 0.1, stage === "seed");
}
/** A horsetail's toothed sheath round a node, ridged. */
function sheath(at, w, h) {
    const teeth = 4;
    const top = Array.from({ length: teeth * 2 + 1 }, (_, k) => [at[0] + w - 2 * w * k / (teeth * 2), at[1] + h * (k % 2 ? 0.55 : 1)]);
    return { type: "body", outline: [[at[0] - w * 0.85, at[1]], [at[0] + w * 0.85, at[1]], ...top], shadow: [], grain: [],
        veins: [-0.5, 0, 0.5].map(q => [[at[0] + q * w, at[1]], [at[0] + q * w, at[1] + h * 0.55]]), weight: 0.4 };
}
/**
 * A horsetail node: its sheath and a whorl of slender jointed branches arching out on both sides, drawn
 * with the stem along +y.
 */
function whorl(rng, length) {
    const comb = [[0, 0.02]];
    const joints = [];
    const count = rng.int(9, 12);
    for (let k = 0; k < count; k += 1) {
        const side = k % 2 ? 1 : -1;
        const front = k % 3 === 2;
        const a = side * rng.range(38, 72) * DEG;
        const len = length * rng.range(0.75, 1) * (front ? 0.5 : 1);
        const dir = [Math.sin(a), Math.cos(a)];
        const branch = sample(v => [dir[0] * len * v, 0.02 + dir[1] * len * v + len * 0.1 * v * v], 6);
        comb.push(...branch, ...branch.slice(0, -1).reverse());
        for (let j = 1; j * 0.17 < len; j += 1) {
            const v = j * 0.17 / len;
            joints.push([dir[0] * len * v, 0.02 + dir[1] * len * v + len * 0.1 * v * v]);
        }
    }
    return [line(comb, 0.011, false), { type: "dots", points: joints, radius: 0.012 }, sheath([0, 0], 0.05, 0.11)];
}
/** A horsetail's spore cone: shields in hexagons, tight and dark, then ripe, then parted and smoking with spores. */
function strobilus(rng, s, stage, base) {
    const len = s * (stage === "bud" ? 0.3 : stage === "bloom" ? 0.48 : 0.6);
    const r = s * (stage === "bud" ? 0.075 : 0.1);
    const hw = (v) => r * Math.min(1, (v + 0.1) / 0.25) ** 0.5 * Math.sqrt(Math.max(0, 1 - Math.max(0, (v - 0.72) / 0.28) ** 2));
    const outline = profile(len, hw, base[1], 24);
    const body = roundBody(outline, [base[0], base[1] + len * 0.5], r * 1.3, HATCH * 0.55, stage === "bud" ? 0.8 : 0.6);
    const rows = Math.round(len / (r * 0.55));
    const lattice = [];
    for (let i = 1; i < rows; i += 1) {
        const v = i / rows, y = base[1] + len * v, w = hw(v) * 0.95;
        lattice.push(sample(u => [base[0] + (u * 2 - 1) * w, y + (Math.round(u * 6) % 2 ? 1 : -1) * r * 0.08], 6));
        for (let j = 0; j < 3; j += 1) {
            const x = base[0] + ((j + 0.5 * (i % 2)) / 3 * 2 - 0.85) * w;
            if (Math.abs(x - base[0]) < w * 0.9)
                lattice.push([[x, y + r * 0.08], [x, y + len / rows - r * 0.08]]);
        }
    }
    if (stage === "seed") {
        return [body, ...lattice.map(points => line(points, s * 0.01, false)), spores(rng, [base[0] + r, base[1] + len * 0.5], unit(1, 0.5), s * 0.4, s * 0.15, 30, s * 0.005)];
    }
    if (stage === "bloom")
        body.veins = lattice;
    return [body];
}
/** A fertile horsetail shoot: an unbranched stem with pale sheaths, crowned by its cone. */
function fertileShoot(rng, s, stage) {
    const h = s * 0.55;
    const shapes = [line([[0, 0], [rng.sym(0.02), h * 0.5], [0, h]], s * 0.05)];
    for (const f of [0.25, 0.62])
        shapes.push(sheath([0, h * f], s * 0.045, s * 0.1));
    shapes.push(sheath([0, h - s * 0.06], s * 0.05, s * 0.08), ...strobilus(rng, s, stage, [0, h]));
    return shapes;
}
/** A sterile horsetail sprig: a jointed stem segment with two whorls. */
function sprig(rng, s) {
    const shapes = [line([[0, 0], [0, s]], 0.035)];
    for (const f of [0.3, 0.75])
        shapes.push(...whorl(rng, s * (0.55 - 0.15 * f)).map(shape => turnShape(shape, 0, [0, s * f])));
    return shapes;
}
/** How long a fruit body stays a bud, as a share of the day. */
const BUDDING = 0.1;
/** Lattice step for carving hatching around threads, in centimetres. */
const CELL = 0.02;
const stageOf = (season, t) => t < season.born ? null : t >= season.seedAt ? "seed" : t < season.born + BUDDING ? "bud" : "bloom";
const seedOf = (rng) => Math.floor(rng.u() * 4294967295);
/** Moments for `n` fruit bodies coming up one after another: the first to come is the first to shed. */
function seasons(rng, n, from = 0.03, to = 0.62) {
    return Array.from({ length: n }, (_, i) => {
        const q = n > 1 ? i / (n - 1) : 0;
        const born = Math.max(0, from + (to - from) * q ** 0.85 + rng.sym(0.015));
        return { born, seedAt: Math.max(born + BUDDING * 1.6, 0.8 + 0.16 * q + rng.sym(0.012)) };
    });
}
/** A shape with every point moved by `f`. */
function mapShape(shape, f) {
    switch (shape.type) {
        case "body": return { ...shape, outline: shape.outline.map(f), shadow: shape.shadow.map(ring => ring.map(f)), grain: shape.grain.map(cut => cut.map(f)), veins: shape.veins.map(vein => vein.map(f)) };
        case "solid": return { ...shape, outline: shape.outline.map(f) };
        case "line": return { ...shape, points: shape.points.map(f) };
        case "dots": return { ...shape, points: shape.points.map(f) };
    }
}
/** Shapes lying flat on the ground: turned by `angle`, foreshortened to `k` of their height, moved to `at`. */
function layFlat(shapes, angle, k, at) {
    return shapes.map(shape => mapShape(turnShape(shape, angle), ([x, y]) => [at[0] + x, at[1] + y * k]));
}
/** A test for points within `radius` of any of the paths, on a fine lattice. */
function carver(paths, radius) {
    const cells = new Set();
    const key = (ix, iy) => (ix + 2000) * 8192 + iy + 2000;
    const reach = Math.ceil(radius / CELL), limit = (radius / CELL + 0.5) ** 2;
    for (const path of paths) {
        for (let i = 1; i < path.length; i += 1) {
            const a = path[i - 1], b = path[i];
            const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (CELL * 0.5)));
            for (let k = 0; k <= steps; k += 1) {
                const cx = Math.floor(lerp(a[0], b[0], k / steps) / CELL), cy = Math.floor(lerp(a[1], b[1], k / steps) / CELL);
                for (let dx = -reach; dx <= reach; dx += 1)
                    for (let dy = -reach; dy <= reach; dy += 1)
                        if (dx * dx + dy * dy <= limit)
                            cells.add(key(cx + dx, cy + dy));
            }
        }
    }
    return ([x, y]) => cells.has(key(Math.floor(x / CELL), Math.floor(y / CELL)));
}
/** A stable value in [0, 1) for a pair of numbers, for texture that must stay put from one moment to the next. */
function grit(a, b) {
    const v = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
    return v - Math.floor(v);
}
/**
 * Earth's hatching over a box: near-level cuts that waver and break off in crumbs, stopping wherever `cut`
 * holds, so that threads and roots show through as paper.
 */
function earthHatch(x0, y0, x1, y1, spacing, slope, cut) {
    const runs = [];
    let row = 0;
    for (let c = y0 - Math.max(0, slope) * (x1 - x0); c <= y1 - Math.min(0, slope) * (x1 - x0); c += spacing * (0.7 + 0.6 * grit(row, 9)), row += 1) {
        const phase = grit(row, 3) * 6;
        let run = [], last = null;
        const flush = () => {
            if (last && run[run.length - 1] !== last)
                run.push(last);
            if (run.length > 1)
                runs.push(run);
            run = [];
            last = null;
        };
        for (let k = 0; x0 + k * CELL <= x1 + 1e-9; k += 1) {
            const x = x0 + k * CELL;
            const p = [x, c + slope * (x - x0) + 0.005 * Math.sin(x * 4 + phase)];
            if (p[1] < y0 || p[1] > y1 || grit(row, Math.floor(x / 0.09 + phase)) < 0.3 || cut(p)) {
                flush();
                continue;
            }
            if (run.length === 0 || k % 5 === 0)
                run.push(p);
            last = p;
        }
        flush();
    }
    return runs;
}
function bedOf(rng, width, level, floor = 0.12) {
    const phase = rng.range(0, 6), wave = rng.range(0.7, 1.1);
    const top = (x) => level + 0.08 * Math.sin(x * wave + phase) + 0.04 * Math.sin(x * 2.6 + phase * 1.7);
    const upper = sample(v => {
        const x = lerp(0.06, width - 0.06, v);
        return [x, top(x)];
    }, 36);
    const side = (x, inward) => sample(v => [x + inward * (0.1 * v + rng.range(0, 0.07)), lerp(top(x) - 0.06, floor + 0.05, v)], Math.max(3, Math.round((level - floor) / 0.18)));
    const lower = sample(v => [lerp(width - 0.22, 0.22, v), floor + 0.04 * Math.sin(v * 11 + phase) + rng.sym(0.04)], 30);
    return { top, outline: [...upper, ...side(width - 0.06, -1), ...lower, ...side(0.06, 1).reverse()], floor, width };
}
/** The soil cut through: dark with crumbling hatching and grit, its threads (and whatever else is carved) left as paper. */
function soilShapes(bed, threads, carved) {
    const cut = carver([...threads, ...carved], 0.024);
    const ceiling = Math.max(...bed.outline.map(p => p[1]));
    const grains = [];
    for (let k = 0; k < bed.width * (ceiling - bed.floor) * 14; k += 1) {
        const x = lerp(0.2, bed.width - 0.2, grit(k, 1)), y = lerp(bed.floor + 0.08, bed.top(x) - 0.06, grit(k, 2));
        if (!cut([x, y]))
            grains.push([x, y]);
    }
    return [{ type: "body", outline: bed.outline, shadow: [], grain: earthHatch(0.06, bed.floor - 0.1, bed.width - 0.06, ceiling, HATCH * 0.72, 0.09, cut), veins: threads, weight: 0.55 },
        { type: "dots", points: grains, radius: 0.008 }];
}
/** Stones in the soil, pale and rounded. */
function pebbles(rng, bed, count) {
    return Array.from({ length: count }, () => {
        const x = rng.range(0.3, bed.width - 0.3), r = rng.range(0.035, 0.09);
        const y = rng.range(bed.floor + 0.12, bed.top(x) - 0.15);
        const outline = sample(v => {
            const a = v * Math.PI * 2, k = 1 + 0.18 * Math.sin(a * 3 + x * 7);
            return [x + Math.cos(a) * r * 1.3 * k, y + Math.sin(a) * r * k];
        }, 12).slice(0, -1);
        return roundBody(outline, [x, y], r * 1.2, HATCH * 0.5, 0.3);
    });
}
/** Mycelium: threads wandering out from each start and forking twice over, kept inside `within`. */
function soilThreads(rng, starts, within, reach) {
    const paths = [];
    const walk = (from, heading, length, depth) => {
        const points = [from], headings = [heading];
        let a = heading;
        for (let i = 0; i < Math.round(length / 0.08); i += 1) {
            a += rng.sym(0.5);
            const last = points[points.length - 1];
            let next = add(last, [Math.cos(a), Math.sin(a)], 0.08);
            if (!within(next)) {
                a += (rng.chance(0.5) ? 1 : -1) * 2;
                next = add(last, [Math.cos(a), Math.sin(a)], 0.08);
                if (!within(next))
                    break;
            }
            points.push(next);
            headings.push(a);
        }
        if (points.length > 1)
            paths.push(points);
        if (depth >= 2 || points.length < 3)
            return;
        const forks = rng.int(1, 3);
        for (let k = 0; k < forks; k += 1) {
            const i = rng.int(1, points.length - 2);
            walk(points[i], headings[i] + (rng.chance(0.5) ? 1 : -1) * rng.range(0.5, 1.1), length * rng.range(0.35, 0.6), depth + 1);
        }
    };
    for (const start of starts) {
        const n = rng.int(2, 3);
        for (let k = 0; k < n; k += 1)
            walk(start, -Math.PI / 2 + lerp(-1.3, 1.3, (k + rng.u()) / n), reach * rng.range(0.6, 1), 0);
    }
    return paths;
}
/** Threads running through the litter just over the ground line, out from each start both ways. */
function litterThreads(rng, bed, starts) {
    return starts.flatMap(x0 => [-1, 1].map(sd => {
        const len = rng.range(0.5, 1.3), phase = rng.range(0, 6);
        return sample(v => {
            const x = clamp(x0 + sd * len * v, 0.15, bed.width - 0.15);
            return [x, bed.top(x) + 0.03 + 0.04 * Math.sin(v * 9 + phase) * v];
        }, 10);
    }));
}
/** How much of the mycelium shows: some from the first, more as the day goes on and fills. */
const spreadOf = (t, fullness) => clamp(0.3 + 0.45 * fullness + 0.25 * t, 0, 1);
/** What lies on the ground, spread along it in the proportions of `mix`; nothing grows where `bare` holds. */
function litterOf(rng, bed, count, mix, bare = () => false) {
    const kinds = Object.keys(mix);
    const total = kinds.reduce((sum, kind) => sum + mix[kind], 0);
    const items = [];
    for (let i = 0; i < count; i += 1) {
        const x = lerp(0.2, bed.width - 0.2, (i + rng.u()) / count);
        let roll = rng.u() * total, kind = kinds[0];
        for (const k of kinds) {
            roll -= mix[k];
            if (roll <= 0) {
                kind = k;
                break;
            }
        }
        const item = { x, kind, size: rng.range(0.7, 1.15), front: rng.chance(0.35), rank: rng.u(), seed: seedOf(rng) };
        if (!bare(x) || kind === "leaf" || kind === "twig")
            items.push(item);
    }
    return items;
}
/** One piece of litter: a fallen leaf lying flat, a moss cushion, a grass tuft or a dead twig. */
function litterShapes(item, bed) {
    const rng = createRng(item.seed), at = [item.x, bed.top(item.x) - 0.02];
    switch (item.kind) {
        case "leaf": return layFlat(lobedLeaf(rng, 0.75 * item.size, rng.sym(0.2)), (rng.chance(0.5) ? 1 : -1) * rng.range(1.25, 1.85), 0.42, [at[0], at[1] + 0.03]);
        case "moss": return mossCushion(rng, 0.55 * item.size).map(shape => turnShape(shape, 0, at));
        case "grass": return grassTuft(rng, 0.55 * item.size).map(shape => turnShape(shape, 0, at));
        case "twig": {
            const len = 0.9 * item.size, tilt = rng.sym(0.12);
            const stick = sample(v => [at[0] - len / 2 + len * v, at[1] + 0.04 + len * tilt * (v - 0.5) + 0.015 * Math.sin(v * 7)], 6);
            const fork = stick[3];
            return [line(stick, 0.028), line([fork, [fork[0] + len * 0.2, fork[1] + len * 0.1], [fork[0] + len * 0.3, fork[1] + len * 0.12]], 0.016)];
        }
    }
}
/** The litter shown at a fullness, behind or in front of what stands among it. */
function litterLayer(items, bed, fullness, front) {
    return items.filter(item => item.front === front && item.rank < 0.4 + 0.6 * fullness).flatMap(item => litterShapes(item, bed));
}
/**
 * A length of wood along a centreline: bark lit from the upper left, shaded and cut along its length on
 * the far side, and fissured. `cap` closes its far end (a broken top), `half` gives its half-width.
 */
function woodBody(rng, centre, half, weight, cap = []) {
    const n = centre.length - 1, nrm = normals(centre);
    const middle = nrm[Math.floor(n / 2)];
    const shade = middle[0] * 0.6 - middle[1] * 0.8 > 0 ? 1 : -1;
    const at = (i, q) => {
        const h = half(i / n);
        return [centre[i][0] + nrm[i][0] * h * q, centre[i][1] + nrm[i][1] * h * q];
    };
    const shadow = [...centre.map((_, i) => at(i, shade * 0.3)), ...centre.map((_, i) => at(i, shade * 1.9)).reverse()];
    const widest = Math.max(...centre.map((_, i) => half(i / n)));
    const lanes = Math.max(3, Math.round(2 * widest / HATCH));
    const grain = Array.from({ length: lanes }, (_, k) => centre.map((_, i) => at(i, -0.95 + 1.9 * k / (lanes - 1))));
    let length = 0;
    for (let i = 1; i <= n; i += 1)
        length += Math.hypot(centre[i][0] - centre[i - 1][0], centre[i][1] - centre[i - 1][1]);
    const veins = Array.from({ length: Math.round(length / 0.3) }, () => {
        const i0 = rng.int(0, n - 2), q = rng.sym(0.8);
        return Array.from({ length: Math.min(rng.int(2, 4), n - i0) + 1 }, (_, j) => at(i0 + j, q + rng.sym(0.08)));
    });
    return { type: "body", outline: [...centre.map((_, i) => at(i, 1)), ...cap, ...centre.map((_, i) => at(i, -1)).reverse()], shadow: [shadow], grain, veins, weight };
}
/** A sawn end of a log seen from the side: an upright ellipse ringed with years, its heart gone soft and dark. */
function endFace(at, r) {
    const rx = r * 0.4, ry = r * 0.97;
    const outline = circle(at, rx, ry, 18);
    const rings = [0.35, 0.6, 0.82].map(k => [...circle(at, rx * k, ry * k, 14), circle(at, rx * k, ry * k, 14)[0]]);
    const cracks = [0.4, 2.2, 4].map(a => [[at[0] + Math.cos(a) * rx * 0.2, at[1] + Math.sin(a) * ry * 0.2], [at[0] + Math.cos(a) * rx * 0.85, at[1] + Math.sin(a) * ry * 0.85]]);
    return { type: "body", outline, shadow: [circle(at, rx * 0.3, ry * 0.3, 10)], grain: hatchAcross(outline, HATCH * 0.4), veins: [...rings, ...cracks], weight: 0.5 };
}
const ONE = { gilled: agaric, morel, puffball: (rng, s, stage) => puffball(rng, s, stage, [0, 0]) };
/** A fruit body's height as a share of its size, so that the foot's room covers what stands in it. */
const TALL = { gilled: 0.78, morel: 0.95, puffball: 0.66 };
/** Clumps of `per` fruit bodies standing at each of `xs` on `base`, the biggest of all coming first. */
function clumps(rng, xs, base, per, smax) {
    const fruits = [];
    for (const x0 of xs) {
        for (let j = 0; j < per; j += 1) {
            const s = smax * (j === 0 ? rng.range(0.85, 1) : rng.range(0.42, 0.72));
            const x = x0 + (j === 0 ? 0 : (j % 2 ? -1 : 1) * smax * (0.38 + 0.22 * Math.ceil(j / 2)) + rng.sym(0.06));
            fruits.push({ at: [x, base(x) - 0.03], s, tilt: -(x - x0) * 0.25 + rng.sym(0.08), season: { born: 0, seedAt: 0 }, seed: seedOf(rng) });
        }
    }
    const times = seasons(rng, fruits.length);
    fruits.slice().sort((a, b) => b.s - a.s).forEach((fruit, rank) => { fruit.season = times[rank]; });
    // The biggest stand behind.
    return fruits.sort((a, b) => b.s - a.s);
}
function fruitShapes(fruit, one, t) {
    const stage = stageOf(fruit.season, t);
    return stage ? one(createRng(fruit.seed), fruit.s, stage).map(shape => turnShape(shape, fruit.tilt, fruit.at)) : [];
}
/**
 * The foot of a fungus fruiting from the ground: soil threaded with mycelium, litter, and clumps pushing up
 * through it one after another. The puffballs crowd a fallen log, and the threads climb from its sawn end.
 */
function fruitingFoot(kind, size, cluster) {
    const level = 1.25, smax = 1.3 * size, onLog = kind === "puffball", logR = 0.38;
    const mix = {
        gilled: { grass: 0.5, moss: 0.2, leaf: 0.12, twig: 0.18 },
        morel: { leaf: 0.45, twig: 0.2, moss: 0.15, grass: 0.2 },
        puffball: { moss: 0.35, leaf: 0.3, twig: 0.2, grass: 0.15 },
    };
    return {
        crown: onLog ? [0.66, level + 0.45] : [0.48, level - 0.15],
        room: [[0, 0, 1, level + (onLog ? 0.45 + logR : 0.05) + TALL[kind] * smax + 0.1]],
        scroll: false,
        draw(rng, { width }, t, fullness) {
            const bed = bedOf(rng, width, level);
            const wood = [];
            let fruits;
            const starts = [];
            if (onLog) {
                const xa = width * 0.1, xb = width * 0.66;
                // Drawn from the sawn end back to the broken one, so that the break is the cap.
                const axis = (v) => [lerp(xb, xa, v), level + 0.44 - 0.08 * v + 0.03 * Math.sin(v * 5)];
                const half = (v) => logR * (0.88 + 0.12 * v);
                const n = 24;
                const broken = sample(u => {
                    const [x, y] = axis(1);
                    return [x - 0.12 * Math.abs(Math.sin(u * 11)) - 0.04, y + half(1) * (1 - 2 * u)];
                }, 8);
                wood.push(woodBody(rng, sample(axis, n), half, 0.55, broken), endFace(axis(0), half(0)));
                const top = (x) => {
                    const v = clamp((xb - x) / (xb - xa), 0, 1);
                    return axis(v)[1] + half(v) * 0.9;
                };
                for (const v of [0.3, 0.75])
                    wood.push(...mossCushion(rng, 0.5).map(shape => turnShape(shape, 0, [lerp(xb, xa, v), top(lerp(xb, xa, v)) - 0.02])));
                fruits = [...clumps(rng, [width * 0.22, width * 0.45], top, cluster + 1, smax * 0.9), ...clumps(rng, [width * 0.86], bed.top, Math.max(1, cluster - 1), smax * 0.6)];
                starts.push([width * 0.3, level - 0.05], [width * 0.55, level - 0.05], [width * 0.86, level - 0.05]);
            }
            else {
                fruits = clumps(rng, [width * (0.2 + rng.sym(0.04)), width * (0.77 + rng.sym(0.04))], bed.top, cluster + 1, smax);
                starts.push([width * 0.48, level - 0.15], ...fruits.map(fruit => [fruit.at[0], level - 0.08]));
            }
            const within = (p) => p[0] > 0.15 && p[0] < width - 0.15 && p[1] > bed.floor + 0.1 && p[1] < bed.top(p[0]) - 0.06;
            const threads = soilThreads(rng, starts, within, 1.6);
            const surface = litterThreads(rng, bed, starts.map(p => p[0]));
            const litter = litterOf(rng, bed, 16, mix[kind]);
            const stones = pebbles(rng, bed, rng.int(3, 6));
            const spread = spreadOf(t, fullness);
            const shown = threads.filter((_, i) => i / threads.length < spread);
            return [
                ...soilShapes(bed, shown, []), ...stones,
                ...litterLayer(litter, bed, fullness, false),
                ...surface.filter((_, i) => i / surface.length < spread).map(points => line(points, 0.006)),
                ...wood,
                ...fruits.flatMap(fruit => fruitShapes(fruit, ONE[kind], t)),
                ...litterLayer(litter, bed, fullness, true),
            ];
        },
    };
}
/**
 * The hoof bracket's foot: a dead birch still standing, broken off high, its bark ringed with lenticels;
 * brackets come out up it one after another, lichens settle on it and the white rot shows where bark has
 * fallen as the day fills.
 */
function snagFoot(size, cluster) {
    const level = 1.2, x = 0.44, top = 13.6, half = 0.12, reach = 0.2 * size;
    return {
        crown: [x, level],
        room: [[0, 0, 1, level + 0.3], [x - half - reach - 0.08, level, x + half + reach + 0.08, top + 0.75]],
        scroll: false,
        draw(rng, { width }, t, fullness) {
            const bed = bedOf(rng, width, level);
            const lean = rng.sym(0.012), phase = rng.range(0, 6);
            // The trunk runs down behind the cut face of the soil, which hides its foot.
            const foot = level - 0.4;
            const axis = (y) => width * x + lean * (y - level) + 0.1 * Math.sin((y - level) * 0.4 + phase) - 0.1 * Math.sin(phase);
            const halfAt = (y) => width * half * (1 - 0.22 * (y - level) / (top - level)) + 0.28 * Math.exp(-Math.max(0, y - level) / 0.4);
            const yOf = (v) => lerp(foot, top, v);
            const splinters = sample(u => {
                const spike = [0.15, 0.55, 0.12, 0.72, 0.3, 0.08, 0.42][Math.round(u * 6)] * rng.range(0.7, 1.1);
                return [axis(top) + halfAt(top) * (u * 2 - 1) * 0.92, top + spike];
            }, 6);
            const bark = woodBody(rng, sample(v => [axis(yOf(v)), yOf(v)], 56), v => halfAt(yOf(v)), 0.45, splinters);
            // Birch bark: dark lenticels across it, and black fissures low on the trunk.
            const lenticels = [];
            for (let y = level + 1.1; y < top - 0.2; y += rng.range(0.16, 0.3)) {
                const q = rng.range(-0.95, 0.45), len = rng.range(0.15, 0.5), h = halfAt(y), thick = rng.range(0.01, 0.02);
                const edge = (u, sd) => [axis(y) + h * (q + len * u), y - 0.03 * Math.sin(Math.PI * u) + sd * thick * Math.sin(Math.PI * u)];
                lenticels.push({ type: "solid", outline: [...sample(u => edge(u, 1), 6), ...sample(u => edge(1 - u, -1), 6).slice(1, -1)] });
            }
            for (let k = 0; k < 9; k += 1) {
                const q = rng.sym(0.85), y0 = level + rng.range(-0.1, 0.3);
                bark.veins.push(sample(u => [axis(y0) + halfAt(y0 + u * 0.9) * (q + 0.06 * Math.sin(u * 14 + k)), y0 + u * rng.range(0.5, 1.1)], 5));
            }
            // Roots flaring into the soil.
            const roots = [-1, -0.4, 0.5, 1].map(sd => {
                const from = [axis(level) + sd * halfAt(level) * 0.7, level - 0.02];
                const to = [from[0] + sd * rng.range(0.6, 1.2), rng.range(0.35, 0.8)];
                return woodBody(rng, sample(bezier3(from, [from[0] + sd * 0.2, from[1] - 0.25], [to[0] - sd * 0.3, to[1] + 0.2], to), 10), v => 0.09 * (1 - 0.75 * v) + 0.01, 0.4);
            });
            // Where bark has fallen: bare wood, its grain, and the white rot fanning through it as the day fills.
            const patches = [];
            for (let k = 0; k < 2; k += 1) {
                const y0 = lerp(level + 2, top - 2, (k + rng.range(0.1, 0.6)) / 2), h = rng.range(0.8, 1.4), q = rng.range(-0.5, 0.2), w = rng.range(0.35, 0.55);
                const ring = sample(u => {
                    const a = u * Math.PI * 2, y = y0 + Math.sin(a) * h / 2;
                    return [axis(y) + halfAt(y) * (q + Math.cos(a) * w * (1 + 0.15 * Math.sin(a * 5 + k))), y];
                }, 16).slice(0, -1);
                const grainLines = [-0.6, -0.2, 0.2, 0.6].map(g => sample(u => {
                    const y = y0 + (u - 0.5) * h * 0.8 * (1 - 0.5 * Math.abs(g));
                    return [axis(y) + halfAt(y) * (q + g * w * 0.85 + 0.03 * Math.sin(u * 8 + g * 5)), y];
                }, 6));
                const fans = Array.from({ length: 5 }, (_, j) => ({ rank: rng.u(), points: sample(u => {
                        const y = y0 - h * 0.35 + h * 0.7 * u, g = (j / 4 - 0.5) * u * 1.4;
                        return [axis(y) + halfAt(y) * (q + g * w), y];
                    }, 5) }));
                patches.push({ type: "body", outline: ring, shadow: [], grain: [], veins: [...grainLines, ...fans.filter(fan => fan.rank < 0.25 + 0.75 * fullness).map(fan => fan.points)], weight: 0.15 });
            }
            // Lichens settling on the bark as the day fills, and a woodpecker's hole near the top.
            const lichens = [];
            for (let k = 0; k < 6; k += 1) {
                const y = lerp(level + 1.5, top - 0.6, (k + rng.u()) / 6), sd = rng.chance(0.5) ? 1 : -1, rank = rng.u(), seed = seedOf(rng);
                if (rank > 0.2 + 0.8 * fullness)
                    continue;
                lichens.push(...lichenPatch(createRng(seed), 0.45).map(shape => turnShape(shape, -sd * 1.2, [axis(y) + sd * halfAt(y) * 0.85, y])));
            }
            const holeY = top - rng.range(1.2, 2), hole = [axis(holeY) - halfAt(holeY) * 0.25, holeY];
            // The brackets, low ones first, alternating sides as they climb.
            const count = 2 + 2 * cluster;
            const brackets = Array.from({ length: count }, (_, i) => {
                const y = level + 1.5 + (top - level - 2.4) * (i + rng.range(0, 0.6)) / count;
                const side = (i % 2 ? -1 : 1) * (rng.chance(0.2) ? -1 : 1);
                return { y, side, d: width * reach * rng.range(0.72, 1) * (1 - 0.3 * i / count), seed: seedOf(rng) };
            });
            const times = seasons(rng, count, 0.04, 0.66);
            const within = (p) => p[0] > 0.15 && p[0] < width - 0.15 && p[1] > bed.floor + 0.1 && p[1] < bed.top(p[0]) - 0.06;
            const threads = soilThreads(rng, [[axis(level) - 0.4, level - 0.15], [axis(level) + 0.4, level - 0.15]], within, 1.8);
            const litter = litterOf(rng, bed, 14, { moss: 0.35, leaf: 0.35, twig: 0.15, grass: 0.15 });
            const stones = pebbles(rng, bed, rng.int(3, 5));
            const moss = mossCushion(rng, 0.5).map(shape => turnShape(shape, 0, [axis(level) + (rng.chance(0.5) ? 1 : -1) * halfAt(level) * 0.6, level - 0.02]));
            const spread = spreadOf(t, fullness);
            return [
                bark, ...lenticels, ...patches, ...lichens,
                { type: "solid", outline: circle(hole, 0.085, 0.11, 12) }, line(circle(hole, 0.11, 0.14, 12).concat([[hole[0] + 0.11, hole[1]]]), 0.01),
                ...soilShapes(bed, threads.filter((_, i) => i / threads.length < spread), []), ...stones, ...roots,
                ...litterLayer(litter, bed, fullness, false),
                ...moss,
                ...brackets.flatMap((bracket, i) => {
                    const stage = stageOf(times[i], t);
                    if (!stage)
                        return [];
                    const d = bracket.d * (stage === "bud" ? 0.4 : 1);
                    return hoof(createRng(bracket.seed), axis(bracket.y) + bracket.side * halfAt(bracket.y) * 0.85, bracket.y, bracket.side, d, d * (stage === "bud" ? 0.85 : 0.72), stage, d / 0.46);
                }),
                ...litterLayer(litter, bed, fullness, true),
            ];
        },
    };
}
/**
 * The truffle's foot: a deep section of soil where the oak's roots run out into rootlets with swollen
 * tips, and truffles ripen among them, pale, then black and warty; the ripest is cut through by the section
 * and shows its marbling. Above ground only a bare patch round the tree and, over a ripe truffle, a crack.
 */
function truffleFoot(size, cluster) {
    const level = 4, x = 0.36;
    return {
        crown: [x, level - 0.04],
        room: [[0, 0, 1, level + 0.45]],
        scroll: false,
        draw(rng, { width }, t, fullness) {
            const bed = bedOf(rng, width, level, 0.15);
            const base = [width * x, level - 0.04];
            const roots = [], rootlets = [], carved = [], tips = [];
            for (const [dx, depth] of [[-1.5, 2.1], [2.6, 1.3], [0.9, 3.1]]) {
                const end = [clamp(base[0] + dx * rng.range(0.8, 1.1), 0.4, width - 0.4), level - depth * rng.range(0.85, 1.05)];
                const phase = rng.range(0, 6);
                const path = sample(bezier3(base, [base[0] + dx * 0.12, base[1] - 0.6], [end[0] - dx * 0.35, end[1] + 0.5], end), 18);
                const centre = path.map((p, i) => [p[0] + 0.07 * Math.sin(i * 0.9 + phase) * Math.min(1, i / 4), p[1] + 0.05 * Math.sin(i * 1.3 + phase * 2) * Math.min(1, i / 4)]);
                const w0 = 0.15 - 0.02 * Math.abs(dx);
                roots.push(woodBody(rng, centre, v => w0 * (1 - v) ** 1.4 + 0.014, 0.35));
                for (let j = 0; j < 4; j += 1) {
                    const p = centre[Math.round(18 * (0.3 + 0.65 * (j + rng.u()) / 4))];
                    const length = Math.min(rng.range(0.5, 0.95), p[1] - bed.floor - 0.25);
                    if (length < 0.3)
                        continue;
                    const angle = rng.sym(1.1) + Math.PI;
                    for (const shape of rootlet(rng, length, rng.sym(0.3))) {
                        const placed = turnShape(shape, angle, p);
                        rootlets.push(placed);
                        if (placed.type === "line")
                            carved.push(placed.points);
                        if (placed.type === "dots")
                            tips.push(...placed.points);
                    }
                }
            }
            // The truffles, each near a rootlet's tip, the biggest first.
            const truffles = [];
            for (let k = 0; k < 2 + cluster && tips.length > 0; k += 1) {
                const r = rng.range(0.22, 0.32) * size * (k === 0 ? 1.25 : 1);
                for (let attempt = 0; attempt < 10; attempt += 1) {
                    const tip = rng.pick(tips), a = rng.range(0, Math.PI * 2);
                    const at = [clamp(tip[0] + Math.cos(a) * r * 1.1, r + 0.25, width - r - 0.25), clamp(tip[1] + Math.sin(a) * r * 1.1, bed.floor + r + 0.15, level - r - 0.35)];
                    if (truffles.every(other => Math.hypot(other.at[0] - at[0], other.at[1] - at[1]) > other.r + r + 0.12)) {
                        truffles.push({ at, r, seed: seedOf(rng) });
                        break;
                    }
                }
            }
            const times = seasons(rng, truffles.length, 0.03, 0.55);
            const within = (p) => p[0] > 0.15 && p[0] < width - 0.15 && p[1] > bed.floor + 0.1 && p[1] < bed.top(p[0]) - 0.06;
            const threads = soilThreads(rng, [...truffles.map(truffle => truffle.at), base], within, 1.4);
            // The bare patch round the oak, where the truffle's mycelium keeps the grass down.
            const litter = litterOf(rng, bed, 16, { grass: 0.45, leaf: 0.35, twig: 0.2, moss: 0 }, px => Math.abs(px - base[0]) < 1.5);
            const stubble = [];
            for (let k = 0; k < 14; k += 1) {
                const px = base[0] + rng.sym(1.4), y = bed.top(px) - 0.01, h = rng.range(0.04, 0.12);
                stubble.push([px, y], [px + rng.sym(0.04), y + h], [px, y]);
            }
            const stones = pebbles(rng, bed, rng.int(6, 10));
            const cracks = truffles.map(truffle => {
                const px = truffle.at[0], y = bed.top(px);
                return sample(u => [px - 0.3 + 0.6 * u, y - 0.01 - 0.025 * Math.abs(Math.sin(u * 17 + px))], 8);
            });
            const spread = spreadOf(t, fullness);
            const shapes = [...soilShapes(bed, threads.filter((_, i) => i / threads.length < spread), carved), ...stones, ...roots, ...rootlets];
            truffles.forEach((truffle, k) => {
                const stage = stageOf(times[k], t);
                if (!stage)
                    return;
                const tr = createRng(truffle.seed), r = truffle.r * (stage === "bud" ? 0.55 : 1);
                if (stage === "bud")
                    shapes.push(roundBody(truffleOutline(tr, truffle.at, r), truffle.at, r, HATCH * 0.6, 0.4));
                else if (stage === "seed" && k === 0)
                    shapes.push(marbled(tr, truffle.at, r));
                else
                    shapes.push(darkBody(truffleOutline(tr, truffle.at, r), truffle.at, r));
                if (stage === "seed" && level - truffle.at[1] < 1.8)
                    shapes.push(line(cracks[k], 0.012, false));
            });
            return [...shapes, line(stubble, 0.008, false), ...litterLayer(litter, bed, fullness, false), ...litterLayer(litter, bed, fullness, true)];
        },
    };
}
/** A ripe truffle cut through by the section: black flesh hatched both ways, run with white marbling. */
function marbled(rng, at, r) {
    const outline = truffleOutline(rng, at, r);
    const veins = Array.from({ length: 8 }, () => {
        const a = rng.range(0, Math.PI * 2);
        let p = [at[0] + Math.cos(a) * r * 0.85, at[1] + Math.sin(a) * r * 0.8], heading = a + Math.PI + rng.sym(0.6);
        const out = [p];
        for (let k = 0; k < 9; k += 1) {
            heading += rng.sym(0.9);
            p = add(p, [Math.cos(heading), Math.sin(heading)], r * 0.16);
            if (Math.hypot(p[0] - at[0], p[1] - at[1]) > r * 0.88)
                break;
            out.push(p);
        }
        return out;
    });
    const cut = carver(veins, r * 0.07);
    const grain = [];
    for (const [a, b] of [...hatchAcross(outline, HATCH * 0.4, 0.5), ...hatchAcross(outline, HATCH * 0.55, 2.2)]) {
        let run = [];
        for (let k = 0; k <= 40; k += 1) {
            const p = [lerp(a[0], b[0], k / 40), lerp(a[1], b[1], k / 40)];
            if (!cut(p)) {
                run.push(p);
                continue;
            }
            if (run.length > 1)
                grain.push([run[0], run[run.length - 1]]);
            run = [];
        }
        if (run.length > 1)
            grain.push([run[0], run[run.length - 1]]);
    }
    return { type: "body", outline, shadow: [outline], grain, veins, weight: 0.95 };
}
/** A polyline resampled every `step` of its length from its start, with each sample's distance from the start. */
function resample(points, step) {
    const p = [points[0]], at = [0];
    let walked = 0, next = step;
    for (let i = 1; i < points.length; i += 1) {
        const a = points[i - 1], b = points[i], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        while (len > 0 && next <= walked + len) {
            const f = (next - walked) / len;
            p.push([lerp(a[0], b[0], f), lerp(a[1], b[1], f)]);
            at.push(next);
            next += step;
        }
        walked += len;
    }
    if (walked - at[at.length - 1] > 1e-6) {
        p.push(points[points.length - 1]);
        at.push(walked);
    }
    return { p, at };
}
/**
 * The mycelium's ink: a main stem is a cord of three threads wandering apart and back together, a branch
 * one thread, and every thread is furred with short curling hyphae that sometimes fork, with now and then
 * a long one wandering off. The hyphae have their slots at fixed distances from the base, taken in order
 * with the same draws each, so a growing thread keeps what it has shown.
 */
function threadInk(rng, points, _width, main) {
    const step = 0.06, every = main ? 0.12 : 0.18, strands = main ? 3 : 1, amp = main ? 0.06 : 0.012;
    const { p, at } = resample(points, step);
    if (p.length < 2)
        return [];
    const nrm = normals(p);
    const waves = Array.from({ length: strands }, () => [rng.range(0, 6), rng.range(0, 6), rng.range(1.8, 2.8)]);
    const strandAt = (j, i) => {
        const [a, b, f] = waves[j], s = at[i];
        const off = amp * Math.min(1, s / 0.4) * (0.65 * Math.sin(s * f + a) + 0.35 * Math.sin(s * f * 2.3 + b));
        return [p[i][0] + nrm[i][0] * off, p[i][1] + nrm[i][1] * off];
    };
    const combs = Array.from({ length: strands }, () => []);
    let slot = 0;
    for (let i = 0; i < p.length; i += 1) {
        for (let j = 0; j < strands; j += 1)
            combs[j].push(strandAt(j, i));
        while ((slot + 1) * every <= at[i] + 1e-9) {
            slot += 1;
            for (let j = 0; j < strands; j += 1) {
                const present = rng.u(), sd = rng.u() < 0.5 ? 1 : -1, turn = rng.u(), reach = rng.u(), curl = rng.u(), far = rng.u();
                const long = far < (main ? 0.035 : 0.03);
                if (i === 0 || (!long && present > (main ? 0.24 : 0.4)))
                    continue;
                const base = strandAt(j, i), prev = strandAt(j, i - 1);
                const tangent = unit(base[0] - prev[0], base[1] - prev[1]);
                const len = long ? lerp(0.4, 0.9, reach) : lerp(0.04, main ? 0.16 : 0.14, reach ** 1.4);
                const parts = long ? 6 : 3, bend = sd * lerp(0.15, 0.5, curl) * (long ? 0.4 : 1);
                let dir = rot(tangent, sd * (0.5 + 0.8 * turn));
                const hair = [base];
                for (let k = 0; k < parts; k += 1) {
                    dir = rot(dir, bend + (long ? Math.sin(k * 2.1 + far * 40) * 0.5 : 0));
                    hair.push(add(hair[hair.length - 1], dir, len / parts));
                }
                const fork = reach > 0.55 && !long ? [add(hair[1], rot(dir, -sd * 1.1), len * 0.35), hair[1]] : [];
                combs[j].push(...hair.slice(1), ...hair.slice(1, -1).reverse(), ...fork, base);
            }
        }
    }
    return combs.map(comb => line(comb, main ? 0.0062 : 0.0055, false));
}
/** A fan of mycelium spreading from a thread: wavering hyphae forking and forking again, as one stroke out and back. */
function hyphalFan(rng, length, bend, depth) {
    const tour = (base, dir, len, level) => {
        const n = 6, pts = [base], dirs = [dir];
        for (let i = 1; i <= n; i += 1) {
            dirs.push(rot(dirs[i - 1], rng.sym(0.45) + bend * 0.08));
            pts.push(add(pts[i - 1], dirs[i], len / n));
        }
        const forks = level >= depth ? [] : level === 0 ? [1, 2, 3, 4] : [2, 4];
        const out = [];
        for (let i = 0; i <= n; i += 1) {
            out.push(pts[i]);
            if (forks.includes(i))
                out.push(...tour(pts[i], rot(dirs[i], ((i + level) % 2 ? 1 : -1) * rng.range(0.4, 0.9)), len * rng.range(0.4, 0.6), level + 1), pts[i]);
        }
        return [...out, ...pts.slice(0, -1).reverse()];
    };
    return [line(tour([0, 0], [0, 1], length * 0.62, 0), 0.005, false)];
}
/**
 * A sod of turf lifted where a thread surfaces: crumbling earth with the thread fanning out inside it as
 * paper, rootlets and loose threads hanging from it; `leafy` lays a fallen leaf on it instead of grass.
 */
function clod(rng, w, h, targets, leafy) {
    const phase = rng.range(0, 6);
    const top = (x) => h * (0.85 + 0.15 * (1 - (x / w) ** 2)) + h * 0.06 * Math.sin(x * 9 / w + phase);
    const upper = sample(v => {
        const x = lerp(-w, w, v);
        return [x, top(x)];
    }, 14);
    const lower = sample(v => {
        const x = lerp(w, -w, v), q = x / w;
        return [x * (0.92 + 0.06 * Math.sin(v * 13 + phase)), h * (0.75 * q * q - 0.24 + 0.07 * Math.sin(v * 19 + phase)) + rng.sym(h * 0.05)];
    }, 14);
    const threads = targets.map(tx => sample(v => [tx * v + h * 0.15 * Math.sin(v * 6 + tx * 20), -h * 0.05 + (top(tx) + h * 0.05) * v], 6));
    const shapes = [{ type: "body", outline: [...upper, ...lower.slice(1, -1)], shadow: [], grain: earthHatch(-w, -h * 0.3, w, h * 1.1, HATCH * 0.62, 0.1, carver(threads, 0.016)), veins: threads, weight: 0.55 }];
    // Rootlets and loose threads hanging from its underside.
    for (let k = 0; k < 5; k += 1) {
        const x = lerp(-w * 0.6, w * 0.6, (k + rng.u()) / 5), y = h * (0.75 * (x / w) ** 2 - 0.2), len = h * rng.range(0.3, 0.75), sd = rng.sym(1);
        shapes.push(line(sample(v => [x + sd * len * 0.3 * v * v + h * 0.04 * Math.sin(v * 8 + k), y - len * v], 4), k % 2 ? 0.006 : 0.009));
    }
    if (leafy)
        shapes.push(...layFlat(lobedLeaf(rng, w * 0.9, 0.1), rng.chance(0.5) ? 1.5 : -1.5, 0.35, [rng.sym(w * 0.3), top(0) - h * 0.1]));
    else
        for (const sd of [-1, 1])
            shapes.push(...grassTuft(rng, h * 1.3).map(shape => turnShape(shape, sd * 0.2, [sd * w * 0.8, top(sd * w * 0.8) - 0.01])));
    return { shapes, top };
}
/** A short rotten stick lying where a thread surfaces, mossy on top, its sawn end ringed. */
function stick(rng, w, r) {
    const axis = (v) => [lerp(w, -w, v), r + r * 0.15 * (1 - v)];
    const half = (v) => r * (0.9 + 0.1 * v);
    const broken = sample(u => [-w - 0.03 - r * 0.25 * Math.abs(Math.sin(u * 9)), r + half(1) * (1 - 2 * u)], 6);
    const top = (x) => axis((w - x) / (2 * w))[1] + half((w - x) / (2 * w)) * 0.88;
    return { shapes: [woodBody(rng, sample(axis, 10), half, 0.55, broken), endFace(axis(0), half(0)), ...mossCushion(rng, w * 0.6).map(shape => turnShape(shape, 0, [-w * 0.35, top(-w * 0.35) - 0.01]))], top };
}
/**
 * A clump fruiting where a thread surfaces higher up: a clod of turf (champignon), of litter (morille) or a
 * rotten stick (lycoperdon), and its fruit bodies, the eldest in the middle.
 */
function specimen(kind, cluster) {
    const one = ONE[kind];
    return (rng, s, stage) => {
        const ground = rng.fork(), fruit = rng.fork(), front = rng.fork();
        const w = s * 0.55;
        const spots = [0, -0.62, 0.72].slice(0, cluster).map(q => q * w);
        const bed = kind === "puffball" ? stick(ground, w, s * 0.11) : clod(ground, w, s * 0.3, spots, kind === "morel");
        const shapes = [...bed.shapes];
        for (let k = spots.length - 1; k >= 0; k -= 1) {
            const x = spots[k], st = k === 0 ? stage : stage === "seed" ? "bloom" : "bud";
            shapes.push(...one(fruit, s * (k === 0 ? 0.88 : 0.55), st).map(shape => turnShape(shape, -x / s * 0.4, [x, bed.top(x) - s * 0.015])));
        }
        const fx = front.sym(w * 0.7);
        const tuft = kind === "gilled" ? grassTuft(front, s * 0.24) : mossCushion(front, s * 0.32);
        return [...shapes, ...tuft.map(shape => turnShape(shape, 0, [fx, bed.top(fx) - 0.01]))];
    };
}
/** An oak leaf: obovate on a short stalk, cut into rounded lobes, with two small ears at its base. */
function oakLeaf(rng, length, bend) {
    const lobes = rng.int(4, 6), width = length * rng.range(0.26, 0.32), stalk = 0.07;
    const spine = (v) => [bend * length * v * v - 0.3 * bend * length * v, length * v];
    const blade = (v) => clamp((v - stalk) / (1 - stalk), 0, 1);
    const halfWidth = (v) => {
        if (v < stalk)
            return length * 0.012;
        const envelope = width * Math.sin(Math.PI * Math.min(1, blade(v) ** 1.25)) ** 0.55;
        const ears = blade(v) < 0.09 ? width * 0.28 * Math.sin(Math.PI * blade(v) / 0.09) : 0;
        return envelope * (0.5 + 0.5 * Math.abs(Math.sin(Math.PI * lobes * blade(v))) ** 0.45) + ears + length * 0.01;
    };
    const veins = [];
    for (let k = 0; k < lobes; k += 1) {
        const tip = stalk + (1 - stalk) * (k + 0.5) / lobes;
        if (tip > 0.9)
            continue;
        for (const sd of [1, -1]) {
            const [x, y] = spine(tip);
            veins.push([spine(tip - 0.07), [x + sd * halfWidth(tip) * 0.85, y + length * 0.02]]);
        }
    }
    return [bladeBody({ spine, halfWidth, shade: rng.chance(0.5) ? 1 : -1, spacing: HATCH, grain: "across", weight: 0.55, midrib: true, veins, samples: 72 }, rng)];
}
/** An acorn in its cup: a small cup at first, then a green acorn in a scaly cup, brown and glossy when ripe. */
function acorn(s, stage) {
    const cupR = s * (stage === "bud" ? 0.065 : 0.095), cupH = cupR * 0.95;
    const nutLen = s * (stage === "bud" ? 0.05 : stage === "bloom" ? 0.26 : 0.3), nutR = s * (stage === "bud" ? 0.045 : 0.075);
    const nutHw = (v) => nutR * Math.sqrt(Math.max(0, 1 - v ** 2.4)) * Math.min(1, 0.6 + v * 4);
    const nut = roundBody(profile(nutLen + nutR * 0.4, nutHw, cupH * 0.45), [0, cupH * 0.45 + nutLen * 0.45], nutR, HATCH * 0.55, stage === "seed" ? 0.8 : 0.3);
    nut.veins = [-0.4, 0.35].map(q => sample(v => [q * nutHw(v), cupH * 0.45 + (nutLen + nutR * 0.4) * v], 5, 0.25, 0.85));
    const cupHw = (v) => cupR * (0.32 + 0.68 * Math.sin(Math.PI / 2 * Math.min(1, v * 1.1)) ** 0.7);
    const scales = [];
    for (let i = 1; i <= 3; i += 1)
        for (let j = -2; j <= 2; j += 1)
            scales.push([(j + (i % 2) * 0.5) / 2.8 * cupHw(i / 4), cupH * i / 4]);
    return [nut, roundBody(profile(cupH, cupHw), [0, cupH * 0.5], cupR, HATCH * 0.45, 0.55), { type: "dots", points: scales, radius: s * 0.007 }];
}
/** A pair of acorns on their long stalk (the pedunculate oak's). */
function acorns(rng, s, stage) {
    const stalk = s * 0.3;
    const shapes = [line([[0, 0], [rng.sym(s * 0.03), stalk * 0.5], [0, stalk]], s * 0.022)];
    for (const sd of [-1, 1])
        shapes.push(...acorn(s, stage).map(shape => turnShape(shape, sd * rng.range(0.4, 0.7), [0, stalk])));
    return shapes;
}
/**
 * The oak's ink: a main stem is a young trunk, its bark shaded on the far side and fissured, every fissure
 * keyed to its distance from the foot; a branch is a plain twig.
 */
function barkInk(rng, points, width, main) {
    const outline = ribbon(points, width);
    const step = 0.15;
    const { p, at } = resample(points, step);
    if (!main || p.length < 3)
        return [{ type: "solid", outline }];
    const total = at[at.length - 1], nrm = normals(p);
    const off = (i, q) => {
        const h = width(at[i] / total) / 2;
        return [p[i][0] + nrm[i][0] * h * q, p[i][1] + nrm[i][1] * h * q];
    };
    const shadow = [...p.map((_, i) => off(i, 0.1)), ...p.map((_, i) => off(i, -1.9)).reverse()];
    const grain = [-0.9, -0.6, -0.3, 0, 0.3].map(q => p.map((_, i) => off(i, q)));
    const veins = [];
    for (let k = 0; (k + 1) * 0.3 < total; k += 1) {
        const present = rng.u(), q = rng.range(-0.8, 0.8), span = rng.int(2, 3);
        const i0 = Math.round(k * 0.3 / step);
        if (present < 0.6 && i0 + span < p.length)
            veins.push(Array.from({ length: span + 1 }, (_, j) => off(i0 + j, q + 0.08 * Math.sin(j * 2 + k))));
    }
    return [{ type: "body", outline, shadow: [shadow], grain, veins, weight: 0.7 }];
}
/** The ground habit's plant for the five fungi; null for the others, which grow as plants either way. */
function groundHabit(mode, size, cluster) {
    switch (mode) {
        case "gilled":
        case "morel":
        case "puffball": {
            const draw = specimen(mode, cluster);
            return {
                id: "cryptogame",
                stems: { count: 3, amplitude: 0.15, lambda: [3, 5], width: 0.03, tops: [0.86, 0.7, 0.54] },
                foot: fruitingFoot(mode, size, cluster),
                stemInk: threadInk,
                basal: null,
                nodes: { every: [1.4, 2.2], length: () => 0.95, angle: [35, 70], below: 0.92 },
                leafProxy: 0.3,
                leaf: (rng, length, bend) => hyphalFan(rng, length, bend, 3),
                leaflet: (rng, length, bend) => hyphalFan(rng, length, bend, 2),
                // The growth loop stands the first cord's terminal upright at the largest size (at most 0.27 of the
                // column's width) and gives the others, which lean with their cords, at most 0.85 of it: those end
                // in a fan of growing hyphae instead of a clump that would tip over.
                terminal: { size: [1.3 * size, 1.5 * size], r: s => 0.55 * s, off: () => 0,
                    draw: (rng, s, stage) => s > Math.min(1.3 * size, 1.6) ? draw(rng, s, stage) : hyphalFan(rng, s * 0.8, rng.sym(0.2), 3) },
                motifs: [
                    { name: "fruit", w: 3, smin: 0.85 * size, smax: 1.17 * size, max: 7, hard: true, layer: LAYER.bloom, upright: 6, staged: true, r: s => 0.55 * s, off: s => 0.5 * s, draw },
                    { name: "mycelium", w: 2, smin: 0.8, smax: 1.4, max: 12, hard: true, layer: LAYER.leaf, upright: 0.6, r: s => 0.32 * s, off: s => 0.35 * s, draw: (rng, s) => hyphalFan(rng, s, rng.sym(0.2), 3) },
                ],
            };
        }
        case "bracket": {
            const draw = (rng, s, stage) => brackets(rng, s, stage, cluster);
            const tuft = (rng, length, bend) => rng.chance(0.55) ? pinna(rng, length, bend, false) : grassTuft(rng, length * 0.6);
            // The snag is the whole garden: no stems, only young ferns and grass about its foot.
            return {
                id: "cryptogame",
                stems: { count: 0, amplitude: 0, lambda: [3, 5], width: 0.03, tops: [] },
                foot: snagFoot(size, cluster),
                basal: { count: [7, 9], length: [0.8, 1.3] },
                nodes: { every: [1, 1], length: () => 1, angle: [40, 60], below: 1 },
                leafProxy: 0.3,
                leaf: tuft,
                leaflet: tuft,
                terminal: { size: [1.3 * size, 1.5 * size], r: s => 0.55 * s, off: () => 0, draw },
                motifs: [{ name: "fruit", w: 3, smin: 0.85, smax: 1.17, max: 6, hard: true, layer: LAYER.bloom, upright: 1.8, staged: true, r: s => 0.55 * s, off: s => 0.5 * s, draw }],
            };
        }
        case "truffle": return {
            id: "cryptogame",
            stems: { count: 2, amplitude: 0.08, lambda: [5, 8], width: 0.2, tops: [0.8, 0.62] },
            foot: truffleFoot(size, cluster),
            stemInk: barkInk,
            basal: null,
            nodes: { every: [0.6, 0.95], length: h => lerp(1.6, 1.0, h), angle: [40, 65], below: 0.97 },
            leafProxy: 0.3,
            leaf: oakLeaf,
            leaflet: (rng, length, bend) => oakLeaf(rng, length * 0.8, bend),
            terminal: { size: [1.1, 1.3], r: s => 0.42 * s, off: () => 0, draw: acorns },
            motifs: [
                { name: "acorn", w: 3, smin: 0.8, smax: 1.1, max: 5, hard: true, layer: LAYER.bloom, upright: 0.3, staged: true, r: s => 0.42 * s, off: s => 0.4 * s, draw: acorns },
                { name: "oak leaf", w: 2, smin: 0.9, smax: 1.5, max: 14, hard: true, layer: LAYER.leaf, upright: 0.5, r: s => 0.3 * s, off: s => 0.45 * s, draw: (rng, s) => oakLeaf(rng, s, rng.sym(0.15)) },
            ],
        };
        default: return null;
    }
}
const cords = (tops) => ({ count: tops.length, amplitude: 0.17, lambda: [3, 5], width: 0.03, tops });
function modeOf(name, size, cluster) {
    const moss = { name: "moss", smin: 0.9, smax: 1.5, r: 0.35, draw: (rng, s) => mossTuft(rng, s) };
    const fungus = (draw, r, off) => ({
        stems: cords([0.9, 0.72, 0.52]), nodes: { every: [1.6, 2.4], length: () => 1.0, angle: [35, 65], below: 0.9 }, leafProxy: 0.32,
        leaf: litter, leaflet: (rng, length) => grassTuft(rng, length), terminal: [1.3 * size, 1.5 * size], draw, r, off, upright: 1.6, max: 9,
        foliage: { name: "litter", smin: 0.8, smax: 1.5, r: 0.38, draw: (rng, s) => litter(rng, s, rng.sym(0.2)) },
    });
    const group = (one) => (rng, s, stage) => {
        const shapes = [];
        for (let k = cluster - 1; k >= 0; k -= 1) {
            const x = k === 0 ? 0 : (k % 2 ? -1 : 1) * s * 0.42, scale = k === 0 ? 1 : 0.62;
            if (k > 0)
                shapes.push(line([[0, 0], [x * 0.5, s * 0.03], [x, 0]], s * 0.012));
            shapes.push(...one(rng, s * scale, k === 0 ? stage : stage === "seed" ? "bloom" : "bud").map(shape => turnShape(shape, -x * 0.3, [x, 0])));
        }
        return shapes;
    };
    switch (name) {
        case "morel": return fungus(group(morel), 0.42, 0.45);
        case "puffball": return fungus((rng, s, stage) => puffballs(rng, s, stage, cluster), 0.42, 0.35);
        case "bracket": return {
            stems: { count: 2, amplitude: 0.05, lambda: [6, 9], width: 0.17, tops: [0.88, 0.7] },
            nodes: { every: [1.3, 2.0], length: () => 1.1, angle: [35, 60], below: 0.95 }, leafProxy: 0.36,
            leaf: (rng, length) => mossTuft(rng, length * 0.8), leaflet: (rng, length, bend) => mossShoot(rng, length, bend), terminal: [1.3 * size, 1.5 * size],
            draw: (rng, s, stage) => brackets(rng, s, stage, cluster), r: 0.55, off: 0.5, upright: 1.8, max: 6, foliage: moss,
        };
        case "truffle": return {
            stems: { count: 3, amplitude: 0.22, lambda: [3, 5], width: 0.07, tops: [0.88, 0.7, 0.55] },
            nodes: { every: [0.9, 1.4], length: h => lerp(1.4, 0.9, h), angle: [35, 65], below: 0.95 }, leafProxy: 0.25,
            leaf: rootlet, leaflet: rootlet, terminal: [1.2 * size, 1.4 * size], draw: truffle, r: 0.4, off: 0.4, upright: -0.4, max: 8,
            foliage: { name: "rootlet", smin: 0.9, smax: 1.6, r: 0.3, draw: (rng, s) => rootlet(rng, s, rng.sym(0.3)) },
        };
        case "moss": return {
            stems: { count: 3, amplitude: 0.1, lambda: [5, 8], width: 0.02, tops: [0.9, 0.76, 0.62] },
            // The cushion: leafy shoots fanning from the foot, under the setae that lift the capsules.
            basal: { count: [10, 14], length: [0.9, 1.6] },
            nodes: { every: [0.6, 0.9], length: () => 0.8, angle: [25, 50], below: 0.3 }, leafProxy: 0.3,
            leaf: mossShoot, leaflet: mossShoot, terminal: [1.4 * size, 1.7 * size],
            draw: capsule, r: 0.28, off: 0.55, upright: 1.6, max: 16, foliage: { name: "tuft", smin: 0.9, smax: 1.5, r: 0.35, draw: (rng, s) => mossTuft(rng, s) },
        };
        case "lichen": return {
            stems: { count: 3, amplitude: 0.13, lambda: [4, 7], width: 0.07, tops: [0.9, 0.72, 0.56] },
            nodes: { every: [0.9, 1.4], length: () => 0.9, angle: [40, 70], below: 0.95 }, leafProxy: 0.35,
            leaf: (rng, length) => lichenPatch(rng, length), leaflet: (rng, length) => lichenPatch(rng, length), terminal: [1.2 * size, 1.4 * size],
            draw: lichenTwig, r: 0.45, off: 0.5, upright: 0.9, max: 8, foliage: { name: "lobes", smin: 0.8, smax: 1.3, r: 0.3, draw: (rng, s) => lichenPatch(rng, s) },
        };
        case "fern": return {
            stems: { count: 3, amplitude: 0.07, lambda: [6, 10], width: 0.045, tops: [0.92, 0.78, 0.62] },
            nodes: { every: [0.5, 0.7], length: h => lerp(2.1, 0.8, h ** 1.3), angle: [55, 72], below: 1 }, leafProxy: 0.16,
            leaf: (rng, length, bend) => pinna(rng, length, bend, false), leaflet: (rng, length, bend) => pinna(rng, length, bend, false), terminal: [1.2 * size, 1.4 * size],
            draw: crozier, r: 0.45, off: 0.5, upright: 1.0, max: 6, foliage: { name: "pinna", smin: 1.0, smax: 1.8, r: 0.2, draw: (rng, s) => pinna(rng, s, rng.sym(0.15), false) },
        };
        case "maidenhair": return {
            stems: { count: 3, amplitude: 0.13, lambda: [4, 7], width: 0.022, tops: [0.88, 0.72, 0.56] },
            nodes: { every: [0.7, 1.1], length: h => lerp(1.7, 1.0, h), angle: [40, 65], below: 0.95 }, leafProxy: 0.26,
            leaf: (rng, length, bend) => maidenFrond(rng, length, bend, false), leaflet: (rng, length) => fan(rng, [0, 0], 0, length * 0.5, false), terminal: [1.3 * size, 1.5 * size],
            draw: fans, r: 0.42, off: 0.5, upright: 0.8, max: 8, foliage: { name: "frond", smin: 1.0, smax: 1.7, r: 0.3, draw: (rng, s) => maidenFrond(rng, s, rng.sym(0.2), false) },
        };
        case "horsetail": {
            const angle = 40;
            return {
                stems: { count: 3, amplitude: 0.025, lambda: [8, 12], width: 0.05, tops: [0.9, 0.78, 0.62] },
                // The angle is fixed so that a node's whorl can turn itself back square to its stem.
                nodes: { every: [0.8, 1.1], length: h => lerp(1.5, 0.8, h), angle: [angle, angle], below: 0.97 }, leafProxy: 0.2,
                leaf: (rng, length, bend) => whorl(rng, length).map(shape => turnShape(shape, -(bend >= 0 ? 1 : -1) * angle * DEG)),
                leaflet: (rng, length) => [line(sample(v => [0, length * v], 3), 0.011), { type: "dots", points: [[0, length * 0.35], [0, length * 0.7]], radius: 0.012 }],
                terminal: [1.1 * size, 1.3 * size], draw: (rng, s, stage) => [line([[0, 0], [0, s * 0.12]], s * 0.05), sheath([0, s * 0.04], s * 0.05, s * 0.08), ...strobilus(rng, s, stage, [0, s * 0.12])],
                fruit: fertileShoot, r: 0.4, off: 0.5, upright: 1.6, max: 6, foliage: { name: "whorl", smin: 1.0, smax: 1.6, r: 0.4, draw: sprig },
            };
        }
        default: return fungus(group(agaric), 0.48, 0.42);
    }
}
export const form = {
    id: "cryptogame",
    name: "cryptogame",
    doc: "Fungi, mosses, lichens, ferns and horsetails, each in its own mode, shedding spores at the end of the day; fungi fruit from soil and dead wood over their mycelium, or on a stem like a plant.",
    variants: {
        mode: { doc: "What is drawn: gilled cap, honeycomb morel, puffball, bracket on a stub, truffle on roots, moss cushion with capsules, foliose lichen, fern frond, maidenhair fans, or jointed horsetail", default: "gilled",
            values: ["gilled", "morel", "puffball", "bracket", "truffle", "moss", "lichen", "fern", "maidenhair", "horsetail"] },
        habit: { doc: "How a fungus grows: from soil, litter and dead wood over threads of mycelium (ground: a bracket up a dead birch, puffballs on a fallen log, the truffle under the soil by its oak), or at branch tips like a plant (plant). Mosses, lichen, ferns, maidenhair and horsetail grow as plants either way", default: "ground",
            values: ["ground", "plant"] },
        size: { doc: "Size of the fruit body, capsule, rosette or cone relative to the mode's usual", default: 1, range: [0.6, 1.5] },
        cluster: { doc: "Fruit bodies grouped in one clump: mushrooms, puffballs, brackets on a stub; on the ground, the brackets up the snag and the truffles in the soil grow with it too (fungi only)", default: 2, range: [1, 3] },
    },
    examples: [
        { name: "champignon", variant: { habit: "plant" } },
        { name: "champignon, ground", variant: {} },
        { name: "morille", variant: { mode: "morel", cluster: 1, habit: "plant" } },
        { name: "morille, ground", variant: { mode: "morel", cluster: 1 } },
        { name: "lycoperdon", variant: { mode: "puffball", cluster: 3, habit: "plant" } },
        { name: "lycoperdon, ground", variant: { mode: "puffball", cluster: 3 } },
        { name: "amadouvier", variant: { mode: "bracket", cluster: 3, size: 1.2, habit: "plant" } },
        { name: "amadouvier, ground", variant: { mode: "bracket", cluster: 3, size: 1.2 } },
        { name: "truffe", variant: { mode: "truffle", habit: "plant" } },
        { name: "truffe, ground", variant: { mode: "truffle" } },
        { name: "mousse", variant: { mode: "moss" } },
        { name: "lichen", variant: { mode: "lichen" } },
        { name: "fougère", variant: { mode: "fern" } },
        { name: "capillaire", variant: { mode: "maidenhair" } },
        { name: "prêle", variant: { mode: "horsetail" } },
    ],
    build(variant) {
        const size = numberOf(variant, "size"), cluster = Math.round(numberOf(variant, "cluster"));
        const ground = textOf(variant, "habit") === "ground" ? groundHabit(textOf(variant, "mode"), size, cluster) : null;
        if (ground)
            return ground;
        const mode = modeOf(textOf(variant, "mode"), size, cluster);
        const smin = mode.terminal[0] * 0.65, smax = mode.terminal[0] * 0.9;
        return {
            id: "cryptogame",
            stems: mode.stems,
            basal: mode.basal ?? null,
            nodes: mode.nodes,
            leafProxy: mode.leafProxy,
            leaf: mode.leaf,
            leaflet: mode.leaflet,
            terminal: { size: mode.terminal, r: s => mode.r * s, off: () => 0, draw: mode.draw },
            motifs: [
                { name: "fruit", w: 3, smin, smax, max: mode.max, hard: true, layer: LAYER.bloom, upright: mode.upright, staged: true,
                    r: s => mode.r * s, off: s => mode.off * s, draw: mode.fruit ?? mode.draw },
                { name: mode.foliage.name, w: 2, smin: mode.foliage.smin, smax: mode.foliage.smax, max: 14, hard: true, layer: LAYER.leaf, upright: 0.8,
                    r: s => mode.foliage.r * s, off: s => 0.3 * s, draw: (rng, s) => mode.foliage.draw(rng, s, "bloom") },
            ],
        };
    },
};
