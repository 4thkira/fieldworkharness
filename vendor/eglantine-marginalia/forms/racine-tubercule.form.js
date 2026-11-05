// Plants known by what they keep underground: a tapered, forked, bundled or swollen root, stem tubers on
// their runners, or a creeping woody root, drawn as an engraved root study at the foot of the column,
// with the plant growing out of its crown to say which plant it is (carotte, navet, betterave, salsifis,
// pomme de terre, topinambour, mandragore, garance, réglisse).
//
// The organ is the garden's foot. It stands under a soil line drawn across the column, a little of it
// above the ground, and the main stems and the basal rosette leave its crown. Everything under the soil
// line is the foot's room, so leaves and blooms keep to the air. In the study habit the organ is a
// specimen at the foot, 1.7 times its margin-size measures; in the long habit the root
// climbs well over half the column, its soil line near its top, and the leaves and flowers crown it.
// The organ is there from the start of the day, since it is underground; as the day fills, more fibrous rootlets
// and soil crumbs come in, and none of them leave.
import { LAYER, numberOf, textOf, flagOf } from "../form.js";
import { bezier3, clamp, lerp, sample, smoothstep, unit } from "../geometry.js";
import { berry, circle, HATCH, line, pinnateLeaf, side, simpleLeaf, strapLeaf, turnShape } from "../kit.js";
import { bladeBody, roundBody } from "../shapes.js";
const TAU = Math.PI * 2;
/** The margin column the foot is laid out for, in centimetres (see grow.ts, which keeps the top fifth as sky). */
const COLUMN_WIDTH = 6, COLUMN_HEIGHT = 22, GROWN = COLUMN_HEIGHT * 0.8;
/** Where the crown stands across the column, as a share of its width: where the stems sway about. */
const CROWN_X = 0.47;
/** The organ's lowest point, in centimetres above the paper's foot. */
const BOTTOM = 0.35;
/** The study draws the organ this much larger than its margin-size measures. */
const STUDY = 1.7;
/** A long root reaches this many centimetres below its crown besides its length, and swells by this much, to at most this half-width. */
const LONG_DEPTH = 9.6, LONG_GIRTH = 2.2, LONG_WIDEST = 1.0;
const place = (shapes, angle, at) => shapes.map(shape => turnShape(shape, angle, at));
/** The turn that points a primitive's +y axis along (dx, dy). */
const toward = (dx, dy) => Math.atan2(-dx, dy);
/** The share of the ranked marks a foot shows at fullness 0; the rest come as the day fills. */
const RANKED_FLOOR = 0.4;
const shownAt = (rank, fullness) => rank < RANKED_FLOOR + (1 - RANKED_FLOOR) * clamp(fullness, 0, 1);
/** A fibrous rootlet leaving a root's flank: it droops away from the root, with a fine hair or two. */
function fibre(rng, from, sd, reach) {
    const end = [from[0] + sd * reach, from[1] - reach * rng.range(0.5, 0.95)];
    const path = sample(bezier3(from, [from[0] + sd * reach * 0.45, from[1] - reach * 0.05], [end[0] - sd * reach * 0.12, end[1] + reach * 0.3], end), 6);
    const shapes = [line(path, 0.008)];
    for (let j = 0; j < (reach > 0.35 ? 2 : 1); j += 1) {
        const p = path[2 + j];
        shapes.push(line([p, [p[0] + sd * reach * 0.16, p[1] - reach * rng.range(0.15, 0.3)]], 0.005));
    }
    return shapes;
}
/**
 * A root's body along a downward spine `length` centimetres long, shaded across like a turned cylinder,
 * its skin cut over it; its fibrous rootlets go to `fibres`, ranked for fullness to bring in.
 */
function rootBody(rng, spine, halfWidth, skin, length, fibres, weight = 0.6) {
    const body = bladeBody({ spine, halfWidth, shade: 1, spacing: HATCH * (skin === "dark" ? 0.55 : 0.8), grain: "across", weight: skin === "dark" ? 0.9 : weight, samples: Math.max(36, Math.ceil(length * 10)) }, rng);
    const across = (v, q, bow) => { const [x, y] = spine(v); return [x + q * halfWidth(v), y + bow * halfWidth(v)]; };
    if (skin === "ringed") {
        // The carrot's rings: shallow cuts across the body, a few millimetres apart whatever its length.
        for (let v = 0.06; v < 0.92; v += rng.range(0.12, 0.22) / length)
            body.veins.push([across(v, -0.75, 0.1), across(v, 0, -0.12), across(v, rng.range(0.3, 0.8), 0.05)]);
    }
    if (skin === "dark") {
        // A dark root (orcanète) is cut across its lit side too, so the whole body reads dark.
        for (let v = 0.04; v < 0.95; v += 0.1 / length)
            body.veins.push([across(v, -0.9, 0.05), across(v + 0.03 / length, 0.2, -0.05)]);
    }
    if (skin === "rough") {
        for (let k = 0, n = Math.round(length * 7); k < n; k += 1) {
            const v = rng.range(0.05, 0.92), q = rng.sym(0.8);
            body.veins.push([across(v, q, 0), across(v + 0.06 / length, q + rng.sym(0.25), 0.1)]);
        }
    }
    for (let k = 0, n = Math.round(4 + length * 2.4); k < n; k += 1) {
        const v = rng.range(0.15, 0.94), sd = side(rng);
        fibres.push({ shapes: fibre(rng, across(v, sd * 0.95, 0), sd, rng.range(0.2, 0.5) * (1.2 - v * 0.4)), rank: rng.u() });
    }
    return [body];
}
/** The leaf bases at the crown, where the stems and the rosette leave the organ. */
function leafBases(rng, girth) {
    const spread = clamp(girth * 0.45, 0.06, 0.24);
    const shapes = [];
    for (let k = 0; k < 5; k += 1) {
        const u = k / 4 * 2 - 1;
        const len = rng.range(0.22, 0.32) * (1 - 0.3 * Math.abs(u));
        shapes.push(...place([bladeBody({ spine: v => [0, len * v], halfWidth: v => 0.03 * (1 - 0.4 * v), shade: 1, spacing: HATCH * 0.6, grain: "along", reach: [0.5, 0.9], weight: 0.5, samples: 6 }, rng)], u * 0.35 + rng.sym(0.06), [u * spread, -0.04]));
    }
    return shapes;
}
/**
 * The ground: a broken soil line across the column, short dashes of earth beneath it thinning with
 * depth, and crumbs and pebbles ranked for fullness to bring in. The line and the earth part round
 * the organ (`gap` either side of `cx`) so that the wash does not cross it.
 */
function ground(rng, width, y, cx, gap, fullness) {
    const clear = (x, x1 = x) => x1 < cx - gap || x > cx + gap;
    const shapes = [];
    for (let x = 0.2; x < width - 0.2;) {
        const len = Math.min(rng.range(0.15, 0.4), width - 0.2 - x), lift = rng.sym(0.015);
        if (clear(x, x + len))
            shapes.push(line([[x, y + lift], [x + len * 0.5, y + lift + rng.sym(0.012)], [x + len, y + rng.sym(0.015)]], 0.012, false));
        x += len + rng.range(0.03, 0.09);
    }
    const earth = [];
    for (const [depth, density] of [[0.08, 0.75], [0.17, 0.55], [0.28, 0.38], [0.42, 0.22], [0.58, 0.12]]) {
        for (let x = 0.25 + rng.range(0, 0.15); x < width - 0.3; x += rng.range(0.12, 0.3)) {
            const len = rng.range(0.05, 0.14), keep = rng.u() < density, dy = rng.sym(0.02);
            if (keep && clear(x, x + len))
                earth.push([[x, y - depth + dy], [x + len, y - depth + dy + rng.sym(0.01)]]);
        }
    }
    shapes.push(...earth.map(points => line(points, 0.007, false)));
    const crumbs = [];
    for (let k = 0; k < 70; k += 1) {
        const at = [rng.range(0.25, width - 0.25), y - 0.04 - 0.9 * rng.u() ** 2], rank = rng.u();
        if (shownAt(rank, fullness) && clear(at[0]))
            crumbs.push(at);
    }
    shapes.push({ type: "dots", points: crumbs, radius: 0.011 });
    for (let k = 0; k < 6; k += 1) {
        const at = [rng.range(0.4, width - 0.4), y - rng.range(0.25, 1.1)], r = rng.range(0.03, 0.06), rank = rng.u();
        if (rank < clamp(fullness, 0, 1) && clear(at[0] - r, at[0] + r))
            shapes.push({ ...line(circle(at, r, r * 0.7, 9), 0.008), smooth: true }, line([[at[0] - r * 0.3, at[1] - r * 0.4], [at[0] + r * 0.5, at[1] - r * 0.45]], 0.006));
    }
    return shapes;
}
/** A tuber on its runner: smooth with eyes, knobbly, or a small bead. */
function tuber(rng, at, r, kind) {
    if (kind === "knobbly") {
        const phase = rng.range(0, TAU);
        const outline = sample(v => {
            const a = v * TAU, k = 1 + 0.16 * Math.sin(3 * a + phase) + 0.08 * Math.sin(5 * a + phase * 2);
            return [at[0] + Math.cos(a) * r * 0.75 * k, at[1] + Math.sin(a) * r * 1.25 * k];
        }, 40).slice(0, -1);
        const body = roundBody(outline, at, r, HATCH * 0.7, 0.6);
        body.veins = Array.from({ length: 4 }, (_, j) => { const y = at[1] + (j / 3 - 0.5) * r * 1.6; return [[at[0] - r * 0.45, y], [at[0], y - r * 0.08], [at[0] + r * 0.4, y]]; });
        return [body];
    }
    const rx = r * (kind === "beaded" ? 0.8 : 1.1), ry = r * (kind === "beaded" ? 1 : 0.85);
    const body = roundBody(circle(at, rx, ry, 22), at, (rx + ry) / 2, HATCH * 0.7, kind === "beaded" ? 0.7 : 0.5);
    if (kind === "round") {
        // The eyes: small brows cut over the skin.
        for (let j = 0; j < 5; j += 1) {
            const a = rng.range(0, TAU), q = rng.range(0.3, 0.75);
            const e = [at[0] + Math.cos(a) * rx * q, at[1] + Math.sin(a) * ry * q];
            body.veins.push([[e[0] - r * 0.1, e[1] + r * 0.03], [e[0], e[1] - r * 0.04], [e[0] + r * 0.1, e[1] + r * 0.03]]);
        }
    }
    return [body];
}
/** How far the organ spreads either side of its crown where it meets the soil line. */
function shoulder(organ) {
    switch (organ.kind) {
        case "bundle": return organ.girth * 1.6 + 0.05;
        case "tuber": return 0.12;
        default: return organ.girth;
    }
}
/** The organ, drawn downward from its crown at the origin; its rootlets shown as far as the day has filled. */
function rootStudy(rng, organ, fullness, room) {
    const { depth: L, girth: W, long } = organ;
    const at = (depth, x = 0) => [x, -depth];
    const shapes = [];
    const fibres = [];
    const taper = (from, to, hw, skin = organ.skin) => rootBody(rng, v => at(lerp(from, to, v)), hw, skin, to - from, fibres);
    switch (organ.kind) {
        case "globe": {
            // A swollen root drawn out into a thin tail; a long one is a white radish's column, rounded at both ends.
            const bulb = L * (long ? 0.86 : 0.55);
            shapes.push(line(sample(v => at(bulb * 0.85 + (L - bulb * 0.85) * v, 0.05 * Math.sin(v * 3)), 8), 0.02));
            const hw = long
                ? (v) => W * Math.sin(Math.PI * Math.min(1, 0.06 + v * 0.94)) ** 0.25 + 0.01
                : (v) => W * Math.sin(Math.PI * (0.05 + 0.95 * v)) ** 0.55 * (1 - 0.25 * v * v) + 0.01;
            shapes.push(...taper(0, bulb, hw));
            break;
        }
        case "forked": {
            // A mandrake: a trunk that parts into two legs, with a pair of slender arms.
            const fork = L * 0.42;
            for (const sd of [-1, 1]) {
                const start = at(fork * 0.85);
                const leg = (v) => [start[0] + sd * (0.12 + 0.3 * v) * Math.min(L, 6) * 0.5 * v, start[1] - (L - fork * 0.85) * v];
                shapes.push(...rootBody(rng, leg, v => W * 0.6 * (1 - v) ** 0.9 + 0.008, organ.skin, L - fork * 0.85, fibres));
                const arm = at(fork * 0.35), reach = Math.min(L, 6);
                shapes.push(line(sample(v => [arm[0] + sd * (W * 0.85 + reach * 0.16 * v), arm[1] - reach * 0.2 * v], 5), 0.022));
            }
            shapes.push(...taper(0, fork, v => W * (0.35 + 0.65 * smoothstep(0, 0.22, v)) * (1 + 0.12 * Math.sin(Math.PI * v))));
            break;
        }
        case "bundle": {
            // A bundle of slender storage roots spreading from the crown.
            const n = Math.max(2, organ.count);
            const order = Array.from({ length: n }, (_, k) => k).sort((a, b) => Math.abs(b - (n - 1) / 2) - Math.abs(a - (n - 1) / 2));
            const rootletRoom = 0.6;
            const width = Math.min(W, Math.max(0, room - rootletRoom) / 1.5);
            const reach = Math.min(Math.max(W * 3, 0.45), Math.max(0, room - width * 1.5 - rootletRoom));
            for (const k of order) {
                const u = k / (n - 1) * 2 - 1;
                const len = L * rng.range(0.78, 1), spread = u * reach;
                shapes.push(...rootBody(rng, v => { const [px, py] = at(len * v); return [px + spread * Math.sin(v * 1.4) + u * width * 0.5, py]; }, v => width * Math.sin(Math.PI * Math.min(1, 0.1 + v * 0.95)) ** 0.7 * (1 - 0.5 * v) + 0.006, organ.skin, len, fibres));
            }
            break;
        }
        case "tuber": {
            // Stem tubers on runners from the buried stem, among fibrous roots; a long buried stem bears them all the way down.
            const stem = L * (long ? 0.8 : 0.32), low = L - W * 1.7;
            shapes.push(line(sample(v => at(stem * v, 0.03 * Math.sin(v * 5)), long ? 16 : 5), 0.05));
            for (let k = 0; k < 6; k += 1) {
                const a = Math.PI * (1.2 + 0.6 * k / 5) + rng.sym(0.1), r = Math.min(L, 4) * rng.range(0.2, 0.32);
                const from = at(stem);
                shapes.push(line([from, [from[0] + Math.cos(a) * r * 0.5, from[1] + Math.sin(a) * r * 0.45], [from[0] + Math.cos(a) * r, from[1] + Math.sin(a) * r]], 0.008));
            }
            const n = Math.max(1, organ.count);
            for (let k = 0; k < n; k += 1) {
                const u = n === 1 ? 0 : k / (n - 1) * 2 - 1;
                let from, end;
                if (long) {
                    // Up the buried stem, alternate sides, the runners reaching out and down.
                    from = at(stem * (0.18 + 0.82 * (k + 0.5) / n));
                    const sd = k % 2 === 0 ? 1 : -1;
                    end = [sd * rng.range(1.0, 1.7), Math.max(-low, from[1] - rng.range(0.5, 1.1))];
                }
                else {
                    from = at(stem * rng.range(0.6, 1));
                    end = [from[0] + u * Math.max(1.4, W * 3.5), -stem - (low - stem) * rng.range(0.55, 1) + Math.abs(u) * 0.3];
                }
                const path = sample(bezier3(from, [from[0] + (end[0] - from[0]) * 0.2, from[1] - 0.25], [end[0], end[1] + 0.3], end), 8);
                shapes.push(line(path, 0.014));
                const r = W * rng.range(0.75, 1);
                if (organ.tuber === "beaded") {
                    shapes.push(...tuber(rng, path[4], r * 0.6, "beaded"));
                    shapes.push(...tuber(rng, end, r * 0.75, "beaded"));
                }
                else {
                    shapes.push(...tuber(rng, [end[0], end[1] - r * 0.6], r, organ.tuber));
                }
            }
            break;
        }
        case "rhizome": {
            // A woody root that goes down and then creeps along under the soil, rooting at its joints.
            const down = L * (long ? 0.82 : 0.45), dip = L * (long ? 0.1 : 0.25);
            shapes.push(...taper(0, down, v => W * (0.7 + 0.3 * smoothstep(0, 0.12, v)), organ.skin));
            const start = at(down);
            for (const sd of [-1, 1]) {
                const reach = sd > 0 ? 2.2 : 1.3;
                const spine = (v) => [start[0] + sd * reach * v, start[1] - dip * Math.sin(v * 1.6) - 0.05];
                const body = bladeBody({ spine, halfWidth: v => W * (1 - 0.45 * v), shade: 1, spacing: HATCH * 0.7, grain: "across", weight: 0.7, samples: 30 }, rng);
                for (let j = 1; j < 6; j += 1) {
                    const [x, y] = spine(j / 6), hw = W * (1 - 0.45 * j / 6);
                    body.veins.push([[x - 0.02, y + hw], [x + 0.02, y - hw]]);
                    fibres.push({ shapes: [line([[x, y - hw], [x + rng.sym(0.1), y - hw - rng.range(0.15, 0.4)]], 0.008)], rank: rng.u() });
                }
                shapes.push(body);
            }
            break;
        }
        default: {
            // A taproot: broad at the shoulder, drawn to a fine tail; a long one keeps its girth further down.
            shapes.push(line(sample(v => at(L * (0.86 + 0.14 * v), 0.03 * Math.sin(v * 4)), 6), 0.009));
            const shoulderAt = Math.min(0.1, 0.5 / L), fall = long ? 0.8 : 1.1;
            shapes.push(...taper(0, L * 0.9, v => W * (0.6 + 0.4 * smoothstep(0, shoulderAt, v)) * (1 - v) ** fall + 0.006));
        }
    }
    if (organ.section) {
        // A slice of the root laid beside it, to show the red within (dye roots, beet).
        const r = clamp(W * 0.45, 0.15, 0.3);
        const c = [Math.max(W, 0.2) + r + 0.3, -L * (long ? 0.3 : 0.45)];
        const slice = roundBody(circle(c, r, r * 0.8, 20), c, r, HATCH * 0.5, 0.75, [-0.6, 0.8], "accent");
        slice.veins = [0.4, 0.7].map(q => circle(c, r * q, r * q * 0.8, 16));
        shapes.push(slice);
    }
    // The rootlets lie under the organ's body, so its outline stays clean.
    const shown = fibres.filter(item => shownAt(item.rank, fullness)).flatMap(item => item.shapes);
    return [...shown, ...shapes, ...leafBases(rng, W)];
}
/** The foot: the organ at the column's foot under its soil line, the plant leaving its crown. */
function rootFoot(organ) {
    const crownY = BOTTOM + organ.depth, soilY = crownY - organ.soil;
    const half = shoulder(organ) + 0.12;
    const room = [[0, 0, 1, soilY]];
    if (organ.soil > 0.05)
        room.push([CROWN_X - half / COLUMN_WIDTH, soilY, CROWN_X + half / COLUMN_WIDTH, crownY]);
    return {
        crown: [CROWN_X, crownY],
        room,
        scroll: false,
        draw: (rng, column, _t, fullness) => {
            const cx = column.width * CROWN_X;
            return [...ground(rng, column.width, soilY, cx, shoulder(organ) + 0.06, fullness), ...place(rootStudy(rng, organ, fullness, Math.min(cx, column.width - cx)), 0, [cx, crownY])];
        },
    };
}
// ---------------------------------------------------------------- the flowering shoot
/** Items along a stalk on alternate sides, from the base of the stalk's top part to its tip. */
function alongStalk(rng, s, count, length, item, spread = 0.7) {
    const axis = sample(v => [s * 0.04 * Math.sin(v * 2.5), length * v], 12);
    const shapes = [line(axis, s * 0.018)];
    for (let k = 0; k < count; k += 1) {
        const t = count === 1 ? 1 : 0.4 + 0.6 * k / (count - 1);
        const sd = k % 2 === 0 ? 1 : -1;
        shapes.push(...place(item(k, sd, t), -sd * spread * (1.1 - 0.5 * t) + rng.sym(0.08), axis[Math.round(t * 11)]));
    }
    return shapes;
}
/** A compound umbel of tiny florets; a carrot's has one dark floret at its heart and closes to a nest. */
function umbel(rng, s, stage, heart) {
    const hub = [0, s * 0.36];
    const shapes = [line([[0, 0], hub], s * 0.02)];
    const rays = rng.int(9, 12);
    const florets = [];
    for (let k = 0; k < rays; k += 1) {
        const u = k / (rays - 1) * 2 - 1;
        const len = s * 0.38 * (1 - 0.1 * Math.abs(u)) * rng.range(0.94, 1.06);
        let tip, path;
        if (stage === "seed" && heart) {
            // The bird's nest: the rays curl up and in.
            tip = [u * s * 0.12, hub[1] + len * 0.75];
            path = sample(bezier3(hub, [u * s * 0.3, hub[1] + len * 0.2], [u * s * 0.32, hub[1] + len * 0.6], tip), 6);
        }
        else {
            const a = Math.PI / 2 - u * (stage === "bud" ? 0.45 : stage === "seed" ? 0.75 : 1.05);
            tip = [Math.cos(a) * len, hub[1] + Math.sin(a) * len * 0.75 + s * 0.04 * (1 - u * u)];
            path = [hub, tip];
        }
        shapes.push(line(path, s * 0.007));
        for (let j = 0; j < 6; j += 1) {
            const v = j / 5 * 2 - 1, a = Math.PI / 2 - v * 1.1;
            florets.push([tip[0] + Math.cos(a) * s * 0.06, tip[1] + Math.sin(a) * s * 0.045]);
        }
    }
    shapes.push({ type: "dots", points: florets, radius: s * (stage === "seed" ? 0.016 : stage === "bud" ? 0.012 : 0.014) });
    if (heart && stage === "bloom")
        shapes.push({ type: "dots", points: [[0, hub[1] + s * 0.32]], radius: s * 0.025, tone: "accent" });
    return shapes;
}
/** A crucifer's raceme: buds at the tip, four-petalled flowers below; then a ladder of slender pods. */
function crossRaceme(rng, s, stage) {
    const len = s * 0.75;
    if (stage === "seed") {
        return alongStalk(rng, s, 7, len, () => [line([[0, 0], [0, s * 0.05]], s * 0.008),
            bladeBody({ spine: v => [0, s * 0.05 + s * 0.26 * v], halfWidth: v => s * 0.016 * Math.sin(Math.PI * Math.min(1, 0.1 + v)) ** 0.4, shade: 1, spacing: HATCH * 0.6, grain: "along", reach: [0.4, 0.8], weight: 0.5, samples: 8 }, rng)], 0.45);
    }
    const shapes = alongStalk(rng, s, stage === "bud" ? 0 : 4, len * 0.8, () => {
        const f = [line([[0, 0], [0, s * 0.1]], s * 0.008)];
        const c = [0, s * 0.14], tilt = rng.range(0.5, 0.8);
        for (let j = 0; j < 4; j += 1) {
            const a = j / 4 * TAU + Math.PI / 4;
            f.push(bladeBody({ spine: v => [c[0] + Math.cos(a) * s * 0.1 * v, c[1] + Math.sin(a) * s * 0.1 * v * tilt], halfWidth: v => s * 0.04 * v ** 0.6 * (1 - v) ** 0.3,
                shade: 1, spacing: HATCH * 0.6, grain: "along", reach: [0.1, 0.25], weight: 0.2, samples: 8 }, rng));
        }
        f.push({ type: "dots", points: [c], radius: s * 0.012 });
        return f;
    });
    const top = [0, len * 0.8];
    shapes.push(line([[0, 0], [0, len * 0.95]], s * 0.016));
    shapes.push({ type: "dots", points: Array.from({ length: stage === "bud" ? 9 : 6 }, () => [top[0] + rng.sym(0.05) * s, top[1] + rng.range(0.02, 0.16) * s]), radius: s * 0.02 });
    return shapes;
}
/** A composite head: ligules round a disc over bracts (long and pointed in salsifis); a clock or a dry head. */
function compositeHead(rng, s, stage, longBracts) {
    const stalkTop = s * 0.32;
    const shapes = [line([[0, 0], [0, stalkTop]], s * 0.022)];
    const c = [0, stalkTop + s * 0.08];
    const bracts = (open, length) => {
        for (let k = 0; k < 8; k += 1) {
            const u = k / 7 * 2 - 1, a = Math.PI / 2 - u * open;
            shapes.push(bladeBody({ spine: v => [Math.cos(a) * length * v, stalkTop + Math.sin(a) * length * v], halfWidth: v => s * 0.025 * (1 - v) ** 0.8,
                shade: u > 0 ? 1 : -1, spacing: HATCH * 0.6, grain: "along", reach: [0.3, 0.7], weight: 0.5, samples: 8 }, rng));
        }
    };
    if (stage === "bud") {
        bracts(0.18, s * (longBracts ? 0.4 : 0.22));
        return shapes;
    }
    if (stage === "seed") {
        if (longBracts) {
            // A clock of plumed seeds on long beaks.
            for (let k = 0; k < 16; k += 1) {
                const a = Math.PI / 2 + (k / 15 * 2 - 1) * 1.45, tip = [c[0] + Math.cos(a) * s * 0.42, c[1] + Math.sin(a) * s * 0.42];
                shapes.push(line([c, tip], s * 0.005));
                for (let j = 0; j < 5; j += 1) {
                    const b = a + (j - 2) * 0.35;
                    shapes.push(line([tip, [tip[0] + Math.cos(b) * s * 0.09, tip[1] + Math.sin(b) * s * 0.09]], s * 0.003));
                }
            }
            bracts(1.3, s * 0.2);
            return shapes;
        }
        bracts(0.9, s * 0.16);
        shapes.push(roundBody(circle(c, s * 0.14, s * 0.07, 18), c, s * 0.12, HATCH * 0.5, 0.85));
        return shapes;
    }
    bracts(longBracts ? 0.75 : 1.0, s * (longBracts ? 0.42 : 0.18));
    const rays = longBracts ? 14 : 12, tilt = rng.range(0.45, 0.6);
    const back = [], front = [];
    for (let k = 0; k < rays; k += 1) {
        const a = k / rays * TAU + rng.sym(0.08), len = s * (longBracts ? 0.2 : 0.3);
        const ray = bladeBody({ spine: v => [c[0] + Math.cos(a) * len * v, c[1] + Math.sin(a) * len * v * tilt], halfWidth: v => s * 0.035 * Math.min(1, v * 3) * (1 - v * 0.3),
            shade: Math.cos(a) > 0 ? 1 : -1, spacing: HATCH * 0.7, grain: "along", reach: [0.2, 0.4], weight: 0.3, samples: 10 }, rng);
        (Math.sin(a) > 0 ? back : front).push(ray);
    }
    shapes.push(...back, roundBody(circle(c, s * 0.08, s * 0.08 * tilt, 16), c, s * 0.08, HATCH * 0.6, 0.8), ...front);
    shapes.push({ type: "dots", points: Array.from({ length: 5 }, () => [c[0] + rng.sym(0.04) * s, c[1] + rng.sym(0.02) * s]), radius: s * 0.01, tone: "accent" });
    return shapes;
}
/** A five-lobed flower seen at a tilt, with a cone of stamens (pomme de terre) or a closed cup (mandragore). */
function starFlower(rng, f, cupped) {
    const c = [0, f * 0.3], tilt = rng.range(0.45, 0.7), start = rng.range(0, TAU);
    const shapes = [line([[0, 0], c], f * 0.03)];
    const lobes = Array.from({ length: 5 }, (_, j) => start + j / 5 * TAU).sort((a, b) => Math.sin(b) - Math.sin(a));
    for (const a of lobes) {
        const lift = cupped ? 0.55 : 0.05;
        shapes.push(bladeBody({ spine: v => [c[0] + Math.cos(a) * f * 0.36 * v * (1 - lift * 0.4), c[1] + Math.sin(a) * f * 0.36 * v * tilt + lift * f * 0.4 * v], halfWidth: v => f * 0.2 * v ** 0.4 * (1 - v) ** 0.7,
            shade: Math.cos(a) > 0 ? 1 : -1, spacing: HATCH * 0.6, grain: "along", reach: [0.15, 0.35], weight: 0.3, midrib: true, samples: 10 }, rng));
    }
    shapes.push({ type: "dots", points: [[c[0], c[1] + f * 0.04], [c[0] - f * 0.03, c[1] + f * 0.02], [c[0] + f * 0.03, c[1] + f * 0.02]], radius: f * 0.035, tone: "accent" });
    return shapes;
}
function starCyme(rng, s, stage, cupped) {
    const fork = [0, s * 0.3];
    const shapes = [line([[0, 0], fork], s * 0.02)];
    const n = cupped ? 2 : rng.int(3, 4);
    for (let k = 0; k < n; k += 1) {
        const a = (k / Math.max(1, n - 1) * 2 - 1) * 0.7;
        const piece = stage === "bud" ? [line([[0, 0], [0, s * 0.12]], s * 0.01), berry([0, s * 0.16], s * 0.045, 0.4)]
            : stage === "seed" ? [line([[0, 0], [0, s * 0.14]], s * 0.012), berry([0, s * 0.14 + s * (cupped ? 0.13 : 0.08)], s * (cupped ? 0.13 : 0.08), cupped ? 0.45 : 0.6)]
                : starFlower(rng, s * (cupped ? 0.55 : 0.48), cupped);
        shapes.push(...place(piece, a, fork));
    }
    return shapes;
}
/** A beet's spike: knots of small flowers along slender branches; then corky seed clusters. */
function beetSpike(rng, s, stage) {
    const shapes = [];
    for (const [angle, len] of [[0, 0.85], [0.45, 0.55], [-0.4, 0.6]]) {
        const axis = sample(v => [s * 0.03 * Math.sin(v * 3), s * len * v], 8);
        const knots = [];
        for (let k = 1; k < 8; k += 1)
            knots.push([axis[k][0] + (k % 2 ? 1 : -1) * s * 0.025, axis[k][1]]);
        const branch = [line(axis, s * 0.012)];
        if (stage === "seed")
            for (const at of knots)
                branch.push(berry(at, s * 0.032, 0.7));
        else
            branch.push({ type: "dots", points: knots, radius: s * (stage === "bud" ? 0.018 : 0.026) });
        shapes.push(...place(branch, angle, angle === 0 ? [0, 0] : [0, s * 0.2]));
    }
    return shapes;
}
/** Madder: a loose panicle of tiny yellow stars; then small black berries. */
function madder(rng, s, stage) {
    const shapes = [];
    const tips = [];
    for (let k = 0; k < 5; k += 1) {
        const a = Math.PI / 2 + (k - 2) * 0.35, len = s * rng.range(0.35, 0.55);
        const end = [Math.cos(a) * len, s * 0.15 + Math.sin(a) * len];
        shapes.push(line([[0, 0], [0, s * 0.15], end], s * 0.01));
        for (let j = 0; j < 3; j += 1)
            tips.push([end[0] + rng.sym(0.06) * s, end[1] + rng.range(0, 0.06) * s]);
    }
    if (stage === "seed") {
        for (const at of tips)
            shapes.push(berry(at, s * 0.035, 0.92));
        return shapes;
    }
    if (stage === "bloom")
        for (const at of tips)
            for (let j = 0; j < 5; j += 1) {
                const a = j / 5 * TAU;
                shapes.push(line([at, [at[0] + Math.cos(a) * s * 0.03, at[1] + Math.sin(a) * s * 0.03]], s * 0.005, false));
            }
    shapes.push({ type: "dots", points: tips, radius: s * (stage === "bud" ? 0.016 : 0.01) });
    return shapes;
}
/** A small pea flower facing +x, or its pod. */
function peaBit(rng, f, stage) {
    const shapes = [line([[0, 0], [0, f * 0.2]], f * 0.04)];
    if (stage === "seed") {
        shapes.push(bladeBody({ spine: v => [f * 0.1 * v * v, f * 0.2 + f * 0.85 * v], halfWidth: v => f * 0.08 * Math.min(1, v * 6) * (1 - smoothstep(0.8, 1, v) * 0.9), shade: 1, spacing: HATCH * 0.6, grain: "across", weight: 0.55, samples: 14 }, rng));
        return shapes;
    }
    const b = [0, f * 0.3];
    if (stage === "bloom")
        shapes.push(bladeBody({ spine: v => [-f * 0.2 * v, b[1] + f * 0.5 * v], halfWidth: v => f * 0.28 * Math.sin(Math.PI * Math.min(1, 0.1 + v * 0.9)) ** 0.55, shade: 1, spacing: HATCH * 0.6, grain: "along", reach: [0.2, 0.5], weight: 0.4, samples: 12 }, rng));
    shapes.push(bladeBody({ spine: v => [f * 0.4 * v, b[1] + f * 0.1 * v * v], halfWidth: v => f * 0.11 * Math.sin(Math.PI * Math.min(1, 0.15 + v * 0.85)) ** 0.7, shade: -1, spacing: HATCH * 0.6, grain: "along", reach: [0.3, 0.6], weight: 0.5, samples: 10 }, rng));
    return shapes;
}
/** A campanula's raceme of nodding bells; then upright capsules. */
function bellRaceme(rng, s, stage) {
    return alongStalk(rng, s, 5, s * 0.75, (_, sd) => {
        const out = [line([[0, 0], [sd * s * 0.03, s * 0.08]], s * 0.008)];
        const at = [sd * s * 0.03, s * 0.08];
        if (stage === "seed") {
            out.push(bladeBody({ spine: v => [at[0], at[1] + s * 0.14 * v], halfWidth: v => s * 0.05 * v ** 0.7, shade: 1, spacing: HATCH * 0.6, grain: "along", reach: [0.4, 0.8], weight: 0.6, samples: 8 }, rng));
            return out;
        }
        const len = s * (stage === "bud" ? 0.12 : 0.2);
        const bell = bladeBody({ spine: v => [at[0], at[1] + len * v], halfWidth: v => s * (stage === "bud" ? 0.035 * Math.sin(Math.PI * Math.min(1, 0.2 + v)) : 0.03 + 0.05 * v ** 1.5),
            shade: 1, spacing: HATCH * 0.6, grain: "along", reach: [0.3, 0.6], weight: 0.4, samples: 10 }, rng);
        if (stage === "bloom")
            bell.veins.push(sample(v => [at[0] + s * 0.08 * Math.cos(v * Math.PI), at[1] + len + s * 0.02 * Math.sin(v * TAU * 2.5)], 12));
        out.push(bell);
        return out;
    }, 0.5);
}
/** Alkanet: a coiled cyme of small funnel flowers with bristly calyces; then nutlets in the calyces. */
function funnelCyme(rng, s, stage) {
    const coil = sample(v => {
        const a = Math.PI - v * Math.PI * 1.3, r = s * 0.25 * (1 - 0.55 * v);
        return [r + Math.cos(a) * r, s * 0.35 + Math.sin(a) * r];
    }, 14);
    const shapes = [line([[0, 0], [0, s * 0.35], ...coil], s * 0.014)];
    const open = stage === "bloom" ? 4 : 0;
    for (let k = 1; k < coil.length; k += 2) {
        const p = coil[k], q = coil[Math.min(coil.length - 1, k + 1)];
        const [tx, ty] = unit(q[0] - p[0], q[1] - p[1]);
        const angle = toward(-ty, tx);
        const bit = [];
        for (const sd of [-1, 0, 1])
            bit.push(line([[0, 0], [sd * s * 0.025, s * 0.06]], s * 0.005));
        if (stage === "seed")
            bit.push({ type: "dots", points: [[0, s * 0.04]], radius: s * 0.02 });
        else if (k / 2 < open) {
            bit.push(bladeBody({ spine: v => [0, s * 0.04 + s * 0.1 * v], halfWidth: v => s * (0.012 + 0.04 * v ** 2), shade: 1, spacing: HATCH * 0.6, grain: "along", reach: [0.2, 0.4], weight: 0.3, samples: 8 }, rng));
        }
        else
            bit.push({ type: "dots", points: [[0, s * 0.05]], radius: s * 0.016 });
        shapes.push(...place(bit, angle, p));
    }
    return shapes;
}
const BLOOMS = {
    umbel: { draw: (rng, s, stage, look) => umbel(rng, s, stage, look.heart), proxy: 0.45 },
    cross: { draw: crossRaceme, proxy: 0.42 },
    head: { draw: (rng, s, stage, look) => compositeHead(rng, s, stage, look.bracts), proxy: 0.45 },
    star: { draw: (rng, s, stage) => starCyme(rng, s, stage, false), proxy: 0.45 },
    spike: { draw: beetSpike, proxy: 0.42 },
    tiny: { draw: madder, proxy: 0.42 },
    pea: { draw: (rng, s, stage) => alongStalk(rng, s, stage === "seed" ? 3 : 6, s * 0.7, (_, sd) => { const bit = peaBit(rng, s * 0.3, stage); return sd > 0 ? bit : bit.map(flipX); }, 0.8), proxy: 0.42 },
    bell: { draw: bellRaceme, proxy: 0.42 },
    cup: { draw: (rng, s, stage) => starCyme(rng, s, stage, true), proxy: 0.42 },
    funnel: { draw: funnelCyme, proxy: 0.4 },
};
function flipX(shape) {
    const f = (points) => points.map(([x, y]) => [-x, y]);
    switch (shape.type) {
        case "body": return { ...shape, outline: f(shape.outline), shadow: shape.shadow.map(f), grain: shape.grain.map(f), veins: shape.veins.map(f) };
        case "solid": return { ...shape, outline: f(shape.outline) };
        case "line": return { ...shape, points: f(shape.points) };
        case "dots": return { ...shape, points: f(shape.points) };
    }
}
// ---------------------------------------------------------------- leaves
/** A lyrate leaf: small lobes down the stalk and a large rounded end lobe (navet, radis). */
function lyrateLeaf(rng, length, bend) {
    const rachis = sample(v => [bend * length * v * v, length * v], 12);
    const shapes = [line(rachis.slice(0, 8), length * 0.018)];
    const pairs = rng.int(3, 4);
    for (let k = 0; k < pairs; k += 1) {
        const at = rachis[2 + k * Math.floor(5 / pairs)], size = length * (0.13 + 0.05 * k);
        for (const sd of [1, -1])
            shapes.push(...place(simpleLeaf(rng, size, sd * 0.1, 0.5), -sd * 1.05 + rng.sym(0.1), at));
    }
    shapes.push(...place(simpleLeaf(rng, length * 0.48, bend * 0.5, 0.52), 0, rachis[7]));
    return shapes;
}
/** A broad oblong leaf on a long stalk, wavy at the edge (betterave, raifort, mandragore). */
function broadLeaf(rng, length, bend) {
    const stalk = 0.28, width = length * rng.range(0.2, 0.25);
    const spine = (v) => [bend * length * v * v, length * v];
    const halfWidth = (v) => v < stalk ? length * 0.012 : width * Math.sin(Math.PI * ((v - stalk) / (1 - stalk) * 0.9 + 0.1)) ** 0.6;
    const veins = [];
    for (let k = 1; k < 7; k += 1) {
        const v = stalk + (1 - stalk) * k / 7, [x, y] = spine(v);
        for (const sd of [1, -1])
            veins.push([[x, y], [x + sd * halfWidth(v) * 0.85, y + length * 0.06]]);
    }
    return [bladeBody({ spine, halfWidth, edge: (v, sd) => v < stalk ? 0 : 0.012 * length * Math.sin(v * 38 + sd), shade: side(rng), spacing: HATCH, grain: "across", weight: 0.55, midrib: true, veins, samples: 60 }, rng)];
}
/** A whorl of narrow leaves round a node, as madder holds them. */
function whorlLeaf(rng, length, bend) {
    const node = [bend * length * 0.1, length * 0.3];
    const shapes = [line([[0, 0], node, [node[0], node[1] + length * 0.12]], length * 0.016)];
    const count = rng.int(5, 6);
    for (let k = 0; k < count; k += 1)
        shapes.push(...place(simpleLeaf(rng, length * 0.55, rng.sym(0.1), 0.16), (k / count) * TAU + rng.sym(0.15), node));
    return shapes;
}
/** A pair of leaflets with a tendril between them (macjonc). */
function pairedLeaf(rng, length, bend) {
    const tip = [bend * length * 0.2, length * 0.32];
    const shapes = [line([[0, 0], tip], length * 0.016)];
    for (const sd of [1, -1])
        shapes.push(...place(simpleLeaf(rng, length * 0.6, sd * 0.05, 0.22), -sd * 0.45, tip));
    const run = sample(bezier3(tip, [tip[0], tip[1] + length * 0.2], [tip[0] + length * 0.1, tip[1] + length * 0.35], [tip[0] + length * 0.05, tip[1] + length * 0.45]), 8);
    const end = run[run.length - 1];
    shapes.push(line(run, length * 0.008), line(sample(v => { const a = v * TAU * 1.8, r = length * 0.06 * (1 - 0.7 * v); return [end[0] + r - Math.cos(a) * r, end[1] + Math.sin(a) * r]; }, 24), length * 0.006));
    return shapes;
}
function leafOf(kind) {
    switch (kind) {
        case "divided": return (rng, length, bend) => pinnateLeaf(rng, length, bend, 5, 0.3, true);
        case "pinnate": return (rng, length, bend) => pinnateLeaf(rng, length, bend, 4, 0.3);
        case "compound": return (rng, length, bend) => pinnateLeaf(rng, length, bend, 3, 0.36);
        case "lyrate": return lyrateLeaf;
        case "broad": return broadLeaf;
        case "strap": return (rng, length, bend) => strapLeaf(rng, length, bend, 0.8);
        case "whorl": return whorlLeaf;
        case "paired": return pairedLeaf;
        default: return (rng, length, bend) => simpleLeaf(rng, length, bend, 0.3);
    }
}
/** The rosette leaving the crown, by leaf kind; a madder's whorls and a vetchling's pairs belong to the stems alone. */
const ROSETTES = {
    divided: { count: [5, 7], length: [2.6, 3.6] },
    pinnate: { count: [4, 6], length: [2.6, 3.4] },
    compound: { count: [3, 4], length: [2.4, 3.2] },
    lyrate: { count: [4, 6], length: [2.6, 3.4] },
    broad: { count: [4, 6], length: [2.6, 3.6] },
    strap: { count: [5, 8], length: [3.2, 4.6] },
    simple: { count: [3, 5], length: [2.2, 3.0] },
};
// ---------------------------------------------------------------- the form
export const form = {
    id: "racine-tubercule",
    name: "racine et tubercule",
    doc: "Plants known by their underground organ: a root study at the foot (taproot, globe, fork, bundle, tubers, creeping root) with the plant growing out of its crown.",
    variants: {
        organ: { doc: "The organ: tapering taproot, swollen globe with a tail, forked (mandragore), bundle of slender roots, stem tubers on runners, or a creeping woody root", default: "taproot", values: ["taproot", "globe", "forked", "bundle", "tuber", "rhizome"] },
        habit: { doc: "How the organ is drawn: a study at the foot, or a long root climbing well over half the column under its leaves and flowers (a long globe is a white radish's column, long tubers hang all down a buried stem)", default: "study", values: ["study", "long"] },
        length: { doc: "Depth of the organ below the crown, in centimetres at margin size (the study draws it 1.7 times as deep; a long root reaches 9.6 cm further)", default: 2.8, range: [0.8, 3.6] },
        girth: { doc: "Half-width of the organ (or of each root or tuber), in centimetres at margin size (the study draws it 1.7 times as wide, a long root 2.2 times, to 1 cm)", default: 0.3, range: [0.06, 0.8] },
        skin: { doc: "Skin: smooth, ringed (carotte), rough and wrinkled (salsifis, raifort), or dark (orcanète)", default: "ringed", values: ["smooth", "ringed", "rough", "dark"] },
        crown: { doc: "How much of the organ stands above the soil line", default: 0.1, range: [0, 0.6] },
        count: { doc: "Roots in a bundle, or tubers on their runners", default: 4, range: [1, 8] },
        tuber: { doc: "Tubers: smooth with eyes (pomme de terre), knobbly (topinambour), or small beads on the roots (macjonc)", default: "round", values: ["round", "knobbly", "beaded"] },
        section: { doc: "A slice laid beside the root, showing red within (dye roots, beet)", default: false, values: [true, false] },
        leaf: { doc: "Leaf: finely divided, pinnate, compound (pomme de terre), lyrate (navet, radis), broad and wavy, grassy strap, whorled (garance), simple, or one pair with a tendril (macjonc)", default: "divided", values: ["divided", "pinnate", "compound", "lyrate", "broad", "strap", "whorl", "simple", "paired"] },
        bloom: { doc: "The diagnostic flowering shoot: umbel, crucifer raceme, composite head, star-flowered cyme, beet spike, madder panicle, pea raceme, campanula bells, mandrake cups, coiled funnel cyme", default: "umbel", values: Object.keys(BLOOMS) },
        shoot: { doc: "Height of the flowering shoot as a share of the column above the crown (a long root's shoot at least 0.75 of the little room left)", default: 0.8, range: [0.3, 1] },
        heart: { doc: "A dark floret at the umbel's heart, and the umbel closing to a nest (carotte)", default: false, values: [true, false] },
        bracts: { doc: "Long pointed bracts beyond the rays, going to a clock of plumed seeds (salsifis); else a dry head", default: false, values: [true, false] },
        size: { doc: "Flower size relative to the carrot's", default: 1, range: [0.6, 1.4] },
    },
    examples: [
        { name: "carotte", variant: { heart: true } },
        { name: "navet", variant: { organ: "globe", length: 2.6, girth: 0.72, skin: "smooth", crown: 0.35, leaf: "lyrate", bloom: "cross" } },
        { name: "betterave", variant: { organ: "globe", length: 3.0, girth: 0.6, skin: "smooth", crown: 0.3, section: true, leaf: "broad", bloom: "spike" } },
        { name: "salsifis", variant: { length: 3.5, girth: 0.14, skin: "rough", leaf: "strap", bloom: "head", bracts: true } },
        { name: "pomme de terre", variant: { organ: "tuber", length: 2.6, girth: 0.34, count: 4, leaf: "compound", bloom: "star", shoot: 0.6 } },
        { name: "mandragore", variant: { organ: "forked", length: 3.2, girth: 0.34, skin: "rough", leaf: "broad", bloom: "cup", shoot: 0.35 } },
        { name: "réglisse", variant: { organ: "rhizome", length: 2.6, girth: 0.15, skin: "rough", leaf: "pinnate", bloom: "pea" } },
        { name: "chervis", variant: { organ: "bundle", length: 2.6, girth: 0.13, count: 6, skin: "smooth" } },
        { name: "carotte (long)", variant: { heart: true, habit: "long" } },
        { name: "salsifis (long)", variant: { habit: "long", length: 3.5, girth: 0.14, skin: "rough", leaf: "strap", bloom: "head", bracts: true } },
        { name: "panais (long)", variant: { habit: "long", length: 3.0, girth: 0.38, skin: "rough", leaf: "pinnate" } },
        { name: "pomme de terre (long)", variant: { habit: "long", organ: "tuber", length: 2.6, girth: 0.34, count: 4, leaf: "compound", bloom: "star", shoot: 0.6 } },
    ],
    build(variant) {
        const kind = textOf(variant, "organ"), long = textOf(variant, "habit") === "long";
        const length = numberOf(variant, "length"), girth = numberOf(variant, "girth");
        const depth = long ? LONG_DEPTH + length : length * STUDY;
        const above = numberOf(variant, "crown") * depth * (kind === "globe" ? 0.55 : 0.3);
        const organ = { kind, long, depth, girth: long ? Math.min(girth * LONG_GIRTH, LONG_WIDEST) : girth * STUDY, skin: textOf(variant, "skin"),
            soil: long ? Math.min(above, 0.9) : above, count: numberOf(variant, "count"), tuber: textOf(variant, "tuber"), section: flagOf(variant, "section") };
        const foot = rootFoot(organ);
        const crownY = foot.crown[1];
        const bloom = BLOOMS[textOf(variant, "bloom")];
        const look = { heart: flagOf(variant, "heart"), bracts: flagOf(variant, "bracts") };
        const size = numberOf(variant, "size");
        // The shoot shares out the column above the crown; a long root leaves little, so its shoot takes most of it.
        const shoot = long ? Math.max(0.75, numberOf(variant, "shoot")) : numberOf(variant, "shoot");
        const top = (share) => (crownY + shoot * (GROWN - crownY) * share) / GROWN;
        const leafKind = textOf(variant, "leaf");
        const leaf = leafOf(leafKind);
        const strap = leafKind === "strap";
        return {
            id: "racine-tubercule",
            stems: { count: 3, amplitude: 0.04, lambda: [6, 9], width: 0.04, tops: [top(0.95), top(0.8), top(0.62)] },
            foot,
            basal: ROSETTES[leafKind] ?? null,
            nodes: { every: [2.0, 3.0], length: height => lerp(2.2, 1.2, height) * (strap ? 1.3 : 1), angle: [28, 48], below: top(long ? 0.7 : 0.55) },
            leafProxy: strap ? 0.14 : 0.3,
            leaf,
            // Branch leaflets and fillers: one small blade, grassy for a grassy plant.
            leaflet: (rng, length, bend) => strap ? strapLeaf(rng, length * 1.2, bend, 0.8) : simpleLeaf(rng, length * 0.8, bend, 0.3),
            terminal: { size: [1.1, 1.4], r: s => bloom.proxy * s * size, off: () => 0, draw: (rng, s, stage) => bloom.draw(rng, s * size, stage, look) },
            motifs: [
                { name: "bloom", w: 2.4, smin: 0.7 * size, smax: 1.05 * size, max: 4, hard: true, layer: LAYER.bloom, upright: 0.8, staged: true,
                    r: s => bloom.proxy * s, off: s => 0.35 * s, draw: (rng, s, stage) => bloom.draw(rng, s, stage, look) },
                { name: "leaf", w: 2.2, smin: 1.1, smax: 2.2, max: 9, hard: true, layer: LAYER.leaf, upright: 0.5,
                    r: s => (strap ? 0.16 : 0.3) * s, off: s => 0.5 * s, draw: (rng, s) => leaf(rng, s, rng.sym(0.25)) },
            ],
        };
    },
};
