// Grasses and grains: tufted culms with long arching blades, topped by a compact ear of spikelets in
// rows (blé, orge, seigle, ivraie), a bristly foxtail (panic) or an open panicle of hanging lanterns,
// beads or plumes (avoine, millet, sorgho, roseau). The ear boots out of its sheath, flowers with its
// anthers hanging, and at the end of the day ripens heavy and nods. Maize carries a tassel at the top
// and husked cobs in the leaf axils.
import { LAYER, flagOf, numberOf, textOf } from "../form.js";
import { blade, lerp, sample, smoothstep, unit } from "../geometry.js";
import { HATCH, line, side, turnShape } from "../kit.js";
import { bladeBody } from "../shapes.js";
/** A paper-filled form with only its outline: small spikelets and grains that need no hatching. */
const plain = (outline, weight = 0.3, veins = []) => ({ type: "body", outline, shadow: [], grain: [], veins, weight });
const rot = ([x, y], a) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
const add = (p, d, k) => [p[0] + d[0] * k, p[1] + d[1] * k];
/** A culm top of equal steps whose heading turns by `turn` radians, mostly toward the tip: a nodding head. */
function bentAxis(length, turn, lean, n = 32) {
    const points = [[0, 0]];
    let x = 0, y = 0;
    for (let k = 1; k <= n; k += 1) {
        const v = (k - 0.5) / n;
        const a = lean * v + turn * v ** 2.2;
        x += Math.sin(a) * length / n;
        y += Math.cos(a) * length / n;
        points.push([x, y]);
    }
    return points;
}
/** The point and unit tangent at fraction v of an axis of equal steps. */
function along(axis, v) {
    const n = axis.length - 1;
    const f = Math.min(n - 1e-6, Math.max(0, v * n));
    const i = Math.floor(f), t = f - i;
    const a = axis[i], b = axis[i + 1];
    return { at: [lerp(a[0], b[0], t), lerp(a[1], b[1], t)], dir: unit(b[0] - a[0], b[1] - a[1]) };
}
/** One spikelet or grain: a pointed oval from `at` along `dir`, hatched when it lies on the shaded side. */
function spikelet(rng, at, dir, length, half, hatched, weight, serrate = 0) {
    const spine = (v) => add(at, dir, length * v);
    const halfWidth = (v) => half * Math.sin(Math.PI * Math.min(1, v ** 0.7)) ** 0.75;
    // An edge-on spikelet shows its florets as a saw along the outer edge.
    const edge = (v, s) => serrate && s === serrate ? half * 0.7 * ((v * 4) % 1) * Math.sin(Math.PI * v) : 0;
    if (hatched) {
        const body = bladeBody({ spine, halfWidth, edge, shade: serrate ? (serrate === 1 ? -1 : 1) : 1, spacing: HATCH * 0.55, grain: "across", weight, samples: 8 }, rng);
        body.veins = [];
        return body;
    }
    const { outline, centre } = blade(spine, 8, halfWidth, halfWidth, edge);
    return plain(outline, weight * 0.6, serrate ? [] : [centre.slice(2, 7)]);
}
/** An anther hanging on its thread from a flowering spikelet: the only accent a grass gets. */
function anther(rng, at, s) {
    const end = [at[0] + rng.sym(0.03) * s, at[1] - s * rng.range(0.04, 0.07)];
    return [line([at, [lerp(at[0], end[0], 0.5) + s * 0.01, lerp(at[1], end[1], 0.5)], end], s * 0.0025),
        { type: "dots", points: [end], radius: s * 0.009, tone: "accent" }];
}
/** The flag leaf's sheath swollen round the ear before it emerges, with the flag blade leaving it. */
function boot(rng, axis, from, to, s, awns) {
    const spine = (v) => along(axis, lerp(from, to, v)).at;
    const halfWidth = (v) => s * 0.045 * Math.sin(Math.PI * (0.12 + 0.82 * v)) ** 0.6 * (1 - 0.6 * v ** 3);
    const shapes = [line(axis.slice(0, Math.ceil(from * (axis.length - 1)) + 1), s * 0.02)];
    shapes.push(bladeBody({ spine, halfWidth, shade: side(rng), spacing: HATCH * 0.7, grain: "along", reach: [0.4, 0.9], weight: 0.5, samples: 18 }, rng));
    const top = along(axis, to);
    for (let k = 0; k < awns; k += 1) {
        const d = rot(top.dir, (k - (awns - 1) / 2) * 0.09);
        shapes.push(line([top.at, add(top.at, d, s * rng.range(0.12, 0.2))], s * 0.0035));
    }
    const base = along(axis, from);
    const flag = rot(base.dir, side(rng) * rng.range(0.35, 0.55));
    shapes.push(...grassBlade(rng, s * 0.7, flag[0] > 0 ? 0.12 : -0.12, 0.7).map(shape => turnShape(shape, Math.atan2(flag[1], flag[0]) - Math.PI / 2, base.at)));
    return shapes;
}
/** A compact ear: spikelets in two, four or six rows along a rachis, with or without awns. */
function ear(rng, s, stage, head) {
    const ripe = stage === "seed";
    const peduncle = s * 0.22, L = s * 0.68 * head.length;
    const turn = head.nod * (ripe ? 2.0 : stage === "bloom" ? 1.3 : 0.4) * rng.range(0.85, 1.1);
    const axis = bentAxis(peduncle + L, turn, rng.sym(0.12));
    const v0 = peduncle / (peduncle + L);
    if (stage === "bud")
        return boot(rng, axis, v0 * 0.55, 0.88, s, head.awn > 0.3 ? 5 : 0);
    const shapes = [];
    const edge = head.spikelet === "edge", plump = head.spikelet === "plump";
    const perSide = Math.max(4, Math.min(16, Math.round(6.5 * head.density * head.length)));
    const pitch = L / perSide;
    // The rachis zigzags where edge-on spikelets sit in its notches.
    const nodes = [];
    for (let i = 0; i < perSide * 2; i += 1) {
        const { at, dir } = along(axis, v0 + (1 - v0) * (i + 0.5) / (perSide * 2) * 0.97);
        const sd = i % 2 === 0 ? 1 : -1;
        nodes.push({ at: edge ? add(at, [-dir[1], dir[0]], sd * s * 0.008) : at, dir, side: sd });
    }
    shapes.push(line(axis.slice(0, Math.ceil(v0 * (axis.length - 1)) + 1), s * 0.02));
    shapes.push(line([along(axis, v0).at, ...nodes.map(node => node.at)], s * (edge ? 0.009 : 0.012), !edge));
    const swell = ripe ? 1.22 : 1;
    const awnLength = head.awn * L * 0.62;
    const bodies = [], awns = [], anthers = [];
    const grains = [];
    // Upper spikelets first, so each lower one laps over the base of the one above.
    for (const [rank, node] of nodes.slice().reverse().entries()) {
        // The ear tapers a little at both ends.
        const taper = 0.72 + 0.28 * Math.sin(Math.PI * (0.05 + 0.9 * (1 - rank / nodes.length)));
        const angles = plump ? [0.5, 0.85] : edge ? [0.07] : head.rows === 6 ? [0.12, 0.4, 0.7] : head.rows === 4 ? [0.22, 0.55] : [0.32];
        const sl = (edge ? pitch * 1.2 : plump ? pitch * 2.1 : pitch * 2.2) * taper;
        const half = sl * (edge ? 0.2 : plump ? 0.36 : 0.21) * swell;
        for (const [index, a] of angles.entries()) {
            const spread = a * (ripe && !edge ? 1.2 : 1) + rng.sym(0.05);
            const dir = rot(node.dir, node.side * spread);
            const length = sl * (plump && index === 1 ? 0.82 : 1) * rng.range(0.92, 1.05);
            const hatched = node.side === 1 || (plump && index === 1);
            bodies.push(spikelet(rng, node.at, dir, length, half, hatched, ripe ? 0.75 : 0.55, edge ? (node.side === 1 ? 1 : -1) : 0));
            // Ripe, the grain shows between the gaping glumes.
            if (ripe && plump && index === 0)
                grains.push(add(node.at, dir, length * 0.5));
            const tip = add(node.at, dir, length);
            if (awnLength > 0) {
                const pull = ripe ? 0.3 : 0.5;
                const awnDir = unit(lerp(dir[0], node.dir[0], pull), lerp(dir[1], node.dir[1], pull));
                const al = awnLength * rng.range(0.85, 1.08) * (edge ? 0.6 : 1);
                const bow = rot(awnDir, node.side * 0.06);
                awns.push(line([tip, add(tip, bow, al * 0.5), add(tip, awnDir, al)], s * 0.0035));
            }
            if (stage === "bloom" && rng.chance(edge ? 0.35 : 0.22))
                anthers.push(...anther(rng, add(node.at, dir, length * 0.6), s));
        }
    }
    shapes.push(...awns, ...bodies, ...anthers);
    if (grains.length > 0)
        shapes.push({ type: "dots", points: grains, radius: pitch * 0.2 });
    return shapes;
}
/** A foxtail: a dense lobed cylinder of spikelets bristling with fine hairs, nodding heavily when ripe. */
function foxtail(rng, s, stage, head) {
    const ripe = stage === "seed";
    const peduncle = s * 0.3, L = s * 0.58 * head.length;
    const turn = head.nod * (ripe ? 2.2 : stage === "bloom" ? 1.5 : 0.5) * rng.range(0.85, 1.1);
    const axis = bentAxis(peduncle + L, turn, rng.sym(0.12));
    const v0 = peduncle / (peduncle + L);
    if (stage === "bud")
        return boot(rng, axis, v0 * 0.55, 0.9, s, 4);
    const R = s * 0.068 * (ripe ? 1.18 : 1) * head.density ** 0.3;
    const spine = (v) => along(axis, lerp(v0, 1, v)).at;
    const halfWidth = (v) => R * Math.sin(Math.PI * Math.min(1, 0.08 + v * 0.95)) ** 0.4;
    const lobes = rng.int(7, 10);
    const shapes = [line(axis.slice(0, Math.ceil(v0 * (axis.length - 1)) + 2), s * 0.02)];
    const bristles = [];
    for (let k = 0; k < 34; k += 1) {
        const v = rng.range(0.04, 0.98), sd = side(rng);
        const { at, dir } = along(axis, lerp(v0, 1, v));
        const normal = [-dir[1] * sd, dir[0] * sd];
        const base = add(at, normal, halfWidth(v) * 0.85);
        const out = rot(dir, sd * rng.range(0.5, 1.1));
        bristles.push(line([base, add(base, out, s * rng.range(0.05, 0.085))], s * 0.0028));
    }
    shapes.push(...bristles);
    shapes.push(bladeBody({ spine, halfWidth, edge: v => R * 0.16 * Math.abs(Math.sin(v * Math.PI * lobes)), shade: side(rng),
        spacing: HATCH * 0.6, grain: "across", weight: ripe ? 0.75 : 0.55, samples: 36 }, rng));
    if (ripe) {
        // The ripe grains show as a stipple over the head.
        const grains = Array.from({ length: 40 }, () => {
            const v = rng.range(0.06, 0.95), { at, dir } = along(axis, lerp(v0, 1, v));
            return add(at, [-dir[1], dir[0]], halfWidth(v) * rng.sym(0.8));
        });
        shapes.push({ type: "dots", points: grains, radius: s * 0.007 });
    }
    else {
        for (let k = 0; k < 5; k += 1) {
            const v = rng.range(0.15, 0.85), { at, dir } = along(axis, lerp(v0, 1, v));
            shapes.push(...anther(rng, add(at, [-dir[1], dir[0]], halfWidth(v) * rng.sym(1)), s));
        }
    }
    return shapes;
}
/** Spikelets along one panicle branch from t0 to its tip, by kind. */
function branchSpikelets(rng, path, s, stage, head, outward) {
    const shapes = [];
    const ripe = stage === "seed", bud = stage === "bud";
    switch (head.spikelet) {
        case "lantern": {
            // Oat and fromental: a few spikelets hang from the branch ends on hair-fine stalks, two glumes like a lantern.
            const count = Math.max(1, Math.round(1.6 * head.density));
            for (let k = 0; k < count; k += 1) {
                const t = k === 0 ? 1 : rng.range(0.55, 0.85);
                const p = along(path, t).at;
                const stalk = [p[0] + outward * s * 0.025, p[1] - s * 0.05];
                const dir = unit(outward * 0.2 + rng.sym(0.12), -1);
                const sl = s * (bud ? 0.08 : 0.13), open = ripe ? 0.32 : bud ? 0.04 : 0.14;
                shapes.push(line([p, stalk], s * 0.004));
                for (const sd of [1, -1])
                    shapes.push(spikelet(rng, stalk, rot(dir, sd * open), sl, sl * 0.16, sd === 1, ripe ? 0.65 : 0.5));
                if (ripe)
                    shapes.push({ type: "dots", points: [add(stalk, dir, sl * 0.55)], radius: s * 0.012 });
                if (head.awn > 0 && !bud) {
                    // A bent awn from the back of the glume, kneed halfway.
                    const from = add(stalk, dir, sl * 0.4), knee = add(from, rot(dir, -outward * 1.3), s * 0.045 * head.awn);
                    shapes.push(line([from, knee, add(knee, rot(dir, -outward * 0.6), s * 0.05 * head.awn)], s * 0.003, false));
                }
                if (stage === "bloom" && rng.chance(0.4))
                    shapes.push(...anther(rng, add(stalk, dir, sl * 0.9), s));
            }
            break;
        }
        case "bead": {
            // Millet and sorghum: small round spikelets crowded along the outer part of each branch; grains when ripe.
            const count = Math.max(3, Math.min(7, Math.round(6 * head.density)));
            for (let k = 0; k < count; k += 1) {
                const t = 0.3 + 0.7 * (k + 0.5) / count;
                const { at: p, dir } = along(path, t);
                const sd = k % 2 === 0 ? 1 : -1;
                const c = add(p, [-dir[1] * sd, dir[0] * sd], s * 0.014);
                if (bud) {
                    shapes.push({ type: "dots", points: [c], radius: s * 0.009 });
                    continue;
                }
                const r = s * (ripe ? 0.022 : 0.017) * (0.9 + 0.2 * rng.u());
                const ring = sample(u => add(add(c, dir, Math.sin(u * Math.PI * 2) * r * 1.25), [-dir[1], dir[0]], Math.cos(u * Math.PI * 2) * r), 6).slice(0, -1);
                shapes.push(plain(ring, ripe ? 0.7 : 0.35));
                if (ripe)
                    shapes.push({ type: "dots", points: [add(add(c, dir, -r * 0.3), [-dir[1], dir[0]], r * 0.35)], radius: r * 0.5 });
                else if (rng.chance(0.06))
                    shapes.push(...anther(rng, c, s));
            }
            break;
        }
        case "feather": {
            // The reed: crowded fine spikelets whose silky hairs grow out into a plume.
            const count = Math.max(4, Math.round(9 * head.density));
            for (let k = 0; k < count; k += 1) {
                const t = 0.15 + 0.85 * (k + 0.5) / count;
                const { at: p, dir } = along(path, t);
                const sd = k % 2 === 0 ? 1 : -1;
                const d = rot(dir, sd * 0.4);
                const tip = add(p, d, s * (bud ? 0.03 : 0.05));
                shapes.push(line([p, tip], s * 0.006));
                const hairs = ripe ? 3 : bud ? 0 : 2;
                for (let h = 0; h < hairs; h += 1)
                    shapes.push(line([add(p, d, s * 0.02), add(tip, rot(d, (h - (hairs - 1) / 2) * 0.45), s * (ripe ? 0.08 : 0.04))], s * 0.0022));
            }
            break;
        }
        default: {
            // A tassel's branch: paired spikelets as short dashes along its length, anthers dangling at bloom.
            const count = Math.max(4, Math.round(9 * head.density));
            for (let k = 0; k < count; k += 1) {
                const t = 0.1 + 0.9 * (k + 0.5) / count;
                const { at: p, dir } = along(path, t);
                for (const sd of [1, -1])
                    shapes.push(line([p, add(p, rot(dir, sd * 0.3), s * 0.04)], s * 0.007));
                if (stage === "bloom" && rng.chance(0.1))
                    shapes.push(...anther(rng, p, s));
            }
        }
    }
    return shapes;
}
/** An open panicle: whorls of branches up a nodding axis, carrying lanterns, beads, plumes or tassel spikelets. */
function panicle(rng, s, stage, head) {
    const ripe = stage === "seed", bud = stage === "bud";
    const peduncle = s * 0.22, L = s * 0.7 * head.length;
    const turn = head.nod * (ripe ? 1.5 : 1.0) * rng.range(0.85, 1.1);
    const axis = bentAxis(peduncle + L, turn, rng.sym(0.1));
    const v0 = peduncle / (peduncle + L);
    const shapes = [line(axis, s * 0.016)];
    const spread = head.spread * (bud ? 0.25 : ripe ? 1.05 : 1);
    const lax = head.spikelet === "lantern";
    const whorls = lax || head.spread < 0.4 ? 5 : 6;
    const branches = [];
    // One-sided plumes (the reed) lean their branches all one way.
    const oneSide = head.spikelet === "feather" ? side(rng) : 0;
    for (let w = 0; w < whorls; w += 1) {
        const f = w / whorls;
        const { at, dir } = along(axis, v0 + (1 - v0) * f * 0.92);
        const count = head.spread < 0.4 || oneSide !== 0 ? 3 : rng.int(1, 2);
        for (let b = 0; b < count; b += 1) {
            const sd = oneSide !== 0 && rng.chance(0.6) ? oneSide : (w + b) % 2 === 0 ? 1 : -1;
            const angle = sd * spread * 1.15 * rng.range(0.7, 1.1) * (1 - 0.35 * f);
            const length = s * (lax ? 0.5 : 0.42) * (0.3 + 0.7 * head.spread) * (1 - 0.7 * f) * rng.range(0.8, 1.15);
            const d = rot(dir, angle);
            const hang = (0.15 + 0.85 * head.nod) * (ripe ? 1.2 : 1) * (bud ? 0.2 : 1);
            const path = sample(t => [at[0] + d[0] * length * t, at[1] + d[1] * length * t - hang * length * 0.7 * t * t], 8);
            branches.push(line(path, s * 0.006));
            branches.push(...branchSpikelets(rng, path, s, stage, head, sd));
        }
    }
    // Spikelets up the axis above the last whorl.
    const top = sample(t => along(axis, lerp(v0 + (1 - v0) * 0.85, 1, t)).at, 6);
    shapes.push(...branches, ...branchSpikelets(rng, top, s, stage, head, 0));
    if (bud)
        shapes.push(...boot(rng, axis, v0 * 0.55, v0 + (1 - v0) * 0.45, s, 0).slice(1));
    return shapes;
}
/** A maize ear in the leaf axil: husks wrapped round the cob, silks at the tip; ripe, the husks fall back from the grain. */
function cob(rng, s, stage) {
    const shank = s * 0.12, L = s * (stage === "bud" ? 0.55 : 0.85), R = s * (stage === "bud" ? 0.08 : 0.14);
    const lean = rng.sym(0.1);
    const shapes = [line([[0, 0], [0, shank * 1.2]], s * 0.05)];
    const husk = (angle, length, width, shade) => {
        const d = rot([0, 1], angle + lean);
        const spine = (v) => [d[0] * length * v + angle * length * 0.4 * v * v, shank + d[1] * length * v];
        const halfWidth = (v) => width * Math.sin(Math.PI * Math.min(1, 0.15 + v * 0.9)) ** 0.7 * (1 - 0.7 * v ** 2);
        return bladeBody({ spine, halfWidth, shade, spacing: HATCH * 0.8, grain: "along", reach: [0.35, 0.85], weight: 0.5, samples: 24,
            veins: [-0.5, 0.5].map(q => sample(v => { const [x, y] = spine(v); return [x + q * halfWidth(v), y]; }, 8, 0.1, 0.8)) }, rng);
    };
    const silkTip = [lean * L, shank + L * 1.02];
    if (stage === "seed") {
        // The cob bared: rows of kernels as lines along it and scallops across, husks hanging back below.
        for (const sd of [1, -1]) {
            const d = rot([0, -1], sd * rng.range(0.4, 0.7));
            const spine = (v) => [d[0] * L * 0.75 * v + sd * R * 0.6, shank + R * 0.5 + d[1] * L * 0.75 * v * (1 - 0.3 * v)];
            shapes.push(bladeBody({ spine, halfWidth: v => R * 0.9 * Math.sin(Math.PI * Math.min(1, 0.1 + v)) ** 0.7, shade: sd,
                spacing: HATCH * 0.9, grain: "along", reach: [0.3, 0.7], weight: 0.45, samples: 18 }, rng));
        }
        const axisAt = (v) => [lean * L * v, shank + L * v];
        const halfWidth = (v) => R * Math.sin(Math.PI * Math.min(1, 0.06 + v * 0.98)) ** 0.45;
        const rows = [-0.7, -0.35, 0, 0.35, 0.7].map(q => sample(v => { const [x, y] = axisAt(v); return [x + q * halfWidth(v), y]; }, 12, 0.04, 0.96));
        const scallops = [];
        for (let k = 1; k < 16; k += 1) {
            const v = k / 16, [x, y] = axisAt(v), h = halfWidth(v);
            scallops.push(sample(u => [x + (u * 2 - 1) * h * 0.92, y - h * 0.18 * (1 - (u * 2 - 1) ** 2)], 6));
        }
        const body = bladeBody({ spine: axisAt, halfWidth, shade: 1, spacing: HATCH * 0.7, grain: "across", weight: 0.7, samples: 24 }, rng);
        body.veins = [...rows, ...scallops];
        shapes.push(body);
        shapes.push(...Array.from({ length: 5 }, (_, k) => line([silkTip, add(silkTip, rot([0, 1], (k - 2) * 0.3 + rng.sym(0.1)), s * 0.07)], s * 0.004)));
        return shapes;
    }
    shapes.push(husk(-0.12, L * 1.02, R * 0.85, -1), husk(0.12, L, R * 0.85, 1), husk(0, L * 1.06, R, side(rng)));
    // Silks: the styles that catch the tassel's pollen, accent while the ear flowers.
    const silks = stage === "bud" ? 4 : 9;
    for (let k = 0; k < silks; k += 1) {
        const a = (k / (silks - 1) - 0.5) * (stage === "bud" ? 0.4 : 1.6) + rng.sym(0.1);
        const length = s * (stage === "bud" ? 0.06 : rng.range(0.14, 0.22));
        const d = rot([0, 1], a);
        shapes.push(line([silkTip, add(silkTip, d, length * 0.5), add(add(silkTip, d, length), [0, -1], length * 0.35 * Math.abs(a))], s * 0.0035, true, stage === "bloom" ? "accent" : undefined));
    }
    return shapes;
}
/** A grass blade: long and narrow, rising and arching over to a fine point, sometimes twisted once. */
function grassBlade(rng, length, bend, width) {
    const w = length * 0.028 * width * rng.range(0.85, 1.15);
    const arch = 0.08 + Math.min(0.9, Math.abs(bend) * 2.2), sgn = bend >= 0 ? 1 : -1;
    const spine = (v) => [sgn * length * arch * 0.5 * v * v, length * v * (1 - 0.3 * arch * v * v)];
    const twist = length > 1.2 && rng.chance(0.4) ? rng.range(0.45, 0.7) : -1;
    const halfWidth = (v) => w * (0.7 + 0.3 * smoothstep(0, 0.12, v)) * (1 - v ** 1.7) ** 0.8
        * (twist > 0 ? 0.18 + 0.82 * smoothstep(0, 0.1, Math.abs(v - twist)) : 1);
    const veins = width > 0.9 ? [-0.5, 0.5].map(q => sample(v => { const [x, y] = spine(v); return [x + q * halfWidth(v), y]; }, 14, 0.05, 0.8)) : [];
    // Broad maize-like blades ripple along the edge.
    const ripple = width > 1.5 ? w * 0.1 : 0;
    const edge = (v) => ripple * Math.sin(v * 34) * v;
    return [bladeBody({ spine, halfWidth, edge, shade: side(rng), spacing: HATCH, grain: "across", weight: 0.5, midrib: true, veins, samples: 24 }, rng)];
}
export const form = {
    id: "epi-graminee",
    name: "épi de graminée",
    doc: "Grasses and grains: tufted culms and arching blades under a compact ear, a foxtail, an open panicle, or maize's tassel and husked cobs.",
    variants: {
        head: { doc: "The inflorescence: a compact ear (blé), a bristly foxtail (panic), an open panicle (avoine) or maize's tassel with cobs at the nodes", default: "ear", values: ["ear", "foxtail", "panicle", "cob"] },
        spikelet: { doc: "Spikelet kind: plump fans, narrow grains or edge-on spikelets for an ear; hanging lanterns, round beads or silky plumes for a panicle", default: "plump", values: ["plump", "narrow", "edge", "lantern", "bead", "feather"] },
        rows: { doc: "Rows of narrow grains in an ear: two-rowed or six-rowed barley", default: 2, values: [2, 4, 6] },
        density: { doc: "Spikelets per length of ear or branch: below 1 lax (épeautre, ivraie), above 1 crowded (blé, sorgho)", default: 1, range: [0.4, 1.6] },
        awn: { doc: "Awn length as a share of the ear's length (0 for awnless wheat, 2 for barley's beard)", default: 0, range: [0, 2.5] },
        nod: { doc: "How far the head bows over, more when ripe: 0 upright, 1 hanging", default: 0.2, range: [0, 1] },
        length: { doc: "Length of ear or panicle relative to blé's", default: 1, range: [0.6, 1.6] },
        spread: { doc: "How widely a panicle's branches open: low for a dense sorghum head, high for an open oat", default: 0.7, range: [0.15, 1] },
        culm: { doc: "Culm stoutness, from fine couch grass to maize", default: 1, range: [0.7, 2] },
        leafWidth: { doc: "Blade width relative to wheat's", default: 1, range: [0.5, 1.8] },
        tufted: { doc: "A tuft of blades at the root", default: true, values: [true, false] },
    },
    examples: [
        { name: "blé", variant: { density: 1.3, nod: 0.15 } },
        { name: "orge", variant: { spikelet: "narrow", rows: 2, awn: 2, nod: 0.6, density: 1.1, length: 0.85 } },
        { name: "ivraie", variant: { spikelet: "edge", density: 0.55, awn: 0.35, nod: 0.05, length: 1.2, culm: 0.8, leafWidth: 0.7 } },
        { name: "panic", variant: { head: "foxtail", nod: 0.8, length: 1.1, leafWidth: 1.3, culm: 1.2 } },
        { name: "avoine", variant: { head: "panicle", spikelet: "lantern", spread: 0.8, nod: 0.35, density: 1, length: 1.15, awn: 0 } },
        { name: "roseau", variant: { head: "panicle", spikelet: "feather", spread: 0.45, nod: 0.3, length: 1.3, culm: 1.6, leafWidth: 1.4, tufted: false } },
        { name: "sorgho", variant: { head: "panicle", spikelet: "bead", spread: 0.2, nod: 0.05, density: 1.5, length: 0.9, culm: 1.8, leafWidth: 1.6, tufted: false } },
        { name: "maïs", variant: { head: "cob", spikelet: "narrow", nod: 0.3, culm: 2, leafWidth: 1.8, tufted: false } },
    ],
    build(variant) {
        const head = { head: textOf(variant, "head"), spikelet: textOf(variant, "spikelet"), rows: numberOf(variant, "rows"), density: numberOf(variant, "density"),
            awn: numberOf(variant, "awn"), nod: numberOf(variant, "nod"), length: numberOf(variant, "length"), spread: numberOf(variant, "spread") };
        const culm = numberOf(variant, "culm"), width = numberOf(variant, "leafWidth");
        const maize = head.head === "cob";
        const draw = (rng, s, stage) => head.head === "foxtail" ? foxtail(rng, s, stage, head)
            : head.head === "panicle" ? panicle(rng, s, stage, head)
                : maize ? panicle(rng, s, stage, { ...head, spikelet: "dash", spread: 0.55, nod: 0.45, density: 1, length: 1.1 })
                    : ear(rng, s, stage, head);
        const leaf = (rng, length, bend) => grassBlade(rng, length, bend, width);
        const stout = culm > 1.4;
        const awned = head.awn * head.length * 0.35;
        const earRow = { name: "ear", w: 3.4, smin: 1.15, smax: 1.5, max: 7, hard: true, layer: LAYER.bloom, upright: 2.2, staged: true,
            r: (s) => (0.42 + awned * 0.25) * s, off: (s) => (0.55 + awned * 0.2) * s, draw };
        return {
            id: "epi-graminee",
            stems: stout
                ? { count: 3, amplitude: 0.05, lambda: [9, 13], width: 0.042 * culm, tops: [0.94, 0.78, 0.62] }
                : { count: 4, amplitude: 0.06, lambda: [8, 12], width: 0.042 * culm, tops: [0.95, 0.85, 0.74, 0.62] },
            basal: flagOf(variant, "tufted") ? { count: [5, 8], length: [2.4, 4.2] } : null,
            nodes: { every: maize ? [1.5, 2.1] : [1.7, 2.6], length: height => lerp(maize ? 3.2 : 2.7, maize ? 2.2 : 1.6, height), angle: [16, 32], below: 0.8 },
            leafProxy: 0.1 + 0.03 * width,
            leaf,
            leaflet: (rng, length, bend) => grassBlade(rng, length * 1.3, bend, width * 0.8),
            terminal: { size: [1.3, 1.55], r: s => 0.5 * s, off: () => 0, draw },
            motifs: [
                maize
                    ? { name: "cob", w: 3, smin: 1.0, smax: 1.35, max: 3, hard: true, layer: LAYER.bloom, upright: 1.2, staged: true,
                        r: s => 0.42 * s, off: s => 0.5 * s, draw: (rng, s, stage) => cob(rng, s, stage) }
                    : earRow,
                { name: "leaf", w: 1.6, smin: 1.6, smax: 2.6, max: 6, layer: LAYER.leaf, upright: 0.6,
                    r: s => 0.26 * s, off: s => 0.55 * s, draw: (rng, s) => leaf(rng, s, rng.sym(0.25)) },
            ],
        };
    },
};
