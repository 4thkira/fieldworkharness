// Climbers: vines that hold on by coiled or forked tendrils, by twining about their own stems, or by
// clinging rootlets, known by their leaves and by what hangs from them at the end: grape bunches, hop
// cones, ivy berries, gourds, pods (raisin, houblon, lierre, potiron, concombre, pois, haricots,
// chèvrefeuille, jasmin).
import { LAYER, numberOf, textOf, flagOf } from "../form.js";
import { bezier3, clamp, lerp, RAD, sample, smoothstep, unit } from "../geometry.js";
import { berry, circle, HATCH, line, side, simpleLeaf, turnShape } from "../kit.js";
import { bladeBody, roundBody } from "../shapes.js";
const TAU = Math.PI * 2;
/** The turn that points a primitive's +y axis along (dx, dy). */
const toward = (dx, dy) => Math.atan2(-dx, dy);
const place = (shapes, angle, at) => shapes.map(shape => turnShape(shape, angle, at));
function flip(shape) {
    const f = (points) => points.map(([x, y]) => [-x, y]);
    switch (shape.type) {
        case "body": return { ...shape, outline: f(shape.outline), shadow: shape.shadow.map(f), grain: shape.grain.map(f), veins: shape.veins.map(f) };
        case "solid": return { ...shape, outline: f(shape.outline) };
        case "line": return { ...shape, points: f(shape.points) };
        case "dots": return { ...shape, points: f(shape.points) };
    }
}
/** A rounded fruit or bud as an ellipse, shaded as a sphere. */
const oval = (at, rx, ry, weight, spacing = HATCH * 0.6) => roundBody(circle(at, rx, ry, 18), at, (rx + ry) / 2, spacing, weight);
/** A black berry (ivy, jasmine): a sphere inked over but for a crescent of light. */
const darkBerry = (at, r) => [berry(at, r, 0.9), { type: "dots", points: [[at[0] + r * 0.12, at[1] - r * 0.12]], radius: r * 0.8 }];
// ---------------------------------------------------------------- holding on
/** A spiral curling inward from `from`, leaving along `heading`, toward side `sideOf`. */
function curl(from, heading, r0, turns, sideOf) {
    const c = [from[0] + heading[1] * sideOf * r0, from[1] - heading[0] * sideOf * r0];
    const phi0 = Math.atan2(from[1] - c[1], from[0] - c[0]);
    const dir = -Math.sin(phi0) * heading[0] + Math.cos(phi0) * heading[1] > 0 ? 1 : -1;
    return sample(t => {
        const r = r0 * (1 - 0.78 * t), phi = phi0 + dir * t * turns * TAU;
        return [c[0] + r * Math.cos(phi), c[1] + r * Math.sin(phi)];
    }, Math.ceil(turns * 16));
}
/** A tendril: a wavering run that ends in a tight curl, along +y. */
function tendril(rng, length, width, turns = rng.range(1.6, 2.6)) {
    const sway = rng.sym(0.25) * length;
    const run = sample(bezier3([0, 0], [rng.sym(0.1) * length, length * 0.25], [sway, length * 0.4], [sway * 0.6, length * 0.62]), 9);
    const end = run[run.length - 1], before = run[run.length - 2];
    const coil = curl(end, unit(end[0] - before[0], end[1] - before[1]), length * rng.range(0.09, 0.13), turns, side(rng));
    return [line(run, width), line(coil, width * 0.7)];
}
/** A forked tendril (pea, vetch, vine): a short stalk that splits into two or three curling arms. */
function forkedTendril(rng, length, width) {
    const stalk = length * 0.35;
    const shapes = [line([[0, 0], [rng.sym(0.04) * length, stalk]], width)];
    const arms = rng.int(2, 3);
    for (let k = 0; k < arms; k += 1) {
        const angle = (arms === 2 ? (k - 0.5) * 0.9 : (k - 1) * 0.7) + rng.sym(0.12);
        shapes.push(...place(tendril(rng, length * rng.range(0.55, 0.7), width * 0.8), angle, [0, stalk]));
    }
    return shapes;
}
/** Two shoots wound about each other, the way a twiner winds about its own stems, their tips free and nodding. */
function twine(rng, s) {
    const turns = rng.range(2.2, 3.0), length = s * 0.8, amp = s * 0.045;
    const lean = rng.sym(0.12) * s;
    const strand = (phase) => (v) => {
        const a = v * turns * TAU + phase;
        return { p: [lean * v * v + amp * (1 - 0.35 * v) * Math.sin(a), length * v], front: Math.cos(a) > 0 };
    };
    const back = [], front = [];
    for (const phase of [0, Math.PI]) {
        const at = strand(phase);
        let run = [], isFront = at(0).front;
        for (let k = 0; k <= 72; k += 1) {
            const { p, front: f } = at(k / 72);
            run.push(p);
            if (f !== isFront || k === 72) {
                (isFront ? front : back).push(line(run, isFront ? s * 0.022 : s * 0.014));
                run = [p];
                isFront = f;
            }
        }
        // The free tip hooks over, as a searching shoot does.
        const end = at(1).p, sd = phase === 0 ? 1 : -1;
        const hook = sample(bezier3(end, [end[0] + sd * s * 0.04, end[1] + s * 0.12], [end[0] + sd * s * 0.16, end[1] + s * 0.16], [end[0] + sd * s * 0.2, end[1] + s * 0.08]), 8);
        front.push(line(hook, s * 0.015));
        front.push(...place(simpleLeaf(rng, s * 0.16, rng.sym(0.2), 0.3), toward(sd, 0.6), hook[3]));
    }
    return [...back, ...front];
}
/** An ivy runner pressed to its support, with tufts of clinging rootlets and a young leaf. */
function runner(rng, s, leaf) {
    const path = sample(v => [s * 0.04 * Math.sin(v * 5 + rng.u()), s * v], 14);
    const shapes = [];
    for (let k = 1; k < 13; k += 2) {
        const [x, y] = path[k];
        for (let j = 0; j < 4; j += 1) {
            const a = Math.PI * (0.75 + 0.35 * j / 3) + rng.sym(0.1), r = s * rng.range(0.04, 0.08);
            shapes.push(line([[x, y], [x + Math.cos(a) * r * 0.6, y + Math.sin(a) * r * 0.5 + r * 0.2], [x + Math.cos(a) * r, y + Math.sin(a) * r]], s * 0.006));
        }
    }
    shapes.push(line(path, s * 0.03));
    shapes.push(...place(leaf(rng, s * 0.42), toward(1, 0.5), path[7]));
    return shapes;
}
function palmLeaf(rng, length, p) {
    const petiole = length * p.petiole, R = length - petiole;
    const centre = [0, petiole];
    const lobes = p.angles.map((a, i) => ({ a: (a + (i === 0 ? 0 : rng.sym(5))) * RAD, r: p.reach[i] * R * rng.range(0.94, 1.04), lobe: true }));
    const sinus = { a: Math.PI, r: p.sinus * R, lobe: false };
    const nodes = [{ ...sinus, a: -Math.PI }, ...lobes.slice(1).reverse().map(n => ({ ...n, a: -n.a })), lobes[0], ...lobes.slice(1), sinus];
    const profile = (c) => p.pointed ? c ** 1.5 : Math.sin(c * Math.PI / 2) ** 1.3;
    const radius = (theta) => {
        let i = 0;
        while (i < nodes.length - 2 && theta > nodes[i + 1].a)
            i += 1;
        const n0 = nodes[i], n1 = nodes[i + 1];
        const t = clamp((theta - n0.a) / (n1.a - n0.a), 0, 1);
        let r = lerp(n0.r, n1.r, smoothstep(0, 1, t));
        if (n0.lobe && n1.lobe) {
            const c = Math.abs(2 * t - 1);
            r *= 1 - p.depth * (1 - profile(c));
            // Deeply cut leaves (pastèque) are cut again along their lobes.
            if (p.depth > 0.6)
                r *= 1 - 0.3 * (1 - Math.abs(2 * ((t * 3) % 1) - 1)) ** 1.5 * c;
        }
        if (p.teeth > 0) {
            const f = ((theta + Math.PI) / TAU * p.teeth) % 1;
            r *= 1 + p.tooth * ((1 - f) ** 2 - 0.33) * (1 - smoothstep(2.5, 3.05, Math.abs(theta)));
        }
        return r;
    };
    const outline = sample(v => {
        const theta = -Math.PI + 0.02 + (TAU - 0.04) * v;
        const r = radius(theta);
        return [centre[0] + r * Math.sin(theta), centre[1] + r * Math.cos(theta)];
    }, 150);
    const shade = side(rng);
    const shadow = [[0, -length], [shade * length * 2, -length], [shade * length * 2, length * 2], [0, length * 2]];
    const grain = [];
    for (let k = -Math.ceil(R * 1.3 / HATCH); k <= Math.ceil(R * 1.3 / HATCH); k += 1) {
        const y0 = centre[1] + k * HATCH * 1.05;
        grain.push([[-R * 1.2, y0 - R * 0.35 * shade], [R * 1.2, y0 + R * 0.35 * shade]]);
    }
    const veins = [];
    for (const { a } of nodes.filter(n => n.lobe)) {
        const reach = radius(a) * 0.86;
        veins.push(sample(v => [centre[0] + reach * v * Math.sin(a + 0.05 * Math.sin(v * 3)), centre[1] + reach * v * Math.cos(a)], 8));
        for (const t of [0.4, 0.65]) {
            const start = [centre[0] + reach * t * Math.sin(a), centre[1] + reach * t * Math.cos(a)];
            for (const sd of [1, -1])
                veins.push([start, [start[0] + reach * 0.22 * Math.sin(a + sd * 0.75), start[1] + reach * 0.22 * Math.cos(a + sd * 0.75)]]);
        }
    }
    const shapes = [line([[0, 0], [rng.sym(0.03) * length, petiole * 0.6], centre], length * 0.022)];
    if (p.rootlets) {
        for (let k = 0; k < 5; k += 1) {
            const a = Math.PI * (1.15 + 0.7 * k / 4), r = length * rng.range(0.06, 0.1);
            shapes.push(line([[0, 0], [Math.cos(a) * r * 0.5, Math.sin(a) * r * 0.5 - r * 0.1], [Math.cos(a) * r, Math.sin(a) * r]], length * 0.006));
        }
    }
    shapes.push({ type: "body", outline, shadow: [shadow], grain, veins, weight: 0.6 });
    return shapes;
}
/** A ribbon of rachis, for winged leaf stalks (gesse). */
function wingedRachis(rng, rachis, width) {
    const n = rachis.length - 1;
    return bladeBody({ spine: v => rachis[Math.min(n, Math.round(v * n))], halfWidth: v => width * (0.4 + 0.6 * Math.sin(Math.PI * Math.min(1, v * 1.2))),
        shade: 1, spacing: HATCH * 0.7, grain: "along", reach: [0.2, 0.5], weight: 0.4, samples: n, midrib: true }, rng);
}
/** A pinnate leaf of paired leaflets ending in a tendril or an odd leaflet, with leafy stipules (pois). */
function pinnate(rng, length, bend, p) {
    const span = p.tendril === "none" ? 0.8 : 0.58;
    const rachis = sample(v => [bend * length * span * v * v, length * span * v], 14);
    const shapes = [];
    const size = length * (p.pairs === 1 ? 0.55 : clamp(1.05 / (p.pairs + 1.2), 0.12, 0.42));
    const width = p.pairs === 1 ? 0.14 : p.pairs >= 4 ? 0.22 : 0.3;
    if (p.stipules) {
        for (const sd of [1, -1]) {
            const st = length * 0.26;
            const stipule = bladeBody({ spine: v => [sd * st * 0.9 * v, st * 0.1 + st * 0.45 * v * v], halfWidth: v => st * 0.5 * v ** 0.5 * (1 - v) ** 0.8 * (1 + 0.6 * (1 - v)),
                shade: sd === 1 ? -1 : 1, spacing: HATCH, grain: "across", weight: 0.45, midrib: true, samples: 16 }, rng);
            shapes.push(stipule);
        }
    }
    shapes.push(p.winged ? wingedRachis(rng, rachis, length * 0.02) : line(rachis, length * 0.016));
    const tip = rachis[rachis.length - 1];
    if (p.tendril === "simple")
        shapes.push(...place(tendril(rng, length * 0.42, length * 0.01), rng.sym(0.2), tip));
    if (p.tendril === "forked")
        shapes.push(...place(forkedTendril(rng, length * 0.45, length * 0.011), rng.sym(0.15), tip));
    if (p.tendril === "none")
        shapes.push(...place(simpleLeaf(rng, size * 1.35, rng.sym(0.1), width), 0, tip));
    for (let k = 1; k <= p.pairs; k += 1) {
        const v = p.pairs === 1 ? 0.98 : 0.2 + 0.78 * (k - 0.5) / p.pairs;
        const at = rachis[Math.round(v * 13)];
        for (const sd of [1, -1]) {
            const leafletSize = size * (1 - 0.15 * v) * rng.range(0.92, 1.05);
            // Many small leaflets (vesce, lentille) are cut with fewer, wider strokes, so the plate stays light.
            const leaflet = p.pairs >= 4
                ? [bladeBody({ spine: t => [sd * 0.05 * leafletSize * t * t, leafletSize * t], halfWidth: t => leafletSize * width * 2.1 * t ** 0.6 * (1 - t) ** 0.85,
                        shade: side(rng), spacing: HATCH * 1.4, grain: "across", weight: 0.5, midrib: true, samples: 10 }, rng)]
                : simpleLeaf(rng, leafletSize, sd * rng.range(0.02, 0.1), width);
            shapes.push(...place(leaflet, -sd * (p.pairs === 1 ? 0.45 : 0.95) + rng.sym(0.08), at));
        }
    }
    return shapes;
}
/** Three broad pointed leaflets on a long stalk (haricots). */
function trifoliate(rng, length, bend) {
    const stalk = length * 0.36;
    const junction = [bend * stalk * 0.5, stalk];
    const end = [junction[0] + bend * length * 0.08, junction[1] + length * 0.08];
    const shapes = [line([[0, 0], junction, end], length * 0.02)];
    for (const sd of [1, -1])
        shapes.push(...place(simpleLeaf(rng, length * 0.48, sd * 0.12, 0.4), -sd * 1.15 + rng.sym(0.1), junction));
    shapes.push(...place(simpleLeaf(rng, length * 0.56, bend * 0.4, 0.42), rng.sym(0.08), end));
    return shapes;
}
/** A grape bunch: tiny capped flowers in a conical cluster, which swell into a hanging bunch of berries. */
function bunch(rng, s, stage) {
    const stalk = s * 0.16;
    const len = s * (stage === "seed" ? 0.78 : stage === "bloom" ? 0.62 : 0.5);
    const shapes = [];
    shapes.push(...place(tendril(rng, s * 0.4, s * 0.012), side(rng) * 0.9, [0, stalk * 0.6]));
    shapes.push(line([[0, 0], [rng.sym(0.02) * s, stalk], [0, stalk + len * 0.92]], s * 0.022));
    const spots = [];
    const rows = 7;
    for (let i = 0; i < rows; i += 1) {
        const f = i / (rows - 1);
        const half = len * 0.36 * (1 - f) ** 0.85 + s * 0.03;
        const n = Math.max(1, Math.round(half / (len * 0.085)));
        for (let j = 0; j < n; j += 1)
            spots.push({ at: [lerp(-half, half, n === 1 ? 0.5 : j / (n - 1)) + rng.sym(0.02) * s, stalk + s * 0.05 + f * len + rng.sym(0.02) * s], depth: rng.u() });
    }
    // A shoulder: the bunch's small side wing.
    const sd = side(rng);
    for (let j = 0; j < 3; j += 1)
        spots.push({ at: [sd * (len * 0.42 + j * len * 0.07), stalk + len * (0.1 + j * 0.09)], depth: rng.u() });
    spots.sort((a, b) => a.depth - b.depth);
    if (stage === "seed") {
        const r = len * 0.085;
        for (const { at } of spots)
            shapes.push(oval(at, r, r * 1.08, 0.8));
        shapes.push({ type: "dots", points: spots.map(({ at }) => [at[0] - r * 0.35, at[1] + r * 0.4]), radius: r * 0.12 });
        return shapes;
    }
    if (stage === "bud") {
        shapes.push({ type: "dots", points: spots.map(({ at }) => at), radius: s * 0.026 });
        return shapes;
    }
    // Open flowers shed their caps: a tuft of stamens over a small ovary.
    const anthers = [];
    for (const { at } of spots) {
        for (let k = 0; k < 5; k += 1) {
            const a = Math.PI / 2 + (k - 2) * 0.55 + rng.sym(0.1);
            const tip = [at[0] + Math.cos(a) * s * 0.045, at[1] + Math.sin(a) * s * 0.045];
            shapes.push(line([at, tip], s * 0.005, false));
            if (k % 2 === 0)
                anthers.push(tip);
        }
    }
    shapes.push({ type: "dots", points: spots.map(({ at }) => at), radius: s * 0.016 }, { type: "dots", points: anthers, radius: s * 0.008, tone: "accent" });
    return shapes;
}
/** A hop cone of overlapping bracts along +y; open and papery when ripe. */
function hopCone(rng, len, ripe) {
    const rows = ripe ? 6 : 5;
    const coneHalf = len * (ripe ? 0.27 : 0.22);
    const scales = [];
    // Each bract covers the base of the next toward the tip, so the tip is cut first.
    for (let row = rows - 1; row >= 0; row -= 1) {
        const f = row / (rows - 1);
        const y = len * (0.08 + 0.7 * f);
        // An ovoid outline, broadest a third of the way along, drawn to a point.
        const half = coneHalf * Math.sin(Math.PI * (0.3 + 0.7 * f)) ** 0.8;
        const cols = row % 2 === 0 ? [-1, 0, 1] : [-0.5, 0.5];
        for (const c of [...cols].sort((a, b) => Math.abs(b) - Math.abs(a))) {
            const x = c * half * 0.7;
            const sh = len * (ripe ? 0.24 : 0.2) * (1 - 0.25 * f), sw = half * (cols.length === 3 ? 0.42 : 0.55);
            const out = c * (ripe ? 0.4 : 0.15);
            scales.push(bladeBody({ spine: v => [x + out * sh * v, y + sh * v], halfWidth: v => sw * Math.sin(Math.PI * Math.min(1, 0.18 + 0.82 * v)) ** 0.7,
                shade: c > 0 ? 1 : -1, spacing: HATCH * 1.1, grain: "along", reach: ripe ? [0.15, 0.3] : [0.3, 0.5], weight: ripe ? 0.3 : 0.55, midrib: ripe, samples: 7 }, rng));
        }
    }
    return [line([[0, 0], [0, len * 0.2]], len * 0.04), ...scales];
}
/** Hops: bristly female burrs, then small tight cones, then clusters of loose papery cones. */
function strobile(rng, s, stage) {
    const shapes = [line([[0, 0], [rng.sym(0.03) * s, s * 0.3]], s * 0.02)];
    const count = stage === "bloom" ? rng.int(1, 2) : 2;
    for (let k = 0; k < count; k += 1) {
        const at = [0, s * (0.16 + 0.12 * k)];
        const angle = (k % 2 === 0 ? 1 : -1) * rng.range(0.35, 0.7);
        if (stage === "bud") {
            const r = s * 0.06, c = [0, s * 0.12];
            const burr = [line([[0, 0], [0, s * 0.06]], s * 0.012), oval(c, r, r, 0.6)];
            for (let j = 0; j < 9; j += 1) {
                const a = j / 9 * TAU;
                burr.push(line([[c[0] + Math.cos(a) * r * 0.8, c[1] + Math.sin(a) * r * 0.8], [c[0] + Math.cos(a) * r * 1.6, c[1] + Math.sin(a) * r * 1.6]], s * 0.005));
            }
            shapes.push(...place(burr, angle, at));
            continue;
        }
        const cone = hopCone(rng, s * (stage === "seed" ? rng.range(0.45, 0.55) : 0.32), stage === "seed");
        shapes.push(...place(cone, angle, at));
    }
    return shapes;
}
/** Ivy: a globe of rays ending in small green flowers, which turn to black berries. */
function ivyUmbels(rng, s, stage) {
    const shapes = [];
    const umbel = (hub, size) => {
        const rays = Math.round(rng.int(10, 13) * Math.min(1, size / s + 0.2));
        const tips = [];
        for (let k = 0; k < rays; k += 1) {
            const a = Math.PI / 2 + (k / (rays - 1) * 2 - 1) * 1.55 + rng.sym(0.08);
            const len = size * (stage === "bud" ? 0.17 : 0.24) * rng.range(0.6, 1);
            const at = [hub[0] + Math.cos(a) * len, hub[1] + Math.sin(a) * len];
            tips.push({ at, depth: len });
            shapes.push(line([hub, at], size * 0.006, false));
        }
        tips.sort((a, b) => a.depth - b.depth);
        if (stage === "seed") {
            for (const { at } of tips)
                shapes.push(...darkBerry(at, size * 0.05));
            shapes.push({ type: "dots", points: tips.map(({ at }) => [at[0], at[1] + size * 0.04]), radius: size * 0.01 });
        }
        else if (stage === "bud") {
            shapes.push({ type: "dots", points: tips.map(({ at }) => at), radius: size * 0.022 });
        }
        else {
            for (const { at } of tips) {
                for (let j = 0; j < 5; j += 1) {
                    const a = j / 5 * TAU + rng.sym(0.2);
                    shapes.push(line([at, [at[0] + Math.cos(a) * size * 0.035, at[1] + Math.sin(a) * size * 0.03]], size * 0.006, false));
                }
            }
            shapes.push({ type: "dots", points: tips.map(({ at }) => at), radius: size * 0.014 }, { type: "dots", points: tips.filter((_, i) => i % 3 === 0).map(({ at }) => at), radius: size * 0.008, tone: "accent" });
        }
    };
    const main = [0, s * 0.42];
    shapes.push(line([[0, 0], [rng.sym(0.03) * s, s * 0.2], main], s * 0.02));
    const sd = side(rng);
    const sideHub = [sd * s * 0.22, s * 0.3];
    shapes.push(line([[0, s * 0.12], [sd * s * 0.1, s * 0.22], sideHub], s * 0.014));
    umbel(sideHub, s * 0.7);
    umbel(main, s);
    return shapes;
}
/** A gourd flower in side view: a flaring funnel with five pointed lobes, the stigma red at the mouth. */
function cupFlower(rng, s, open, female) {
    const stalk = s * 0.22;
    const shapes = [line([[0, 0], [rng.sym(0.03) * s, stalk]], s * 0.025)];
    let base = stalk;
    if (female) {
        shapes.push(oval([0, stalk + s * 0.06], s * 0.05, s * 0.08, 0.6));
        base += s * 0.13;
    }
    for (const sd of [1, -1])
        shapes.push(line([[0, base], [sd * s * 0.07, base + s * 0.05]], s * 0.008));
    if (!open) {
        const len = s * 0.42;
        const hw = (v) => s * 0.1 * Math.sin(Math.PI * Math.min(1, 0.08 + v * 0.9) ** 0.75) * (1 - 0.5 * v);
        const bud = bladeBody({ spine: v => [rng.sym(0.001), base + len * v], halfWidth: hw, shade: side(rng), spacing: HATCH * 0.7, grain: "along", reach: [0.3, 0.7], weight: 0.45, samples: 16 }, rng);
        bud.veins = [-0.6, 0, 0.6].map(q => sample(v => [hw(v) * (q + 0.35 * v) * (1 - v * 0.3), base + len * v], 8, 0.05, 0.95));
        shapes.push(bud);
        return shapes;
    }
    const len = s * 0.36, W = s * 0.3;
    const hw = (v) => s * 0.045 + (W - s * 0.045) * v ** 1.7;
    const top = base + len;
    // Back lobes stand above the rim; the funnel; then the front lobes fold out over it.
    const lobe = (at, angle, size, weight) => place([bladeBody({ spine: v => [0, size * v], halfWidth: v => size * 0.5 * v ** 0.3 * (1 - v) ** 1.1, shade: 1, spacing: HATCH * 0.7, grain: "along", reach: [0.2, 0.5], weight, midrib: true, samples: 12 }, rng)], angle, at);
    for (const sd of [1, -1])
        shapes.push(...lobe([sd * W * 0.45, top + W * 0.1], -sd * 0.45, s * 0.17, 0.25));
    const funnel = bladeBody({ spine: v => [0, base + len * v], halfWidth: hw, shade: side(rng), spacing: HATCH * 0.7, grain: "along", reach: [0.25, 0.6], weight: 0.4, samples: 18 }, rng);
    funnel.veins = [-0.55, 0, 0.55].map(q => sample(v => [hw(v) * q, base + len * v], 8, 0.1, 1));
    shapes.push(funnel);
    shapes.push(line(sample(v => [Math.cos(v * TAU) * W, top + Math.sin(v * TAU) * W * 0.22], 20), s * 0.008));
    for (const sd of [1, -1])
        shapes.push(...lobe([sd * W * 0.9, top - W * 0.05], -sd * 1.45, s * 0.2, 0.3));
    shapes.push(...lobe([0, top - W * 0.22], Math.PI * 0.04, s * 0.15, 0.3));
    shapes.push({ type: "dots", points: [[-s * 0.02, top + s * 0.02], [s * 0.02, top + s * 0.025], [0, top + s * 0.05]], radius: s * 0.018, tone: "accent" });
    return shapes;
}
/** A pole-to-pole curve over a rounded fruit, at longitude `lambda`: the ribs and stripes of a gourd. */
const meridian = (centre, rx, ry, lambda, wobble = (_) => 0) => sample(u => [centre[0] + rx * Math.sin(lambda + wobble(u)) * Math.sin(Math.PI * u), centre[1] - ry * Math.cos(Math.PI * u)], 14, 0.04, 0.96);
/** The gourd a cucurbit becomes, hanging along +y from its stalk. */
function gourd(rng, s, kind) {
    const stalkLength = s * (kind === "pumpkin" ? 0.12 : 0.16);
    const stalk = bladeBody({ spine: v => [0, stalkLength * 1.15 * v], halfWidth: () => s * (kind === "pumpkin" || kind === "pepo" ? 0.04 : 0.02),
        shade: 1, spacing: HATCH * 0.6, grain: "along", reach: [0.6, 0.9], weight: 0.7, samples: 6 }, rng);
    const light = [-0.6, 0.8];
    if (kind === "cucumber") {
        const len = s * 0.9, hw = s * 0.11, bow = rng.sym(0.12) * len;
        const spine = (v) => [bow * v * v, stalkLength + len * v];
        const halfWidth = (v) => hw * v ** 0.3 * (1 - v) ** 0.25 * 1.4;
        const fruit = bladeBody({ spine, halfWidth, shade: side(rng), spacing: HATCH * 0.8, grain: "across", weight: 0.65, samples: 30 }, rng);
        const warts = Array.from({ length: 30 }, () => { const v = rng.range(0.08, 0.92); const [x, y] = spine(v); return [x + rng.sym(0.85) * halfWidth(v), y]; });
        return [stalk, fruit, { type: "dots", points: warts, radius: s * 0.009 }];
    }
    if (kind === "pumpkin" || kind === "pepo") {
        const rx = s * (kind === "pumpkin" ? 0.55 : 0.44), ry = s * (kind === "pumpkin" ? 0.36 : 0.42);
        const centre = [0, stalkLength + ry * 0.92];
        const ribs = kind === "pumpkin" ? 9 : 10;
        // The ribs show at the silhouette as shallow scallops.
        const outline = sample(v => {
            const a = v * TAU, bump = 1 + 0.035 * Math.abs(Math.sin(a * ribs / 2));
            return [centre[0] + Math.cos(a) * rx * bump, centre[1] + Math.sin(a) * ry * (kind === "pumpkin" ? 1 - 0.08 * Math.max(0, -Math.sin(a)) ** 4 : 1)];
        }, 72).slice(0, -1);
        const body = roundBody(outline, centre, Math.min(rx, ry) * 1.15, HATCH * 0.8, kind === "pumpkin" ? 0.55 : 0.6, light);
        body.veins = Array.from({ length: 7 }, (_, k) => meridian(centre, rx, ry, (k / 6 * 2 - 1) * 1.25));
        return [body, stalk];
    }
    const rx = s * (kind === "watermelon" ? 0.44 : 0.4), ry = s * (kind === "watermelon" ? 0.56 : 0.42);
    const centre = [0, stalkLength + ry * 0.95];
    const body = roundBody(circle(centre, rx, ry, 40), centre, Math.min(rx, ry) * 1.1, HATCH * 0.8, kind === "watermelon" ? 0.72 : 0.55, light);
    if (kind === "watermelon") {
        // Dark wavering stripes, each cut as a pair of lines.
        body.veins = Array.from({ length: 8 }, (_, k) => (k / 7 * 2 - 1) * 1.3).flatMap(l => {
            const phase = rng.range(0, TAU);
            return [-0.05, 0.05].map(d => meridian(centre, rx, ry, l + d, u => 0.06 * Math.sin(u * 16 + phase)));
        });
    }
    else {
        // A melon's net: a jittered grid of short cuts over the sphere, with its faint sutures.
        const net = [];
        const at = (i, j) => {
            const l = (i / 7 * 2 - 1) * 1.35 + Math.sin(i * 7.1 + j * 3.3) * 0.08, u = 0.1 + 0.8 * j / 7 + Math.cos(i * 5.3 + j * 2.9) * 0.03;
            return [centre[0] + rx * Math.sin(l) * Math.sin(Math.PI * u), centre[1] - ry * Math.cos(Math.PI * u)];
        };
        for (let i = 0; i <= 7; i += 1)
            for (let j = 0; j <= 7; j += 1) {
                if (i < 7)
                    net.push([at(i, j), at(i + 1, j)]);
                if (j < 7)
                    net.push([at(i, j), at(i, j + 1)]);
            }
        body.veins = [...net, ...[-0.9, 0, 0.9].map(l => meridian(centre, rx, ry, l))];
    }
    return [body, stalk];
}
/** A pea flower in side view, facing +x: the banner thrown back, wings and keel thrust forward. */
function peaFlower(rng, f, open) {
    const calyxTop = f * 0.36;
    const shapes = [line([[0, 0], [0, f * 0.2]], f * 0.04)];
    const calyx = bladeBody({ spine: v => [0, f * 0.16 + (calyxTop - f * 0.16) * v], halfWidth: v => f * (0.05 + 0.06 * v), shade: 1,
        spacing: HATCH * 0.6, grain: "along", reach: [0.4, 0.8], weight: 0.55, samples: 8 }, rng);
    if (!open) {
        shapes.push(bladeBody({ spine: v => [f * 0.14 * v * v, calyxTop - f * 0.04 + f * 0.48 * v], halfWidth: v => f * 0.14 * Math.sin(Math.PI * Math.min(1, 0.12 + v * 0.88)) ** 0.7 * (1 - 0.4 * v),
            shade: -1, spacing: HATCH * 0.6, grain: "along", reach: [0.3, 0.6], weight: 0.45, samples: 14 }, rng), calyx);
        return shapes;
    }
    const b = [0, calyxTop];
    const banner = bladeBody({ spine: v => [b[0] - f * 0.3 * v, b[1] + f * 0.62 * v], halfWidth: v => f * 0.34 * Math.sin(Math.PI * Math.min(1, 0.1 + v * 0.9)) ** 0.55 * (1 - 0.22 * smoothstep(0.88, 1, v)),
        shade: 1, spacing: HATCH * 0.6, grain: "along", reach: [0.25, 0.55], weight: 0.42, midrib: true, samples: 18 }, rng);
    const wing = bladeBody({ spine: v => [b[0] + f * 0.5 * v, b[1] + f * 0.12 * v + f * 0.12 * v * v], halfWidth: v => f * 0.15 * Math.sin(Math.PI * Math.min(1, 0.15 + v * 0.85)) ** 0.7,
        shade: -1, spacing: HATCH * 0.6, grain: "along", reach: [0.3, 0.6], weight: 0.45, samples: 14 }, rng);
    const keel = bladeBody({ spine: v => [b[0] + f * 0.46 * v, b[1] - f * 0.04 + f * 0.16 * v * v * v], halfWidth: v => f * 0.09 * Math.sin(Math.PI * Math.min(1, 0.15 + v * 0.85)) ** 0.8,
        shade: -1, spacing: HATCH * 0.6, grain: "along", reach: [0.3, 0.7], weight: 0.5, samples: 12 }, rng);
    shapes.push(banner, wing, keel, calyx);
    return shapes;
}
/** A legume's pod, hanging along +y from its stalk; the kind sets its outline. */
function pod(rng, s, kind) {
    const dims = {
        // length, half-width, seed bulges, weight
        plump: [0.72, 0.09, 6, 0.42], broad: [0.6, 0.13, 0, 0.4], long: [1.0, 0.05, 7, 0.5], narrow: [0.7, 0.045, 0, 0.85], lentil: [0.3, 0.1, 2, 0.45],
    };
    const [L0, W0, bulges, weight] = dims[kind] ?? dims.plump;
    const L = s * L0, W = s * W0, stalk = s * 0.06;
    const curve = rng.sym(kind === "long" ? 0.25 : 0.12) * L;
    const spine = (v) => [curve * v * v, stalk + L * v];
    const halfWidth = (v) => W * smoothstep(0, kind === "lentil" ? 0.35 : 0.12, v) ** 0.6 * (1 - 0.92 * smoothstep(kind === "lentil" ? 0.55 : 0.8, 1, v))
        * (bulges > 0 ? 0.82 + 0.18 * Math.abs(Math.sin(v * bulges * Math.PI)) : 1);
    const shapes = [line([[0, 0], [0, stalk]], s * 0.015)];
    for (const sd of [1, -1])
        shapes.push(line([[0, stalk * 0.7], [sd * s * 0.04, stalk * 1.4]], s * 0.008));
    if (kind === "plump" && rng.chance(0.35)) {
        // One pod split along its seam, showing its peas.
        const valve = bladeBody({ spine, halfWidth: v => halfWidth(v) * 1.1, shade: 1, spacing: HATCH, grain: "along", reach: [0.1, 0.25], weight: 0.2, samples: 30 }, rng);
        shapes.push(valve);
        for (let k = 0; k < bulges; k += 1) {
            const v = (k + 0.5) / bulges * 0.82 + 0.06;
            shapes.push(berry(spine(v), halfWidth(v) * 0.8, 0.5));
        }
    }
    else {
        const body = bladeBody({ spine, halfWidth, shade: side(rng), spacing: HATCH * 0.75, grain: kind === "broad" ? "along" : "across", reach: [0.5, 0.9], weight, samples: 32 }, rng);
        body.veins.push(sample(v => { const [x, y] = spine(v); return [x + halfWidth(v) * 0.72, y]; }, 16, 0.06, 0.9));
        if (kind === "broad")
            body.veins.push(sample(v => { const [x, y] = spine(v); return [x + halfWidth(v) * 0.5, y]; }, 16, 0.1, 0.85));
        shapes.push(body);
    }
    const tip = spine(1), near = spine(0.96);
    shapes.push(line([tip, [tip[0] + (tip[0] - near[0]) * 2 + s * 0.03, tip[1] + (tip[1] - near[1]) * 1.5]], s * 0.01));
    return shapes;
}
/** A legume's raceme: banner flowers on alternate sides of a stalk, which become hanging pods. */
function peaRaceme(rng, s, stage, look) {
    const n = look.flowers;
    const stalk = s * (n > 2 ? 0.25 : 0.2), span = n > 1 ? s * 0.42 : 0;
    const axis = sample(v => [s * 0.05 * Math.sin(v * 2.4), (stalk + span) * v], 10);
    const shapes = [line(axis, s * 0.02)];
    const f = s * (n > 4 ? 0.3 : n > 2 ? 0.36 : 0.44);
    const count = stage === "seed" ? Math.min(n, look.pod === "lentil" ? 3 : 2) : n;
    for (let k = 0; k < count; k += 1) {
        const v = n === 1 ? 1 : 0.45 + 0.55 * (k / Math.max(1, count - 1));
        const at = axis[Math.round(v * 9)];
        const sd = k % 2 === 0 ? 1 : -1;
        if (stage === "seed") {
            const piece = pod(rng, s, look.pod);
            shapes.push(...place(piece, -sd * rng.range(0.25, 0.6), at));
            continue;
        }
        const flower = peaFlower(rng, f * rng.range(0.92, 1.05), stage === "bloom" && !(k === count - 1 && n > 2));
        shapes.push(...place(sd > 0 ? flower : flower.map(flip), -sd * rng.range(0.5, 0.8), at));
    }
    return shapes;
}
/** Honeysuckle: a whorl of long curved tubes, two-lipped, stamens thrust out; then a knot of berries. */
function honeysuckle(rng, s, stage) {
    const head = [0, s * 0.24];
    const shapes = [line([[0, 0], [rng.sym(0.03) * s, s * 0.12], head], s * 0.022)];
    if (stage === "seed") {
        const spots = Array.from({ length: rng.int(6, 9) }, () => ({ at: [head[0] + rng.sym(0.15) * s, head[1] + s * 0.08 + rng.range(0, 0.14) * s], depth: rng.u() }));
        for (const { at } of spots.sort((a, b) => a.depth - b.depth))
            shapes.push(berry(at, s * 0.072, 0.5));
        return shapes;
    }
    const n = stage === "bud" ? rng.int(6, 8) : rng.int(7, 9);
    const tubes = [];
    for (let k = 0; k < n; k += 1) {
        const u = n === 1 ? 0 : k / (n - 1) * 2 - 1;
        const angle = -u * 1.35 + rng.sym(0.1);
        const len = s * (stage === "bud" ? 0.36 : 0.48) * rng.range(0.85, 1.05), bow = -u * len * 0.18;
        const spine = (v) => [bow * v * v, len * v];
        const tube = [];
        if (stage === "bud") {
            tube.push(bladeBody({ spine, halfWidth: v => s * (0.02 + 0.04 * v ** 3) * (1 - smoothstep(0.93, 1, v) * 0.6), shade: 1, spacing: HATCH * 0.6, grain: "along", reach: [0.4, 0.8], weight: 0.5, samples: 14 }, rng));
        }
        else {
            const mouth = spine(1);
            const lip = (angleOf, length, width) => turnShape(bladeBody({ spine: v => [0, length * v], halfWidth: v => width * v ** 0.4 * (1 - v) ** 0.6 * 1.6, shade: 1, spacing: HATCH * 0.6, grain: "along", reach: [0.2, 0.5], weight: 0.3, samples: 10 }, rng), angleOf, mouth);
            const out = Math.atan2(-(mouth[0] - spine(0.9)[0]), mouth[1] - spine(0.9)[1]);
            const sd = u >= 0 ? -1 : 1;
            for (let j = 0; j < 5; j += 1) {
                const a = out + (j - 2) * 0.12 + sd * 0.15, l = s * rng.range(0.14, 0.2);
                tube.push(line([mouth, [mouth[0] - Math.sin(a) * l, mouth[1] + Math.cos(a) * l]], s * 0.004));
            }
            tube.push(bladeBody({ spine, halfWidth: v => s * (0.018 + 0.03 * v * v), shade: 1, spacing: HATCH * 0.6, grain: "along", reach: [0.3, 0.6], weight: 0.4, samples: 14 }, rng));
            tube.push(lip(out + sd * 1.9, s * 0.17, s * 0.065), lip(out - sd * 2.3, s * 0.16, s * 0.025));
            const style = out + sd * 0.05, sl = s * 0.22;
            tube.push({ type: "dots", points: [[mouth[0] - Math.sin(style) * sl, mouth[1] + Math.cos(style) * sl]], radius: s * 0.012, tone: "accent" });
        }
        tubes.push(place(tube, angle, head));
    }
    // The outer tubes lie behind, the upright ones in front.
    tubes.forEach((tube, k) => { if (Math.abs(k / Math.max(1, n - 1) * 2 - 1) > 0.5)
        shapes.push(...tube); });
    tubes.forEach((tube, k) => { if (Math.abs(k / Math.max(1, n - 1) * 2 - 1) <= 0.5)
        shapes.push(...tube); });
    return shapes;
}
/** Jasmine: a few long-tubed flowers opening to a five-lobed star, then pairs of black berries. */
function jasmine(rng, s, stage) {
    const fork = [0, s * 0.22];
    const shapes = [line([[0, 0], fork], s * 0.02)];
    const count = Math.max(1, Math.min(5, rng.int(3, 4)));
    for (let k = 0; k < count; k += 1) {
        const angle = (k / Math.max(1, count - 1) * 2 - 1) * 0.75 + rng.sym(0.08);
        const flower = [line([[0, 0], [0, s * 0.1]], s * 0.012)];
        if (stage === "seed") {
            for (const sd of [1, -1])
                flower.push(...darkBerry([sd * s * 0.05, s * 0.16], s * 0.055));
            shapes.push(...place(flower, angle, fork));
            continue;
        }
        const len = s * 0.3, mouth = [0, s * 0.1 + len];
        flower.push(bladeBody({ spine: v => [0, s * 0.1 + len * v], halfWidth: v => s * (0.016 + 0.006 * v), shade: 1, spacing: HATCH * 0.6, grain: "along", reach: [0.3, 0.6], weight: 0.35, samples: 8 }, rng));
        if (stage === "bud") {
            flower.push(oval([0, mouth[1] + s * 0.035], s * 0.03, s * 0.05, 0.6));
        }
        else {
            const tilt = rng.range(0.4, 0.65), start = rng.range(0, TAU), lr = s * 0.19;
            const lobes = Array.from({ length: 5 }, (_, j) => start + j / 5 * TAU).sort((a, b) => Math.sin(b) - Math.sin(a));
            for (const a of lobes) {
                flower.push(bladeBody({ spine: v => [mouth[0] + Math.cos(a) * lr * v, mouth[1] + Math.sin(a) * lr * v * tilt], halfWidth: v => lr * 0.3 * v ** 0.5 * (1 - v) ** 0.5 * 1.6,
                    shade: Math.cos(a) > 0 ? 1 : -1, spacing: HATCH * 0.6, grain: "along", reach: [0.1, 0.25], weight: 0.15, samples: 10 }, rng));
            }
            flower.push({ type: "dots", points: [mouth], radius: s * 0.014 });
        }
        shapes.push(...place(flower, angle, fork));
    }
    return shapes;
}
const BLOOMS = {
    bunch: { draw: bunch, hangs: () => true, proxy: 0.5, max: 8 },
    strobile: { draw: strobile, hangs: stage => stage !== "bud", proxy: 0.45, max: 6 },
    umbel: { draw: ivyUmbels, hangs: () => false, proxy: 0.48, max: 7 },
    cup: { draw: (rng, s, stage, look) => stage === "seed" ? gourd(rng, s, look.gourd) : cupFlower(rng, s, stage === "bloom", rng.chance(0.5)), hangs: stage => stage === "seed", proxy: 0.6, max: 5 },
    pea: { draw: peaRaceme, hangs: stage => stage === "seed", proxy: 0.48, max: 9 },
    tube: { draw: honeysuckle, hangs: () => false, proxy: 0.45, max: 8 },
    star: { draw: jasmine, hangs: () => false, proxy: 0.42, max: 9 },
};
/** At a shoot's tip a hanging fruit arches over on its stalk and hangs beside it. */
function arching(draw) {
    return (rng, s, stage) => {
        const sd = side(rng);
        const end = [sd * s * 0.22, s * 0.26];
        const stalk = line(sample(bezier3([0, 0], [0, s * 0.2], [sd * s * 0.12, s * 0.32], end), 8), s * 0.022);
        return [stalk, ...place(draw(rng, s, stage), toward(sd * 0.35, -1), end)];
    };
}
// ---------------------------------------------------------------- the form
const PALMS = {
    vine: { angles: [0, 52, 112], reach: [1, 0.9, 0.62], sinus: 0.06, teeth: 34, tooth: 0.06, petiole: 0.24, rootlets: false },
    ivy: { angles: [0, 62, 112], reach: [1, 0.72, 0.48], sinus: 0.22, teeth: 0, tooth: 0, petiole: 0.3, rootlets: true },
    gourd: { angles: [0, 55, 115], reach: [1, 0.92, 0.68], sinus: 0.05, teeth: 56, tooth: 0.025, petiole: 0.3, rootlets: false },
};
function leafOf(variant) {
    const kind = textOf(variant, "leaf");
    const attach = textOf(variant, "attach");
    const palm = PALMS[kind];
    if (palm) {
        const spec = { ...palm, depth: numberOf(variant, "lobes"), pointed: textOf(variant, "lobeTips") === "pointed" };
        return { leaf: (rng, length) => palmLeaf(rng, length, spec), proxy: 0.42, scale: kind === "gourd" ? 1.15 : kind === "ivy" ? 0.8 : 1 };
    }
    if (kind === "trifoliate")
        return { leaf: trifoliate, proxy: 0.38, scale: 1 };
    if (kind === "oval")
        return { leaf: (rng, length, bend) => simpleLeaf(rng, length, bend, 0.34), proxy: 0.26, scale: 0.65 };
    const spec = { pairs: numberOf(variant, "leaflets"), tendril: attach === "coil" ? "simple" : attach === "branched" ? "forked" : "none", stipules: flagOf(variant, "stipules"), winged: flagOf(variant, "winged") };
    return { leaf: (rng, length, bend) => pinnate(rng, length, bend, spec), proxy: 0.3, scale: 1 };
}
export const form = {
    id: "grimpante",
    name: "grimpante",
    doc: "Climbers held by tendrils, twining or rootlets: lobed, pinnate or trifoliate leaves; bunches, cones, berries, gourds or pods.",
    variants: {
        attach: { doc: "How it holds on: coiled simple tendrils (gourds, lentil), forked tendrils (vine, pea, vetch), twining shoots wound about each other, or clinging rootlets (ivy)", default: "branched", values: ["coil", "branched", "twining", "clinging"] },
        leaf: { doc: "Leaf: toothed palmate vine leaf, ivy leaf, broad gourd leaf, pinnate (tendrilled or odd-ended), trifoliate, or simple oval", default: "vine", values: ["vine", "ivy", "gourd", "pinnate", "trifoliate", "oval"] },
        lobes: { doc: "How deep the palmate lobes are cut (vine, ivy, gourd leaves)", default: 0.3, range: [0, 0.9] },
        lobeTips: { doc: "Lobe tips rounded (melon, potiron) or pointed (ivy, concombre, pastèque)", default: "pointed", values: ["round", "pointed"] },
        leaflets: { doc: "Pairs of leaflets on a pinnate leaf", default: 2, range: [1, 8] },
        stipules: { doc: "Large leafy stipules clasping the leaf's base (pois)", default: false, values: [true, false] },
        winged: { doc: "Winged leaf stalks (gesse)", default: false, values: [true, false] },
        bloom: { doc: "Bloom and what it becomes: grape bunch, hop cones, ivy umbels and black berries, gourd flower and gourd, pea flowers and pods, honeysuckle whorl and berries, jasmine stars and black berries", default: "bunch", values: Object.keys(BLOOMS) },
        flowers: { doc: "Flowers on a pea raceme", default: 2, range: [1, 8] },
        pod: { doc: "Pod outline: plump pea pod, broad winged gesse pod, long bean, narrow dark vetch pod, short lentil pod", default: "plump", values: ["plump", "broad", "long", "narrow", "lentil"] },
        gourd: { doc: "Gourd: squat ribbed potiron, round ribbed citrouille, warty concombre, netted melon, striped pastèque", default: "pumpkin", values: ["pumpkin", "pepo", "cucumber", "melon", "watermelon"] },
        woody: { doc: "Thick woody stems (vine, ivy)", default: false, values: [true, false] },
        size: { doc: "Bloom and fruit size relative to the vine's", default: 1, range: [0.6, 1.5] },
    },
    examples: [
        { name: "raisin", variant: { woody: true } },
        { name: "houblon", variant: { attach: "twining", lobes: 0.42, bloom: "strobile" } },
        { name: "lierre", variant: { attach: "clinging", leaf: "ivy", lobes: 0.4, bloom: "umbel", woody: true } },
        { name: "pois", variant: { leaf: "pinnate", leaflets: 2, stipules: true, bloom: "pea", flowers: 2, pod: "plump" } },
        { name: "haricots", variant: { attach: "twining", leaf: "trifoliate", bloom: "pea", flowers: 4, pod: "long" } },
        { name: "potiron", variant: { attach: "coil", leaf: "gourd", lobes: 0.15, lobeTips: "round", bloom: "cup", gourd: "pumpkin", size: 1.25 } },
        { name: "concombre", variant: { attach: "coil", leaf: "gourd", lobes: 0.3, bloom: "cup", gourd: "cucumber" } },
        { name: "chèvrefeuille", variant: { attach: "twining", leaf: "oval", bloom: "tube" } },
        { name: "jasmin", variant: { attach: "twining", leaf: "pinnate", leaflets: 3, bloom: "star", size: 0.85 } },
    ],
    build(variant) {
        const attach = textOf(variant, "attach");
        const bloom = BLOOMS[textOf(variant, "bloom")];
        const size = numberOf(variant, "size");
        const woody = flagOf(variant, "woody");
        const look = { pod: textOf(variant, "pod"), gourd: textOf(variant, "gourd"), flowers: numberOf(variant, "flowers") };
        const { leaf, proxy: leafProxy, scale: leafScale } = leafOf(variant);
        const draw = (rng, s, stage) => bloom.draw(rng, s, stage, look);
        const hanging = arching(draw);
        const terminal = (rng, s, stage) => bloom.hangs(stage) ? hanging(rng, s, stage) : draw(rng, s, stage);
        const twining = attach === "twining";
        const holdOn = attach === "twining" ? (rng, s) => twine(rng, s)
            : attach === "clinging" ? (rng, s) => runner(rng, s, (r, length) => leaf(r, length, r.sym(0.2)))
                : attach === "coil" ? (rng, s) => tendril(rng, s, s * 0.016, rng.range(2, 3)) : (rng, s) => forkedTendril(rng, s, s * 0.016);
        const gourds = textOf(variant, "bloom") === "cup";
        return {
            id: "grimpante",
            stems: {
                count: woody ? 2 : 3,
                amplitude: twining ? 0.16 : woody ? 0.11 : 0.13,
                lambda: twining ? [2.4, 3.6] : [3, 4.6],
                width: woody ? 0.085 : gourds ? 0.06 : 0.045,
                tops: [0.92, 0.72, 0.52],
            },
            basal: null,
            nodes: { every: [1.4, 2.1], length: height => lerp(2.3, 1.5, height) * leafScale, angle: [35, 62], below: 0.95 },
            leafProxy,
            leaf,
            // Branch leaflets and fillers: a small palmate leaf, or one leaflet of a compound leaf.
            leaflet: PALMS[textOf(variant, "leaf")] ? (rng, length, bend) => leaf(rng, length * 0.9, bend) : (rng, length, bend) => simpleLeaf(rng, length * 0.8, bend, 0.3),
            terminal: { size: [1.1 * size, 1.4 * size], r: s => bloom.proxy * s, off: () => 0, draw: terminal },
            motifs: [
                { name: "bloom", w: 3, smin: 0.75 * size, smax: 1.2 * size, max: bloom.max, hard: true, layer: LAYER.bloom, upright: bloom.hangs("seed") ? -0.35 : 0.5, staged: true,
                    r: s => bloom.proxy * s, off: s => 0.45 * s, draw },
                { name: "leaf", w: 2, smin: 1.2 * leafScale, smax: 2.2 * leafScale, max: PALMS[textOf(variant, "leaf")] ? 9 : 12, hard: true, layer: LAYER.leaf, upright: 0.25,
                    r: s => leafProxy * 1.1 * s, off: s => 0.55 * s, draw: (rng, s) => leaf(rng, s, rng.sym(0.25)) },
                { name: attach === "twining" ? "twine" : attach === "clinging" ? "runner" : "tendril", w: 1.4, smin: 0.6, smax: 1.1, max: 9, hard: true,
                    layer: attach === "clinging" ? LAYER.leaf : LAYER.airy, upright: 0.7, r: s => 0.32 * s, off: s => 0.45 * s, draw: holdOn },
            ],
        };
    },
};
