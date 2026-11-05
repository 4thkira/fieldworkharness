// Scape-and-strap plants: a rosette of strap leaves (or broad paired leaves, or a lily's whorls) round a
// bare scape that carries six-tepalled flowers, singly, in a raceme or in an umbel, with a bulb at the
// root. Cups, goblets, trumpets, starry narcissi with their corona, hanging bells, turk's caps, waxy
// tubes and an allium's ball of florets; then upright capsules, red berries, bulbils or a dry umbel
// (tulipe, narcisse, jonquille, hyacinthe, martagon, muguet, safran, colchique, perce-neige, ail).
import { LAYER, numberOf, textOf, flagOf } from "../form.js";
import { bezier3, lerp, sample, smoothstep, unit } from "../geometry.js";
import { circle, HATCH, line, side, simpleLeaf, strapLeaf, turnShape } from "../kit.js";
import { bladeBody, roundBody } from "../shapes.js";
import { arrange, egg, petal, placeAll, polarLeaf, project } from "./rosacee-coupe.form.js";
// ---------------------------------------------------------------- one flower
/** A tepal's half-width along its length: narrow at the claw, round-tipped or drawn to a point. */
function tepalWidth(length, share, tip) {
    if (tip === "pointed")
        return v => length * share * 1.6 * v ** 0.5 * (1 - v) ** 0.8 + length * 0.008;
    return v => length * share * (0.35 + 0.65 * Math.sin(Math.PI / 2 * Math.min(1, v / 0.6))) * (1 - 0.35 * Math.max(0, (v - 0.6) / 0.4));
}
/** The tepal centreline's control points (in units of the flower's length), its tip, the view, and a perianth tube. */
const SHAPES = {
    cup: { path: [[0.02, 0], [0.32, 0.08], [0.38, 0.6], [0.24, 1.0]], tip: "pointed", tilt: 0.35, tube: 0 },
    goblet: { path: [[0.02, 0], [0.14, 0.1], [0.26, 0.42], [0.27, 0.62]], tip: "round", tilt: 0.35, tube: 0.38 },
    trumpet: { path: [[0.03, 0], [0.07, 0.35], [0.22, 0.72], [0.46, 0.8]], tip: "pointed", tilt: 0.55, tube: 0 },
    corona: { path: [[0.02, 0], [0.2, 0.02], [0.4, 0.03], [0.55, 0]], tip: "pointed", tilt: 1.1, tube: 0 },
    bell: { path: [[0.02, 0], [0.26, 0.04], [0.3, 0.55], [0.22, 1.0]], tip: "round", tilt: 0.3, tube: 0 },
    turban: { path: [[0.02, 0], [0.25, 0.12], [0.42, -0.02], [0.26, -0.36]], tip: "pointed", tilt: 0.3, tube: 0 },
    tube: { path: [[0.07, 0.55], [0.16, 0.62], [0.28, 0.64], [0.34, 0.56]], tip: "round", tilt: 0.5, tube: 0.55 },
    reflexed: { path: [[0.05, 0], [0.18, -0.1], [0.4, -0.45], [0.45, -0.82]], tip: "round", tilt: 0.4, tube: 0 },
};
/** A narrow tube along the axis (crocus, tuberose, hyacinth), as long on the page as the view allows. */
function perianthTube(rng, L, length) {
    return bladeBody({ spine: v => [0, length * v], halfWidth: v => L * lerp(0.035, 0.07, v ** 2), shade: 1, spacing: HATCH * 0.7, grain: "along", reach: [0.5, 0.9], weight: 0.5, samples: 10 }, rng);
}
/** A bell of six joined tepals hanging from its base (muguet, fritillaire): one body, its lip in six points. */
function fusedBell(rng, L, lily) {
    const r0 = L * lily.tepalWidth * 1.1;
    const radius = (v) => r0 * Math.sin(Math.PI / 2 * Math.min(1, (v + 0.04) / 0.38)) ** 0.8 * (1 + lily.lip * smoothstep(0.65, 1, v) * 1.6);
    const n = 16;
    const rightSide = sample(v => [radius(v), L * v], n);
    const lipR = radius(1);
    const teeth = [];
    for (let k = 1; k < 6; k += 1) {
        const x = lipR * (1 - k / 3);
        teeth.push([x, L * (k % 2 === 1 ? 0.97 - lily.lip * 0.15 : 1.06 + lily.lip * 0.1)]);
    }
    const outline = [...rightSide, [lipR * 1.04, L * 1.06 + lily.lip * L * 0.1], ...teeth, [-lipR * 1.04, L * 1.06 + lily.lip * L * 0.1], ...rightSide.slice(1).reverse().map(([x, y]) => [-x, y])];
    const centre = [0, L * 0.5];
    const body = roundBody(outline, centre, r0, HATCH * 0.6, lily.pattern === "checkered" ? 0.8 : 0.4, [-0.6, -0.8]);
    if (lily.pattern === "checkered") {
        // The fritillary's chequer: a grid of cuts over the whole bell.
        body.shadow = [];
        body.grain = [...[-0.6, -0.2, 0.2, 0.6].map(q => sample(v => [q * radius(v), L * v], 8, 0.06, 0.98)),
            ...Array.from({ length: 7 }, (_, k) => { const v = 0.12 + k * 0.12; return [[-radius(v), L * v], [radius(v), L * v]]; })];
    }
    body.veins = [-0.5, 0, 0.5].map(q => sample(v => [q * radius(v), L * v], 8, 0.2, 0.96));
    return [body, { type: "dots", points: [[0, L * 1.0 + rng.sym(0.01) * L]], radius: L * 0.03 }];
}
/** One open flower, axis +y from its base, `L` long. */
function flower(rng, L, lily) {
    if (lily.flower === "bell" && lily.tepals === 6)
        return fusedBell(rng, L, lily);
    const shape = SHAPES[lily.flower] ?? SHAPES.cup;
    const tilt = shape.tilt + rng.sym(0.05);
    const ct = Math.cos(tilt);
    const parts = [];
    const start = rng.range(0, Math.PI * 2);
    const count = lily.flower === "reflexed" ? 5 : lily.tepals;
    // A bell with three tepals spreads them wider (snowdrop); a muguet's bell flares at the lip.
    const flare = lily.flower === "bell" && count < 6 ? 0.12 : 0;
    for (let k = 0; k < count; k += 1) {
        const theta = start + k / count * Math.PI * 2 + rng.sym(0.06);
        const inner = count === 6 && k % 2 === 1;
        const len = L * (inner && lily.flower === "cup" ? 0.95 : 1) * rng.range(0.95, 1.04);
        const [p0, p1, p2, p3] = shape.path.map(([r, h], index) => [(r + (index === 3 ? flare : 0)) * len, h * len]);
        const spec = { path: bezier3(p0, p1, p2, p3), width: tepalWidth(len * (lily.flower === "corona" ? 0.55 : 1), lily.tepalWidth * (inner ? 0.9 : 1), shape.tip),
            tip: shape.tip, weight: lily.pattern === "checkered" ? 0.8 : 0.35, pattern: lily.pattern, samples: 14 };
        parts.push(petal(rng, theta, tilt, spec));
    }
    if (lily.flower === "bell" && count < 6) {
        // The snowdrop's short inner cup, notched and marked green at the tip.
        for (let k = 0; k < 3; k += 1) {
            const theta = start + (k + 0.5) / 3 * Math.PI * 2;
            parts.push(petal(rng, theta, tilt, { path: bezier3([0.02 * L, 0], [0.12 * L, 0.1 * L], [0.14 * L, 0.35 * L], [0.12 * L, 0.5 * L]), width: v => L * 0.09 * (0.5 + 0.5 * v), tip: "notch", weight: 0.4, lanes: 1, samples: 10 }));
        }
        parts.push({ depth: 99, shapes: [{ type: "dots", points: [project(0, tilt, 0.12 * L, 0.5 * L)], radius: L * 0.035 }] });
    }
    if (lily.flower === "corona" && lily.corona > 0) {
        // The corona: a short cup of overlapping segments in the star's heart, crinkled (and red-rimmed) at its lip.
        const height = lily.corona * L, radius = L * (0.1 + lily.corona * 0.15);
        for (let k = 0; k < 9; k += 1) {
            const theta = start + k / 9 * Math.PI * 2;
            parts.push(petal(rng, theta, tilt, { path: bezier3([radius * 0.8, 0], [radius * 0.85, height * 0.4], [radius * 0.95, height * 0.8], [radius * 1.05, height]),
                width: () => radius * 0.42, tip: "fringe", weight: 0.45, lanes: lily.corona > 0.2 ? 2 : 0, samples: 6 }));
        }
        const lip = sample(v => project(v * Math.PI * 2, tilt, radius * 1.05, height), 24);
        parts.push({ depth: 99, shapes: [line(lip, L * 0.03, true, lily.rim ? "accent" : undefined)] });
    }
    if (lily.flower === "trumpet" || lily.flower === "turban") {
        // Six long stamens, curving up out of the throat, and the style among them.
        const ends = [];
        const lines = [];
        for (let k = 0; k < 7; k += 1) {
            const u = k / 6 * 2 - 1;
            const end = [u * L * 0.22, L * (lily.flower === "turban" ? 0.72 : 0.95) + L * 0.06 * (1 - u * u)];
            lines.push(line(sample(bezier3([0, L * 0.1], [u * L * 0.05, L * 0.4], [u * L * 0.18, L * 0.6], end), 6), L * 0.012));
            if (k !== 3)
                ends.push(end);
        }
        parts.push({ depth: 99, shapes: [...lines, { type: "dots", points: ends, radius: L * 0.03, tone: "accent" }] });
    }
    if (lily.flower === "reflexed")
        parts.push({ depth: 99, shapes: [{ type: "dots", points: [[0, L * 0.01]], radius: L * 0.06 }] });
    const lift = shape.tube * L * ct;
    if (lily.stigma) {
        // Saffron's three long red stigmas, spilling over the rim.
        const base = [0, L * 0.1];
        parts.push({ depth: 99, shapes: [-1, 0.15, 1].map(u => line(sample(bezier3(base, [u * L * 0.1, L * 0.5], [u * L * 0.35, L * 0.75], [u * L * 0.45, L * (u === 0.15 ? 0.85 : 0.55)]), 8), L * 0.035, true, "accent")) });
    }
    else if (lily.flower === "goblet") {
        parts.push({ depth: 99, shapes: [{ type: "dots", points: Array.from({ length: 6 }, (_, k) => [Math.cos(k) * L * 0.06, L * 0.32 + Math.sin(k) * L * 0.03]), radius: L * 0.025, tone: "accent" }] });
    }
    const head = arrange(parts).map(item => turnShape(item, 0, [0, lift]));
    return lift > 0 ? [perianthTube(rng, L, lift), ...head] : head;
}
/** A closed bud along +y: a pointed egg with its tepals' seams; in a papery spathe if the plant has one. */
function closedBud(rng, L, lily) {
    const length = L * (lily.flower === "trumpet" || lily.flower === "tube" ? 0.8 : 0.6), width = L * (lily.flower === "bell" ? 0.3 : 0.22);
    const out = [];
    const shapeTube = SHAPES[lily.flower]?.tube ?? 0;
    if (shapeTube > 0)
        out.push(perianthTube(rng, L, L * shapeTube * 0.8));
    const base = [0, L * shapeTube * 0.8];
    const bud = roundBody(egg(base, length, width, 0.7), [base[0], base[1] + length * 0.5], width / 2, HATCH * 0.6, 0.5);
    bud.veins = [-0.35, 0.3].map(q => sample(v => [base[0] + q * width * Math.sin(Math.PI * v) ** 0.8, base[1] + length * v], 8, 0.15, 0.95));
    if (lily.spathe)
        out.push(spathe(rng, L * 0.5, 0.35));
    out.push(bud);
    return out;
}
/** A papery bract drawn to a point, leaning by `lean` radians. */
function spathe(rng, length, lean) {
    const spine = (v) => [Math.sin(lean) * length * v + length * 0.08 * v * v, Math.cos(lean) * length * v];
    return bladeBody({ spine, halfWidth: v => length * 0.12 * (1 - v) ** 0.9 * Math.min(1, v * 4 + 0.3), shade: 1, spacing: HATCH * 0.8, grain: "along", reach: [0.3, 0.6], weight: 0.3, midrib: true, samples: 12 }, rng);
}
// ---------------------------------------------------------------- what the flower becomes
/** An upright three-ribbed capsule along +y, with the withered tepals at its foot. */
function capsule(rng, L) {
    const length = L * 0.55, width = L * 0.24;
    const body = roundBody(egg([0, L * 0.05], length, width, 0.1), [0, L * 0.05 + length * 0.5], width / 2, HATCH * 0.55, 0.6);
    body.veins = [-0.4, 0, 0.4].map(q => sample(v => [q * width / 2 * Math.sin(Math.PI * v) ** 0.5, L * 0.05 + length * v], 8, 0.05, 0.95));
    const remnants = [-1, 1].map(sd => line([[0, L * 0.05], [sd * L * 0.08, rng.range(0.02, 0.06) * L]], L * 0.02));
    return [...remnants, body, line([[0, L * 0.05 + length], [0, L * 0.1 + length]], L * 0.02)];
}
// ---------------------------------------------------------------- on the scape
/** One flower, bud or fruit on its pedicel, turned to face up, out or down. */
function onPedicel(rng, L, stage, lily, length, sd, facing) {
    let face = facing;
    if (stage === "seed")
        face = lily.seed === "berries" || lily.seed === "hanging" ? "nod" : "up";
    else if (stage === "bud" && lily.flower === "corona")
        face = "out";
    const end = face === "nod" ? [sd * length * 0.55, length * 0.85] : face === "out" ? [sd * length * 0.35, length * 0.95] : [sd * length * 0.08, length];
    const pull = face === "nod" ? [sd * length * 0.2, length * 1.25] : [end[0] * 0.3, length * 0.7];
    const points = sample(bezier3([0, 0], [0, length * 0.4], pull, end), 6);
    const berry = roundBody(circle([0, L * 0.18], L * 0.17), [0, L * 0.18], L * 0.17, HATCH * 0.5, 0.6, [-0.6, 0.8], "accent");
    const head = stage === "bud" ? closedBud(rng, L, lily) : stage === "seed" ? (lily.seed === "berries" ? [berry] : capsule(rng, L)) : flower(rng, L, lily);
    const angle = face === "out" ? -sd * 1.15 : face === "nod" ? -sd * (Math.PI - 0.3) : -sd * 0.12;
    return [line(points, L * 0.035), ...placeAll(head, angle, end)];
}
/** A cyclamen's fruit: the stalk coils down like a spring, drawing the round capsule to the ground. */
function coiled(rng, s) {
    const turns = 3.2;
    const coil = sample(t => [Math.sin(t * turns * Math.PI * 2) * s * 0.07 + rng.sym(0.001), s * 0.15 - t * s * 0.5], 60);
    const at = [0, -s * 0.42];
    return [line([[0, 0], [0, s * 0.15]], s * 0.018), line(coil, s * 0.014), roundBody(circle(at, s * 0.1), at, s * 0.1, HATCH * 0.55, 0.65)];
}
/** An allium's head: a ball of starry florets on fine pedicels, in bud a beaked papery spathe. */
function ball(rng, s, stage, lily) {
    // The scape rises, or (garlic) hooks over so the head looks aside; the head is drawn from its neck.
    const hook = lily.arch > 0;
    const neck = hook ? [s * 0.3 * lily.arch, s * 0.42] : [0, s * 0.1];
    const stalk = hook ? sample(bezier3([0, 0], [0, s * 0.42], [s * 0.2 * lily.arch, s * 0.62], neck), 10) : [[0, 0], neck];
    const turn = hook ? -1.4 * lily.arch : 0;
    const head = [];
    const radius = s * 0.26 * (0.75 + 0.25 * Math.min(1, lily.flowers / 40));
    const centre = [0, radius * 1.05];
    const done = () => [line(stalk, s * 0.022), ...placeAll(head, turn, neck)];
    if (stage === "bud") {
        const length = radius * 1.6, beak = lily.spathe ? s * (0.25 + 0.35 * lily.arch) : s * 0.06;
        const body = roundBody(egg([0, 0], length, radius * 1.1, 0.8), [0, length * 0.5], radius * 0.55, HATCH * 0.7, 0.35);
        body.veins = [-0.3, 0, 0.3].map(q => sample(v => [q * radius * Math.sin(Math.PI * v), length * v], 8, 0.1, 0.9));
        head.push(body, line(sample(v => [beak * 0.3 * v * v, length + beak * v], 6), s * 0.012));
        return done();
    }
    const count = Math.round(lily.flowers);
    const golden = Math.PI * (3 - Math.sqrt(5));
    const front = [], rim = [];
    for (let k = 0; k < count; k += 1) {
        const z = 1 - 2 * (k + 0.5) / count, r = Math.sqrt(1 - z * z), a = k * golden;
        const p = [centre[0] + Math.cos(a) * r * radius, centre[1] + z * radius];
        const depth = Math.sin(a) * r;
        if (depth < -0.2)
            continue;
        (depth < 0.35 ? rim : front).push(p);
    }
    if (lily.spathe)
        head.push(turnShape(spathe(rng, s * 0.22, 0), Math.PI * 0.75));
    for (const p of rim)
        head.push(line([[centre[0] + (p[0] - centre[0]) * 0.2, centre[1] + (p[1] - centre[1]) * 0.2], p], s * 0.005, false));
    const all = [...rim, ...front];
    if (stage === "seed" && lily.seed === "bulbils") {
        // Garlic's head of bulbils, packed tight.
        for (const p of all.filter((_, k) => k % 3 === 0))
            head.push(roundBody(circle(p, s * 0.05, s * 0.06, 10), p, s * 0.055, HATCH * 0.55, 0.55));
        return done();
    }
    if (stage === "seed") {
        // A dry head: three-lobed capsules split to their black seeds.
        head.push({ type: "dots", points: all, radius: s * 0.022 }, { type: "dots", points: all.map(([x, y]) => [x + s * 0.02, y + s * 0.012]), radius: s * 0.01 });
        return done();
    }
    // Each floret a small six-pointed star.
    for (const p of all) {
        const a0 = rng.range(0, Math.PI);
        for (let k = 0; k < 3; k += 1) {
            const a = a0 + k * Math.PI / 3, dx = Math.cos(a) * s * 0.025, dy = Math.sin(a) * s * 0.025;
            head.push(line([[p[0] - dx, p[1] - dy], [p[0] + dx, p[1] + dy]], s * 0.007, false));
        }
    }
    head.push({ type: "dots", points: front.filter((_, k) => k % 4 === 0), radius: s * 0.009, tone: "accent" });
    return done();
}
/** The inflorescence at the top of a scape, `s` tall: solitary, a raceme or spike, an umbel or a ball. */
function inflorescence(rng, s, stage, lily) {
    if (lily.flower === "reflexed" && stage === "seed")
        return coiled(rng, s);
    if (lily.flower === "star")
        return ball(rng, s, stage, lily);
    const sd = side(rng);
    if (lily.cluster === "solitary") {
        const out = onPedicel(rng, s * 0.8, stage, lily, s * 0.22, sd, lily.facing);
        if (lily.spathe && stage !== "bud")
            out.unshift(spathe(rng, s * 0.24, sd * 0.5));
        return out;
    }
    const out = [];
    const n = Math.max(2, Math.round(lily.flowers));
    if (lily.cluster === "umbel") {
        const hub = [0, s * 0.06];
        out.push(line([[0, 0], hub], s * 0.03));
        if (lily.spathe)
            for (const lean of [-0.7, 0.8])
                out.push(turnShape(spathe(rng, s * 0.2, 0), lean + Math.PI, hub));
        const order = Array.from({ length: n }, (_, k) => k).sort((a, b) => Math.abs(b - (n - 1) / 2) - Math.abs(a - (n - 1) / 2));
        for (const k of order) {
            const u = n === 1 ? 0 : k / (n - 1) * 2 - 1;
            const sub = stage === "bloom" && n > 3 && k === order[0] ? "bud" : stage;
            // In an umbel the spread of the pedicels already turns each flower outward.
            out.push(...placeAll(onPedicel(rng, s * 0.42, sub, lily, s * 0.3 * (1 - 0.2 * Math.abs(u)), u >= 0 ? 1 : -1, lily.facing === "out" ? "up" : lily.facing), -u * 1.15, hub));
        }
        return out;
    }
    // A raceme (or a spike when the pedicels are short): flowers up the axis, smaller toward the top, the
    // last few still in bud; an arching raceme carries them all on its outer side (muguet).
    const spike = lily.cluster === "spike";
    const archSide = sd;
    const axis = (v) => [archSide * lily.arch * s * 0.4 * v * v, s * 0.95 * v * (1 - 0.25 * lily.arch * v)];
    out.push(line(sample(axis, 12), s * 0.018));
    // Flowers no wider than their spacing allows, so a dense raceme stays legible.
    const spacing = 0.82 * s * 0.95 / Math.max(1, n - 1);
    for (let k = n - 1; k >= 0; k -= 1) {
        const v = 0.15 + 0.82 * k / Math.max(1, n - 1);
        const at = axis(v);
        const flowerSide = lily.arch > 0 ? archSide : k % 2 === 0 ? 1 : -1;
        const sub = stage === "bloom" && k >= n - (n > 5 ? 2 : 1) ? "bud" : stage;
        const L = Math.min(s * (spike ? 0.34 : 0.42), spacing * (spike ? 3.2 : 1.6)) * (1 - 0.3 * v);
        const tangent = unit(axis(v + 0.01)[0] - at[0], axis(v + 0.01)[1] - at[1]);
        const lean = Math.atan2(-tangent[0], tangent[1]) - flowerSide * (spike ? 1.05 : 0.75);
        out.push(...placeAll(onPedicel(rng, L, sub, lily, s * (spike ? 0.03 : 0.1), flowerSide, spike ? "up" : lily.facing), lean, at));
    }
    return out;
}
// ---------------------------------------------------------------- leaves and bulb
/** A bulb at the root, round about its own centre so every rosette leaf can draw it in its own frame. */
function bulb(rng, kind, r) {
    const at = [0, 0];
    switch (kind) {
        case "cluster": return [-1, 1, 0].map(k => { const c = [k * r * 0.55, -Math.abs(k) * r * 0.15]; return roundBody(circle(c, r * 0.6, r * 0.65, 14), c, r * 0.6, HATCH * 0.6, 0.45); });
        case "cloves": {
            // Garlic's bulb, swelling in cloves.
            const outline = sample(v => { const a = v * Math.PI * 2; const k = 1 + 0.08 * Math.abs(Math.sin(a * 4)); return [Math.cos(a) * r * k, Math.sin(a) * r * 0.9 * k]; }, 48).slice(0, -1);
            const body = roundBody(outline, at, r, HATCH * 0.6, 0.4);
            body.veins = [-0.5, 0, 0.5].map(q => sample(v => [q * r * Math.sin(Math.PI * v), -r * 0.85 + r * 1.7 * v], 8));
            return [body];
        }
        case "corm": {
            // A corm in its netted tunic (crocus, colchique), or a cyclamen's flat tuber.
            const body = roundBody(circle(at, r, r * 0.75, 18), at, r, HATCH * 0.55, 0.6);
            return [body, { type: "dots", points: Array.from({ length: 10 }, () => [rng.sym(r * 0.7), rng.sym(r * 0.45)]), radius: r * 0.04 }];
        }
        default: return [roundBody(circle(at, r, r * 0.95, 20), at, r, HATCH * 0.6, 0.45)];
    }
}
/** A martagon's whorl of leaves round the stem, in a frame whose stem runs along +y. */
function whorl(rng, length) {
    const count = rng.int(6, 8);
    const start = rng.range(0, Math.PI);
    const leaves = Array.from({ length: count }, (_, k) => {
        const theta = start + k / count * Math.PI * 2;
        const reach = length * (0.45 + 0.55 * Math.abs(Math.sin(theta)));
        const [dx, dy] = unit(Math.sin(theta), -0.18 - 0.2 * Math.cos(theta));
        const shapes = simpleLeaf(rng, reach, rng.sym(0.1), 0.2).map(shape => turnShape(shape, Math.atan2(-dx, dy)));
        return { depth: Math.cos(theta), shapes };
    });
    return leaves.sort((a, b) => a.depth - b.depth).flatMap(leaf => leaf.shapes);
}
/** A broad elliptic leaf with arching parallel veins, sheathing at its foot (muguet). */
function broadLeaf(rng, length, bend) {
    const spine = (v) => [bend * length * v * v, length * v];
    const halfWidth = (v) => length * 0.2 * Math.sin(Math.PI * Math.min(1, v ** 0.8)) ** 0.8 * Math.min(1, 0.25 + v * 3) + length * 0.01;
    const veins = [-0.6, -0.3, 0.3, 0.6].map(q => sample(v => { const [x, y] = spine(v); return [x + q * halfWidth(v), y]; }, 14, 0.06, 0.92));
    return [bladeBody({ spine, halfWidth, shade: side(rng), spacing: HATCH, grain: "across", weight: 0.55, midrib: true, veins, samples: 30 }, rng)];
}
/** The leaf a kind names, without the bulb. */
function plainLeaf(kind, strap) {
    switch (kind) {
        case "rush": return (rng, length, bend) => strapLeaf(rng, length, bend * 0.6, strap * 0.45);
        case "broad": return (rng, length, bend) => broadLeaf(rng, length, bend);
        case "heart": return (rng, length, bend) => polarLeaf(rng, length, bend, { breadth: 0.9, point: 0.7, sinus: 0.75, lobes: 5, depth: 0.05, crenate: 0, petiole: 0.45, mottled: true });
        case "whorl": return rng => whorl(rng, 1.2 + rng.range(0, 0.4));
        default: return (rng, length, bend) => strapLeaf(rng, length, bend, strap);
    }
}
/** Rosette leaves are longer than any stem leaf; only they carry the bulb (see `basal` and `nodes` below). */
const BULB_LEAF = 3.4;
// ---------------------------------------------------------------- the form
export const form = {
    id: "lis-bulbe",
    name: "lis et bulbe",
    doc: "Scape-and-strap plants: six tepals singly, in racemes or umbels on a bare scape over strap leaves and a bulb; capsules, berries or bulbils after.",
    variants: {
        flower: { doc: "The flower: tulip cup, crocus goblet on a tube, flaring trumpet, starry narcissus with a corona, hanging bell, turk's cap, waxy tube, a cyclamen's swept-back petals, or an allium's ball of star florets", default: "cup",
            values: ["cup", "goblet", "trumpet", "corona", "bell", "turban", "tube", "reflexed", "star"] },
        tepals: { doc: "Tepals that show: 6, or 3 for the snowdrop's outer three", default: 6, values: [3, 6] },
        tepalWidth: { doc: "A tepal's half-width as a share of the flower's length: 0.1 narrow (martagon), 0.3 broad (tulipe)", default: 0.22, range: [0.06, 0.36] },
        facing: { doc: "The flower looks up, out to the side, or hangs", default: "up", values: ["up", "out", "nod"] },
        cluster: { doc: "One flower to a scape, a raceme up the scape, a close spike, or an umbel from its tip (an allium's ball is always an umbel)", default: "solitary", values: ["solitary", "raceme", "spike", "umbel"] },
        flowers: { doc: "Flowers in a raceme or umbel (florets in an allium's ball)", default: 6, range: [2, 60] },
        corona: { doc: "The narcissus's corona as a share of the flower's length: 0.1 a red-rimmed eye (narcisse), 0.3 a cup (jonquille)", default: 0, range: [0, 0.5] },
        rim: { doc: "The corona's lip is red (poet's narcissus)", default: false, values: [true, false] },
        pattern: { doc: "The tepals plain, chequered (fritillaire) or spotted (martagon)", default: "plain", values: ["plain", "checkered", "spotted"] },
        stigma: { doc: "Three long red stigmas spill from the flower (safran)", default: false, values: [true, false] },
        lip: { doc: "How far a joined bell's lip flares (muguet 0.3, fritillaire 0.05)", default: 0.1, range: [0, 0.4] },
        spathe: { doc: "A papery spathe at the flower's or umbel's foot (narcisse, perce-neige, allium, amaryllis)", default: false, values: [true, false] },
        arch: { doc: "How far the raceme arches to one side (muguet), or for an allium how tightly the scape curls (ail)", default: 0, range: [0, 1] },
        seed: { doc: "What follows: an upright capsule, a hanging capsule (perce-neige), red berries (muguet), bulbils (ail) or a dry seed head (civette); a cyclamen coils its stalk", default: "capsule", values: ["capsule", "hanging", "berries", "bulbils", "seedhead"] },
        leaf: { doc: "Leaf kind: strap, fine rush-like or hollow, broad paired (muguet), mottled heart (cyclamen), or a lily's whorls up the stem (martagon)", default: "strap", values: ["strap", "rush", "broad", "heart", "whorl"] },
        strap: { doc: "Strap width relative to a lily's: 0.5 for rush-fine leaves, 2 for a tulip's broad ones", default: 1, range: [0.4, 2.4] },
        stemLeaves: { doc: "Leaves clasp the lower scape as well as rising from the root (tulipe, fritillaire)", default: false, values: [true, false] },
        bulb: { doc: "The bulb at the root: none, round (oignon), a cluster of offsets (échalote), cloves (ail), or a corm or tuber (safran, colchique, cyclamen)", default: "round", values: ["none", "round", "cluster", "cloves", "corm"] },
        bulbSize: { doc: "The bulb's radius in centimetres", default: 0.4, range: [0.2, 0.8] },
        height: { doc: "How tall the scapes stand, as a share of the column", default: 0.85, range: [0.4, 1] },
        size: { doc: "Flower size relative to a tulip's", default: 1, range: [0.5, 1.6] },
    },
    examples: [
        { name: "tulipe", variant: { tepalWidth: 0.3, strap: 2, stemLeaves: true, size: 1.2 } },
        { name: "narcisse", variant: { flower: "corona", tepalWidth: 0.3, facing: "out", corona: 0.1, rim: true, spathe: true, size: 1.1 } },
        { name: "martagon", variant: { flower: "turban", tepalWidth: 0.1, facing: "nod", cluster: "raceme", flowers: 5, pattern: "spotted", leaf: "whorl", bulb: "none", height: 1 } },
        { name: "muguet", variant: { flower: "bell", tepalWidth: 0.32, facing: "nod", cluster: "raceme", flowers: 7, lip: 0.3, arch: 0.7, seed: "berries", leaf: "broad", bulb: "none", height: 0.5, size: 1.2 } },
        { name: "ail", variant: { flower: "star", cluster: "umbel", flowers: 40, spathe: true, arch: 1, seed: "bulbils", leaf: "strap", strap: 0.8, bulb: "cloves", bulbSize: 0.6 } },
    ],
    build(variant) {
        const lily = {
            flower: textOf(variant, "flower"), tepals: numberOf(variant, "tepals"), tepalWidth: numberOf(variant, "tepalWidth"), facing: textOf(variant, "facing"),
            cluster: textOf(variant, "cluster"), flowers: numberOf(variant, "flowers"), corona: numberOf(variant, "corona"), rim: flagOf(variant, "rim"),
            pattern: textOf(variant, "pattern"), stigma: flagOf(variant, "stigma"), spathe: flagOf(variant, "spathe"), arch: numberOf(variant, "arch"), seed: textOf(variant, "seed"), lip: numberOf(variant, "lip"),
        };
        const size = numberOf(variant, "size"), height = numberOf(variant, "height");
        const kind = textOf(variant, "leaf"), strap = numberOf(variant, "strap");
        const bulbKind = textOf(variant, "bulb"), bulbSize = numberOf(variant, "bulbSize");
        const whorled = kind === "whorl", stemLeaves = flagOf(variant, "stemLeaves");
        const plain = plainLeaf(kind, strap);
        // The bulb belongs to the rosette: a basal leaf draws it at its foot, under itself.
        const leaf = whorled
            ? (rng, length, bend) => whorl(rng, length).map(shape => turnShape(shape, -Math.sign(bend || 1) * Math.PI / 2))
            : (rng, length, bend) => bulbKind !== "none" && length >= BULB_LEAF ? [...plain(rng, length, bend), ...bulb(rng, bulbKind, bulbSize)] : plain(rng, length, bend);
        const draw = (rng, s, stage) => inflorescence(rng, s, stage, lily);
        const tall = lily.cluster === "raceme" || lily.cluster === "spike";
        const blade = kind === "strap" || kind === "rush" ? (rng, s) => plain(rng, s, rng.sym(0.3)) : (rng, s) => strapLeaf(rng, s, rng.sym(0.3), 0.8);
        const basalCount = kind === "broad" ? [2, 3] : kind === "rush" ? [7, 10] : kind === "heart" ? [3, 4] : [5, 8];
        const basalLength = kind === "heart" ? [BULB_LEAF / 0.65, 5.6] : kind === "broad" ? [5.4, 6.4] : [5.4, 7.6];
        return {
            id: "lis-bulbe",
            stems: { count: 3, amplitude: 0.05, lambda: [8, 12], width: lily.flower === "star" ? 0.06 : 0.05, tops: [0.85, 0.62, 0.45].map(top => top * height) },
            basal: whorled ? null : { count: basalCount, length: basalLength },
            nodes: whorled
                ? { every: [2.2, 3.0], length: () => 1.5, angle: [90, 90], below: 0.65 }
                : { every: [2.4, 3.4], length: h => lerp(3.0, 2.0, h), angle: [14, 28], below: stemLeaves ? 0.4 : 0 },
            leafProxy: whorled ? 0.45 : 0.14,
            leaf,
            leaflet: (rng, length, bend) => strapLeaf(rng, length, bend, 0.7),
            terminal: { size: [1.3 * size, 1.6 * size], r: s => (tall ? 0.5 : 0.42) * s, off: () => 0, draw },
            motifs: [
                { name: "bloom", w: 3, smin: 0.95 * size, smax: 1.35 * size, max: 5, hard: true, layer: LAYER.bloom, upright: 0.9, staged: true,
                    r: s => (tall ? 0.5 : 0.42) * s, off: s => 0.45 * s, draw },
                { name: "leaf", w: 1.5, smin: 1.4, smax: 2.2, max: 2, hard: true, layer: LAYER.leaf, upright: 0.6,
                    r: s => 0.16 * s, off: s => 0.5 * s, draw: (rng, s) => blade(rng, s) },
            ],
        };
    },
};
