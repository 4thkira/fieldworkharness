// The drawing kit every plant form shares: hatch spacing, small helpers, and the leaves several forms
// use. A primitive draws in its own frame, origin at its base and axis along +y, at its final size in
// centimetres, and returns paint-agnostic shapes (see shapes.ts). A form's own primitives stay in its file.
import { bezier3, lerp, sample, smoothstep } from "./geometry.js";
import { bladeBody, roundBody } from "./shapes.js";
/** Hatch spacing in centimetres at margin size; smaller is darker. */
export const HATCH = 0.055;
export const side = (rng) => rng.chance(0.5) ? 1 : -1;
export const line = (points, width, smooth = true, tone) => tone ? { type: "line", points, width, smooth, tone } : { type: "line", points, width, smooth };
/** Points rotated by `angle` radians about the origin, then moved to `at`. */
export const turn = (points, angle, at = [0, 0]) => {
    const c = Math.cos(angle), s = Math.sin(angle);
    return points.map(([x, y]) => [at[0] + x * c - y * s, at[1] + x * s + y * c]);
};
/** A shape rotated by `angle` radians about the origin, then moved to `at`. */
export function turnShape(shape, angle, at = [0, 0]) {
    switch (shape.type) {
        case "body": return { ...shape, outline: turn(shape.outline, angle, at), shadow: shape.shadow.map(ring => turn(ring, angle, at)),
            grain: shape.grain.map(cut => turn(cut, angle, at)), veins: shape.veins.map(vein => turn(vein, angle, at)) };
        case "solid": return { ...shape, outline: turn(shape.outline, angle, at) };
        case "line": return { ...shape, points: turn(shape.points, angle, at) };
        case "dots": return { ...shape, points: turn(shape.points, angle, at) };
    }
}
/** A closed circle (or ellipse) outline, for berries, buds and discs. */
export function circle(at, rx, ry = rx, n = 16) {
    return sample(v => [at[0] + Math.cos(v * Math.PI * 2) * rx, at[1] + Math.sin(v * Math.PI * 2) * ry], n).slice(0, -1);
}
/** A round berry or bud shaded as a sphere. */
export const berry = (at, r, weight = 0.75) => roundBody(circle(at, r), at, r, HATCH * 0.6, weight);
// ---------------------------------------------------------------- leaves
/** A long strap leaf with parallel veins (scorsonère, lilies, grasses). */
export function strapLeaf(rng, length, bend, widthShare = 1) {
    const width = length * rng.range(0.055, 0.08) * widthShare;
    const wave = rng.range(5, 8), phase = rng.range(0, 6);
    const spine = (v) => [bend * length * v * v - 0.25 * bend * length * v, length * v];
    const halfWidth = (v) => width * 2.3 * v ** 0.45 * (1 - v) ** 0.9;
    const veins = [-0.5, 0.5].map(q => sample(v => {
        const [x, y] = spine(v);
        return [x + q * halfWidth(v), y];
    }, 14, 0.08, 0.82));
    return [bladeBody({ spine, halfWidth, edge: (v, s) => 0.012 * length * Math.sin(v * wave * Math.PI + phase + s) * v * (1 - v) * 4,
            shade: side(rng), spacing: HATCH, grain: "across", weight: 0.55, midrib: true, veins, samples: 40 }, rng)];
}
/** A lanceolate leaf whose edge is cut into backward teeth (pissenlit, chicorée). */
export function toothedLeaf(rng, length, bend) {
    const width = length * rng.range(0.12, 0.16);
    const teeth = rng.int(5, 7);
    const spine = (v) => [bend * length * v * v - 0.25 * bend * length * v, length * v];
    const halfWidth = (v) => {
        const envelope = width * 2 * v ** 0.5 * (1 - v) ** 0.7;
        const phase = (v * teeth) % 1;
        return envelope * (0.45 + 0.55 * (1 - phase) ** 2.2);
    };
    return [bladeBody({ spine, halfWidth, shade: side(rng), spacing: HATCH, grain: "across", weight: 0.55, midrib: true, samples: 60 }, rng)];
}
/** An ovate leaf cut into forward-pointing lobes (alisier). */
export function lobedLeaf(rng, length, bend) {
    const width = length * rng.range(0.36, 0.44);
    const lobes = rng.int(3, 4);
    const depth = rng.range(0.35, 0.55);
    const spine = (v) => [bend * length * v * v - 0.3 * bend * length * v, length * v];
    const envelope = (v) => width * Math.sin(Math.PI * v ** 0.72) ** 0.8;
    const period = (v) => (v * lobes * 1.05 + 0.15) % 1;
    const halfWidth = (v) => {
        const cut = depth * (1 - smoothstep(0, 0.9, v));
        return envelope(v) * ((1 - cut) + cut * period(v) ** 1.7);
    };
    const veins = [];
    for (let k = 1; k <= lobes; k += 1) {
        const tip = (k - 0.15) / (lobes * 1.05);
        if (tip > 0.88)
            continue;
        for (const s of [1, -1]) {
            const base = spine(Math.max(0.02, tip - 0.14));
            const [x, y] = spine(tip);
            veins.push(sample(bezier3(base, [lerp(base[0], x, 0.5), lerp(base[1], y, 0.4)], [x + s * envelope(tip) * 0.6, y], [x + s * halfWidth(tip) * 0.92, y]), 6));
        }
    }
    return [bladeBody({ spine, halfWidth, edge: v => 0.004 * length * (1 - Math.abs(2 * ((v * 26) % 1) - 1)),
            shade: side(rng), spacing: HATCH, grain: "across", weight: 0.6, midrib: true, veins, samples: 56 }, rng)];
}
/** A palmate leaf of three or five lobes on a petiole (figue). */
export function palmateLeaf(rng, length) {
    const petiole = length * 0.16;
    const centre = [0, petiole];
    const five = rng.chance(0.65);
    const lobes = (five ? [-80, -40, 0, 40, 80] : [-50, 0, 50]).map(a => (a + rng.sym(6)) * Math.PI / 180);
    const reach = (five ? [0.55, 0.86, 1, 0.86, 0.55] : [0.82, 1, 0.82]).map(r => r * length * 0.84 * rng.range(0.92, 1.05));
    const halfAngle = (five ? 22 : 30) * Math.PI / 180;
    const radius = (theta) => {
        let best = Math.abs(theta) > 2.2 ? 0.1 * length : 0.2 * length;
        lobes.forEach((angle, index) => {
            const x = (theta - angle) / halfAngle;
            if (Math.abs(x) < 1)
                best = Math.max(best, reach[index] * Math.cos(x * Math.PI / 2) ** 0.5);
        });
        return best;
    };
    const outline = sample(v => {
        const theta = -Math.PI + 2 * Math.PI * v;
        const r = radius(theta) * (1 + 0.02 * Math.sin(theta * 23));
        return [centre[0] + r * Math.sin(theta), centre[1] + r * Math.cos(theta)];
    }, 120).slice(0, -1);
    const shade = side(rng);
    const shadow = [[0, -length], [shade * length * 2, -length], [shade * length * 2, length * 2], [0, length * 2]];
    const grain = [];
    for (let k = -40; k <= 40; k += 1) {
        const y0 = centre[1] + k * HATCH * 1.05;
        grain.push([[-length, y0 - length * 0.35 * shade], [length, y0 + length * 0.35 * shade]]);
    }
    const veins = lobes.map((angle, index) => sample(v => {
        const r = reach[index] * 0.88 * v;
        return [centre[0] + r * Math.sin(angle + 0.06 * Math.sin(v * 3)), centre[1] + r * Math.cos(angle)];
    }, 8));
    for (const [index, angle] of lobes.entries()) {
        for (const t of [0.35, 0.6]) {
            const r = reach[index] * 0.88 * t;
            const start = [centre[0] + r * Math.sin(angle), centre[1] + r * Math.cos(angle)];
            for (const s of [1, -1]) {
                const out = angle + s * 0.7;
                veins.push([start, [start[0] + reach[index] * 0.2 * Math.sin(out), start[1] + reach[index] * 0.2 * Math.cos(out)]]);
            }
        }
    }
    const body = { type: "body", outline, shadow: [shadow], grain, veins, weight: 0.6 };
    return [line([[0, 0], [0, petiole * 0.6], centre], length * 0.025), body];
}
/** A small simple leaf for branches and fillers; `width` is its breadth as a share of its length. */
export function simpleLeaf(rng, length, bend, width = 0.28) {
    const spine = (v) => [bend * length * v * v, length * v];
    const halfWidth = (v) => length * width * 2.1 * v ** 0.6 * (1 - v) ** 0.85;
    return [bladeBody({ spine, halfWidth, shade: side(rng), spacing: HATCH, grain: "across", weight: 0.5, midrib: true, samples: 20 }, rng)];
}
/**
 * A pinnate leaf: leaflets in pairs along a rachis, with an odd one at the tip (persil, carotte, sureau,
 * frêne). `pairs` sets the count; `leaflet` the leaflet's length as a share of the leaf's; `divided`
 * cuts each leaflet into narrow segments for finely divided foliage.
 */
export function pinnateLeaf(rng, length, bend, pairs = 4, leaflet = 0.32, divided = false) {
    const rachis = sample(v => [bend * length * v * v, length * v], 12);
    const shapes = [line(rachis, length * 0.018)];
    const draw = (at, angle, size) => {
        const piece = divided
            ? [line([[0, 0], [0, size]], size * 0.03), ...[-1, 1].flatMap(s => [0.3, 0.55, 0.8].map(t => line([[0, size * t], [s * size * 0.22, size * (t + 0.12)]], size * 0.025)))]
            : simpleLeaf(rng, size, rng.sym(0.12), 0.24);
        return piece.map(shape => turnShape(shape, angle, at));
    };
    for (let k = 1; k <= pairs; k += 1) {
        const v = 0.18 + 0.72 * (k - 0.5) / pairs;
        const at = rachis[Math.round(v * 11)];
        const size = length * leaflet * (1 - 0.35 * v);
        for (const s of [1, -1])
            shapes.push(...draw(at, s * (Math.PI / 2 - 0.55) * -1, size));
    }
    shapes.push(...draw(rachis[11], 0, length * leaflet * 0.8));
    return shapes;
}
