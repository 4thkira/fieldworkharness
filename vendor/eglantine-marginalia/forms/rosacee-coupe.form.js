// Radial and cupped flowers: a ring (or several) of petals round a boss of stamens, seen in perspective
// from above the side, on a pedicel; flat stars, open cups and goblets, a viola's unequal face, a
// columbine's spurs. What follows is the plant's own: hips, haws, strawberries, poppy urns, follicles,
// capsules, pods, heads of achenes or berries (rose, églantier, aubépine, fraise, pivoine, pavot,
// anémone, violette, ancolie, asaret, câprier). The perspective corolla is exported for lis-bulbe.
import { LAYER, numberOf, textOf, flagOf } from "../form.js";
import { bezier3, clamp, lerp, sample, smoothstep, unit } from "../geometry.js";
import { circle, HATCH, line, lobedLeaf, side, simpleLeaf, turnShape } from "../kit.js";
import { bladeBody, roundBody } from "../shapes.js";
const tri = (x) => 1 - Math.abs(2 * (x - Math.floor(x)) - 1);
/** How far past the last width sample the tip reaches, across the tip from one edge (0) to the other (1). */
const CAP = {
    round: t => 0.85 * Math.sin(Math.PI * t),
    notch: t => 0.85 * Math.sin(Math.PI * t) - 0.75 * Math.exp(-(((t - 0.5) / 0.11) ** 2)),
    pointed: t => 1.7 * Math.sin(Math.PI * t) ** 2.4,
    fringe: t => Math.sin(Math.PI * t) ** 0.4 * (0.15 + 0.55 * tri(t * 7 + 0.5)),
    oblique: t => 1.05 * Math.sin(Math.PI * t ** 1.8),
    wavy: t => 0.8 * Math.sin(Math.PI * t) + 0.13 * Math.sin(Math.PI * 6 * t),
};
/** Where a point at distance r from the axis, height h and azimuth theta (0 toward the viewer) falls on the page. */
export function project(theta, tilt, r, h) {
    return [r * Math.sin(theta), h * Math.cos(tilt) - r * Math.cos(theta) * Math.sin(tilt)];
}
const depthOf = (theta, tilt, r, h) => r * Math.cos(theta) * Math.cos(tilt) + h * Math.sin(tilt);
/**
 * A petal at azimuth `theta` of a flower whose axis is +y, seen from `tilt` radians above its side
 * (0 side-on, π/2 face-on). The petal's breadth lies across the azimuth, so side petals foreshorten.
 */
export function petal(rng, theta, tilt, spec) {
    const n = spec.samples ?? 16;
    const st = Math.sin(tilt);
    let lat = [Math.cos(theta), Math.sin(theta) * st];
    const latLength = Math.hypot(lat[0], lat[1]);
    // A petal seen edge-on keeps a sliver of breadth, as an engraver would show its thickness.
    if (latLength < 0.3)
        lat = latLength < 1e-6 ? [0, 0.3] : [lat[0] / latLength * 0.3, lat[1] / latLength * 0.3];
    const centre = [], left = [], right = [];
    let depth = 0;
    for (let k = 0; k <= n; k += 1) {
        const v = k / n;
        const [r, h] = spec.path(v);
        const c = project(theta, tilt, r, h);
        const w = spec.width(v);
        centre.push(c);
        left.push([c[0] + lat[0] * w, c[1] + lat[1] * w]);
        right.push([c[0] - lat[0] * w, c[1] - lat[1] * w]);
        depth += depthOf(theta, tilt, r, h) / (n + 1);
    }
    const end = centre[n], before = centre[n - 1];
    const [r0, h0] = spec.path(1 - 1 / n), [r1, h1] = spec.path(1);
    const screen = Math.hypot(end[0] - before[0], end[1] - before[1]);
    const fore = Math.min(1, screen / Math.max(1e-6, Math.hypot(r1 - r0, h1 - h0)));
    const [tx, ty] = unit(end[0] - before[0], end[1] - before[1]);
    const w1 = spec.width(1);
    const cap = [];
    for (let k = 1; k < 10; k += 1) {
        const t = k / 10, reach = w1 * fore * CAP[spec.tip](t), across = Math.cos(Math.PI * t) * w1;
        cap.push([end[0] + lat[0] * across + tx * reach, end[1] + lat[1] * across + ty * reach]);
    }
    const outline = [...left, ...cap, ...right.slice().reverse()];
    // Light from the upper left of the page: the edge further right lies in shade.
    const meanX = (points) => points.reduce((sum, p) => sum + p[0], 0) / points.length;
    const shadeSide = meanX(left) >= meanX(right) ? 1 : -1;
    const edge = shadeSide > 0 ? left : right;
    const weight = spec.weight * (depth < 0 ? 1.15 : 0.9);
    const grain = [], veins = [], extra = [];
    const along = (q, v0, v1) => {
        const a = Math.round(v0 * n), b = Math.max(a + 1, Math.round(v1 * n));
        const points = [];
        for (let k = a; k <= b; k += 1) {
            const c = centre[k], w = spec.width(k / n) * q;
            points.push([c[0] + lat[0] * w, c[1] + lat[1] * w]);
        }
        return points;
    };
    let shadow;
    if (spec.pattern === "checkered") {
        // The fritillary's chequer: cuts both ways over the whole tepal.
        shadow = [];
        for (let q = -0.85; q <= 0.86; q += 0.34)
            grain.push(along(q, 0.05, 1));
        for (let k = 2; k < n; k += 2)
            grain.push([left[k], right[k]]);
    }
    else {
        shadow = [[...centre, ...edge.slice().reverse().map((p, index) => {
                    const c = centre[n - index];
                    return [c[0] + (p[0] - c[0]) * 1.7, c[1] + (p[1] - c[1]) * 1.7];
                })]];
        const widest = Math.max(...Array.from({ length: 9 }, (_, k) => spec.width(k / 8)));
        const lanes = spec.lanes ?? clamp(Math.round(widest * Math.max(0.4, latLength) / (HATCH * 0.8)), 1, 7);
        for (let lane = 1; lane <= lanes; lane += 1) {
            const q = shadeSide * lane / (lanes + 0.4);
            grain.push(along(q, 0.1 + 0.08 * Math.abs(q), rng.range(0.4, 0.7) + 0.25 * Math.abs(q)));
        }
    }
    for (let k = 0; k < (spec.veins ?? 0); k += 1) {
        const q = (k + 1) / ((spec.veins ?? 0) + 1) * 1.6 - 0.8;
        veins.push(along(q, 0.06, 0.78 - 0.25 * Math.abs(q)));
    }
    if (spec.pattern === "spotted") {
        const spots = Array.from({ length: 7 }, () => {
            const v = rng.range(0.12, 0.6), k = Math.round(v * n), c = centre[k], w = spec.width(v) * rng.sym(0.6);
            return [c[0] + lat[0] * w, c[1] + lat[1] * w];
        });
        extra.push({ type: "dots", points: spots, radius: Math.max(0.006, spec.width(0.4) * 0.12) });
    }
    const body = { type: "body", outline, shadow, grain, veins, weight };
    if (spec.tone)
        body.tone = spec.tone;
    return { depth, shapes: [body, ...extra] };
}
/** Parts laid back to front. */
export const arrange = (parts) => parts.sort((a, b) => a.depth - b.depth).flatMap(part => part.shapes);
/** Shapes turned by `angle` about the origin and moved to `at`. */
export const placeAll = (shapes, angle, at = [0, 0]) => shapes.map(shape => turnShape(shape, angle, at));
/** A body from an outline, shaded with diagonals on its right half (stalks, pods, small fruits). */
function solidBody(outline, at, radius, weight, tone) {
    return roundBody(outline, at, radius, HATCH * 0.6, weight, [-0.6, 0.8], tone);
}
/** An egg-shaped outline along +y from `base`, `length` long and `width` across at its widest. */
export function egg(base, length, width, point = 0.3, n = 20) {
    const profile = (v) => width / 2 * Math.sin(Math.PI * v) ** (0.6 + point) * (1 + 0.25 * point * (0.5 - v));
    const rightSide = sample(v => [base[0] + profile(v), base[1] + length * v], n);
    const leftSide = sample(v => [base[0] - profile(v), base[1] + length * v], n).slice(1, -1).reverse();
    return [...rightSide, ...leftSide];
}
/** Small prickles along a stalk, hooked back toward its base (rose, églantier). */
function prickles(rng, points, size) {
    const out = [];
    for (let k = 2; k < points.length - 1; k += 2) {
        if (!rng.chance(0.7))
            continue;
        const a = points[k - 1], b = points[k];
        const [tx, ty] = unit(b[0] - a[0], b[1] - a[1]);
        const s = rng.chance(0.5) ? 1 : -1;
        const nx = -ty * s, ny = tx * s;
        out.push({ type: "solid", smooth: false, outline: [[b[0] - tx * size * 0.5, b[1] - ty * size * 0.5], [b[0] + tx * size * 0.4, b[1] + ty * size * 0.4],
                [b[0] + nx * size - tx * size * 0.45, b[1] + ny * size - ty * size * 0.45]] });
    }
    return out;
}
/** A petal's centreline for cup depth c: -1 swept back, 0 flat, 1 a goblet. */
function cupPath(length, c, base = 0.03) {
    const flat = [[0.35, 0.03], [0.7, 0.07], [1, 0.1]];
    const goblet = [[0.3, 0.22], [0.56, 0.6], [0.5, 0.95]];
    const swept = [[0.35, 0.0], [0.68, -0.2], [0.75, -0.55]];
    const target = c >= 0 ? goblet : swept, k = Math.abs(c);
    const [p1, p2, p3] = flat.map((p, index) => [lerp(p[0], target[index][0], k) * length, lerp(p[1], target[index][1], k) * length]);
    return bezier3([base * length, 0], p1, p2, p3);
}
function petalWidth(length, breadth, tip) {
    if (tip === "pointed")
        return v => length * breadth * 1.7 * v ** 0.6 * (1 - v) ** 0.85 + length * 0.01;
    return v => length * breadth * Math.sin(Math.PI / 2 * Math.min(1, v / 0.7)) ** 0.8 * (1 - 0.3 * Math.max(0, (v - 0.7) / 0.3)) * (0.35 + 0.65 * smoothstep(0, 0.35, v));
}
/** The boss at the flower's heart: stamens, a dark eye, a poppy's ovary, a borage cone, a mallow's column. */
function boss(rng, s, kind, centre, tilt, stamens) {
    const st = Math.max(0.35, Math.sin(tilt));
    const ring = (radius, count) => Array.from({ length: count }, (_, k) => {
        const a = k / count * Math.PI * 2 + rng.sym(0.2);
        return [centre[0] + Math.cos(a) * radius, centre[1] + Math.sin(a) * radius * st];
    });
    const scatter = (radius, count) => Array.from({ length: count }, () => {
        const a = rng.range(0, Math.PI * 2), r = Math.sqrt(rng.u()) * radius;
        return [centre[0] + Math.cos(a) * r, centre[1] + Math.sin(a) * r * st];
    });
    switch (kind) {
        case "ring": return [{ type: "dots", points: ring(s * 0.06, 7), radius: s * 0.014, tone: "accent" }, { type: "dots", points: [centre], radius: s * 0.02 }];
        case "dense": return [{ type: "dots", points: scatter(s * 0.13, 30), radius: s * 0.011 }, { type: "dots", points: scatter(s * 0.07, 9), radius: s * 0.013, tone: "accent" }];
        case "brush": {
            const out = [];
            const tips = [];
            for (let k = 0; k < 26; k += 1) {
                const a = rng.range(0, Math.PI * 2), lift = rng.range(0.25, 1);
                const len = s * stamens * rng.range(0.7, 1.05);
                const r = len * Math.sqrt(1 - lift * lift * 0.6);
                const end = [centre[0] + Math.cos(a) * r, centre[1] + Math.sin(a) * r * st + len * lift * Math.cos(tilt) * 0.8];
                out.push(line([centre, [lerp(centre[0], end[0], 0.5), lerp(centre[1], end[1], 0.5) + len * 0.05], end], s * 0.004));
                tips.push(end);
            }
            out.push({ type: "dots", points: tips, radius: s * 0.012, tone: "accent" }, { type: "dots", points: [centre], radius: s * 0.025 });
            return out;
        }
        case "dark": return [roundBody(circle(centre, s * 0.09, s * 0.09 * st, 14), centre, s * 0.09, HATCH * 0.45, 1), { type: "dots", points: ring(s * 0.12, 14), radius: s * 0.012 }];
        case "urn": {
            const top = [centre[0], centre[1] + s * 0.07];
            const urn = egg([centre[0], centre[1] - s * 0.02], s * 0.12, s * 0.11, 0.1, 12);
            const rays = Array.from({ length: 8 }, (_, k) => {
                const a = k / 8 * Math.PI * 2;
                return line([top, [top[0] + Math.cos(a) * s * 0.055, top[1] + Math.sin(a) * s * 0.055 * st]], s * 0.006, false);
            });
            return [{ type: "dots", points: ring(s * 0.1, 18), radius: s * 0.01 }, solidBody(urn, [centre[0], centre[1] + s * 0.04], s * 0.055, 0.7), ...rays];
        }
        case "cone": {
            const tip = [centre[0], centre[1] + s * 0.2 * Math.max(0.3, Math.cos(tilt))];
            return [{ type: "solid", outline: [[centre[0] - s * 0.045, centre[1]], tip, [centre[0] + s * 0.045, centre[1]]], smooth: false },
                { type: "dots", points: [tip], radius: s * 0.012, tone: "accent" }];
        }
        case "column": {
            const top = [centre[0], centre[1] + s * 0.14 * Math.max(0.4, Math.cos(tilt))];
            return [line([centre, top], s * 0.03), { type: "dots", points: scatter(s * 0.035, 8).map(([x, y]) => [x + top[0] - centre[0], y + top[1] - centre[1]]), radius: s * 0.012, tone: "accent" }];
        }
        default: return [{ type: "dots", points: [centre], radius: s * 0.012, tone: "accent" }];
    }
}
/** A calyx or corolla tube along the axis, foreshortened by the tilt; a carnation's ends in teeth. */
function tube(rng, s, length, toothed) {
    const w0 = s * 0.04, w1 = s * (toothed ? 0.065 : 0.055);
    const spine = (v) => [0, length * v];
    const body = bladeBody({ spine, halfWidth: v => lerp(w0, w1, v ** 1.5), shade: 1, spacing: HATCH * 0.7, grain: "along", reach: [0.6, 0.95], weight: 0.6,
        veins: [-0.45, 0.45].map(q => sample(v => [q * lerp(w0, w1, v ** 1.5), length * v], 6, 0.05, 0.9)), samples: 14 }, rng);
    if (toothed) {
        const teeth = Array.from({ length: 9 }, (_, k) => [w1 * (1 - k / 4), length + (k % 2 === 0 ? s * 0.05 : 0)]);
        body.outline = [[w0, 0], [w1, length * 0.97], ...teeth, [-w1, length * 0.97], [-w0, 0]];
        // Two small scales at the calyx's foot (the carnation's epicalyx).
        return [body, ...[-1, 1].map(sd => line([[sd * w0, s * 0.01], [sd * w0 * 1.6, s * 0.1]], s * 0.014))];
    }
    return [body];
}
/** An open flower, axis along +y from the origin, `s` across; returns its shapes and where its face is. */
function openFlower(rng, s, b, small = false) {
    if (b.symmetry === "viola")
        return violaFace(rng, s, b);
    if (b.symmetry === "spurred")
        return columbine(rng, s);
    const L = s * 0.5;
    // A long tube is seen from lower down, so the trumpet shows below its face.
    const tilt = small ? rng.range(0.7, 1.3) : b.tube > 0.3 ? 0.62 : 0.42 + 0.6 * (1 - Math.max(0, b.cup)) + rng.sym(0.05);
    const parts = [];
    const start = rng.range(0, Math.PI * 2);
    for (let ring = 0; ring < b.rings; ring += 1) {
        const length = L * (1 - 0.2 * ring);
        const cup = Math.min(1, b.cup + 0.28 * ring);
        for (let k = 0; k < b.petals; k += 1) {
            const theta = start + (k + 0.5 * ring) / b.petals * Math.PI * 2 + rng.sym(0.08);
            const len = length * rng.range(0.92, 1.06);
            parts.push(petal(rng, theta, tilt, { path: cupPath(len, cup), width: petalWidth(len, b.breadth, b.tip), tip: b.tip,
                weight: small ? 0.2 : 0.3 + 0.1 * ring, veins: b.veins ? 3 : 0, ...(small ? { lanes: 0 } : {}), samples: small ? 8 : 16 }));
        }
    }
    const height = b.tube * s;
    const lift = height * Math.cos(tilt);
    // In a goblet the boss sits low and the front petals cover it; in an open cup or a flat flower it shows.
    const bossDepth = b.cup > 0.6 ? depthOf(0, tilt, 0, L * 0.1) : Infinity;
    parts.push({ depth: bossDepth, shapes: boss(rng, s, small && b.boss === "dense" ? "ring" : b.boss, [0, 0], tilt, b.stamens) });
    const face = arrange(parts).map(shape => turnShape(shape, 0, [0, lift]));
    return height > 0 ? [...tube(rng, s, lift, b.boss === "none"), ...face] : face;
}
/** A violet or pansy face-on: two upper petals, two side ones and a broad lower lip, with a spur behind. */
function violaFace(rng, s, b) {
    const L = s * 0.42;
    const face = Math.PI / 2;
    const parts = [];
    const add = (theta, length, breadth, weight, veins, order) => {
        const part = petal(rng, theta, face, { path: cupPath(length, 0.05, 0.05), width: petalWidth(length, breadth, "round"), tip: "round", weight, veins });
        parts.push({ depth: order, shapes: part.shapes });
    };
    const broad = b.breadth;
    for (const sd of [-1, 1])
        add(Math.PI + sd * 0.42, L * 1.0, broad, 0.75, 0, 0);
    for (const sd of [-1, 1])
        add(sd * 1.3, L * 0.85, broad * 0.85, 0.4, 0, 1);
    add(0, L * 1.05, broad * 1.15, 0.35, 3, 2);
    // The spur, behind the face, poking out between an upper and a side petal.
    const spur = bladeBody({ spine: v => [-L * 0.95 * v, L * 0.15 + L * 0.35 * v - L * 0.15 * v * v], halfWidth: v => L * 0.09 * (1 - 0.6 * v),
        shade: 1, spacing: HATCH * 0.7, grain: "along", reach: [0.5, 0.9], weight: 0.6, samples: 10 }, rng);
    return [spur, ...arrange(parts), { type: "dots", points: [[0, -L * 0.04]], radius: s * 0.03, tone: "accent" }];
}
/** A columbine, axis +y: five spurred petals in a funnel, five spreading sepals between, stamens beyond. */
function columbine(rng, s) {
    const L = s * 0.48, tilt = 0.32;
    const parts = [];
    const start = rng.range(0, Math.PI * 2);
    for (let k = 0; k < 5; k += 1) {
        const theta = start + k / 5 * Math.PI * 2;
        parts.push(petal(rng, theta + Math.PI / 5, tilt, { path: cupPath(L * 0.75, 0.35), width: petalWidth(L * 0.75, 0.16, "pointed"), tip: "pointed", weight: 0.35, lanes: 2 }));
        parts.push(petal(rng, theta, tilt, { path: cupPath(L * 0.62, 0.75), width: petalWidth(L * 0.62, 0.22, "round"), tip: "round", weight: 0.45 }));
        // The spur runs back past the base and hooks in at its end.
        const spur = petal(rng, theta, tilt, { path: bezier3([L * 0.12, L * 0.05], [L * 0.4, -L * 0.2], [L * 0.48, -L * 0.6], [L * 0.3, -L * 0.72]),
            width: v => L * 0.05 * (1 - 0.85 * v) + L * 0.006, tip: "round", weight: 0.55, lanes: 1, samples: 10 });
        parts.push({ depth: spur.depth - L, shapes: spur.shapes });
    }
    const bundle = Array.from({ length: 7 }, (_, k) => {
        const x = (k - 3) * L * 0.025;
        return line([[x * 0.4, L * 0.2], [x, L * 0.85]], s * 0.005);
    });
    parts.push({ depth: depthOf(0, tilt, 0, L * 0.3), shapes: [...bundle, { type: "dots", points: Array.from({ length: 7 }, (_, k) => [(k - 3) * L * 0.025, L * 0.86]), radius: s * 0.011, tone: "accent" }] });
    return arrange(parts);
}
/** A closed bud along +y: an egg in a clasp of sepals; a rose's sepals end in leafy tips. */
function closedBud(rng, s, b) {
    if (b.symmetry === "spurred") {
        const head = egg([0, 0], s * 0.32, s * 0.16, 0.5);
        const spurs = [-1, 0, 1].map(sd => line(sample(v => [sd * s * 0.05 * (1 + v), -s * 0.22 * v + s * 0.03 * v * v], 5), s * 0.025));
        return [...spurs, solidBody(head, [0, s * 0.16], s * 0.08, 0.5)];
    }
    if (b.cluster === "corymb")
        return [roundBody(circle([0, s * 0.12], s * 0.12, s * 0.12, 10), [0, s * 0.12], s * 0.12, HATCH * 0.6, 0.35)];
    const round = b.seed === "berry" && b.boss === "brush";
    const length = round ? s * 0.22 : b.tube > 0 ? s * (0.35 + b.tube * 0.5) : s * (b.budNod ? 0.36 : 0.32);
    const width = round ? s * 0.2 : s * (b.tube > 0 ? 0.09 : 0.18);
    const out = [solidBody(egg([0, 0], length, width, round ? 0 : 0.5), [0, length * 0.5], width / 2, b.budNod ? 0.65 : 0.45)];
    if (b.budNod) {
        // A poppy's bud hangs and is bristly.
        for (let k = 0; k < 12; k += 1) {
            const v = rng.range(0.15, 0.9), sd = k % 2 ? 1 : -1;
            const x = sd * width / 2 * Math.sin(Math.PI * v) ** 0.8, y = length * v;
            out.push(line([[x, y], [x + sd * s * 0.035, y + s * 0.01]], s * 0.004, false));
        }
    }
    const sepals = round ? 0 : 3;
    for (let k = 0; k < sepals; k += 1) {
        const sd = k - 1;
        const reach = length * (b.prickles ? 1.15 : 0.7);
        out.push(bladeBody({ spine: v => [sd * width * 0.42 * Math.sin(Math.PI * v * 0.9) + sd * s * 0.02 * v, reach * v],
            halfWidth: v => width * 0.28 * (1 - v) ** 0.8 * (sd === 0 ? 1 : 0.7), shade: sd >= 0 ? 1 : -1, spacing: HATCH * 0.7, grain: "along", reach: [0.4, 0.8], weight: 0.6, samples: 10 }, rng));
        if (b.prickles)
            out.push(line([[sd * width * 0.3, reach * 0.95], [sd * width * 0.3 + sd * s * 0.06, reach * 1.05]], s * 0.008));
    }
    if (!round)
        out.push(line([[0, length * 0.75], [0, length * 0.98]], s * 0.005));
    return out;
}
// ---------------------------------------------------------------- what the flower becomes
/** One fruit along +y from the origin, `s` the flower's size. */
function fruit(rng, s, b) {
    switch (b.seed) {
        case "hip": {
            // A hip: smooth, red, crowned with the dried sepals.
            const length = s * 0.22 * b.fruit, width = s * 0.24;
            const neck = [0, length + s * 0.02];
            const crown = Array.from({ length: 5 }, (_, k) => {
                const a = (k / 4 - 0.5) * 2.2;
                return line(sample(v => [neck[0] + Math.sin(a) * s * 0.16 * v, neck[1] + Math.cos(a) * s * 0.12 * v - s * 0.04 * v * v], 4), s * 0.008);
            });
            return [solidBody(egg([0, s * 0.02], length, width, 0.15), [0, length * 0.5], width / 2, 0.6, "accent"), ...crown];
        }
        case "haw": {
            const r = s * 0.12;
            return [solidBody(circle([0, r * 1.1], r * 0.9, r, 14), [0, r * 1.1], r, 0.6, "accent"), { type: "dots", points: [[0, r * 2]], radius: r * 0.25 }];
        }
        case "strawberry": {
            // A strawberry: a red cone pitted with seeds, under a star of sepals.
            const length = s * 0.36, width = s * 0.3;
            const outline = sample(v => [width / 2 * Math.sin(Math.PI * Math.min(1, v * 1.1)) ** 0.7 * (1 - 0.35 * v), s * 0.04 + length * v], 14);
            const body = [...outline, ...outline.slice(1, -1).reverse().map(([x, y]) => [-x, y])];
            const seeds = Array.from({ length: 22 }, () => {
                const v = rng.range(0.08, 0.92), [x, y] = outline[Math.round(v * 14)];
                return [x * rng.range(-0.85, 0.85), y];
            });
            const calyx = Array.from({ length: 7 }, (_, k) => {
                const a = (k / 6 - 0.5) * 3.2;
                return line([[0, s * 0.04], [Math.sin(a) * s * 0.17, s * 0.04 - Math.cos(a) * s * 0.03 + s * 0.02]], s * 0.016);
            });
            return [solidBody(body, [0, s * 0.18], width / 2, 0.55, "accent"), { type: "dots", points: seeds, radius: s * 0.009 }, ...calyx];
        }
        case "urn": {
            // The poppy's urn: a ribbed capsule capped with a flat disc of stigmatic rays.
            const length = s * 0.42, width = s * 0.28;
            const outline = egg([0, s * 0.03], length, width, -0.2, 20);
            const body = solidBody(outline, [0, length * 0.55], width / 2, 0.65);
            body.veins = [-0.6, -0.2, 0.2, 0.6].map(q => sample(v => [q * width / 2 * Math.sin(Math.PI * v) ** 0.4, s * 0.03 + length * v], 8, 0.08, 0.92));
            const top = [0, s * 0.03 + length * 0.96];
            const disc = circle(top, width * 0.36, width * 0.12, 16);
            const rays = Array.from({ length: 9 }, (_, k) => {
                const a = k / 9 * Math.PI * 2;
                return line([top, [top[0] + Math.cos(a) * width * 0.34, top[1] + Math.sin(a) * width * 0.11]], s * 0.006, false);
            });
            return [line([[0, 0], [0, s * 0.06]], s * 0.03), body, { type: "body", outline: disc, shadow: [], grain: [], veins: [], weight: 0.5 }, ...rays];
        }
        case "pod": {
            // Slender pods, beaded with seeds (chélidoine).
            const out = [];
            for (const lean of [-0.25, 0.05, 0.3]) {
                const len = s * rng.range(0.6, 0.8);
                const spine = (v) => [Math.sin(lean) * len * v, Math.cos(lean) * len * v];
                out.push(bladeBody({ spine, halfWidth: v => s * 0.022 * (0.8 + 0.2 * Math.sin(v * Math.PI * 9) ** 2) * (1 - v * 0.4), shade: 1, spacing: HATCH * 0.6, grain: "along", reach: [0.6, 0.95], weight: 0.5, midrib: true, samples: 18 }, rng));
            }
            return out;
        }
        case "follicles": {
            // Follicles: plump beaked pods splayed from one point; some split and show their seeds.
            const count = b.symmetry === "spurred" ? 5 : b.tube > 0 ? 2 : b.rings > 1 ? 3 : 4;
            const out = [];
            for (let k = 0; k < count; k += 1) {
                const lean = ((k + 0.5) / count - 0.5) * (b.symmetry === "spurred" ? 0.5 : 1.4) + rng.sym(0.06);
                const len = s * (b.symmetry === "spurred" ? 0.42 : 0.38), w = s * (b.rings > 1 ? 0.13 : 0.08);
                const spine = (v) => [Math.sin(lean) * len * v + Math.sign(lean) * s * 0.06 * v * v, Math.cos(lean) * len * v];
                const pod = bladeBody({ spine, halfWidth: v => w * Math.sin(Math.PI * Math.min(1, v * 1.05)) ** 0.6 * (1 - v * 0.3), shade: lean > 0 ? 1 : -1, spacing: HATCH * 0.65, grain: "along", reach: [0.5, 0.9], weight: 0.55, midrib: true, samples: 16 }, rng);
                out.push(pod, line([spine(0.97), [spine(1)[0] + Math.sign(lean || 1) * s * 0.03, spine(1)[1] + s * 0.05]], s * 0.008));
                if (b.rings > 1 && k === 1)
                    out.push({ type: "dots", points: [0.35, 0.5, 0.65].map(v => spine(v)), radius: w * 0.42, tone: "accent" });
            }
            return out;
        }
        case "achenes": {
            // A head of achenes on its stalk: a woolly ball for the anemone, beaked achenes for the wood anemone.
            const centre = [0, s * 0.18];
            const r = s * 0.13;
            const points = Array.from({ length: 36 }, (_, k) => {
                const a = k * 2.4, rr = r * Math.sqrt((k + 0.5) / 36);
                return [centre[0] + Math.cos(a) * rr, centre[1] + Math.sin(a) * rr * 1.1];
            });
            const beaks = b.petals > 6 ? points.filter((_, k) => k > 20).map(p => {
                const [dx, dy] = unit(p[0] - centre[0], p[1] - centre[1]);
                return line([p, [p[0] + dx * s * 0.06, p[1] + dy * s * 0.06 - s * 0.02]], s * 0.005, false);
            }) : [];
            return [line([[0, 0], [0, s * 0.08]], s * 0.02), roundBody(circle(centre, r, r * 1.1, 16), centre, r, HATCH * 0.6, 0.55), { type: "dots", points, radius: s * 0.012 }, ...beaks];
        }
        case "berry": {
            // A berry crowned with the calyx (myrte); a long one split to its red pulp (câprier).
            if (b.fruit > 1.4) {
                const length = s * 0.42, width = s * 0.2;
                const shapes = [line([[0, 0], [0, s * 0.12]], s * 0.018), solidBody(egg([0, s * 0.12], length, width, 0.1), [0, s * 0.12 + length / 2], width / 2, 0.6)];
                const split = egg([0, s * 0.2], length * 0.68, width * 0.5, 0.2);
                shapes.push({ type: "body", outline: split, shadow: [], grain: [], veins: [], weight: 0.6, tone: "accent" }, { type: "dots", points: Array.from({ length: 8 }, (_, k) => [rng.sym(width * 0.15), s * 0.24 + length * 0.6 * k / 8]), radius: s * 0.012 });
                return shapes;
            }
            const r = s * 0.14 * b.fruit;
            const top = [0, r * 2.1];
            return [roundBody(circle([0, r * 1.05], r * 0.92, r, 16), [0, r * 1.05], r, HATCH * 0.45, 0.95),
                ...[-0.7, 0, 0.7].map(a => line([top, [top[0] + Math.sin(a) * r * 0.5, top[1] + Math.cos(a) * r * 0.35]], s * 0.007))];
        }
        default: {
            // A capsule in its persistent calyx: round and beaked (lin), long in a tube (œillet), three-valved (violette).
            const long = b.tube > 0.3;
            const length = s * (long ? 0.5 : 0.24 * b.fruit), width = s * (long ? 0.12 : 0.2);
            const out = [];
            if (b.symmetry === "viola") {
                for (const a of [-0.7, 0, 0.7]) {
                    const valve = bladeBody({ spine: v => [Math.sin(a) * s * 0.22 * v, Math.cos(a) * s * 0.22 * v], halfWidth: v => s * 0.05 * Math.sin(Math.PI * v) ** 0.7, shade: a >= 0 ? 1 : -1, spacing: HATCH * 0.6, grain: "along", reach: [0.4, 0.8], weight: 0.5, midrib: true, samples: 12 }, rng);
                    out.push(valve);
                }
                return out;
            }
            out.push(solidBody(egg([0, s * 0.03], length, width, long ? 0.1 : 0.35), [0, length * 0.5], width / 2, 0.55));
            for (const a of [-0.45, -0.15, 0.15, 0.45])
                out.push(line([[0, s * 0.02], [Math.sin(a) * width * 0.9, s * 0.02 + length * (long ? 0.85 : 0.45)]], s * 0.01));
            out.push(line([[0, length + s * 0.03], [0, length + s * 0.07]], s * 0.008));
            return out;
        }
    }
}
// ---------------------------------------------------------------- on the plant
/** Turns a head drawn upright so that it faces out to one side or hangs, at the end of its pedicel. */
function orient(shapes, facing, sd, top) {
    const angle = facing === "out" ? -sd * 1.05 : facing === "nod" ? -sd * (Math.PI - 0.45) : 0;
    return placeAll(shapes, angle, top);
}
function pedicel(rng, s, facing, sd, length) {
    const end = facing === "nod" ? [sd * s * 0.17, length * 1.02] : facing === "out" ? [sd * s * 0.1, length * 0.97] : [rng.sym(0.03) * s, length];
    const pull = facing === "nod" ? [sd * s * 0.04, length * 1.25] : [end[0] * 0.3, length * 0.75];
    return sample(bezier3([0, 0], [0, length * 0.45], pull, end), 8);
}
/** One flower, bud or fruit at the end of its pedicel, `s` across. */
function single(rng, s, stage, b, length) {
    const sd = side(rng);
    const facing = stage === "bud" ? (b.budNod || b.facing === "nod" ? "nod" : b.facing === "out" ? "out" : "up")
        : stage === "seed" ? (b.seed === "strawberry" || (b.seed === "berry" && b.fruit > 1.4) ? "nod" : b.seed === "hip" && b.fruit > 1.3 ? "out" : "up")
            : b.facing;
    const points = pedicel(rng, s, facing, sd, length);
    const top = points[points.length - 1];
    const head = stage === "bud" ? closedBud(rng, s, b) : stage === "seed" ? fruit(rng, s, b) : openFlower(rng, s, b);
    const out = [line(points, s * 0.022)];
    if (b.prickles)
        out.push(...prickles(rng, points, s * 0.05));
    // A viola's face is drawn face-on already: its pedicel hooks over and the face turns only a little.
    if (stage === "bloom" && b.symmetry === "viola")
        return [...out, ...placeAll(head, -sd * 0.25, top)];
    return [...out, ...orient(head, facing, sd, top)];
}
/** A few flowers on forking pedicels: one open (or fruiting), the others behind it in bud or bloom. */
function cyme(rng, s, stage, b) {
    const out = [];
    const fork = [0, s * 0.18];
    out.push(line([[0, 0], fork], s * 0.024));
    const count = rng.int(2, 3);
    for (let k = count - 1; k >= 0; k -= 1) {
        const lean = k === 0 ? rng.sym(0.12) : (k % 2 ? -1 : 1) * rng.range(0.55, 0.8);
        const size = k === 0 ? s : s * rng.range(0.7, 0.85);
        const sub = stage === "bloom" && k === count - 1 && count > 2 ? "bud" : stage === "seed" && k > 0 && rng.chance(0.4) ? "bloom" : stage;
        out.push(...placeAll(single(rng, size, sub, b, s * (k === 0 ? 0.3 : 0.26)), -lean, fork));
    }
    return out;
}
/** A domed cluster of small five-petalled flowers (aubépine), going to haws. */
function corymb(rng, s, stage, b) {
    const out = [];
    const nodes = [[0, s * 0.26], [-s * 0.13, s * 0.38], [s * 0.14, s * 0.36]];
    out.push(line([[0, 0], nodes[0]], s * 0.022), line([nodes[0], nodes[1]], s * 0.015), line([nodes[0], nodes[2]], s * 0.015));
    const count = rng.int(8, 12);
    const heads = [];
    for (let k = 0; k < count; k += 1) {
        const x = (k / (count - 1) * 2 - 1) * s * 0.42 + rng.sym(0.04 * s);
        const y = s * 0.58 + s * 0.1 * (1 - (x / (s * 0.45)) ** 2) + rng.sym(0.07 * s);
        heads.push({ at: [x, y], node: x < -s * 0.14 ? nodes[1] : x > s * 0.14 ? nodes[2] : nodes[0] });
    }
    for (const { at, node } of heads)
        out.push(line([node, [lerp(node[0], at[0], 0.4), lerp(node[1], at[1], 0.75)], at], s * 0.009));
    const small = s * 0.22;
    for (const { at } of heads.sort((p, q) => q.at[1] - p.at[1])) {
        if (stage === "bud")
            out.push(roundBody(circle(at, small * 0.18, small * 0.18, 10), at, small * 0.18, HATCH * 0.6, 0.35));
        else if (stage === "seed")
            out.push(...placeAll(fruit(rng, small, b), rng.sym(0.3), [at[0], at[1] - small * 0.1]));
        else
            out.push(...placeAll(openFlower(rng, small, b, true), rng.sym(0.3), at));
    }
    return out;
}
function inflorescence(rng, s, stage, b) {
    if (b.cluster === "corymb")
        return corymb(rng, s, stage, b);
    if (b.cluster === "cyme")
        return cyme(rng, s, stage, b);
    return single(rng, s, stage, b, s * 0.38);
}
// ---------------------------------------------------------------- leaves
/** An ovate leaflet with a sawn edge and paired veins (rose, fraise). */
function serrate(rng, length, bend, width = 0.3, teeth = 7) {
    const spine = (v) => [bend * length * v * v, length * v];
    const halfWidth = (v) => length * width * 2.2 * v ** 0.55 * (1 - v) ** 0.75 + length * 0.004;
    const edge = (v) => -length * 0.03 * ((v * teeth) % 1) * Math.sin(Math.PI * Math.min(1, v * 1.1));
    const veins = [];
    for (const t of [0.22, 0.38, 0.54, 0.7]) {
        for (const sd of [1, -1]) {
            const [x, y] = spine(t), [x2, y2] = spine(t + 0.12);
            veins.push([[x, y], [x2 + sd * halfWidth(t + 0.12) * 0.8, y2]]);
        }
    }
    return [bladeBody({ spine, halfWidth, edge, shade: side(rng), spacing: HATCH, grain: "across", weight: 0.55, midrib: true, veins, samples: teeth * 3 }, rng)];
}
/** A small rounded leaflet with crenate lobes toward its tip (ancolie, chélidoine). */
function roundlet(rng, size, bend = 0) {
    const spine = (v) => [bend * size * v * v, size * v];
    const halfWidth = (v) => size * 0.52 * Math.sin(Math.PI * (v ** 0.75) * 0.94) ** 0.7 + size * 0.02;
    const edge = (v) => -size * 0.07 * Math.abs(Math.sin(Math.PI * 3 * v)) * smoothstep(0.45, 0.85, v);
    return [bladeBody({ spine, halfWidth, edge, shade: side(rng), spacing: HATCH, grain: "across", weight: 0.5, midrib: true, samples: 18 }, rng)];
}
/** A blade cut deep into narrow lobes (anémone, sylvie). */
function cutBlade(rng, length, bend) {
    const spine = (v) => [bend * length * v * v, length * v];
    const halfWidth = (v) => length * 0.34 * Math.sin(Math.PI * v ** 0.8) ** 0.9 * (0.25 + 0.75 * tri(v * 3.5 + 0.15) ** 1.6) + length * 0.01;
    return [bladeBody({ spine, halfWidth, shade: side(rng), spacing: HATCH, grain: "across", weight: 0.5, midrib: true, samples: 28 }, rng)];
}
/** Leaflets spread at the head of a petiole: `parts` gives each leaflet's angle and its shapes. */
function onPetiole(length, bend, petiole, parts) {
    const stem = sample(v => [bend * petiole * v * v, petiole * v], 6);
    const top = stem[6];
    return [line(stem, length * 0.018), ...parts.flatMap(part => placeAll(part.shapes, part.angle, top))];
}
/** A broad leaf drawn round its centre: heart, kidney, round or shallowly lobed, on a petiole. */
export function polarLeaf(rng, length, bend, spec) {
    const radius = (phi) => {
        let r = 1 + spec.point * 0.4 * Math.max(0, Math.cos(phi)) ** 6;
        r *= 1 - spec.sinus * 0.7 * Math.exp(-(((Math.abs(phi) - Math.PI) / 0.32) ** 2));
        r *= 1 + spec.depth * Math.max(0, Math.cos(spec.lobes * phi)) ** 2 - spec.depth * 0.3;
        r *= 1 - spec.crenate * 0.045 * (1 - Math.abs(Math.sin(phi * 9)));
        return r;
    };
    const petiole = length * spec.petiole;
    const scale = (length - petiole) / (radius(0) + radius(Math.PI));
    const centre = [bend * length * 0.3, petiole + radius(Math.PI) * scale];
    const at = (phi, k = 1) => [centre[0] + spec.breadth * radius(phi) * scale * k * Math.sin(phi), centre[1] + radius(phi) * scale * k * Math.cos(phi)];
    const outline = sample(v => at(-Math.PI + 2 * Math.PI * v), 96).slice(0, -1);
    const shade = side(rng);
    const reach = length * 2;
    // Shade as a crescent away from the light, as on a broad leaf cupped toward the viewer.
    const R = radius(0) * scale;
    const frame = [[centre[0] - reach, -reach], [centre[0] + reach, -reach], [centre[0] + reach, reach * 2], [centre[0] - reach, reach * 2]];
    const lit = outline.map(([x, y]) => [centre[0] + (x - centre[0]) * 0.95 - shade * R * 0.3, centre[1] + (y - centre[1]) * 0.95 + R * 0.15]);
    const shadow = [frame, lit];
    const grain = [];
    for (let k = -36; k <= 36; k += 1) {
        const y0 = centre[1] + k * HATCH * 1.05;
        grain.push([[centre[0] - length, y0 - length * 0.35 * shade], [centre[0] + length, y0 + length * 0.35 * shade]]);
    }
    const base = [centre[0], petiole + radius(Math.PI) * scale * 0.35];
    const veins = [0, 0.75, -0.75, 1.5, -1.5, 2.2, -2.2].map(phi => {
        const end = at(phi, 0.86);
        return sample(v => [lerp(base[0], end[0], v) + Math.sin(phi) * scale * 0.05 * Math.sin(Math.PI * v), lerp(base[1], end[1], v)], 6);
    });
    // A pale band within the edge, as on a cyclamen's leaf.
    if (spec.mottled)
        veins.push(sample(v => at(-Math.PI * 0.85 + 1.7 * Math.PI * v, 0.62), 30));
    const body = { type: "body", outline, shadow, grain, veins, weight: 0.6 };
    return [line([[0, 0], [bend * petiole * 0.2, petiole * 0.6], [centre[0], petiole + radius(Math.PI) * scale * 0.3]], length * 0.022), body];
}
/** An obovate leaf, crinkled between close veins, with a scalloped edge (primevère, bourrache). */
function rugose(rng, length, bend) {
    const spine = (v) => [bend * length * v * v, length * v];
    const halfWidth = (v) => length * 0.36 * v ** 0.9 * (1 - v) ** 0.45 + length * 0.006;
    const veins = [];
    for (let k = 1; k <= 7; k += 1) {
        const t = 0.12 + k * 0.1;
        for (const sd of [1, -1]) {
            const [x, y] = spine(t), [x2, y2] = spine(Math.min(1, t + 0.08));
            veins.push([[x, y], [x2 + sd * halfWidth(t) * 0.85, y2]]);
        }
    }
    return [bladeBody({ spine, halfWidth, edge: v => -length * 0.012 * Math.abs(Math.sin(v * Math.PI * 16)), shade: side(rng), spacing: HATCH * 0.9, grain: "across", weight: 0.6, midrib: true, veins, samples: 34 }, rng)];
}
/** An oblong leaf, lobed and toothed, its base widened to clasp the stem (pavot). */
function clasping(rng, length, bend) {
    const spine = (v) => [bend * length * v * v, length * v];
    const phase = rng.range(0, 1);
    const halfWidth = (v) => length * 0.36 * v ** 0.25 * (1 - v) ** 0.6 * (1 + 0.35 * (1 - smoothstep(0, 0.15, v))) + length * 0.006;
    const edge = (v) => -length * 0.045 * tri(v * 7 + phase) ** 1.6 * (1 - v * 0.4) - length * 0.008 * tri(v * 34);
    return [bladeBody({ spine, halfWidth, edge, shade: side(rng), spacing: HATCH, grain: "across", weight: 0.65, midrib: true, samples: 36 }, rng)];
}
function leafOf(kind, width, prickly) {
    switch (kind) {
        case "pinnate": return (rng, length, bend) => {
            // Two pairs and an odd leaflet, toothed, with stipules at the foot of the rachis (rose, églantier).
            const rachis = sample(v => [bend * length * v * v * 0.6, length * v], 12);
            const out = [line(rachis, length * 0.016)];
            for (const sd of [1, -1])
                out.push(line([rachis[0], [sd * length * 0.05, length * 0.08], [sd * length * 0.03, length * 0.15]], length * 0.02));
            for (let k = 0; k < 2; k += 1) {
                const at = rachis[4 + k * 4];
                for (const sd of [1, -1])
                    out.push(...placeAll(serrate(rng, length * 0.34, rng.sym(0.1), 0.27, 5), -sd * 1.0, at));
            }
            out.push(...serrate(rng, length * 0.38, rng.sym(0.1), 0.27, 6).map(shape => turnShape(shape, 0, rachis[12])));
            if (prickly)
                out.push(...prickles(rng, rachis.slice(0, 9), length * 0.04));
            return out;
        };
        case "trifoliate": return (rng, length, bend) => onPetiole(length, bend, length * 0.42, [-0.8, 0, 0.8].map(angle => ({ angle, shapes: serrate(rng, length * (angle === 0 ? 0.56 : 0.5), rng.sym(0.08), 0.33) })));
        case "ternate": return (rng, length, bend) => {
            const petiole = length * 0.42;
            const out = [line(sample(v => [bend * petiole * v * v, petiole * v], 6), length * 0.018)];
            const top = [bend * petiole, petiole];
            for (const a of [-0.9, 0, 0.9]) {
                const arm = length * (a === 0 ? 0.18 : 0.14);
                const end = [top[0] - Math.sin(a) * arm, top[1] + Math.cos(a) * arm];
                out.push(line([top, end], length * 0.012));
                out.push(...placeAll(roundlet(rng, length * 0.36), a, end));
            }
            return out;
        };
        case "compound": return (rng, length, bend) => {
            const petiole = length * 0.36;
            const out = [line(sample(v => [bend * petiole * v * v, petiole * v], 6), length * 0.02)];
            const top = [bend * petiole, petiole];
            for (const a of [-0.85, 0, 0.85]) {
                const arm = length * (a === 0 ? 0.2 : 0.14);
                const end = [top[0] - Math.sin(a) * arm, top[1] + Math.cos(a) * arm];
                out.push(line([top, end], length * 0.014));
                for (const b of a === 0 ? [-0.55, 0, 0.55] : [-0.3, 0.3])
                    out.push(...placeAll(simpleLeaf(rng, length * (b === 0 ? 0.42 : 0.34), rng.sym(0.1), 0.2), a + b, end));
            }
            return out;
        };
        case "pedate": return (rng, length, bend) => onPetiole(length, bend, length * 0.45, Array.from({ length: 5 }, (_, k) => {
            const u = k / 4 * 2 - 1;
            return { angle: u * 1.2, shapes: serrate(rng, length * 0.58 * (1 - 0.3 * Math.abs(u)), rng.sym(0.08), 0.16, 6) };
        }));
        case "divided": return (rng, length, bend) => onPetiole(length, bend, length * 0.4, [-0.75, 0, 0.75].map(angle => ({ angle, shapes: cutBlade(rng, length * 0.58, rng.sym(0.1)) })));
        case "pinnatifid": return (rng, length, bend) => {
            const rachis = sample(v => [bend * length * v * v * 0.5, length * v], 12);
            const out = [line(rachis, length * 0.016)];
            for (let k = 0; k < 2; k += 1)
                for (const sd of [1, -1])
                    out.push(...placeAll(roundlet(rng, length * 0.3), -sd * 1.0, rachis[4 + k * 3]));
            out.push(...placeAll(roundlet(rng, length * 0.4), 0, rachis[10]));
            return out;
        };
        case "lobed": return (rng, length, bend) => lobedLeaf(rng, length, bend);
        case "clasping": return (rng, length, bend) => clasping(rng, length, bend);
        case "rugose": return (rng, length, bend) => rugose(rng, length, bend);
        case "heart": return (rng, length, bend) => polarLeaf(rng, length, bend, { breadth: 0.85, point: 1, sinus: 0.8, lobes: 0, depth: 0, crenate: 1, petiole: 0.42 });
        case "kidney": return (rng, length, bend) => polarLeaf(rng, length, bend, { breadth: 1.3, point: 0, sinus: 0.9, lobes: 0, depth: 0, crenate: 0, petiole: 0.42 });
        case "round": return (rng, length, bend) => polarLeaf(rng, length, bend, { breadth: 1, point: 0.15, sinus: 0.25, lobes: 0, depth: 0, crenate: 0, petiole: 0.18 });
        case "mallow": return (rng, length, bend) => polarLeaf(rng, length, bend, { breadth: 0.9, point: 0.6, sinus: 0.45, lobes: 3, depth: 0.14, crenate: 1, petiole: 0.28 });
        default: return (rng, length, bend) => simpleLeaf(rng, length, bend, width);
    }
}
/** Mirrors shapes across the line through the origin along `axis`, for the second leaf of an opposite pair. */
function mirror(shapes, axis) {
    const [ax, ay] = unit(axis[0], axis[1]);
    const flip = (points) => points.map(([x, y]) => { const d = x * ax + y * ay; return [2 * d * ax - x, 2 * d * ay - y]; });
    return shapes.map(shape => {
        switch (shape.type) {
            case "body": return { ...shape, outline: flip(shape.outline), shadow: shape.shadow.map(flip), grain: shape.grain.map(flip), veins: shape.veins.map(flip) };
            case "solid": return { ...shape, outline: flip(shape.outline) };
            case "line": return { ...shape, points: flip(shape.points) };
            case "dots": return { ...shape, points: flip(shape.points) };
        }
    });
}
/** The angle a node leaf leaves its stem at, fixed for opposite pairs so the pair's twin can be found. */
const OPPOSITE = 55;
// ---------------------------------------------------------------- the form
export const form = {
    id: "rosacee-coupe",
    name: "rosacée en coupe",
    doc: "Radial and cupped flowers in perspective, a boss of stamens at the heart; hips, haws, capsules, follicles or berries after.",
    variants: {
        petals: { doc: "Petals (or petal-like sepals) in a ring", default: 5, range: [3, 8] },
        rings: { doc: "Rings of petals: 1 single, 2 semi-double (old rose), 3 double (pivoine)", default: 1, range: [1, 3] },
        breadth: { doc: "A petal's half-width as a share of its length: 0.15 narrow star, 0.55 broad round", default: 0.45, range: [0.1, 0.65] },
        cup: { doc: "Cup depth: -0.6 swept back (bourrache), 0 flat (fraise), 0.5 open cup (rose), 0.8 goblet (asaret)", default: 0.2, range: [-0.6, 0.9] },
        tip: { doc: "Petal tip: round, notched (églantier, primevère), pointed (bourrache), fringed (œillet), oblique (pervenche's pinwheel), wavy (pavot's crumpled silk)", default: "round", values: ["round", "notch", "pointed", "fringe", "oblique", "wavy"] },
        symmetry: { doc: "Radial; a viola's unequal face with a spur (violette, pensée); a columbine's spurred nodding bells (ancolie)", default: "radial", values: ["radial", "viola", "spurred"] },
        tube: { doc: "A corolla or calyx tube below the petals, as a share of the flower's size (belle-de-nuit long, œillet's toothed calyx, primevère short)", default: 0, range: [0, 0.7] },
        boss: { doc: "The heart: stamen ring, dense stamens (rose, pivoine), long brush (câprier, myrte), dark eye (anémone), poppy ovary, borage cone, mallow column, or bare", default: "ring", values: ["ring", "dense", "brush", "dark", "urn", "cone", "column", "none"] },
        stamens: { doc: "Length of a brush of stamens as a share of the flower's size", default: 0.3, range: [0.1, 0.75] },
        veins: { doc: "Fine veins on the petals (pavot, lin)", default: false, values: [true, false] },
        facing: { doc: "The open flower looks up, out to the side, or hangs", default: "up", values: ["up", "out", "nod"] },
        budNod: { doc: "The bud hangs on its hooked stalk and is bristly (pavot)", default: false, values: [true, false] },
        cluster: { doc: "Flowers borne singly, a few on a forking cyme, or in a domed corymb of small flowers (aubépine)", default: "solitary", values: ["solitary", "cyme", "corymb"] },
        seed: { doc: "What follows the flower: hip, haws, strawberry, a capsule in its calyx, a poppy urn, slender pods, follicles, a head of achenes, or a berry", default: "capsule", values: ["hip", "haw", "strawberry", "capsule", "urn", "pod", "follicles", "achenes", "berry"] },
        fruit: { doc: "The fruit's length over its breadth: a round hip 1, églantier's long hip 1.7; a berry over 1.4 splits to its pulp (câprier)", default: 1, range: [0.7, 2] },
        leaf: { doc: "Leaf kind", default: "simple", values: ["simple", "pinnate", "trifoliate", "ternate", "compound", "pedate", "divided", "pinnatifid", "lobed", "clasping", "rugose", "heart", "kidney", "round", "mallow"] },
        leafWidth: { doc: "A simple leaf's breadth as a share of its length (lin's needles 0.06, myrte 0.2, belle-de-nuit 0.35)", default: 0.28, range: [0.04, 0.45] },
        opposite: { doc: "Stem leaves in opposite pairs (pervenche, myrte, œillet, mouron)", default: false, values: [true, false] },
        basal: { doc: "A rosette of leaves at the root", default: false, values: [true, false] },
        prickles: { doc: "Prickles on the stalks and leaf rachis (rose, églantier)", default: false, values: [true, false] },
        woody: { doc: "A woody shrub's stems rather than a herb's", default: false, values: [true, false] },
        height: { doc: "How tall the plant stands, as a share of the column (violette and fraise low)", default: 0.9, range: [0.4, 1] },
        size: { doc: "Flower size relative to a dog rose's", default: 1, range: [0.4, 1.6] },
    },
    examples: [
        { name: "rose", variant: { rings: 2, breadth: 0.55, cup: 0.5, boss: "dense", seed: "hip", leaf: "pinnate", prickles: true, woody: true, size: 1.3 } },
        { name: "pavot", variant: { petals: 4, breadth: 0.62, cup: 0.55, tip: "wavy", veins: true, boss: "urn", budNod: true, seed: "urn", leaf: "clasping", size: 1.4 } },
        { name: "violette", variant: { symmetry: "viola", breadth: 0.4, seed: "capsule", leaf: "heart", basal: true, height: 0.45, size: 0.7 } },
        { name: "ancolie", variant: { symmetry: "spurred", facing: "nod", cluster: "cyme", seed: "follicles", leaf: "ternate", basal: true, size: 1.1 } },
        { name: "aubépine", variant: { cluster: "corymb", breadth: 0.45, seed: "haw", leaf: "lobed", woody: true, size: 1.3 } },
    ],
    build(variant) {
        const b = {
            petals: Math.round(numberOf(variant, "petals")), rings: Math.round(numberOf(variant, "rings")), breadth: numberOf(variant, "breadth"), cup: numberOf(variant, "cup"),
            tip: textOf(variant, "tip"), symmetry: textOf(variant, "symmetry"), tube: numberOf(variant, "tube"), boss: textOf(variant, "boss"), stamens: numberOf(variant, "stamens"),
            veins: flagOf(variant, "veins"), facing: textOf(variant, "facing"), cluster: textOf(variant, "cluster"), seed: textOf(variant, "seed"), fruit: numberOf(variant, "fruit"),
            prickles: flagOf(variant, "prickles"), budNod: flagOf(variant, "budNod"),
        };
        const size = numberOf(variant, "size"), height = numberOf(variant, "height");
        const woody = flagOf(variant, "woody"), basal = flagOf(variant, "basal");
        const kind = textOf(variant, "leaf");
        const plain = leafOf(kind, numberOf(variant, "leafWidth"), b.prickles);
        const opposite = flagOf(variant, "opposite");
        // The pair's twin mirrors across the stem, which lies at the fixed node angle from the leaf's axis.
        const leaf = opposite
            ? (rng, length, bend) => {
                const one = plain(rng, length, bend);
                const a = Math.sign(bend || 1) * OPPOSITE * Math.PI / 180;
                return [...one, ...mirror(plain(rng, length, -bend), [Math.sin(a), Math.cos(a)])];
            }
            : plain;
        const broad = ["trifoliate", "ternate", "compound", "pedate", "divided", "heart", "kidney", "round", "mallow", "lobed", "pinnate", "pinnatifid"].includes(kind);
        const draw = (rng, s, stage) => inflorescence(rng, s, stage, b);
        const low = height < 0.6;
        const tops = [0.92, 0.7, 0.5].map(top => top * height);
        return {
            id: "rosacee-coupe",
            stems: { count: 3, amplitude: woody ? 0.15 : 0.1, lambda: woody ? [4, 6] : [6, 9], width: woody ? 0.085 : 0.05, tops },
            basal: basal ? { count: [4, 7], length: low ? [2.6, 3.8] : [2.8, 4.4] } : null,
            nodes: { every: opposite ? [2.0, 2.8] : low ? [2.2, 3.0] : broad ? [1.9, 2.7] : [1.5, 2.3], length: h => lerp(broad ? 2.2 : 1.9, broad ? 1.4 : 1.2, h) * (low ? 0.85 : 1),
                angle: opposite ? [OPPOSITE, OPPOSITE] : [30, 55], below: basal ? (low ? 0.3 : 0.7) : 0.9 },
            leafProxy: broad ? 0.36 : 0.26,
            leaf,
            leaflet: (rng, length, bend) => kind === "pinnate" || kind === "trifoliate" ? serrate(rng, length * 0.8, bend, 0.28) : broad ? simpleLeaf(rng, length, bend, 0.3) : plain(rng, length, bend),
            terminal: { size: [1.25 * size, 1.5 * size], r: s => 0.5 * s, off: () => 0, draw },
            motifs: [
                { name: "bloom", w: 3, smin: 0.9 * size, smax: 1.3 * size, max: b.cluster === "corymb" ? 6 : 5, hard: true, layer: LAYER.bloom, upright: 0.8, staged: true,
                    r: s => 0.46 * s, off: s => 0.42 * s, draw },
                { name: "bud", w: 1, smin: 0.7 * size, smax: 0.95 * size, max: 4, hard: true, layer: LAYER.bloom, upright: 0.8,
                    r: s => 0.28 * s, off: s => 0.3 * s, draw: (rng, s) => single(rng, s, "bud", b, s * 0.3) },
                { name: "leaf", w: 2, smin: 1.1, smax: broad ? 2.0 : 1.7, max: 12, hard: true, layer: LAYER.leaf, upright: 0.3,
                    r: s => (broad ? 0.36 : 0.28) * s, off: s => 0.5 * s, draw: (rng, s) => plain(rng, s, rng.sym(0.25)) },
            ],
        };
    },
};
