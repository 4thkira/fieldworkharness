// Upright stems of small flowers on an axis: a dense spike (lavande, bouillon-blanc), a raceme opening
// from the bottom up (giroflée, lupin), interrupted whorls (sauge, bétoine), a round head (trèfle, thym),
// a branched panicle (lilas, armoise), a coiled cyme (consoude) or a hanging tassel (amarante). The
// corolla is tubular, lipped, pea-shaped, cross-shaped, a bell, a star, spurred or a mere dot; at the
// end of the day each flower becomes its fruit: a calyx of nutlets, a pod, a disc, a berry, a capsule.
import { LAYER, flagOf, numberOf, textOf } from "../form.js";
import { bezier3, blade, lerp, sample, unit } from "../geometry.js";
import { berry, circle, HATCH, line, pinnateLeaf, side, simpleLeaf, turnShape } from "../kit.js";
import { bladeBody, roundBody } from "../shapes.js";
/** A paper-filled form with only its outline: florets too small to hatch. */
const plain = (outline, weight = 0.3, veins = []) => ({ type: "body", outline, shadow: [], grain: [], veins, weight });
const rot = ([x, y], a) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
const add = (p, d, k) => [p[0] + d[0] * k, p[1] + d[1] * k];
/** A small blade from `from` toward `to`, bowed sideways by `bow`, as an outline. */
function petal(from, to, half, bow = 0, shape = v => Math.sin(Math.PI * v) ** 0.7, n = 6) {
    const d = unit(to[0] - from[0], to[1] - from[1]), length = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const spine = (v) => [from[0] + d[0] * length * v - d[1] * bow * length * v * (1 - v), from[1] + d[1] * length * v + d[0] * bow * length * v * (1 - v)];
    const left = [], right = [];
    for (let k = 0; k <= n; k += 1) {
        const v = k / n, [x, y] = spine(v), w = half * shape(v);
        left.push([x - d[1] * w, y + d[0] * w]);
        right.push([x + d[1] * w, y - d[0] * w]);
    }
    return [...left, ...right.slice(1, -1).reverse()];
}
const obovate = (v) => Math.sin(Math.PI * Math.min(1, 0.1 + v * 0.95)) ** 0.5 * (0.35 + 0.65 * v);
/** A flat corolla of rounded lobes seen a little from the side, as one outline: four for a cross, five for a star. */
function face(rng, c, r, lobes) {
    const tilt = rng.range(0.5, 0.75), turn0 = rng.range(0, Math.PI);
    return sample(v => {
        const a = v * Math.PI * 2;
        const reach = r * (0.3 + 0.7 * Math.abs(Math.cos((a - turn0) * lobes / 2)) ** 0.5);
        return [c[0] + Math.cos(a) * reach, c[1] + Math.sin(a) * reach * tilt + r * 0.15];
    }, lobes * 5).slice(0, -1);
}
// ---------------------------------------------------------------- corollas, drawn opening toward +y; `up` is the side the upper lip takes
function corolla(rng, kind, f, up) {
    const calyx = line([[0, 0], [0, f * 0.28]], f * 0.11);
    switch (kind) {
        case "tube": {
            // A long narrow tube flaring into a small limb (tabac, dentelaire, mézéréon).
            const tube = plain(petal([0, f * 0.15], [0, f * 1.05], f * 0.08, 0, v => 0.55 + 0.45 * v ** 2));
            const lobes = [-1, 1].map(sd => plain(petal([0, f * 1.02], add([0, f * 1.02], rot([0, 1], sd * 1.25), f * 0.26), f * 0.1)));
            return [calyx, tube, ...lobes];
        }
        case "lipped": {
            // A short tube opening into a hooded upper lip and a broad lower lip (sauge, lavande, bétoine).
            const tube = line([[0, f * 0.15], [0, f * 0.6]], f * 0.13);
            const hood = plain(petal([0, f * 0.55], [-up * f * 0.06, f * 1.05], f * 0.13, up * 0.5, obovate), 0.35);
            const lip = plain(petal([0, f * 0.55], [up * f * 0.38, f * 0.78], f * 0.14, -up * 0.3, obovate), 0.3);
            return [calyx, tube, lip, hood];
        }
        case "pea": {
            // The standard raised at the back, the keel thrust forward like a boat's prow (lupin, sainfoin, ajonc).
            const keel = plain(petal([0, f * 0.1], [-up * f * 0.2, f * 0.85], f * 0.15, up * 0.35), 0.4);
            const banner = plain(petal([0, f * 0.12], [up * f * 0.42, f * 0.72], f * 0.3, -up * 0.25, obovate, 8), 0.3, [sample(v => [up * f * 0.42 * v * 0.8, f * 0.12 + f * 0.6 * v * 0.8], 3)]);
            return [calyx, banner, keel];
        }
        case "cross": {
            // Four petals in a cross, seen a little from the side (giroflée, colza, véronique, lilas).
            const c = [0, f * 0.3];
            const shapes = [line([[0, 0], c], f * 0.06), plain(face(rng, c, f * 0.5, 4), 0.25)];
            if (rng.chance(0.35))
                shapes.push({ type: "dots", points: [[c[0], c[1] + f * 0.07]], radius: f * 0.06, tone: "accent" });
            return shapes;
        }
        case "bell": {
            // A hanging bell with a scalloped mouth (consoude, bruyère, pulmonaire).
            const halfWidth = (v) => f * (0.09 + 0.17 * v ** 1.4 + (v > 0.85 ? 0.08 * (v - 0.85) / 0.15 : 0));
            const outline = petal([0, f * 0.05], [0, f * 0.8], 1, 0, halfWidth, 7);
            return [plain(outline, 0.4, [[[0, f * 0.2], [f * 0.04, f * 0.7]]]), line([[-f * 0.2, f * 0.8], [-f * 0.05, f * 0.84], [f * 0.1, f * 0.8], [f * 0.24, f * 0.82]], f * 0.025)];
        }
        case "star": {
            // Five lobes spread flat on a short tube (buglosse, héliotrope, bouillon-blanc).
            const c = [0, f * 0.28];
            return [line([[0, 0], c], f * 0.07), plain(face(rng, c, f * 0.45, 5), 0.25), { type: "dots", points: [[c[0], c[1] + f * 0.07]], radius: f * 0.05 }];
        }
        case "spur": {
            // A narrow flower held sideways, a spur curling back behind and a lip in front (balsamine, fumeterre).
            const body = plain(petal([0, f * 0.05], [0, f * 0.95], f * 0.13, 0, v => Math.sin(Math.PI * Math.min(1, 0.2 + v * 0.85)) ** 0.5), 0.35);
            const spur = line(sample(bezier3([0, f * 0.15], [up * f * 0.05, -f * 0.12], [up * f * 0.22, -f * 0.2], [up * f * 0.28, -f * 0.05]), 6), f * 0.06);
            const lip = plain(petal([0, f * 0.85], [-up * f * 0.25, f * 1.05], f * 0.11, 0, obovate), 0.3);
            return [spur, body, lip];
        }
        default:
            // Tiny florets read as a dot each (amarante, armoise, caille-lait).
            return [{ type: "dots", points: [[0, f * 0.2]], radius: f * 0.2 }];
    }
}
function bud(kind, f) {
    if (kind === "tiny")
        return [{ type: "dots", points: [[0, f * 0.15]], radius: f * 0.13 }];
    const length = kind === "tube" ? f * 0.75 : kind === "pea" ? f * 0.5 : f * 0.42;
    return [plain(petal([0, 0], [0, length], f * (kind === "tube" ? 0.08 : 0.13), 0, v => Math.sin(Math.PI * Math.min(1, 0.15 + v * 0.9)) ** 0.6), 0.55)];
}
// ---------------------------------------------------------------- fruits, drawn from the stalk toward +y
/** One fruit; only some are `hatched`, the rest left in paper with their seams, so a laden raceme stays light. */
function fruit(rng, kind, f, hatched) {
    switch (kind) {
        case "silique": {
            // A long narrow pod with a seam and a short beak (giroflée, colza, sénevé).
            const length = f * rng.range(2.4, 3.1), bow = rng.sym(0.06);
            const outline = petal([0, 0], [0, length], f * 0.07, bow, v => Math.min(1, v * 8) * (v > 0.9 ? (1 - v) * 10 : 1) ** 0.6, 16);
            return [plain(outline, 0.5, [[[0, length * 0.08], [-bow * length * 0.25, length * 0.5], [0, length * 0.88]]]), line([[0, length], [0, length + f * 0.25]], f * 0.03)];
        }
        case "disc": {
            // Thlaspi's round winged pod, notched at the top, the seeds showing either side of the partition.
            const c = [0, f * 0.55], r = f * 0.42;
            const outline = sample(v => {
                const a = Math.PI / 2 + v * Math.PI * 2;
                const notch = 1 - 0.35 * Math.exp(-(Math.min(a - Math.PI / 2, Math.PI * 2.5 - a) ** 2) * 40);
                return [c[0] + Math.cos(a) * r * notch, c[1] + Math.sin(a) * r * notch];
            }, 24).slice(0, -1);
            return [line([[0, 0], [0, f * 0.15]], f * 0.04), plain(outline, 0.3, [[[c[0], c[1] - r * 0.85], [c[0], c[1] + r * 0.55]]]),
                { type: "dots", points: [[-r * 0.3, c[1]], [r * 0.3, c[1] + r * 0.1]], radius: f * 0.06 }];
        }
        case "pendant": {
            // Guède's flattened pod hanging on its thread, dark when ripe.
            const spine = (v) => [0, f * 0.2 + f * 1.25 * v];
            const halfWidth = (v) => f * 0.24 * Math.sin(Math.PI * Math.min(1, 0.05 + v * 0.95)) ** 0.6 * (0.45 + 0.55 * v);
            const pod = hatched
                ? bladeBody({ spine, halfWidth, shade: side(rng), spacing: HATCH * 0.6, grain: "across", weight: 0.85, midrib: true, samples: 10 }, rng)
                : plain(petal(spine(0), spine(1), 1, 0, halfWidth), 0.85, [[spine(0.1), spine(0.85)]]);
            return [line([[0, 0], [0, f * 0.22]], f * 0.025), pod];
        }
        case "legume": {
            // A pea pod, the seeds swelling its edge (lupin, sainfoin, ajonc).
            const length = f * rng.range(1.6, 2.0), bend = side(rng) * 0.25;
            const spine = (v) => [bend * length * v * v, length * v];
            const halfWidth = (v) => f * 0.14 * Math.min(1, v * 6) * Math.min(1, (1 - v) * 5);
            const edge = (v, s) => s === 1 ? f * 0.035 * Math.abs(Math.sin(v * Math.PI * 4)) : 0;
            if (hatched)
                return [bladeBody({ spine, halfWidth, edge, shade: -1, spacing: HATCH * 0.6, grain: "across", weight: 0.55, midrib: true, samples: 14 }, rng)];
            const { outline, centre } = blade(spine, 12, halfWidth, halfWidth, edge);
            return [plain(outline, 0.55, [centre.slice(1, 11)])];
        }
        case "spiral": {
            // Luzerne's pod coiled like a small snail shell.
            const c = [0, f * 0.4];
            return [line([[0, 0], [0, f * 0.12]], f * 0.04), line(sample(v => {
                    const a = -Math.PI / 2 + v * Math.PI * 4.5, r = f * (0.3 - 0.2 * v);
                    return [c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r];
                }, 28), f * 0.07)];
        }
        case "berry":
        case "redberry": {
            // Round berries: black (troène), solid ink unless modelled; red (mézéréon) in rubric.
            const c = [0, f * 0.42], stalk = line([[0, 0], [0, f * 0.15]], f * 0.04);
            if (kind === "redberry")
                return [stalk, { ...plain(circle(c, f * 0.28, f * 0.28, 10)), tone: "accent" }];
            return [stalk, hatched ? berry(c, f * 0.28, 0.85) : { type: "dots", points: [c], radius: f * 0.28 }];
        }
        case "capsule": {
            // An ovoid capsule in its calyx, the seam showing (balsamine, tabac, gentiane, véronique).
            const c = [0, f * 0.48], outline = circle(c, f * 0.2, f * 0.32, 10), seam = [[0, f * 0.18], [f * 0.04, f * 0.48], [0, f * 0.79]];
            const body = hatched ? roundBody(outline, c, f * 0.26, HATCH * 0.5, 0.6) : plain(outline, 0.6);
            body.veins = [seam];
            return [line([[-f * 0.12, f * 0.25], [0, f * 0.05], [f * 0.12, f * 0.25]], f * 0.03), body];
        }
        case "dry":
            // A dried floret or seed head: a small dark mark.
            return [{ type: "dots", points: [[0, f * 0.2]], radius: f * 0.16 }];
        default: {
            // Nutlets: the calyx stays, an open cup with a dark seed in its throat (sauge, thym, consoude).
            const cup = plain(petal([0, 0], [0, f * 0.48], f * 0.12, 0, v => 0.45 + 0.55 * v ** 0.7), 0.5);
            return [cup, line([[-f * 0.11, f * 0.46], [-f * 0.15, f * 0.6]], f * 0.025), line([[f * 0.11, f * 0.46], [f * 0.15, f * 0.6]], f * 0.025),
                { type: "dots", points: [[0, f * 0.38]], radius: f * 0.06 }];
        }
    }
}
/** One flower placed at `at`, opening along `dir`, in its state. */
function flower(rng, spec, at, dir, f, state) {
    const up = dir[0] < 0 ? 1 : -1;
    const shapes = state === "bud" ? bud(spec.corolla, f) : state === "open" ? corolla(rng, spec.corolla, f, up) : fruit(rng, spec.fruit, f, rng.chance(0.3));
    const angle = Math.atan2(dir[1], dir[0]) - Math.PI / 2;
    return shapes.map(shape => turnShape(shape, angle, at));
}
/** How a flower at rank u along its axis (0 at the bottom) shows at a stage: racemes open from the bottom up. */
function stateAt(stage, u) {
    if (stage === "bud")
        return "bud";
    if (stage === "bloom")
        return u > 0.72 ? "bud" : "open";
    return u > 0.82 ? "open" : "fruit";
}
/** The direction a flower or fruit takes off its axis: pods ascend, bells and pendants hang. */
function heading(spec, axisDir, sd, state, angle) {
    if (state === "fruit" && spec.fruit === "pendant")
        return unit(sd * 0.3, -1);
    if (state === "fruit" && spec.fruit === "silique")
        return rot(axisDir, sd * angle * 0.55);
    if (state === "open" && spec.corolla === "bell")
        return unit(rot(axisDir, sd * angle)[0] * 0.5, -0.85);
    return rot(axisDir, sd * angle);
}
// ---------------------------------------------------------------- inflorescences, origin at the base, axis along +y
function axisLine(length, lean, n = 12) {
    return sample(v => [lean * length * v * v, length * v], n);
}
/** The point and unit tangent at fraction v of a sampled axis. */
function along(axis, v) {
    const n = axis.length - 1;
    const f = Math.min(n - 1e-6, Math.max(0, v * n));
    const i = Math.floor(f), t = f - i;
    const a = axis[i], b = axis[i + 1];
    return { at: [lerp(a[0], b[0], t), lerp(a[1], b[1], t)], dir: unit(b[0] - a[0], b[1] - a[1]) };
}
/** A raceme or a spike: flowers up an axis, on stalks or sessile, alternating sides, opening from the bottom. */
function raceme(rng, s, stage, spec, sessile) {
    const peduncle = s * 0.18, L = s * 0.72 * spec.length * (stage === "bud" ? 0.55 : 1);
    const axis = axisLine(peduncle + L, rng.sym(0.12));
    const v0 = peduncle / (peduncle + L);
    const f = s * 0.1 * spec.size;
    const count = Math.max(5, Math.min(sessile ? 20 : 16, Math.round((sessile ? 18 : 11) * spec.flowers * spec.length)));
    const shapes = [line(axis, s * 0.016)];
    const flowers = [];
    for (let k = 0; k < count; k += 1) {
        const u = k / (count - 1);
        const { at, dir } = along(axis, v0 + (1 - v0) * (0.02 + 0.96 * u));
        const sd = k % 2 === 0 ? 1 : -1;
        const state = stateAt(stage, u);
        // Upper flowers are younger and smaller; the tip closes into a point of buds.
        const scale = state === "bud" ? 0.8 - 0.35 * u : 1 - 0.25 * u;
        const angle = (sessile ? 0.55 : 0.95) * (1 - 0.35 * u) + rng.sym(0.1);
        const d = heading(spec, dir, sd, state, angle);
        const stalk = sessile ? 0 : s * 0.055 * (1 - 0.4 * u) * (state === "fruit" && spec.fruit === "silique" ? 0.7 : 1);
        const from = add(at, rot(dir, sd * Math.min(1.3, angle * 1.2)), stalk);
        if (stalk > 0)
            flowers.push(line([at, from], s * 0.005));
        // A frontal flower now and then fills a spike's face.
        if (sessile && k % 4 === 1 && state !== "bud")
            flowers.push(...flower(rng, spec, add(at, [-dir[1], dir[0]], sd * f * 0.1), rot(dir, sd * 0.25), f * 0.8 * scale, state));
        flowers.push(...flower(rng, spec, from, d, f * scale, state));
    }
    // Draw from the top down, so lower flowers sit over the stalks of those above.
    shapes.push(...flowers.reverse());
    return shapes;
}
/** Interrupted whorls: tiers of flowers round the stem, wider apart toward the bottom, each over a pair of bracts. */
function whorls(rng, s, stage, spec) {
    const tiers = Math.max(3, Math.round(4.5 * spec.length));
    const L = s * 0.8 * spec.length * (stage === "bud" ? 0.7 : 1);
    const axis = axisLine(L, rng.sym(0.1));
    const f = s * 0.1 * spec.size;
    const shapes = [line(axis, s * 0.016)];
    const per = Math.max(1, Math.round(2 * spec.flowers));
    for (let t = 0; t < tiers; t += 1) {
        const u = t / (tiers - 1);
        // Tiers crowd together toward the tip.
        const v = 0.2 + 0.78 * (1 - (1 - u) ** 1.3);
        const { at, dir } = along(axis, v);
        const state = stateAt(stage, u);
        const tier = [];
        for (const sd of [1, -1]) {
            const bract = leaflet(rng, f * 0.6, 0.3, false);
            tier.push(turnShape(bract, Math.atan2(dir[1], dir[0]) - Math.PI / 2 + sd * 1.25, at));
            for (let k = 0; k < per; k += 1) {
                const a = 0.55 + 0.7 * (k + 0.5) / per + rng.sym(0.08);
                tier.push(...flower(rng, spec, at, heading(spec, dir, sd, state, a), f * (state === "bud" ? 0.8 : 1), state));
            }
        }
        // One facing the viewer sits in the middle of the tier.
        tier.push(...flower(rng, spec, at, rot(dir, rng.sym(0.2)), f * 0.8, state));
        shapes.push(...tier);
    }
    return shapes;
}
/** A round head of florets at the top of a bare stalk (trèfle, thym, pimprenelle). */
function head(rng, s, stage, spec) {
    const stalk = s * 0.42;
    const R = s * 0.2 * spec.size * (stage === "bud" ? 0.7 : 1) * spec.length ** 0.4;
    const c = [rng.sym(0.03) * s, stalk + R * 0.9];
    const f = s * 0.1 * spec.size;
    const shapes = [line([[0, 0], [c[0] * 0.5, stalk * 0.6], c], s * 0.016)];
    // Two small leaves cup the head from below.
    for (const sd of [1, -1])
        shapes.push(...simpleLeaf(rng, s * 0.14, sd * 0.1, 0.3).map(shape => turnShape(shape, sd * 1.1, [c[0] * 0.5, stalk * 0.9])));
    const count = Math.max(8, Math.round(16 * spec.flowers));
    // The head's mass behind its florets, darker as it dries.
    const core = roundBody(circle(c, R * 0.62, R * 0.55, 16), c, R * 0.6, HATCH * 0.6, stage === "seed" ? 0.8 : 0.4);
    const florets = [core];
    for (let k = 0; k < count; k += 1) {
        // Florets point out from the head's centre, the back ones hidden behind the front.
        const a = Math.PI / 2 + (k / count - 0.5) * Math.PI * 1.9 + rng.sym(0.12);
        const r = R * rng.range(0.45, 0.9);
        const at = [c[0] + Math.cos(a) * r * 0.6, c[1] + Math.sin(a) * r * 0.5];
        const state = stage === "bud" ? "bud" : stage === "seed" ? "fruit" : rng.chance(0.15) ? "bud" : "open";
        florets.push(...flower(rng, spec, at, [Math.cos(a), Math.sin(a)], f * 0.85, state));
    }
    shapes.push(...florets);
    if (spec.corolla === "tiny" && stage === "bloom") {
        // Pimprenelle's tufted stigmas, rubric on the head.
        shapes.push({ type: "dots", points: Array.from({ length: 6 }, () => [c[0] + rng.sym(R * 0.7), c[1] + R * rng.range(0.3, 0.9)]), radius: f * 0.12, tone: "accent" });
    }
    return shapes;
}
/** A branched panicle: side branches shortening upward, each carrying its own small flowers (lilas, armoise). */
function panicle(rng, s, stage, spec) {
    const L = s * 0.82 * spec.length * (stage === "bud" ? 0.75 : 1);
    const axis = axisLine(L, rng.sym(0.1));
    const f = s * 0.085 * spec.size;
    const shapes = [line(axis, s * 0.016)];
    const branches = Math.max(4, Math.min(8, Math.round(7 * spec.length)));
    const tiny = spec.corolla === "tiny";
    for (let b = 0; b < branches; b += 1) {
        const u = b / branches;
        const { at, dir } = along(axis, 0.25 + 0.7 * u);
        const sd = b % 2 === 0 ? 1 : -1;
        const length = s * 0.3 * (1 - 0.75 * u) * rng.range(0.85, 1.1);
        // Armoise and absinthe hang their tiny heads from arching branches.
        const droop = tiny ? 0.35 : 0;
        const d = rot(dir, sd * (0.7 + rng.sym(0.1)));
        const path = sample(t => [at[0] + d[0] * length * t, at[1] + d[1] * length * t - droop * length * t * t], 5);
        shapes.push(line(path, s * 0.007));
        const per = Math.max(2, Math.min(5, Math.round((tiny ? 5 : 4) * spec.flowers)));
        for (let k = 0; k < per; k += 1) {
            const t = 0.35 + 0.65 * (k + 0.5) / per;
            const { at: p, dir: q } = along(path, t);
            const ks = k % 2 === 0 ? 1 : -1;
            const state = stateAt(stage, u * 0.6 + t * 0.3);
            const out = tiny ? unit(q[0] * 0.3, -1) : rot(q, ks * 0.7);
            const from = add(p, rot(q, ks * 0.9), s * 0.02);
            shapes.push(line([p, from], s * 0.004));
            shapes.push(...flower(rng, spec, from, out, f, state));
        }
    }
    // A crowded tip of flowers caps the axis.
    const { at, dir } = along(axis, 1);
    for (let k = 0; k < 3; k += 1)
        shapes.push(...flower(rng, spec, at, rot(dir, (k - 1) * 0.6), f, stage === "seed" ? "fruit" : "bud"));
    return shapes;
}
/** A scorpioid cyme: branches that uncoil as they flower, buds tight in the curl, flowers on the outer side. */
function coil(rng, s, stage, spec) {
    const stalk = s * 0.3;
    const f = s * 0.1 * spec.size;
    const shapes = [line([[0, 0], [0, stalk]], s * 0.016)];
    const uncurl = stage === "bud" ? 0.2 : stage === "bloom" ? 0.55 : 0.9;
    const main = side(rng);
    for (const sd of [main, -main]) {
        // One branch leads; the other is shorter, as the cyme forks unequally.
        const length = s * (sd === main ? 0.6 : 0.38) * spec.length;
        // The curve's heading turns faster toward its tip, which stays curled like a crook until the day is old.
        const points = [[0, stalk]];
        let x = 0, y = stalk, a = sd * 0.25;
        const n = 18;
        for (let k = 0; k < n; k += 1) {
            const v = k / n;
            a += sd * (0.06 + (1 - uncurl) * 0.55 * v ** 2);
            x += Math.sin(a) * length / n;
            y += Math.cos(a) * length / n;
            points.push([x, y]);
        }
        shapes.push(line(points, s * 0.01));
        const count = Math.max(4, Math.round(7 * spec.flowers));
        for (let k = 0; k < count; k += 1) {
            const u = (k + 0.5) / count;
            const { at, dir } = along(points, u);
            const state = stage === "bud" ? "bud" : stage === "bloom" ? (u > 0.6 ? "bud" : "open") : (u > 0.75 ? "open" : "fruit");
            // Flowers sit on the outer (convex) side of the curl.
            shapes.push(...flower(rng, spec, at, heading(spec, dir, sd, state, 1.2), f * (state === "bud" ? 1 - 0.4 * u : 1), state));
        }
    }
    return shapes;
}
/** A hanging tassel: a thick rope of tiny flowers drooping from the stem tip (amarante). */
function tassel(rng, s, stage, spec) {
    const shapes = [];
    const ropes = stage === "bud" ? 1 : 3;
    for (let r = 0; r < ropes; r += 1) {
        const length = s * (r === 0 ? 1.25 : 0.75) * spec.length * (stage === "bud" ? 0.35 : 1);
        // Each rope leaves the stem outward and soon turns to hang straight down.
        const turn = stage === "bud" ? 0 : (r === 0 ? 2.1 : 1.9) * (stage === "seed" ? 1.05 : 1);
        const start = r === 0 ? [0, s * 0.25] : [0, s * (0.15 + 0.06 * r)];
        const sd = r === 0 ? side(rng) : r === 1 ? 1 : -1;
        const points = [start];
        let x = start[0], y = start[1];
        for (let k = 0; k < 20; k += 1) {
            const v = (k + 0.5) / 20, a = stage === "bud" ? sd * 0.2 * v : sd * (0.8 + turn * Math.min(1, v / 0.3));
            x += Math.sin(a) * length / 20;
            y += Math.cos(a) * length / 20;
            points.push([x, y]);
        }
        const width = s * 0.05 * spec.size * (stage === "seed" ? 1.15 : 1);
        const spine = (v) => along(points, v).at;
        shapes.push(bladeBody({ spine, halfWidth: v => width * Math.min(1, v * 6) * (1 - 0.6 * v), edge: v => width * 0.3 * Math.abs(Math.sin(v * 37)),
            shade: sd === 1 ? -1 : 1, spacing: HATCH * 0.6, grain: "across", weight: stage === "seed" ? 0.85 : 0.65, samples: 30 }, rng));
        if (stage === "seed")
            shapes.push({ type: "dots", points: Array.from({ length: 14 }, () => { const v = rng.range(0.1, 0.9); const { at, dir } = along(points, v); return add(at, [-dir[1], dir[0]], rng.sym(width * 0.6)); }), radius: s * 0.007 });
    }
    shapes.unshift(line([[0, 0], [0, s * 0.27]], s * 0.02));
    return shapes;
}
function inflorescence(rng, s, stage, spec) {
    switch (spec.inflorescence) {
        case "raceme": return raceme(rng, s, stage, spec, false);
        case "whorls": return whorls(rng, s, stage, spec);
        case "head": return head(rng, s, stage, spec);
        case "panicle": return panicle(rng, s, stage, spec);
        case "coil": return coil(rng, s, stage, spec);
        case "tassel": return tassel(rng, s, stage, spec);
        default: return raceme(rng, s, stage, spec, true);
    }
}
// ---------------------------------------------------------------- leaves
/** An ovate or lanceolate leaf whose edge is sawn into forward teeth, rounded into scallops (menthe, bétoine) or left entire (tabac). */
function serrateLeaf(rng, length, bend, width, teeth, depth, round = false) {
    const w = length * width * rng.range(0.9, 1.08);
    const spine = (v) => [bend * length * v * v - 0.2 * bend * length * v, length * v];
    const envelope = (v) => w * Math.sin(Math.PI * v ** 0.75) ** 0.85;
    const edge = (v) => {
        const phase = (v * teeth) % 1;
        return -envelope(v) * depth * (round ? 1 - Math.sin(Math.PI * phase) : phase) * Math.min(1, v * 5) * Math.min(1, (1 - v) * 6);
    };
    const veins = [];
    for (let k = 1; k <= 4; k += 1) {
        const v = k / 5.5;
        for (const sd of [1, -1]) {
            const [x, y] = spine(v);
            veins.push([[x, y], [x + sd * envelope(v + 0.08) * 0.75, y + length * 0.12]]);
        }
    }
    return [bladeBody({ spine, halfWidth: envelope, edge, shade: side(rng), spacing: HATCH, grain: "across", weight: 0.55, midrib: true, veins, samples: Math.max(22, Math.round(teeth * 3)) }, rng)];
}
/** A short twig with needles (romarin), tiny pressed scales (bruyère) or spines (ajonc) along it, cut as strokes. */
function sprig(rng, length, bend, kind) {
    const twig = sample(v => [bend * length * v * v, length * v], 8);
    const shapes = [line(twig, length * 0.025)];
    const count = kind === "scale" ? 14 : kind === "spiny" ? 12 : 10;
    for (let k = 0; k < count; k += 1) {
        const v = 0.08 + 0.9 * k / count;
        const { at, dir } = along(twig, v);
        const sd = k % 2 === 0 ? 1 : -1;
        if (kind === "scale") {
            shapes.push(line([at, add(at, rot(dir, sd * 0.35), length * 0.09)], length * 0.02));
        }
        else if (kind === "spiny") {
            const d = rot(dir, sd * rng.range(0.5, 1.0));
            shapes.push(line([at, add(at, d, length * rng.range(0.14, 0.22))], length * 0.012));
            if (rng.chance(0.4))
                shapes.push(line([at, add(at, rot(dir, -sd * 0.4), length * 0.1)], length * 0.009));
        }
        else {
            // A needle: a fine stroke bowed a little toward the tip.
            const d = rot(dir, sd * 0.6), reach = length * 0.26 * (1 - 0.4 * v);
            shapes.push(line([at, add(add(at, d, reach * 0.5), dir, reach * 0.06), add(at, rot(d, -sd * 0.15), reach)], length * 0.016));
        }
    }
    return shapes;
}
/** A small leaflet along +y: hatched in the shade, or paper with only its midrib, to keep compound leaves light. */
function leaflet(rng, length, width, hatched) {
    const halfWidth = (v) => length * width * Math.sin(Math.PI * Math.min(1, v ** 0.8)) ** 0.8;
    if (hatched)
        return bladeBody({ spine: v => [0, length * v], halfWidth, shade: side(rng), spacing: HATCH, grain: "across", weight: 0.5, midrib: true, samples: 10 }, rng);
    return plain(petal([0, 0], [0, length], 1, 0, halfWidth), 0.4, [[[0, length * 0.1], [0, length * 0.85]]]);
}
/** Leaflets on one stalk: three (trèfle, luzerne) or a palm of narrow ones (lupin). */
function fingered(rng, length, bend, count) {
    const stalk = length * (count > 3 ? 0.45 : 0.38);
    const top = [bend * length * 0.2, stalk];
    const shapes = [line([[0, 0], [bend * length * 0.06, stalk * 0.5], top], length * 0.02)];
    for (let k = 0; k < count; k += 1) {
        const a = (k / (count - 1) - 0.5) * (count > 3 ? 2.6 : 1.5);
        const piece = leaflet(rng, length * (count > 3 ? 0.5 : 0.48) * (1 - 0.25 * Math.abs(a) / 1.3), count > 3 ? 0.17 : 0.34, k % 2 === 1);
        shapes.push(turnShape(piece, a, top));
    }
    return shapes;
}
/** Leaflets in pairs along a rachis with one at the tip (sainfoin, pimprenelle). */
function pinnate(rng, length, bend, pairs) {
    const rachis = sample(v => [bend * length * v * v, length * v], 10);
    const shapes = [line(rachis, length * 0.018)];
    for (let k = 0; k < pairs; k += 1) {
        const { at } = along(rachis, 0.2 + 0.7 * k / pairs);
        const size = length * 0.26 * (1 - 0.3 * k / pairs);
        for (const sd of [1, -1])
            shapes.push(turnShape(leaflet(rng, size, 0.3, sd === 1 && k === 0), sd * 1.0, at));
    }
    shapes.push(turnShape(leaflet(rng, length * 0.22, 0.3, true), 0, rachis[10]));
    return shapes;
}
/** Narrow leaves in a whorl round the node (caille-lait), splayed to show all round. */
function whorl(rng, length) {
    const count = rng.int(6, 8);
    const shapes = [];
    for (let k = 0; k < count; k += 1) {
        const a = (k / count) * Math.PI * 2 + rng.sym(0.12);
        shapes.push(line([[0, 0], [Math.sin(a) * length * 0.25, Math.cos(a) * length * 0.18 + length * 0.03], [Math.sin(a) * length * 0.5, Math.cos(a) * length * 0.35 + length * 0.05]], length * 0.016));
    }
    return shapes;
}
function leafOf(kind) {
    switch (kind) {
        case "lance": return (rng, length, bend) => simpleLeaf(rng, length, bend, 0.2);
        case "linear": return (rng, length, bend) => simpleLeaf(rng, length, bend, 0.045);
        case "ovate": return (rng, length, bend) => simpleLeaf(rng, length, bend, 0.36);
        case "toothed": return (rng, length, bend) => serrateLeaf(rng, length, bend, 0.32, 9, 0.18);
        case "scalloped": return (rng, length, bend) => serrateLeaf(rng, length, bend, 0.26, 8, 0.2, true);
        case "broad": return (rng, length, bend) => serrateLeaf(rng, length, bend, 0.4, 0, 0);
        case "needle":
        case "scale":
        case "spiny": return (rng, length, bend) => sprig(rng, length, bend, kind);
        case "pinnate": return (rng, length, bend) => pinnate(rng, length, bend, 4);
        case "divided": return (rng, length, bend) => pinnateLeaf(rng, length, bend, 4, 0.34, true);
        case "trifoliate": return (rng, length, bend) => fingered(rng, length, bend, 3);
        case "digitate": return (rng, length, bend) => fingered(rng, length, bend, 7);
        case "whorled": return (rng, length) => whorl(rng, length);
        default: return (rng, length, bend) => serrateLeaf(rng, length, bend, 0.3, 4, 0.45, true);
    }
}
/** Leaf length as a share of the herb's usual node leaf, by kind. */
const LEAF_SCALE = { lance: 1, linear: 0.9, ovate: 1.05, toothed: 1, scalloped: 1, broad: 1.45, needle: 0.9, scale: 0.85, spiny: 0.85,
    pinnate: 1.2, divided: 1.15, trifoliate: 0.85, digitate: 1.15, whorled: 0.75, lobed: 1.1 };
/** A woolly leaf: a stipple of hairs over the blade (bouillon-blanc, sauge, absinthe). */
function hairs(rng, shapes, length) {
    const points = [];
    for (const shape of shapes) {
        if (shape.type !== "body")
            continue;
        const outline = shape.outline;
        const cx = outline.reduce((sum, p) => sum + p[0], 0) / outline.length, cy = outline.reduce((sum, p) => sum + p[1], 0) / outline.length;
        for (let k = 0; k < 10; k += 1) {
            const p = outline[rng.int(0, outline.length - 1)], t = rng.range(0.15, 0.95);
            points.push([lerp(cx, p[0], t), lerp(cy, p[1], t)]);
        }
    }
    return points.length ? [...shapes, { type: "dots", points, radius: length * 0.006 }] : shapes;
}
export const form = {
    id: "epi-aromatique",
    name: "épi aromatique",
    doc: "Upright stems of small flowers: spike, raceme, whorls, head, panicle, coiled cyme or tassel; tube, lip, pea, cross, bell or star corollas going to their fruit.",
    variants: {
        inflorescence: { doc: "How the flowers stand: a dense spike (lavande), a stalked raceme (giroflée), interrupted whorls (sauge), a round head (trèfle), a branched panicle (lilas), a coiled cyme (consoude) or a hanging tassel (amarante)", default: "spike", values: ["spike", "raceme", "whorls", "head", "panicle", "coil", "tassel"] },
        corolla: { doc: "The single flower: a tube (tabac), lipped (sauge), pea-shaped (lupin), a four-petalled cross (giroflée, véronique, lilas), a bell (consoude), a five-lobed star (buglosse), spurred (balsamine) or a mere dot (amarante)", default: "lipped", values: ["tube", "lipped", "pea", "cross", "bell", "star", "spur", "tiny"] },
        fruit: { doc: "What each flower becomes: a calyx of nutlets, a long pod (giroflée), a notched disc (thlaspi), a hanging flat pod (guède), a pea pod (lupin), a coiled pod (luzerne), a black or red berry (troène, mézéréon), a capsule (tabac) or a dry floret", default: "nutlets", values: ["nutlets", "silique", "disc", "pendant", "legume", "spiral", "berry", "redberry", "capsule", "dry"] },
        leaf: { doc: "Leaf kind", default: "lance", values: ["lance", "linear", "ovate", "toothed", "scalloped", "broad", "needle", "scale", "spiny", "pinnate", "divided", "trifoliate", "digitate", "whorled", "lobed"] },
        opposite: { doc: "Leaves in opposite pairs (the mints and their kin) rather than alternate", default: false, values: [true, false] },
        habit: { doc: "A leafy herb, a woody shrublet with many small leaves, or a rosette of large leaves at the root under a tall stem", default: "herb", values: ["herb", "shrub", "rosette"] },
        flowers: { doc: "How many flowers crowd the inflorescence", default: 1, range: [0.5, 1.6] },
        size: { doc: "Flower size relative to a thyme's", default: 1, range: [0.6, 1.8] },
        length: { doc: "Length of the inflorescence relative to the stem's top", default: 1, range: [0.5, 1.6] },
        bare: { doc: "Share of the stem below the flowers left without leaves (lavande's long bare stalks)", default: 0.1, range: [0, 0.6] },
        hairy: { doc: "Woolly or grey-haired leaves, stippled", default: false, values: [true, false] },
    },
    examples: [
        { name: "lavande", variant: { inflorescence: "spike", corolla: "lipped", leaf: "linear", opposite: true, habit: "shrub", size: 0.9, flowers: 1.4, length: 0.8, bare: 0.45, hairy: true } },
        { name: "sauge", variant: { inflorescence: "whorls", corolla: "lipped", leaf: "ovate", opposite: true, habit: "shrub", size: 1.4, length: 1.1, hairy: true } },
        { name: "giroflée", variant: { inflorescence: "raceme", corolla: "cross", fruit: "silique", leaf: "lance", habit: "shrub", size: 1.5 } },
        { name: "lupin", variant: { inflorescence: "raceme", corolla: "pea", fruit: "legume", leaf: "digitate", size: 1.2, length: 1.3, flowers: 1.3 } },
        { name: "consoude", variant: { inflorescence: "coil", corolla: "bell", leaf: "lance", habit: "rosette", size: 1.3, hairy: true } },
        { name: "trèfle", variant: { inflorescence: "head", corolla: "pea", fruit: "dry", leaf: "trifoliate", size: 0.9 } },
        { name: "lilas", variant: { inflorescence: "panicle", corolla: "cross", fruit: "capsule", leaf: "ovate", opposite: true, habit: "shrub", flowers: 1.4, length: 1.2 } },
        { name: "amarante", variant: { inflorescence: "tassel", corolla: "tiny", fruit: "dry", leaf: "ovate", size: 1.3, length: 1.3 } },
        { name: "tabac", variant: { inflorescence: "panicle", corolla: "tube", fruit: "capsule", leaf: "broad", size: 1.6, flowers: 0.6, length: 0.9, hairy: true } },
        { name: "bouillon-blanc", variant: { inflorescence: "spike", corolla: "star", fruit: "capsule", leaf: "broad", habit: "rosette", size: 1.5, flowers: 1.6, length: 1.5, hairy: true } },
        { name: "thlaspi", variant: { inflorescence: "raceme", corolla: "cross", fruit: "disc", leaf: "lance", size: 0.8, flowers: 1.2, length: 1.2 } },
        { name: "guède", variant: { inflorescence: "panicle", corolla: "cross", fruit: "pendant", leaf: "lance", size: 0.8, flowers: 1.2, length: 1.3 } },
        { name: "balsamine", variant: { inflorescence: "raceme", corolla: "spur", fruit: "capsule", leaf: "toothed", size: 1.4, flowers: 0.7, length: 0.8 } },
        { name: "caille-lait", variant: { inflorescence: "panicle", corolla: "tiny", fruit: "dry", leaf: "whorled", size: 0.8, flowers: 1.4, length: 1.2 } },
    ],
    build(variant) {
        const spec = { inflorescence: textOf(variant, "inflorescence"), corolla: textOf(variant, "corolla"), fruit: textOf(variant, "fruit"),
            flowers: numberOf(variant, "flowers"), size: numberOf(variant, "size"), length: numberOf(variant, "length") };
        const kind = textOf(variant, "leaf"), habit = textOf(variant, "habit");
        const opposite = flagOf(variant, "opposite"), woolly = flagOf(variant, "hairy");
        const one = leafOf(kind);
        const hair = (rng, shapes, length) => woolly ? hairs(rng, shapes, length) : shapes;
        // Opposite leaves come as a pair from the node: the second is the first mirrored across the stem, left in
        // paper without hatching, as the far leaf of a pair is in an engraving.
        const leaf = (rng, length, bend) => {
            const first = hair(rng, one(rng, length, bend), length);
            // Whorls and sprigs already show their leaves all round, so they are not doubled.
            if (!opposite || kind === "whorled" || kind === "needle" || kind === "scale" || kind === "spiny")
                return first;
            const sgn = bend >= 0 ? 1 : -1;
            const far = one(rng, length * 0.95, -bend).map(shape => shape.type === "body" ? { ...shape, shadow: [], grain: [] } : shape);
            return [...first, ...hair(rng, far, length).map(shape => turnShape(shape, -sgn * 1.65))];
        };
        const draw = (rng, s, stage) => inflorescence(rng, s, stage, spec);
        const shrub = habit === "shrub", rosette = habit === "rosette";
        const scale = LEAF_SCALE[kind] ?? 1;
        const small = spec.inflorescence === "head";
        const bare = numberOf(variant, "bare");
        return {
            id: "epi-aromatique",
            stems: shrub ? { count: 3, amplitude: 0.13, lambda: [3.5, 5.5], width: 0.07, tops: [0.9, 0.74, 0.58] }
                : rosette ? { count: 2, amplitude: 0.05, lambda: [8, 12], width: 0.065, tops: [0.93, 0.66] }
                    : { count: 3, amplitude: 0.08, lambda: [6, 9], width: 0.052, tops: [0.93, 0.72, 0.52] },
            basal: rosette ? { count: [6, 9], length: [2.6, 4.2] } : null,
            nodes: { every: (shrub ? [1.5, 2.2] : rosette ? [2.0, 2.8] : [1.5, 2.2]).map(d => d * (opposite ? 1.45 : 1)),
                length: height => lerp(shrub ? 1.1 : 1.6, shrub ? 0.75 : 1.0, height) * scale,
                angle: opposite ? [42, 52] : [30, 55], below: 1 - bare },
            leafProxy: kind === "linear" || kind === "needle" || kind === "scale" ? 0.18 : 0.3,
            leaf,
            leaflet: (rng, length, bend) => hair(rng, (kind === "needle" || kind === "scale" || kind === "spiny" ? one : leafOf("lance"))(rng, length, bend), length),
            terminal: { size: [1.45, 1.62], r: s => (small ? 0.4 : 0.5) * s, off: () => 0, draw },
            motifs: [
                { name: "bloom", w: 3.5, smin: 1.25, smax: 1.65, max: Math.round(7 + 5 * bare), hard: true, layer: LAYER.bloom, upright: 1.4, staged: true,
                    r: s => (small ? 0.3 : 0.42) * s, off: s => (small ? 0.62 : 0.5) * s, draw },
                { name: "leaf", w: 2, smin: 0.8 * scale, smax: 1.3 * scale, max: Math.round((opposite ? 4 : 6) * (1 - bare)), layer: LAYER.leaf, upright: 0.3,
                    r: s => 0.3 * s, off: s => 0.5 * s, draw: (rng, s) => leaf(rng, s, rng.sym(0.25)) },
            ],
        };
    },
};
