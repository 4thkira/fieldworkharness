// Trees, shrubs and shoots shown by their fruit: the fruit hangs at the nodes and on short spurs, buds
// small and green, swells, and at the end of the day ripens, darkens, or splits to show its seed or
// flesh (figue, grenade, châtaigne, noix, fusain, coton). Herbaceous fruiting shoots (tomate, piment,
// aubergine, coton) keep thin green stems, and the mâcre floats as a rosette on thin submerged stems.
import { LAYER, numberOf, textOf, flagOf } from "../form.js";
import { bezier3, blade, lerp, sample, smoothstep, unit } from "../geometry.js";
import { HATCH, line, lobedLeaf, palmateLeaf, side, simpleLeaf, turnShape } from "../kit.js";
import { bladeBody, roundBody } from "../shapes.js";
function figBody(rng, s, open) {
    const stalk = s * 0.1;
    const length = s * 0.82;
    const radius = s * 0.36;
    const spine = (v) => [0, stalk + length * v];
    const halfWidth = (v) => radius * v ** 0.6 * Math.max(0, 1 - v ** 4) ** 0.45;
    const outline = [];
    for (let k = 0; k <= 30; k += 1) {
        const v = k / 30;
        const [x, y] = spine(v);
        outline.push([x + halfWidth(v), y]);
    }
    for (let k = 29; k >= 1; k -= 1) {
        const v = k / 30;
        const [x, y] = spine(v);
        outline.push([x - halfWidth(v), y]);
    }
    const centre = [0, stalk + length * 0.62];
    const shapes = [line([[0, 0], [rng.sym(0.02) * s, stalk * 1.2]], s * 0.035)];
    const body = roundBody(outline, centre, radius, HATCH * 0.9, 0.7, [-0.7, 0.4]);
    body.veins = [-0.55, 0, 0.55].map(q => sample(v => { const [x, y] = spine(v); return [x + q * halfWidth(v) * 0.9, y]; }, 10, 0.2, 0.97));
    shapes.push(body);
    const tip = spine(1);
    shapes.push({ type: "dots", points: [[tip[0], tip[1] - s * 0.015]], radius: s * 0.018 });
    const specks = Array.from({ length: 14 }, () => {
        const v = rng.range(0.3, 0.95);
        const [x, y] = spine(v);
        return [x + halfWidth(v) * rng.range(-0.8, 0.85), y];
    });
    shapes.push({ type: "dots", points: specks, radius: s * 0.006 });
    if (open) {
        // The ripe fig splits along its length and shows its flesh.
        const fleshLength = length * 0.62;
        const flesh = (v) => [0, stalk + length * 0.36 + fleshLength * v];
        const fleshWidth = (v) => radius * 0.48 * Math.sin(Math.PI * v) ** 0.7;
        const fleshOutline = [];
        for (let k = 0; k <= 20; k += 1) {
            const v = k / 20;
            const [x, y] = flesh(v);
            fleshOutline.push([x + fleshWidth(v), y]);
        }
        for (let k = 19; k >= 1; k -= 1) {
            const v = k / 20;
            const [x, y] = flesh(v);
            fleshOutline.push([x - fleshWidth(v), y]);
        }
        shapes.push({ type: "body", outline: fleshOutline, shadow: [], grain: [], veins: [], weight: 0.6, tone: "accent" });
        const seeds = Array.from({ length: 26 }, () => {
            const v = rng.range(0.1, 0.9);
            const [x, y] = flesh(v);
            return [x + fleshWidth(v) * rng.range(-0.75, 0.75), y];
        });
        shapes.push({ type: "dots", points: seeds, radius: s * 0.008 });
        for (const sd of [1, -1])
            shapes.push(line(sample(v => { const [x, y] = flesh(v); return [x + sd * fleshWidth(v) * 1.15, y]; }, 10), s * 0.01));
    }
    return shapes;
}
function fig(rng, s, stage) {
    if (stage === "bud")
        return figBody(rng, s * 0.55, false);
    // Gone to seed, some figs ripen whole and a few split to show their flesh.
    return figBody(rng, stage === "seed" ? s * 1.04 : s, stage === "seed" && rng.chance(0.35));
}
// ---------------------------------------------------------------- drawing helpers
const TAU = Math.PI * 2;
/** Light falls from the upper left of a hanging fruit's frame, as on the fig. */
const LIGHT = [-0.7, 0.4];
const angleGap = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
/** A bell around angle `at`, 1 there and fading over `width` radians: dimples, nipples and notches. */
const dip = (phi, at, width) => Math.exp(-((angleGap(phi, at) / width) ** 2));
const dots = (points, radius, tone) => tone ? { type: "dots", points, radius, tone } : { type: "dots", points, radius };
/**
 * A closed outline about a centre; phi 0 points along +y (the blossom end), pi back toward the stalk.
 * Small fruits take fewer points (at most `n`): the curve is smoothed anyway, and a garden holds hundreds.
 */
function polar(centre, rx, ry, k, n = 26) {
    const count = Math.max(10, Math.min(n, Math.round(8 + 40 * Math.max(rx, ry))));
    return Array.from({ length: count }, (_, index) => {
        const phi = index / count * TAU;
        const r = k(phi);
        return [centre[0] + Math.sin(phi) * rx * r, centre[1] + Math.cos(phi) * ry * r];
    });
}
/**
 * A rounded fruit shaded as a solid: the lit part shrinks as the fruit darkens, so a ripe sloe or
 * blackberry is cut nearly all over and keeps only its highlight.
 */
function modelled(outline, centre, rx, ry, weight, dark = 0) {
    const [lx, ly] = unit(LIGHT[0], LIGHT[1]);
    const share = 1.05 - 0.66 * dark;
    const lit = sample(v => [centre[0] + lx * rx * 0.42 + Math.cos(v * TAU) * rx * share, centre[1] + ly * ry * 0.42 + Math.sin(v * TAU) * ry * share], 14);
    const big = Math.max(rx, ry);
    const frame = [[centre[0] - big * 3, centre[1] - big * 3], [centre[0] + big * 3, centre[1] - big * 3],
        [centre[0] + big * 3, centre[1] + big * 3], [centre[0] - big * 3, centre[1] + big * 3]];
    const spacing = HATCH * (0.85 - 0.42 * dark);
    const angle = Math.atan2(ly, lx) + Math.PI / 2 + 0.35;
    const dx = Math.cos(angle), dy = Math.sin(angle);
    const grain = [];
    const cuts = Math.floor(big * 3.2 / spacing);
    // A dark fruit (sloe, bilberry, black mulberry) takes a second set of cuts across the first.
    const directions = dark > 0.6 ? [[dx, dy], [dy, -dx]] : [[dx, dy]];
    for (const [ax, ay] of directions) {
        for (let cut = -cuts / 2; cut <= cuts / 2; cut += 1) {
            const ox = centre[0] - ay * cut * spacing, oy = centre[1] + ax * cut * spacing;
            grain.push([[ox - ax * big * 1.6, oy - ay * big * 1.6], [ox + ax * big * 1.6, oy + ay * big * 1.6]]);
        }
    }
    return { type: "body", outline, shadow: [frame, lit], grain, veins: [], weight };
}
/** Shapes drawn along +y, turned to point along `dir` and moved to `at`. */
function place(shapes, at, dir) {
    const angle = Math.atan2(-dir[0], dir[1]);
    return shapes.map(shape => turnShape(shape, angle, at));
}
/** Any shape with every point moved by `f`: a rosette leaf laid flat on the water is squashed. */
function mapShape(shape, f) {
    switch (shape.type) {
        case "body": return { ...shape, outline: shape.outline.map(f), shadow: shape.shadow.map(ring => ring.map(f)), grain: shape.grain.map(cut => cut.map(f)), veins: shape.veins.map(vein => vein.map(f)) };
        case "solid": return { ...shape, outline: shape.outline.map(f) };
        case "line": return { ...shape, points: shape.points.map(f) };
        case "dots": return { ...shape, points: shape.points.map(f) };
    }
}
/** Points scattered in an ellipse, crowding into the side away from the light: down, stipple, pores. */
function stipple(rng, centre, rx, ry, count, shade = 0.6) {
    const points = [];
    for (let attempt = 0; attempt < count * 6 && points.length < count; attempt += 1) {
        const a = rng.range(0, TAU), r = Math.sqrt(rng.u()) * 0.9;
        const x = Math.cos(a) * r, y = Math.sin(a) * r;
        if (rng.u() > 1 - shade * (0.5 + 0.5 * (x * -LIGHT[0] + y * -LIGHT[1])))
            continue;
        points.push([centre[0] + x * rx, centre[1] + y * ry]);
    }
    return points;
}
/** A meridian of a round fruit at longitude `lambda`, seen from the side: ribs, seams and grooves. */
const meridian = (centre, rx, ry, lambda, from = 0.1, to = 0.9) => sample(t => { const theta = Math.PI * t; return [centre[0] + rx * Math.sin(theta) * Math.sin(lambda), centre[1] - ry * Math.cos(theta)]; }, 8, from, to);
const stalkLine = (rng, s, end, width = 0.03) => line([[0, 0], [end[0] * 0.3 + rng.sym(0.025) * s, end[1] * 0.55], end], s * width);
/** A small closed circle drawn as a vein: drupelets, seeds seen through a translucent skin. */
const ring = (at, rx, ry = rx) => sample(v => [at[0] + Math.cos(v * TAU) * rx, at[1] + Math.sin(v * TAU) * ry], 7);
// ---------------------------------------------------------------- calyces
/** What the flower leaves at the blossom end (the far end of a hanging fruit). */
function blossomEnd(rng, kind, b, r, s) {
    switch (kind) {
        case "eye": {
            // Dry sepal tips in a little pit (pomme, poire, azerole, groseille).
            const tips = [-0.5, -0.18, 0.15, 0.45].map(a => line([[b[0] + a * r * 0.12, b[1] - r * 0.05], [b[0] + a * r * 0.4, b[1] + r * (0.1 + 0.05 * rng.u())]], s * 0.008));
            return [...tips, dots([[b[0], b[1] - r * 0.03]], r * 0.05)];
        }
        case "crown": {
            // A tube of persistent sepals ending in pointed teeth (grenade, coing).
            const w = r * 0.32, h = r * 0.42, teeth = 6;
            const outline = [[b[0] - w, b[1] - h * 0.3], [b[0] - w * 0.95, b[1] + h * 0.45]];
            for (let k = 0; k <= teeth * 2; k += 1) {
                const x = b[0] - w * 1.3 + w * 2.6 * k / (teeth * 2);
                outline.push([x, b[1] + (k % 2 === 0 ? h * (1 + 0.15 * rng.u()) : h * 0.62)]);
            }
            outline.push([b[0] + w * 0.95, b[1] + h * 0.45], [b[0] + w, b[1] - h * 0.3]);
            const body = modelled(outline, [b[0], b[1] + h * 0.4], w * 1.2, h * 0.8, 0.55, 0.15);
            body.veins = [-0.5, 0, 0.5].map(q => [[b[0] + q * w, b[1]], [b[0] + q * w * 1.25, b[1] + h * 0.66]]);
            return [body];
        }
        case "open": {
            // The medlar's wide open eye: a rim round a dark hollow, and five long sepals spread out.
            const shapes = [];
            for (const a of [-1, 1, -0.45, 0.45, 0]) {
                const length = r * (0.62 - 0.22 * (1 - Math.abs(a)));
                const dir = unit(a * 1.3, 0.4 + 0.5 * (1 - Math.abs(a)));
                const spine = (v) => [b[0] + dir[0] * length * v, b[1] + dir[1] * length * v - Math.abs(a) * length * 0.25 * v * v];
                shapes.push(bladeBody({ spine, halfWidth: v => r * 0.07 * Math.sin(Math.PI * v ** 0.6), shade: a < 0 ? -1 : 1, spacing: HATCH * 0.8,
                    grain: "across", weight: 0.5, midrib: true, samples: 10 }, rng));
            }
            shapes.push({ type: "solid", outline: sample(v => [b[0] + Math.cos(v * TAU) * r * 0.24, b[1] - r * 0.02 + Math.sin(v * TAU) * r * 0.08], 12).slice(0, -1) });
            shapes.push(line(sample(v => [b[0] + Math.cos(v * TAU) * r * 0.36, b[1] - r * 0.02 + Math.sin(v * TAU) * r * 0.13], 16), s * 0.01));
            return shapes;
        }
        case "ring": {
            // The bilberry's flat crown: a little ring at the tip.
            return [line(sample(v => [b[0] + Math.cos(v * TAU) * r * 0.3, b[1] - r * 0.06 + Math.sin(v * TAU) * r * 0.1], 12), s * 0.008),
                dots([[b[0], b[1] - r * 0.06]], r * 0.07)];
        }
        default: return [];
    }
}
/** A star of narrow sepals lying over the shoulder at the stalk end (tomate, citrus). */
function sepalStar(rng, t, r, reach) {
    // One outline round the whole star, so a truss of tomatoes stays light to engrave.
    const outline = [[t[0] - r * 0.12, t[1] - r * 0.02]];
    const veins = [];
    const angles = [-1.25, -0.55, 0, 0.55, 1.25];
    for (const [index, a] of angles.entries()) {
        const length = r * reach * (0.55 + 0.45 * Math.abs(a) / 1.25) * rng.range(0.9, 1.1);
        const out = Math.sin(a), down = Math.cos(a) * 0.5 + 0.25;
        const tip = [t[0] + out * length, t[1] + down * length + Math.abs(out) * length * 0.35];
        const mid = [t[0] + out * length * 0.45, t[1] + down * length * 0.45 + Math.abs(out) * length * 0.08];
        const [nx, ny] = unit(-(down + 0.2), out);
        outline.push([mid[0] - nx * r * 0.09, mid[1] - ny * r * 0.09], tip, [mid[0] + nx * r * 0.09, mid[1] + ny * r * 0.09]);
        if (index < angles.length - 1) {
            const b = (a + angles[index + 1]) / 2;
            outline.push([t[0] + Math.sin(b) * r * 0.14, t[1] + (Math.cos(b) * 0.5 + 0.25) * r * 0.14]);
        }
        veins.push([t, mid, [lerp(mid[0], tip[0], 0.6), lerp(mid[1], tip[1], 0.6)]]);
    }
    outline.push([t[0] + r * 0.12, t[1] - r * 0.02]);
    return [{ type: "body", outline, shadow: [], grain: [], veins, weight: 0.45 }];
}
/** A cup calyx clasping the top of a long fruit, its lower edge cut in pointed lobes (aubergine, piment). */
function capOver(rng, spine, halfWidth, depth, spiny, s) {
    const left = [], right = [];
    for (let k = 0; k <= 6; k += 1) {
        const v = depth * k / 6;
        const [x, y] = spine(v);
        const w = Math.max(halfWidth(v), halfWidth(depth * 0.3)) * 1.07;
        left.push([x - w, y]);
        right.push([x + w, y]);
    }
    const edge = [];
    const lobes = 5;
    for (let k = 0; k <= lobes * 2; k += 1) {
        const q = -1 + 2 * k / (lobes * 2);
        const v = depth * (k % 2 === 1 ? 1.55 + 0.2 * rng.u() : 0.75);
        const [x, y] = spine(Math.min(1, v));
        edge.push([x + q * halfWidth(Math.min(1, v)) * 1.05, y]);
    }
    const outline = [...left, ...edge, ...right.reverse()];
    const centre = spine(depth * 0.6);
    const body = modelled(outline, centre, halfWidth(depth) * 1.1, depth * 0.4 * (spine(1)[1] - spine(0)[1]) + s * 0.05, 0.5, 0.2);
    body.veins = [-0.6, 0, 0.6].map(q => [spine(depth * 0.1), (() => { const [x, y] = spine(depth * 1.4); return [x + q * halfWidth(depth * 1.4), y]; })()]);
    if (spiny) {
        for (let k = 0; k < 7; k += 1) {
            const v = depth * rng.range(0.15, 0.85);
            const [x, y] = spine(v);
            const q = rng.range(-0.8, 0.8);
            body.veins.push([[x + q * halfWidth(v), y], [x + q * halfWidth(v) - s * 0.012, y - s * 0.02]]);
        }
    }
    return [body];
}
const grown = (stage) => stage === "bud" ? 0.5 : stage === "seed" ? 1.05 : 1;
/** Down, pores or lenticels on a rounded skin. */
function skin(rng, surface, centre, rx, ry, s) {
    switch (surface) {
        case "fuzzy": return [dots(stipple(rng, centre, rx, ry, 46, 0.85), s * 0.0045)];
        case "bloom": return [dots(stipple(rng, centre, rx, ry, 26, 0.5), s * 0.004)];
        case "speckled": return [dots(stipple(rng, centre, rx, ry, 18, 0.2), s * 0.007)];
        case "dimpled": return [dots(stipple(rng, centre, rx, ry, 60, 0.3), s * 0.0045)];
        case "rough": return [dots(stipple(rng, centre, rx, ry, 70, 0.4), s * 0.0065)];
        default: return [];
    }
}
/** A pome hanging from its cavity, the calyx at its far end (pomme, coing, nèfle, azerole). */
const pome = f => (rng, s, stage) => {
    const g = grown(stage);
    const r = s * 0.34 * f.size * g, ry = r * 0.94 * f.elong;
    const stalk = s * 0.14 * f.stalk;
    const phase = rng.range(0, TAU);
    const open = f.calyx === "open";
    // Quinces are lumpy and ribbed; apples nearly true.
    const lumps = f.surface === "fuzzy" ? 0.05 : 0.012;
    const k = (phi) => (1 - 0.07 * Math.cos(phi)) * (1 - 0.2 * dip(phi, Math.PI, 0.32) - (open ? 0.17 : 0.07) * dip(phi, 0, open ? 0.6 : 0.32))
        * (1 + lumps * Math.sin(5 * phi + phase)) * (1 + f.tip * 0.3 * dip(phi, 0, 0.22));
    const centre = [0, stalk + ry * 0.86];
    const dark = stage === "seed" ? (f.ripe === "dark" ? 0.5 : 0.22) : stage === "bud" ? 0.18 : 0.08;
    const body = modelled(polar(centre, r, ry, k, 30), centre, r, ry, 0.62, dark);
    const top = centre[1] - ry * k(Math.PI);
    // The rim of the stalk's cavity.
    body.veins.push(sample(t => [r * (t - 0.5) * 0.55, top + ry * 0.08 * (1 - (2 * t - 1) ** 2)], 6));
    if (lumps > 0.02)
        body.veins.push(...[-0.7, 0.1, 0.75].map(l => meridian(centre, r, ry, l + 0.1 * Math.sin(phase), 0.15, 0.85)));
    const shapes = [body, ...skin(rng, stage === "bud" ? "smooth" : f.surface, centre, r, ry, s)];
    shapes.push(...blossomEnd(rng, f.calyx, [0, centre[1] + ry * k(0)], stage === "bud" ? r * 1.6 : r, s));
    shapes.push(stalkLine(rng, s, [rng.sym(0.02) * s, top + ry * 0.05]));
    return shapes;
};
/** A pear: a long neck swelling to a round base, on a long stalk. */
const pear = f => (rng, s, stage) => {
    const g = grown(stage);
    const length = s * 0.84 * f.size * f.elong * g, w = s * 0.29 * f.size * g;
    const stalk = s * 0.2 * f.stalk;
    const lean = rng.sym(0.12) * length;
    const spine = (v) => [lean * v * v, stalk + length * v];
    // A slender neck widening into a round bulb whose blunt base carries the eye.
    const bulb = 0.64;
    const halfWidth = (v) => v > bulb
        ? w * Math.sqrt(Math.max(0.0025, 1 - ((v - bulb) / (1 - bulb)) ** 2))
        : w * (0.28 + 0.72 * smoothstep(0.02, bulb, v) ** 1.6) * Math.sqrt(Math.min(1, v / 0.05 + 0.05));
    const { outline } = blade(spine, 28, halfWidth, halfWidth);
    const centre = spine(0.66);
    const dark = stage === "seed" ? 0.22 : stage === "bud" ? 0.18 : 0.08;
    const body = modelled(outline, centre, w, length * 0.38, 0.62, dark);
    const shapes = [body, ...skin(rng, stage === "bud" ? "smooth" : f.surface, centre, w * 0.9, length * 0.4, s)];
    shapes.push(...blossomEnd(rng, f.calyx, spine(0.985), w * (stage === "bud" ? 1.5 : 1), s));
    shapes.push(stalkLine(rng, s, spine(0.02)));
    return shapes;
};
/** A stone fruit with its seam (pêche, abricot, prune, cerise, olive); the hulled ones split at the end (amande, pistache). */
const drupe = f => (rng, s, stage) => {
    const g = grown(stage);
    const r = s * 0.3 * f.size * g, ry = r * 0.96 * f.elong;
    const stalk = s * 0.08 * f.stalk;
    if (stage === "seed" && f.husk === "hull")
        return hullSplit(rng, s, r, ry, stalk, f);
    if (stage === "seed" && f.husk === "split")
        return shellGape(rng, s, r, ry, stalk);
    const k = (phi) => (1 - 0.12 * dip(phi, Math.PI, 0.3)) * (1 + f.tip * 0.35 * dip(phi, 0, 0.2)) * (1 + 0.035 * Math.sin(phi));
    const centre = [0, stalk + ry * 0.9];
    const glossy = f.surface === "glossy";
    const dark = stage === "bud" ? 0.12 : stage === "bloom" ? (glossy ? 0.3 : 0.1) : f.ripe === "dark" ? 0.72 : glossy ? 0.5 : 0.2;
    const body = modelled(polar(centre, r, ry, k, 28), centre, r, ry, 0.62, dark);
    if (!glossy)
        body.veins.push(meridian(centre, r * 1.02, ry * 1.02, 0.42, 0.06, 0.94));
    const shapes = [body, ...skin(rng, stage === "bud" ? "smooth" : f.surface, centre, r, ry, s)];
    shapes.push(stalkLine(rng, s, [rng.sym(0.02) * s, centre[1] - ry * k(Math.PI) + ry * 0.04], 0.026));
    return shapes;
};
/** The almond's green hull split along its seam and curled back from the pitted stone. */
function hullSplit(rng, s, r, ry, stalk, f) {
    const centre = [0, stalk + ry * 0.9];
    const shapes = [];
    for (const sd of [-1, 1]) {
        const half = polar(centre, r * 1.02, ry * 1.02, phi => 1 + f.tip * 0.3 * dip(phi, 0, 0.2), 24).filter(([x]) => x * sd >= -r * 0.05);
        const valve = modelled(half, [centre[0] + sd * r * 0.4, centre[1]], r * 0.6, ry, 0.6, 0.35);
        shapes.push(...place([valve], [0, stalk], [Math.sin(sd * 0.32), Math.cos(sd * 0.32)]));
    }
    const sr = r * 0.66, sry = ry * 0.8;
    const stoneCentre = [0, stalk + ry * 0.95];
    const stone = modelled(polar(stoneCentre, sr, sry, phi => 1 + 0.35 * dip(phi, 0, 0.25), 24), stoneCentre, sr, sry, 0.55, 0.12);
    stone.veins.push(meridian(stoneCentre, sr, sry, 0.5, 0.1, 0.92));
    shapes.push(stone, dots(stipple(rng, stoneCentre, sr * 0.9, sry * 0.9, 26, 0.25), s * 0.008));
    shapes.push(stalkLine(rng, s, [0, stalk + ry * 0.1], 0.026));
    return shapes;
}
/** The pistachio's shell gaping at its tip, the kernel showing in the gap. */
function shellGape(rng, s, r, ry, stalk) {
    const centre = [0, stalk + ry * 0.9];
    // The shell notched open at its tip along its seam; the kernel shows dark in the notch.
    const shell = modelled(polar(centre, r, ry, phi => (1 + 0.25 * dip(phi, 0, 0.25)) * (1 - 0.42 * dip(phi, 0, 0.16)), 22), centre, r, ry, 0.5, 0.05);
    shell.veins.push(meridian(centre, r, ry * 1.1, 0.08, 0.05, 0.62));
    const kernel = { type: "solid", outline: polar([0, centre[1] + ry * 0.62], r * 0.22, ry * 0.3, () => 1, 10) };
    return [shell, kernel, stalkLine(rng, s, [0, centre[1] - ry * 0.85], 0.024)];
}
/** Citrus: a pored rind, the lemon drawn out to a nipple; green and heavy until it ripens pale. */
const citrus = f => (rng, s, stage) => {
    const g = grown(stage);
    const r = s * 0.36 * f.size * g, ry = r * f.elong;
    const stalk = s * 0.07 * f.stalk;
    const rough = f.surface === "rough";
    const phase = rng.range(0, TAU);
    const k = (phi) => (1 + f.tip * 0.32 * dip(phi, 0, 0.15) + f.tip * 0.1 * dip(phi, Math.PI, 0.18) - (1 - f.tip) * 0.05 * dip(phi, Math.PI, 0.3))
        * (1 + (rough ? 0.022 : 0.006) * Math.sin(11 * phi + phase) + (rough ? 0.012 : 0) * Math.sin(23 * phi));
    const centre = [0, stalk + ry * 0.97];
    const dark = stage === "seed" ? 0.04 : 0.32;
    const body = modelled(polar(centre, r, ry, k, 36), centre, r, ry, 0.6, dark);
    const shapes = [body];
    if (stage !== "bud")
        shapes.push(...skin(rng, f.surface === "smooth" ? "dimpled" : f.surface, centre, r, ry, s));
    const top = [0, centre[1] - ry * k(Math.PI)];
    if (f.calyx === "star")
        shapes.push(...sepalStar(rng, top, r, 0.32));
    shapes.push(dots([[0, centre[1] + ry * k(0) - r * 0.03]], r * 0.035));
    shapes.push(stalkLine(rng, s, top, 0.03));
    return shapes;
};
/** The pomegranate: a leathery ball under its crown, splitting at the end to show the arils. */
const pomegranate = f => (rng, s, stage) => {
    const g = grown(stage);
    const r = s * 0.36 * f.size * g, ry = r * 0.94;
    const stalk = s * 0.06 * f.stalk;
    const phase = rng.range(0, TAU);
    const k = (phi) => (1 + 0.03 * Math.cos(6 * phi + phase)) * (1 - 0.06 * dip(phi, Math.PI, 0.3));
    const centre = [0, stalk + ry * 0.95];
    const body = modelled(polar(centre, r, ry, k, 30), centre, r, ry, 0.65, stage === "seed" ? 0.35 : 0.22);
    const shapes = [body, stalkLine(rng, s, [0, centre[1] - ry * 0.9], 0.035)];
    shapes.push(...blossomEnd(rng, "crown", [0, centre[1] + ry * k(0) * 0.97], r * (stage === "bud" ? 1.5 : 1), s));
    if (stage === "seed" && rng.chance(0.4)) {
        // Some ripe fruits crack open on the lit cheek, the arils crowding in the crack; the rest stay whole.
        const at = [-r * 0.12, centre[1] + r * 0.05];
        const crack = (scale) => polar(at, r * 0.5 * scale, r * 0.44 * scale, phi => 1 + 0.12 * Math.sin(7 * phi + phase) + 0.06 * Math.sin(13 * phi), 26);
        shapes.push({ type: "body", outline: crack(1.12), shadow: [], grain: [], veins: [], weight: 0.4 });
        shapes.push({ type: "body", outline: crack(1), shadow: [], grain: [], veins: [], weight: 0.6, tone: "accent" });
        const arils = [];
        for (let row = -3; row <= 3; row += 1)
            for (let col = -3; col <= 3; col += 1) {
                const p = [at[0] + (col + (row % 2) * 0.5) * r * 0.13, at[1] + row * r * 0.11];
                if (((p[0] - at[0]) / (r * 0.44)) ** 2 + ((p[1] - at[1]) / (r * 0.38)) ** 2 < 1)
                    arils.push(p);
            }
        shapes.push(dots(arils, r * 0.022));
    }
    return shapes;
};
/** A berry: pale while green; ripe it goes dark, glossy red, or translucent with its seeds showing. */
const berryFruit = f => (rng, s, stage) => {
    const g = stage === "bud" ? 0.55 : stage === "seed" ? 1.05 : 0.9;
    const r = s * 0.17 * f.size * g, ry = r * f.elong;
    const stalk = s * 0.14 * f.stalk;
    const centre = [0, stalk + ry * 0.95];
    const ripe = stage === "seed";
    const dark = !ripe ? 0.08 : f.ripe === "dark" ? 0.84 : f.ripe === "translucent" ? 0.05 : 0.45;
    const body = modelled(polar(centre, r, ry, phi => 1 - 0.06 * dip(phi, Math.PI, 0.4), 14), centre, r, ry, ripe ? 0.8 : 0.55, dark);
    if (f.ripe === "translucent" && stage !== "bud") {
        body.veins.push(...[-0.7, 0.55].map(l => meridian(centre, r, ry, l, 0.14, 0.86)));
    }
    const shapes = [body];
    // A small berry keeps only a dark point where its flower stood; the bilberry keeps its ring.
    const b = [0, centre[1] + ry];
    shapes.push(...(f.calyx === "ring" && stage !== "bud" ? blossomEnd(rng, "ring", b, r * 1.6, s) : f.calyx === "none" ? [] : [dots([[0, b[1] - r * 0.05]], r * 0.13)]));
    shapes.push(line([[0, 0], [rng.sym(0.02) * s, stalk * 0.6], [0, centre[1] - ry * 0.9]], s * 0.016));
    return shapes;
};
/** A mulberry: an aggregate of drupelets, white and red before it ripens black. */
const mulberry = f => (rng, s, stage) => {
    const g = grown(stage);
    const length = s * 0.5 * f.size * f.elong * g, w = s * 0.15 * f.size * g;
    const stalk = s * 0.1 * f.stalk;
    const spine = (v) => [0, stalk + length * v];
    const halfWidth = (v) => w * Math.sin(Math.PI * Math.min(0.99, v * 1.01)) ** 0.5 * (0.85 + 0.15 * v);
    const { outline } = blade(spine, 36, halfWidth, halfWidth, (v, sd) => w * 0.14 * Math.abs(Math.sin(v * 9 * Math.PI + (sd > 0 ? 0 : 1.3))));
    const dark = stage === "seed" ? 0.86 : stage === "bloom" ? 0.25 : 0.12;
    const body = modelled(outline, spine(0.55), w, length * 0.5, 0.7, dark);
    for (let row = 1; row <= 8; row += 1) {
        const v = (row - 0.3) / 8.4;
        const [x, y] = spine(v);
        for (const q of row % 2 === 0 ? [-0.62, 0, 0.62] : [-0.32, 0.32])
            body.veins.push(ring([x + q * halfWidth(v), y], w * 0.2, w * 0.17));
    }
    return [body, line([[0, 0], [rng.sym(0.02) * s, stalk * 0.6], spine(0.02)], s * 0.022)];
};
/** The aubergine: a long glossy club curving under a spiny cap. */
const aubergine = f => (rng, s, stage) => {
    const g = grown(stage);
    const length = s * 0.95 * f.size * f.elong * g, w = s * 0.21 * f.size * g;
    const stalk = s * 0.1 * f.stalk;
    const bend = side(rng) * rng.range(0.08, 0.16) * length;
    const spine = (v) => [bend * v * v, stalk + length * v];
    const halfWidth = (v) => w * (0.32 + 0.68 * smoothstep(0.02, 0.7, v)) * Math.sqrt(Math.max(0, 1 - Math.min(1, v) ** 5));
    const { outline } = blade(spine, 32, halfWidth, halfWidth);
    const dark = stage === "seed" ? 0.78 : stage === "bloom" ? 0.58 : 0.3;
    const body = modelled(outline, spine(0.62), w, length * 0.42, 0.75, dark);
    return [body, ...capOver(rng, spine, halfWidth, stage === "bud" ? 0.3 : 0.18, true, s), line([[0, 0], [rng.sym(0.02) * s, stalk * 0.6], spine(0.03)], s * 0.045)];
};
/** The tomato: a flattened ribbed ball under a star of sepals, in trusses. */
const tomato = f => (rng, s, stage) => {
    const g = grown(stage);
    const r = s * 0.3 * f.size * g, ry = r * 0.8 * f.elong;
    const stalk = s * 0.12 * f.stalk;
    const phase = rng.range(0, TAU);
    const k = (phi) => (1 - 0.16 * dip(phi, Math.PI, 0.35) - 0.05 * dip(phi, 0, 0.3)) * (1 + 0.045 * Math.cos(6 * phi + phase));
    const centre = [0, stalk + ry * 0.88];
    const body = modelled(polar(centre, r, ry, k, 32), centre, r, ry, 0.6, stage === "seed" ? 0.5 : 0.14);
    // The ribs show only on the shoulders, running out under the sepals.
    body.veins.push(...[-0.8, -0.3, 0.3, 0.8].map(l => meridian(centre, r * 0.97, ry * 0.97, l + 0.15 * Math.sin(phase), 0.06, 0.32)));
    const top = [0, centre[1] - ry * k(Math.PI)];
    const shapes = [body];
    if (f.calyx === "star")
        shapes.push(...sepalStar(rng, top, r, stage === "bud" ? 1.3 : 0.9));
    shapes.push(stalkLine(rng, s, top, 0.03));
    return shapes;
};
/** A pepper pod: shouldered, tapering to a point, creased, glossy as it reddens. */
const pepper = f => (rng, s, stage) => {
    const g = grown(stage);
    const length = s * 0.8 * f.size * f.elong * g, w = s * 0.16 * f.size * g;
    const stalk = s * 0.12 * f.stalk;
    const bend = side(rng) * rng.range(0.1, 0.25) * length;
    const spine = (v) => [bend * v * v, stalk + length * v];
    const halfWidth = (v) => w * (0.6 + 0.4 * smoothstep(0, 0.12, v)) * (1 - Math.min(1, v)) ** 0.55;
    const { outline } = blade(spine, 30, halfWidth, halfWidth);
    const dark = stage === "seed" ? 0.6 : stage === "bloom" ? 0.32 : 0.2;
    const body = modelled(outline, spine(0.35), w, length * 0.45, 0.7, dark);
    body.veins.push(...[-0.45, 0.4].map(q => sample(v => { const [x, y] = spine(v); return [x + q * halfWidth(v), y]; }, 8, 0.1, 0.8)));
    return [body, ...capOver(rng, spine, halfWidth, 0.1, false, s), line([[0, 0], [rng.sym(0.04) * s, stalk * 0.5], spine(0.02)], s * 0.04)];
};
/** A flat legume swelling over its seeds, dry and twisted at the end (gainier, acacia). */
const pod = f => (rng, s, stage) => {
    const length = s * 0.95 * f.size * f.elong * (stage === "bud" ? 0.55 : 1), w = s * 0.11 * f.size * (stage === "bud" ? 0.55 : 1);
    const stalk = s * 0.08 * f.stalk;
    const seeds = rng.int(5, 7);
    const phase = rng.range(0, TAU);
    const twist = stage === "seed" ? 0.07 : 0.025;
    const spine = (v) => [Math.sin(v * Math.PI * 1.2 + phase) * twist * length, stalk + length * v];
    const swell = stage === "bud" ? 0 : stage === "seed" ? 0.3 : 0.18;
    const halfWidth = (v) => w * smoothstep(0, 0.1, v) * (1 - 0.85 * smoothstep(0.86, 1, v))
        * (1 + swell * Math.abs(Math.sin(v * seeds * Math.PI)) * smoothstep(0.08, 0.16, v) * (1 - smoothstep(0.84, 0.92, v)));
    const veins = [sample(v => { const [x, y] = spine(v); return [x - halfWidth(v) * 0.78, y]; }, 12, 0.05, 0.95)];
    if (stage !== "bud")
        for (let j = 0; j < seeds; j += 1) {
            const [x, y] = spine((j + 0.5) / seeds * 0.82 + 0.06);
            veins.push(ring([x + w * 0.1, y], w * 0.42, w * 0.6));
        }
    const body = bladeBody({ spine, halfWidth, shade: side(rng), spacing: HATCH * (stage === "seed" ? 0.65 : 1), grain: "across", weight: stage === "seed" ? 0.8 : 0.5, veins, samples: 18 }, rng);
    const tip = spine(1);
    return [line([[0, 0], spine(0.03)], s * 0.025), body, line([tip, [tip[0] + w * 0.35, tip[1] + length * 0.04]], s * 0.012)];
};
/** A nut in its husk: the chestnut's burr, the hazel's leafy cup or long tube, the walnut's green hull. */
const nut = f => (rng, s, stage) => {
    switch (f.husk) {
        case "burr": return burr(rng, s, stage, f);
        case "hull": return walnut(rng, s, stage, f);
        default: return involucred(rng, s, stage, f, f.husk === "tube");
    }
};
/** A chestnut: dark and glossy, with a pale scar at its base and a tuft at its point. */
function chestnut(rng, at, r, s, squeeze) {
    const k = (phi) => (1 + 0.32 * dip(phi, 0, 0.32)) * (1 - 0.14 * dip(phi, Math.PI, 0.7));
    const body = modelled(polar(at, r * squeeze, r, k, 22), at, r * squeeze, r, 0.8, 0.62);
    const base = at[1] - r * 0.82;
    body.veins.push(sample(t => [at[0] + r * squeeze * 0.75 * (2 * t - 1), base + r * 0.16 * (1 - (2 * t - 1) ** 2) + r * 0.08], 6));
    const tip = [at[0], at[1] + r * 1.3];
    return [body, line([[tip[0] - r * 0.12, tip[1] + r * 0.2], tip, [tip[0] + r * 0.12, tip[1] + r * 0.2]], s * 0.007, false),
        dots(stipple(rng, [at[0], base + r * 0.06], r * squeeze * 0.6, r * 0.08, 10, 0), s * 0.004)];
}
function burr(rng, s, stage, f) {
    const r = s * 0.33 * f.size * grown(stage);
    const stalk = s * 0.06 * f.stalk;
    const centre = [0, stalk + r];
    const shapes = [line([[0, 0], [0, stalk + r * 0.2]], s * 0.035)];
    const spines = (outline, from, length) => outline.map(p => {
        const [dx, dy] = unit(p[0] - from[0], p[1] - from[1]);
        const l = length * rng.range(0.7, 1.1);
        return [p, [p[0] + dx * l + rng.sym(0.3) * l, p[1] + dy * l + rng.sym(0.3) * l]];
    });
    if (stage !== "seed") {
        const outline = polar(centre, r, r, phi => 1 + 0.03 * Math.sin(5 * phi), 30);
        const body = modelled(outline, centre, r, r, 0.5, 0.28);
        body.veins.push(...spines(outline, centre, r * (stage === "bud" ? 0.22 : 0.34)));
        for (let k = 0; k < 26; k += 1) {
            const a = rng.range(0, TAU), q = Math.sqrt(rng.u()) * 0.8;
            const p = [centre[0] + Math.cos(a) * q * r, centre[1] + Math.sin(a) * q * r];
            body.veins.push([p, [p[0] + Math.cos(a) * r * 0.14, p[1] + Math.sin(a) * r * 0.14]], [p, [p[0] + Math.cos(a + 1.2) * r * 0.1, p[1] + Math.sin(a + 1.2) * r * 0.1]]);
        }
        shapes.push(body);
        return shapes;
    }
    // Ripe, the burr splits in four spiny valves, splayed back, and shows its nuts.
    for (const a of [-2.2, 2.2, -1.1, 1.1]) {
        const length = r * 1.15, dir = [Math.sin(a), Math.cos(a)];
        const spine = (v) => [centre[0] - dir[0] * r * 0.1 + dir[0] * length * v, centre[1] - dir[1] * r * 0.1 + dir[1] * length * v];
        const valve = bladeBody({ spine, halfWidth: v => r * 0.42 * Math.sin(Math.PI * v ** 0.8) ** 0.7, shade: a < 0 ? -1 : 1, spacing: HATCH * 0.7, grain: "across", weight: 0.55, samples: 12 }, rng);
        valve.veins.push(...spines(valve.outline.filter((_, index) => index % 2 === 0), centre, r * 0.3));
        shapes.push(valve);
    }
    const count = Math.round(f.nuts);
    if (count === 1)
        shapes.push(...chestnut(rng, [0, centre[1] + r * 0.05], r * 0.62, s, 0.95));
    else {
        const flank = count >= 3 ? [-1, 1] : [-0.6, 0.6];
        for (const q of flank)
            shapes.push(...chestnut(rng, [q * r * 0.42, centre[1] + r * 0.02], r * 0.46, s, 0.78).map(shape => turnShape(shape, q * -0.2, [0, 0])));
        if (count >= 3)
            shapes.push(...chestnut(rng, [0, centre[1] + r * 0.12], r * 0.44, s, 0.62));
    }
    return shapes;
}
/** A hazelnut in its leafy cup (noisette), or wholly sheathed in a long fringed tube (aveline). */
function involucred(rng, s, stage, f, tube) {
    const g = grown(stage);
    const r = s * 0.19 * f.size * g, ry = r * 1.12 * f.elong;
    const stalk = s * 0.1 * f.stalk;
    const centre = [0, stalk + ry * 0.95];
    const nutBody = modelled(polar(centre, r, ry, phi => (1 + (0.18 + f.tip * 0.3) * dip(phi, 0, 0.3)) * (1 - 0.1 * dip(phi, Math.PI, 0.6)), 22), centre, r, ry, 0.65, stage === "seed" ? 0.55 : stage === "bloom" ? 0.15 : 0.1);
    nutBody.veins.push(...[-0.6, 0.15, 0.7].map(l => meridian(centre, r, ry, l, 0.25, 0.85)));
    // The husk wraps the nut's base and opens in a ragged fringe.
    const reach = tube ? ry * 3 : ry * (stage === "seed" ? 0.95 : 1.15);
    const base = centre[1] - ry * 0.95;
    const width = (v) => tube
        ? r * 1.06 * (v < 0.55 ? Math.min(1, 0.55 + v * 3) : lerp(1, 0.55, smoothstep(0.55, 0.78, v)) + 0.35 * smoothstep(0.82, 1, v))
        : r * (0.75 + 0.55 * v ** 0.8) * (stage === "seed" ? 1.12 : 1);
    const left = [], right = [];
    for (let k = 0; k <= 10; k += 1) {
        const v = k / 10;
        left.push([-width(v), base + reach * v]);
        right.push([width(v), base + reach * v]);
    }
    const fringe = [];
    const teeth = tube ? 7 : 9;
    for (let k = 0; k <= teeth * 2; k += 1) {
        const q = -1 + 2 * k / (teeth * 2);
        fringe.push([q * width(1) * 1.05, base + reach * (k % 2 === 1 ? 1.08 + 0.12 * rng.u() : 0.94)]);
    }
    const husk = modelled([...left, ...fringe, ...right.reverse()], [0, base + reach * 0.45], width(0.5), reach * 0.5, 0.5, stage === "seed" ? 0.35 : 0.18);
    husk.veins.push(...[-0.65, -0.2, 0.25, 0.7].map(q => sample(v => [q * width(v), base + reach * v], 6, 0.08, 0.95)));
    const shapes = [line([[0, 0], [rng.sym(0.02) * s, stalk * 0.6], [0, base + ry * 0.05]], s * 0.026)];
    // The cup holds the nut's base in front of it, the tip standing clear; the tube hides the nut entirely.
    if (tube)
        shapes.push(husk);
    else
        shapes.push(nutBody, husk);
    return shapes;
}
/** The walnut: a speckled green hull that splits and peels back from the wrinkled shell. */
function walnut(rng, s, stage, f) {
    const g = grown(stage);
    const r = s * 0.32 * f.size * g, ry = r * 1.05 * f.elong;
    const stalk = s * 0.07 * f.stalk;
    const centre = [0, stalk + ry];
    const shapes = [line([[0, 0], [rng.sym(0.02) * s, stalk + ry * 0.1]], s * 0.035)];
    const k = (phi) => 1 + f.tip * 0.15 * dip(phi, 0, 0.2);
    if (stage !== "seed") {
        shapes.push(modelled(polar(centre, r, ry, k, 28), centre, r, ry, 0.6, 0.22), dots(stipple(rng, centre, r, ry, 22, 0.15), s * 0.006));
        return shapes;
    }
    // The shell shows its seam and its wrinkles; torn pieces of the hull still clasp it at the stalk and curl away.
    const sr = r * 0.86, sry = ry * 0.9;
    const shellCentre = [0, centre[1] + ry * 0.06];
    const shell = modelled(polar(shellCentre, sr, sry, phi => 1 + 0.12 * dip(phi, 0, 0.2), 24), shellCentre, sr, sry, 0.55, 0.15);
    shell.veins.push(meridian(shellCentre, sr, sry, 0.05, 0.02, 0.98));
    for (let j = 0; j < 12; j += 1) {
        const at = [shellCentre[0] + rng.range(-0.75, 0.75) * sr, shellCentre[1] + rng.range(-0.75, 0.75) * sry];
        if ((at[0] / sr) ** 2 + ((at[1] - shellCentre[1]) / sry) ** 2 > 0.6 || Math.abs(at[0]) < sr * 0.08)
            continue;
        const a = rng.range(0, Math.PI);
        shell.veins.push(sample(t => [at[0] + Math.cos(a) * sr * 0.3 * (t - 0.5) + Math.sin(t * 9) * sr * 0.03, at[1] + Math.sin(a) * sr * 0.3 * (t - 0.5)], 6));
    }
    shapes.push(shell);
    for (const sd of [-1, 1]) {
        const sweep = rng.range(1.5, 1.9);
        const arc = sample(t => {
            const phi = Math.PI - sd * sweep * t;
            return [Math.sin(phi) * r * 1.06 + sd * r * 0.3 * t * t, centre[1] + Math.cos(phi) * ry * 1.06 - ry * 0.1 * t * t];
        }, 10);
        const end = arc[arc.length - 1], start = [sd * r * 0.1, stalk + ry * 0.08];
        const tear = [0.8, 0.6, 0.4, 0.2].map((t, index) => [lerp(start[0], end[0], t) - sd * r * (index % 2 === 0 ? 0.18 : 0.06), lerp(start[1], end[1], t) + ry * 0.05]);
        shapes.push(modelled([...arc, ...tear, start], [sd * r * 0.75, centre[1] - ry * 0.3], r * 0.5, ry * 0.6, 0.65, 0.55));
    }
    return shapes;
}
/** The spindle's four-lobed capsule on a long stalk; it opens in four valves over orange arils. */
const capsule = f => (rng, s, stage) => {
    const g = grown(stage);
    const r = s * 0.18 * f.size * g;
    const stalk = s * 0.32 * f.stalk;
    const centre = [0, stalk + r * 0.95];
    const shapes = [line([[0, 0], [rng.sym(0.03) * s, stalk * 0.5], [0, stalk + r * 0.05]], s * 0.016)];
    if (stage !== "seed") {
        const body = modelled(polar(centre, r * 1.1, r, phi => (1 + 0.14 * Math.cos(4 * phi)) * (1 - 0.1 * dip(phi, Math.PI, 0.4)), 28), centre, r * 1.1, r, 0.55, stage === "bud" ? 0.25 : 0.12);
        body.veins.push(...[-0.75, 0, 0.75].map(l => meridian(centre, r * 0.95, r * 0.95, l, 0.1, 0.92)));
        shapes.push(body);
        return shapes;
    }
    for (const a of [-2.4, 2.4, -1.7, 1.7]) {
        const dir = [Math.sin(a), Math.cos(a)];
        const spine = (v) => [centre[0] + dir[0] * r * 1.0 * v, centre[1] - r * 0.2 + dir[1] * r * 1.0 * v + r * 0.25 * v * v];
        shapes.push(bladeBody({ spine, halfWidth: v => r * 0.42 * Math.sin(Math.PI * v ** 0.7) ** 0.6, shade: a < 0 ? -1 : 1, spacing: HATCH * 0.8, grain: "across", weight: 0.45, samples: 12 }, rng));
    }
    for (const at of [[-r * 0.34, centre[1] + r * 0.1], [r * 0.34, centre[1] + r * 0.12], [-r * 0.14, centre[1] + r * 0.52], [r * 0.16, centre[1] + r * 0.5]]) {
        shapes.push({ type: "body", outline: polar(at, r * 0.27, r * 0.3, phi => 1 + 0.1 * dip(phi, 0, 0.5), 12), shadow: [], grain: [], veins: [], weight: 0.6, tone: "accent" });
    }
    shapes.push(dots([[-r * 0.34, centre[1] + r * 0.14], [r * 0.34, centre[1] + r * 0.16], [-r * 0.14, centre[1] + r * 0.56], [r * 0.16, centre[1] + r * 0.54]], r * 0.07));
    return shapes;
};
/** The cotton boll in its three fringed bracts; it bursts at the end into lobes of fibre. */
const boll = f => (rng, s, stage) => {
    const g = grown(stage);
    const r = s * 0.24 * f.size * g;
    const stalk = s * 0.12 * f.stalk;
    const centre = [0, stalk + r * 1.1];
    const bract = (sd, reach, dry) => {
        const dir = unit(sd * 0.6, 1);
        const spine = (v) => [dir[0] * reach * v + sd * r * 0.25 * v * v, stalk + dir[1] * reach * v];
        return bladeBody({ spine, halfWidth: v => r * (0.55 + (dry ? -0.15 : 0)) * Math.sin(Math.PI * v ** 0.6) ** 0.7,
            edge: v => -r * 0.18 * ((v * 6) % 1) * smoothstep(0.35, 0.6, v), shade: sd < 0 ? -1 : 1, spacing: HATCH * (dry ? 0.7 : 0.9),
            grain: "across", weight: dry ? 0.65 : 0.45, midrib: true, samples: 14 }, rng);
    };
    const shapes = [line([[0, 0], [0, stalk + r * 0.1]], s * 0.03)];
    if (stage !== "seed") {
        shapes.push(bract(-1, r * (stage === "bud" ? 2.2 : 1.7), false), bract(1, r * (stage === "bud" ? 2.2 : 1.7), false));
        const ry = r * 1.3;
        const body = modelled(polar(centre, r, ry, phi => 1 + 0.4 * dip(phi, 0, 0.35), 26), centre, r, ry, 0.55, 0.25);
        body.veins.push(...[-0.6, 0.6].map(l => meridian(centre, r, ry * 1.2, l, 0.1, 0.95)));
        shapes.push(body, bract(0.05, r * (stage === "bud" ? 2 : 0.9), false));
        return shapes;
    }
    // Burst: the dry valves spread and the fibre swells out between them.
    shapes.push(bract(-1, r * 1.3, true), bract(1, r * 1.3, true));
    for (const a of [-1.8, 1.8, 0.2]) {
        const dir = [Math.sin(a), Math.cos(a)];
        const spine = (v) => [centre[0] + dir[0] * r * 1.25 * v, centre[1] - r * 0.3 + dir[1] * r * 1.25 * v - r * 0.2 * v * v];
        shapes.push(bladeBody({ spine, halfWidth: v => r * 0.26 * Math.sin(Math.PI * v ** 0.8) ** 0.8, shade: a < 0 ? -1 : 1, spacing: HATCH * 0.6, grain: "across", weight: 0.75, samples: 12 }, rng));
    }
    for (const [x, y, rr] of [[-0.55, 0.2, 0.6], [0.55, 0.25, 0.6], [0, 0.7, 0.62]]) {
        const at = [centre[0] + x * r, centre[1] + y * r];
        const phase = rng.range(0, TAU);
        const fluff = polar(at, r * rr, r * rr * 0.9, phi => 1 + 0.09 * Math.sin(9 * phi + phase) + 0.05 * Math.sin(17 * phi), 30);
        const lobe = { type: "body", outline: fluff, shadow: [], grain: [], veins: [], weight: 0.3 };
        for (let k = 0; k < 4; k += 1) {
            const c = [at[0] + rng.sym(0.5) * r * rr, at[1] + rng.sym(0.5) * r * rr];
            lobe.veins.push(sample(t => [c[0] + Math.cos(t * 4 + phase) * r * rr * 0.2 * t, c[1] + Math.sin(t * 4 + phase) * r * rr * 0.2 * t], 6));
        }
        shapes.push(lobe);
    }
    return shapes;
};
/** The water chestnut's nut: a woody top with two big horns and two small, barbed when ripe. */
const caltrop = f => (rng, s, stage) => {
    const g = grown(stage);
    const w = s * 0.5 * f.size * g;
    const stalk = s * 0.1 * f.stalk;
    const neck = stalk + w * 0.12;
    const shoulder = neck + w * 0.3;
    const dark = stage === "seed" ? 0.75 : stage === "bloom" ? 0.35 : 0.2;
    const shapes = [line([[0, 0], [0, neck]], s * 0.02)];
    const horn = (from, dir, length, curl) => {
        const [dx, dy] = unit(dir[0], dir[1]);
        const spine = (v) => [from[0] + dx * length * v, from[1] + dy * length * v + curl * length * v * v];
        const body = bladeBody({ spine, halfWidth: v => w * 0.06 * (1 - v) ** 0.8, shade: dx < 0 ? -1 : 1, spacing: HATCH * 0.6, grain: "across", weight: 0.75, samples: 10 }, rng);
        if (stage === "seed") {
            const tip = spine(0.85);
            body.veins.push([tip, [tip[0] - dx * w * 0.06 + dy * w * 0.03, tip[1] - dy * w * 0.06 - dx * w * 0.03]]);
        }
        return body;
    };
    for (const sd of [-1, 1])
        shapes.push(horn([sd * w * 0.22, shoulder + w * 0.18], [sd * 0.8, 0.6], w * 0.24, 0));
    const top = (v) => [0, neck + w * 0.7 * v];
    const halfWidth = (v) => w * (0.12 + 0.3 * Math.sin(Math.PI * Math.min(1, v * 1.25)) ** 0.8) * (v > 0.8 ? 1 - (v - 0.8) * 2.5 : 1);
    const { outline } = blade(top, 24, halfWidth, halfWidth);
    shapes.push(modelled(outline, top(0.4), w * 0.4, w * 0.35, 0.7, dark));
    for (const sd of [-1, 1])
        shapes.push(horn([sd * w * 0.3, shoulder], [sd, -0.35], w * 0.42, 0.15));
    // The little crown where the flower stood.
    shapes.push(line(sample(t => [w * 0.1 * (2 * t - 1), neck + w * 0.02 * Math.sin(Math.PI * t * 4)], 6), s * 0.012));
    return shapes;
};
/** The butcher's broom: a stiff spine-tipped cladode bearing its berry in the middle of its face. */
const cladode = f => (rng, s, stage) => {
    const shapes = cladodeBlade(rng, s * 0.9, rng.sym(0.12));
    const at = [0, s * 0.42];
    const r = s * 0.1 * f.size * (stage === "bud" ? 0.4 : stage === "seed" ? 1.05 : 0.85);
    if (stage === "bud") {
        shapes.push(...[0, 1, 2, 3, 4, 5].map(k => line([at, [at[0] + Math.cos(k * 1.05) * r * 1.4, at[1] + Math.sin(k * 1.05) * r * 1.4]], s * 0.006)), dots([at], r * 0.4));
        return shapes;
    }
    shapes.push(modelled(polar(at, r, r, () => 1, 14), at, r, r, 0.75, stage === "seed" ? 0.48 : 0.12));
    return shapes;
};
/** Each fruit draws one fruit on its stalk, origin at the stalk's base, hanging along +y. */
const FRUITS = {
    fig: f => (rng, s, stage) => fig(rng, s * f.size, stage), pome, pear, drupe, citrus, pomegranate, berry: berryFruit, mulberry, aubergine, tomato, pepper, pod, nut, capsule, boll, caltrop, cladode,
};
// ---------------------------------------------------------------- groups of fruit
function pairOf(draw) {
    return (rng, s, stage) => {
        const out = [];
        for (const sd of [-1, 1]) {
            const angle = sd * rng.range(0.35, 0.6);
            out.push(line(sample(bezier3([0, 0], [0, s * 0.15], [sd * s * 0.1, s * 0.2], [sd * s * 0.22, s * 0.25]), 6), s * 0.03));
            out.push(...draw(rng, s * rng.range(0.72, 0.85), stage).map(shape => turnShape(shape, angle, [sd * s * 0.22, s * 0.25])));
        }
        return out;
    };
}
/** Two fruits on long slender stalks from one spur, as cherries hang. */
function twinOf(draw, stalk) {
    return (rng, s, stage) => {
        const out = [line([[0, 0], [0, s * 0.06]], s * 0.035)];
        const fruits = [];
        for (const sd of [-1, 1]) {
            const reach = s * 0.42 * stalk * rng.range(0.85, 1.1);
            const end = [sd * reach * rng.range(0.38, 0.55), s * 0.06 + reach];
            out.push(line(sample(bezier3([0, s * 0.06], [sd * s * 0.04, s * 0.06 + reach * 0.4], [end[0] * 0.8, end[1] * 0.7], end), 6), s * 0.014));
            fruits.push(...place(draw(rng, s * 0.62, stage), end, unit(sd * 0.25, 1)));
        }
        return [...out, ...fruits];
    };
}
/** A hanging bunch: fruits on pedicels fanning from one peduncle (azerole, pistache, noisette, tomate). */
function bunchOf(draw, count) {
    return (rng, s, stage) => {
        const hub = [rng.sym(0.03) * s, s * 0.22];
        const out = [line([[0, 0], hub], s * 0.03)];
        const scale = s * 0.95 / Math.sqrt(count);
        const fruits = [];
        for (let k = 0; k < count; k += 1) {
            const q = count === 1 ? 0 : -1 + 2 * k / (count - 1);
            const a = q * 1.0 + rng.sym(0.12);
            const reach = s * (0.12 + 0.2 * (1 - Math.abs(q)) * rng.range(0.6, 1.2));
            const at = [hub[0] + Math.sin(a) * reach, hub[1] + Math.cos(a) * reach];
            fruits.push({ at, dir: unit(Math.sin(a) * 0.7, 1) });
            out.push(line([hub, [lerp(hub[0], at[0], 0.4), lerp(hub[1], at[1], 0.7)], at], s * 0.013));
        }
        // The nearer, lower fruits are drawn last, over the ones behind.
        fruits.sort((a, b) => a.at[1] - b.at[1]);
        for (const { at, dir } of fruits)
            out.push(...place(draw(rng, scale * rng.range(0.9, 1.05), stage), at, dir));
        return out;
    };
}
/** A hanging string of fruits on short pedicels, smaller toward its tip (groseille, épine-vinette). */
function racemeOf(draw, count) {
    return (rng, s, stage) => {
        const length = s * 0.95;
        const bend = rng.sym(0.12) * length;
        const axis = (v) => [bend * v * v, length * v];
        const out = [line(sample(axis, 10), s * 0.016)];
        const fruits = [];
        for (let k = 0; k < count; k += 1) {
            const v = 0.18 + 0.8 * k / Math.max(1, count - 1);
            const p = axis(v);
            const sd = k % 2 === 0 ? 1 : -1;
            const dir = unit(sd * 0.9, 0.7);
            const at = [p[0] + dir[0] * s * 0.06, p[1] + dir[1] * s * 0.06];
            out.push(line([p, at], s * 0.01));
            fruits.push(...place(draw(rng, s * 0.42 * (1 - 0.35 * v), stage), at, unit(sd * 0.5, 1)));
        }
        return [...out, ...fruits];
    };
}
function groupOf(cluster, draw, count, stalk) {
    switch (cluster) {
        case "pair": return twinOf(draw, stalk);
        case "bunch": return bunchOf(draw, count);
        case "raceme": return racemeOf(draw, count);
        default: return draw;
    }
}
// ---------------------------------------------------------------- leaves
/** An ovate leaf with a sawn edge and straight side veins (pomme, châtaigne, noisette, alaterne). */
function serrateLeaf(rng, length, bend, breadth) {
    const petiole = length * 0.12;
    const blade = length - petiole;
    const width = blade * 0.3 * breadth;
    const heart = breadth > 1.2;
    const teeth = Math.max(10, Math.round(blade / 0.08));
    const spine = (v) => [bend * blade * v * v, petiole + blade * v];
    const halfWidth = (v) => width * (heart ? 1.7 * v ** 0.32 * (1 - v) ** 0.75 : 2.1 * v ** 0.55 * (1 - v) ** 0.8);
    const veins = [];
    const pairs = breadth < 0.8 ? 11 : 7;
    for (let j = 0; j < pairs; j += 1) {
        const v = 0.1 + 0.78 * j / pairs;
        const from = spine(v);
        for (const sd of [1, -1]) {
            const to = spine(Math.min(0.97, v + 0.07 + 0.05 * breadth));
            veins.push([from, [to[0] + sd * halfWidth(Math.min(0.97, v + 0.07 + 0.05 * breadth)) * 0.9, to[1]]]);
        }
    }
    return [line([[0, 0], spine(0)], length * 0.022), bladeBody({ spine, halfWidth, edge: v => -width * 0.08 * ((v * teeth) % 1) * smoothstep(0.03, 0.14, v),
            shade: side(rng), spacing: HATCH, grain: "across", weight: 0.55, midrib: true, veins, samples: Math.round(Math.min(48, Math.max(16, length * 24))) }, rng)];
}
/** One elliptic leaflet, cut lightly (few outline points): pinnate leaves carry many of them. */
function leafletBlade(rng, length, bend, breadth) {
    const spine = (v) => [bend * length * v * v, length * v];
    return [bladeBody({ spine, halfWidth: v => length * 0.27 * breadth * 2.1 * v ** 0.5 * (1 - v) ** 0.8, shade: side(rng), spacing: HATCH,
            grain: "across", weight: 0.5, midrib: true, samples: 10 }, rng)];
}
/** A pinnate leaf of elliptic leaflets in pairs with an odd one at the tip (noix, pistache, acacia, tomate). */
function pinnate(rng, length, bend, pairs, leaflet, breadth) {
    const rachis = sample(v => [bend * length * v * v, length * v], 12);
    const shapes = [line(rachis, length * 0.018)];
    for (let k = 1; k <= pairs; k += 1) {
        const v = 0.15 + 0.75 * (k - 0.5) / pairs;
        const at = rachis[Math.round(v * 12)];
        const size = length * leaflet * (1 - 0.25 * v);
        for (const sd of [1, -1])
            shapes.push(...place(leafletBlade(rng, size, sd * 0.06, breadth), at, unit(sd * 1.2, 0.75)));
    }
    shapes.push(...place(leafletBlade(rng, length * leaflet * 0.85, 0, breadth), rachis[12], unit(bend, 1)));
    return shapes;
}
/** A round leaf with a heart-shaped base and veins fanning from it (gainier). */
function heartLeaf(rng, length, bend) {
    const petiole = length * 0.24;
    const r = (length - petiole) * 0.52;
    const centre = [bend * r * 0.3, petiole + r * 0.82];
    const outline = polar(centre, r, r, phi => (1 + 0.06 * Math.cos(phi)) * (1 - 0.4 * dip(phi, Math.PI, 0.3)), 40);
    const base = [centre[0], centre[1] - r * 0.6];
    const shade = side(rng);
    const shadow = [[base[0], base[1] - r], [base[0] + shade * r * 2, base[1] - r], [base[0] + shade * r * 2, base[1] + r * 3], [base[0], base[1] + r * 3]];
    const grain = [];
    for (let k = -30; k <= 30; k += 1) {
        const y0 = centre[1] + k * HATCH * 1.05;
        grain.push([[centre[0] - r * 1.2, y0 - r * 0.4 * shade], [centre[0] + r * 1.2, y0 + r * 0.4 * shade]]);
    }
    // Veins fan from the notch; the lowest curl up into the basal lobes.
    const veins = [-1.75, -1.0, -0.4, 0.4, 1.0, 1.75].map(a => sample(v => [base[0] + Math.sin(a) * r * 1.2 * v * (1 - 0.3 * Math.abs(a) / 1.75), base[1] + Math.cos(a) * r * 0.9 * v + r * 0.5 * v * v], 5, 0, 0.8));
    veins.push(sample(v => [base[0], base[1] + r * 1.5 * v], 5, 0, 0.95));
    return [line([[0, 0], [bend * r * 0.1, petiole * 0.6], base], length * 0.022), { type: "body", outline, shadow: [shadow], grain, veins, weight: 0.55 }];
}
/** A citrus leaf: an articulated blade over a winged petiole; `wing` sets the wing's breadth. */
function wingedLeaf(rng, length, bend, wing) {
    const petiole = length * 0.24;
    const shapes = [line([[0, 0], [0, petiole * 1.05]], length * 0.02)];
    if (wing > 0.05) {
        shapes.push(bladeBody({ spine: v => [0, petiole * v], halfWidth: v => length * 0.13 * wing * v ** 1.1 * (1 - v ** 6) ** 0.3, shade: side(rng),
            spacing: HATCH, grain: "across", weight: 0.5, samples: 14 }, rng));
    }
    const blade = length - petiole * 1.05;
    const spine = (v) => [bend * blade * v * v, petiole * 1.05 + blade * v];
    shapes.push(bladeBody({ spine, halfWidth: v => blade * 0.55 * v ** 0.5 * (1 - v) ** 0.85, shade: side(rng), spacing: HATCH * 0.9, grain: "across", weight: 0.6, midrib: true, samples: 28 }, rng));
    return shapes;
}
/** The butcher's broom's cladode: a flattened stem like a stiff leaf, ending in a spine. */
function cladodeBlade(rng, length, bend) {
    const spine = (v) => [bend * length * v * v, length * v];
    const halfWidth = (v) => length * 0.22 * v ** 0.45 * (1 - v) ** 0.95;
    const veins = [-0.5, 0.5].map(q => sample(v => { const [x, y] = spine(v); return [x + q * halfWidth(v), y]; }, 10, 0.08, 0.9));
    const body = bladeBody({ spine, halfWidth, shade: side(rng), spacing: HATCH * 0.8, grain: "across", weight: 0.65, midrib: true, veins, samples: 26 }, rng);
    const tip = spine(1), before = spine(0.95);
    const [dx, dy] = unit(tip[0] - before[0], tip[1] - before[1]);
    return [body, line([tip, [tip[0] + dx * length * 0.08, tip[1] + dy * length * 0.08]], length * 0.012)];
}
/** The water chestnut's leaf: a toothed rhombic blade on a petiole swollen into a float. */
function rhombicLeaf(rng, length, bend, samples = 32) {
    const stalk = length * 0.48;
    const float = bladeBody({ spine: v => [0, stalk * (0.25 + 0.65 * v)], halfWidth: v => length * 0.05 * Math.sin(Math.PI * v) ** 0.7, shade: side(rng),
        spacing: HATCH * 0.9, grain: "along", reach: [0.3, 0.7], weight: 0.35, samples: 12 }, rng);
    const blade = length - stalk, w = blade * 0.55;
    const spine = (v) => [bend * blade * v * v, stalk + blade * v];
    const halfWidth = (v) => v < 0.42 ? w * v / 0.42 : w * Math.max(0, 1 - (v - 0.42) / 0.58) ** 0.9;
    const corner = spine(0.42);
    const veins = [-1, 1].map(sd => [spine(0.08), [corner[0] + sd * w * 0.85, corner[1] - blade * 0.02]]);
    return [line([[0, 0], [0, stalk]], length * 0.016), float, bladeBody({ spine, halfWidth, edge: v => v > 0.42 ? -w * 0.1 * ((v * 14) % 1) : 0,
            shade: side(rng), spacing: HATCH, grain: "across", weight: 0.55, midrib: true, veins, samples }, rng)];
}
/** A twig of small alternate leaves (myrtille). */
function smallSprig(rng, length, bend, breadth) {
    const twig = (v) => [bend * length * 0.4 * v * v + (Math.floor(v * 4) % 2 === 0 ? 1 : -1) * length * 0.015, length * v];
    const shapes = [line(sample(twig, 8), length * 0.02, false)];
    for (const [index, v] of [0.28, 0.46, 0.63, 0.8].entries()) {
        const sd = index % 2 === 0 ? 1 : -1;
        shapes.push(...place(simpleLeaf(rng, length * 0.28, sd * 0.1, 0.34 * breadth), twig(v), unit(sd * 0.9, 0.8)));
    }
    shapes.push(...place(simpleLeaf(rng, length * 0.24, 0.05, 0.34 * breadth), twig(1), [0, 1]));
    return shapes;
}
/** A tuft of obovate leaves from a short spur (épine-vinette). */
function fascicle(rng, length, bend, breadth) {
    const spur = [bend * length * 0.05, length * 0.1];
    const shapes = [line([[0, 0], spur], length * 0.03)];
    for (const a of [-0.75, -0.25, 0.25, 0.75]) {
        const l = length * 0.55 * (1 - 0.25 * Math.abs(a));
        const leaf = bladeBody({ spine: v => [bend * l * 0.3 * v * v, l * v], halfWidth: v => l * 0.3 * breadth * 1.9 * v ** 0.9 * (1 - v) ** 0.42,
            edge: v => -l * 0.012 * ((v * 16) % 1) * smoothstep(0.4, 0.6, v), shade: side(rng), spacing: HATCH, grain: "across", weight: 0.5, midrib: true, samples: 14 }, rng);
        shapes.push(...place([leaf], spur, [Math.sin(a + bend), Math.cos(a + bend)]));
    }
    return shapes;
}
/** Thorns at a leaf's base: a single spine, or the barberry's three-pronged one. */
function thornsAt(kind, length, bend) {
    const away = bend >= 0 ? -1 : 1;
    const prongs = kind === "trifid" ? [-0.55, 0, 0.55] : [0];
    return prongs.map(offset => {
        const a = away * 1.75 + offset;
        const l = length * (offset === 0 ? 0.17 : 0.12);
        const dir = [Math.sin(a), Math.cos(a)];
        const normal = [-dir[1], dir[0]];
        const w = length * 0.016;
        return { type: "solid", outline: [[normal[0] * w, normal[1] * w], [dir[0] * l, dir[1] * l], [-normal[0] * w, -normal[1] * w]], smooth: false };
    });
}
/** Leaves in opposite pairs along a short twig (olive, chamérisier, fusain). */
function oppositeSprig(leaf) {
    return (rng, length, bend) => {
        const twig = (v) => [bend * length * 0.3 * v * v, length * v];
        const shapes = [line(sample(twig, 6), length * 0.02)];
        for (const sd of [-1, 1])
            shapes.push(...place(leaf(rng, length * 0.4, sd * 0.08), twig(0.42), unit(sd * 1.1, 0.8)));
        for (const sd of [-1, 1])
            shapes.push(...place(leaf(rng, length * 0.34, sd * 0.05), twig(0.97), unit(sd * 0.35, 1)));
        return shapes;
    };
}
/**
 * The node leaf and the filler leaflet for a leaf kind. A filler stands for a whole leaf, so a pinnate
 * leaf lends it one leaflet and an opposite sprig one blade: they are tucked in by the dozen.
 */
function leavesOf(kind, variant) {
    const breadth = numberOf(variant, "breadth");
    const pinnae = numberOf(variant, "pinnae");
    const thorns = textOf(variant, "thorns");
    let base;
    switch (kind) {
        case "simple":
            base = (rng, length, bend) => simpleLeaf(rng, length, bend, 0.3 * breadth);
            break;
        case "lobed":
            base = (rng, length, bend) => lobedLeaf(rng, length, bend);
            break;
        case "pinnate": {
            const share = 0.34 * Math.sqrt(4 / pinnae) * Math.min(1, breadth);
            base = (rng, length, bend) => pinnate(rng, length, bend, Math.round(pinnae), share, breadth);
            break;
        }
        case "serrate":
            base = (rng, length, bend) => serrateLeaf(rng, length, bend, breadth);
            break;
        case "lanceolate":
            base = (rng, length, bend) => simpleLeaf(rng, length, bend, 0.14 * breadth);
            break;
        case "cordate":
            base = (rng, length, bend) => heartLeaf(rng, length, bend);
            break;
        case "winged": {
            const wing = numberOf(variant, "wing");
            base = (rng, length, bend) => wingedLeaf(rng, length, bend, wing);
            break;
        }
        case "cladode":
            base = (rng, length, bend) => cladodeBlade(rng, length * 0.8, bend);
            break;
        case "rhombic":
            base = (rng, length, bend) => rhombicLeaf(rng, length, bend);
            break;
        case "small":
            base = thorns === "trifid" ? (rng, length, bend) => fascicle(rng, length * 0.7, bend, breadth) : (rng, length, bend) => smallSprig(rng, length, bend, breadth);
            break;
        default: {
            const leaf = (rng, length) => palmateLeaf(rng, length);
            return { leaf, leaflet: (rng, length, bend) => leaf(rng, length * 0.8, bend) };
        }
    }
    const opposite = flagOf(variant, "opposite");
    let leaf = opposite ? oppositeSprig(base) : base;
    if (thorns !== "none") {
        const bare = leaf;
        leaf = (rng, length, bend) => [...thornsAt(thorns, length, bend), ...bare(rng, length, bend)];
    }
    const leaflet = kind === "pinnate" ? (rng, length, bend) => leafletBlade(rng, length * 0.6, bend, breadth)
        : kind === "small" ? (rng, length, bend) => simpleLeaf(rng, length * 0.5, bend, 0.34 * breadth)
            : opposite ? (rng, length, bend) => base(rng, length * 0.6, bend) : (rng, length, bend) => leaf(rng, length * 0.8, bend);
    return { leaf, leaflet };
}
// ---------------------------------------------------------------- the floating rosette
/** The mâcre's rosette of rhombic leaves lying on the water, seen aslant; its nuts hang under it at the end. */
function rosette(nutDraw) {
    return (rng, s, stage) => {
        const size = stage === "bud" ? 0.65 : 1;
        const centre = [0, s * 0.3];
        const flat = 0.46;
        const count = stage === "bud" ? 6 : 9;
        const phase = rng.range(0, TAU);
        const shapes = [line([[0, 0], centre], s * 0.03)];
        if (stage === "seed") {
            for (const sd of [-1, 1])
                shapes.push(...place(nutDraw(rng, s * 0.5, "seed"), [centre[0] + sd * s * 0.12, centre[1] - s * 0.02], unit(sd * 0.5, -1)));
        }
        // The water line runs out on either side, broken where the light lies on it.
        for (const sd of [-1, 1]) {
            shapes.push(line([[sd * s * 0.42 * size, centre[1] - s * 0.03], [sd * s * 0.95, centre[1] - s * 0.035]], s * 0.008));
            shapes.push(line([[sd * s * 0.55, centre[1] - s * 0.075], [sd * s * 0.8, centre[1] - s * 0.08]], s * 0.006));
        }
        const leaves = Array.from({ length: count }, (_, k) => phase + k / count * TAU).sort((a, b) => Math.sin(b) - Math.sin(a));
        for (const a of leaves) {
            const length = s * 0.8 * size * rng.range(0.85, 1.05);
            const leaf = rhombicLeaf(rng, length, rng.sym(0.08), 16).slice(2);
            const dir = [Math.cos(a), Math.sin(a)];
            shapes.push(...place(leaf, [0, -length * 0.42], [0, 1]).map(shape => mapShape(turnShape(shape, Math.atan2(-dir[0], dir[1])), ([x, y]) => [centre[0] + x, centre[1] + y * flat])));
        }
        if (stage === "bloom")
            shapes.push(dots([[centre[0] - s * 0.04, centre[1] + s * 0.02], [centre[0] + s * 0.05, centre[1] + s * 0.03]], s * 0.022));
        return shapes;
    };
}
// ---------------------------------------------------------------- the form
const SHOOTS = {
    tree: { count: 2, amplitude: 0.17, lambda: [3, 5], width: 0.11, tops: [0.9, 0.62] },
    shrub: { count: 3, amplitude: 0.14, lambda: [2.5, 4], width: 0.075, tops: [0.84, 0.66, 0.5] },
    herb: { count: 2, amplitude: 0.1, lambda: [3, 5], width: 0.05, tops: [0.82, 0.6] },
    aquatic: { count: 2, amplitude: 0.22, lambda: [2, 3], width: 0.032, tops: [0.86, 0.66] },
};
export const form = {
    id: "arbre-fruitier",
    name: "arbre fruitier",
    doc: "Trees, shrubs and fruiting shoots shown by their fruit, which buds, swells and ripens, darkens or splits.",
    variants: {
        fruit: { doc: "The fruit drawn at the nodes", default: "fig", values: Object.keys(FRUITS) },
        cluster: { doc: "How fruits hang: one by one (and in forked pairs), as long-stalked twins, in a bunch, or strung on a raceme", default: "single", values: ["single", "pair", "bunch", "raceme"] },
        count: { doc: "Fruits in a bunch or on a raceme", default: 5, range: [2, 14] },
        size: { doc: "Fruit size against the motif: small berries below 1, a quince or pomegranate above", default: 1, range: [0.4, 1.5] },
        elong: { doc: "Fruit length against its breadth: a flat medlar below 1, a lemon, olive or long pod above", default: 1, range: [0.6, 2] },
        tip: { doc: "A point at the blossom end: the lemon's nipple, the almond's point, the hazelnut's beak", default: 0, range: [0, 1] },
        stalk: { doc: "Stalk length against the fruit's usual: a cherry's long pedicel above 1, a sessile peach below", default: 1, range: [0, 3] },
        calyx: { doc: "What the flower leaves on the fruit: a dry eye, a toothed crown, the medlar's open sepals, a ring, a star of sepals, or a cap", default: "none", values: ["none", "eye", "crown", "open", "ring", "star", "cap"] },
        surface: { doc: "The skin: smooth, glossy, downy, waxy bloom, speckled with lenticels, pored or rough-pored rind", default: "smooth", values: ["smooth", "glossy", "fuzzy", "bloom", "speckled", "dimpled", "rough"] },
        husk: { doc: "A husk or shell round the seed: spiny burr, leafy cup, long tube, green hull splitting from a pitted or wrinkled shell, or a gaping shell", default: "none", values: ["none", "burr", "cupule", "tube", "hull", "split"] },
        nuts: { doc: "Nuts showing in an opened burr", default: 2, range: [1, 3] },
        ripe: { doc: "Colour the ripe berry takes in ink: pale (red, opaque), dark (black or blue), or translucent with its seeds showing", default: "pale", values: ["pale", "dark", "translucent"] },
        leaf: { doc: "Leaf kind", default: "palmate", values: ["palmate", "simple", "lobed", "pinnate", "serrate", "lanceolate", "cordate", "winged", "cladode", "rhombic", "small"] },
        breadth: { doc: "Leaf breadth against the kind's usual: the chestnut's narrow blade below 1, the hazel's round one above", default: 1, range: [0.5, 1.6] },
        pinnae: { doc: "Leaflet pairs on a pinnate leaf", default: 4, range: [1, 9] },
        wing: { doc: "Breadth of a winged petiole: the orange's narrow wing, the bitter orange's broad one", default: 0.3, range: [0, 1] },
        opposite: { doc: "Leaves in opposite pairs on short twigs", default: false, values: [true, false] },
        thorns: { doc: "Thorns at the leaf bases: a spine-tipped twig, or the barberry's three-pronged thorn", default: "none", values: ["none", "spine", "trifid"] },
        shoot: { doc: "What bears the fruit: a tree's thick stems, a shrub's several thinner ones, a herbaceous shoot (never woody), or thin stems rising through water to a floating rosette", default: "tree", values: ["tree", "shrub", "herb", "aquatic"] },
    },
    examples: [
        { name: "figue", variant: {} },
        { name: "pomme", variant: { fruit: "pome", calyx: "eye", surface: "speckled", leaf: "serrate", stalk: 0.9 } },
        { name: "poire", variant: { fruit: "pear", calyx: "eye", surface: "speckled", leaf: "simple", breadth: 1.1, stalk: 1.3, elong: 1.15 } },
        { name: "cerise", variant: { fruit: "drupe", cluster: "pair", size: 0.75, surface: "glossy", stalk: 2.2, leaf: "serrate", breadth: 0.85 } },
        { name: "groseille", variant: { fruit: "berry", cluster: "raceme", count: 8, ripe: "translucent", calyx: "eye", stalk: 0.4, leaf: "palmate", shoot: "shrub" } },
        { name: "châtaigne", variant: { fruit: "nut", husk: "burr", nuts: 3, leaf: "serrate", breadth: 0.6 } },
        { name: "noix", variant: { fruit: "nut", husk: "hull", tip: 0.3, leaf: "pinnate", pinnae: 3, breadth: 1.2 } },
        { name: "citron", variant: { fruit: "citrus", elong: 1.3, tip: 0.8, calyx: "star", surface: "dimpled", leaf: "winged", wing: 0.15 } },
        { name: "grenade", variant: { fruit: "pomegranate", calyx: "crown", leaf: "lanceolate", breadth: 1.1, shoot: "shrub" } },
        { name: "tomate", variant: { fruit: "tomato", cluster: "bunch", count: 4, calyx: "star", leaf: "pinnate", pinnae: 3, shoot: "herb" } },
        { name: "aubergine", variant: { fruit: "aubergine", calyx: "cap", leaf: "simple", breadth: 1.4, shoot: "herb" } },
        { name: "mâcre", variant: { fruit: "caltrop", leaf: "rhombic", shoot: "aquatic" } },
        { name: "coton", variant: { fruit: "boll", leaf: "palmate", shoot: "herb" } },
        { name: "fragon", variant: { fruit: "cladode", leaf: "cladode", shoot: "shrub" } },
        { name: "gainier", variant: { fruit: "pod", cluster: "bunch", count: 4, elong: 1.1, leaf: "cordate" } },
        { name: "fusain", variant: { fruit: "capsule", leaf: "serrate", breadth: 0.8, opposite: true, shoot: "shrub" } },
        { name: "olive", variant: { fruit: "drupe", cluster: "bunch", count: 3, elong: 1.35, size: 0.6, surface: "glossy", ripe: "dark", leaf: "lanceolate", breadth: 0.8, opposite: true } },
        { name: "myrtille", variant: { fruit: "berry", calyx: "ring", ripe: "dark", size: 1.3, stalk: 0.5, leaf: "small", shoot: "shrub" } },
    ],
    build(variant) {
        const kind = textOf(variant, "fruit");
        const fruiting = {
            size: numberOf(variant, "size"), elong: numberOf(variant, "elong"), tip: numberOf(variant, "tip"), stalk: numberOf(variant, "stalk"),
            calyx: textOf(variant, "calyx"), surface: textOf(variant, "surface"), husk: textOf(variant, "husk"), nuts: numberOf(variant, "nuts"), ripe: textOf(variant, "ripe"),
        };
        const fruit = FRUITS[kind](fruiting);
        const cluster = textOf(variant, "cluster");
        const count = Math.round(numberOf(variant, "count"));
        const group = groupOf(cluster, fruit, count, fruiting.stalk);
        // A single fruit also hangs in forked pairs (a heavy boll, burr or caltrop alone); a group also hangs
        // as a smaller group, a twin alone.
        const heavy = kind === "boll" || kind === "caltrop" || fruiting.husk === "burr";
        const second = cluster === "single" ? (heavy ? fruit : pairOf(fruit)) : cluster === "pair" ? fruit : groupOf(cluster, fruit, Math.max(2, Math.round(count * 0.6)), fruiting.stalk);
        const leafKind = textOf(variant, "leaf");
        const { leaf, leaflet } = leavesOf(leafKind, variant);
        const shoot = textOf(variant, "shoot");
        const aquatic = shoot === "aquatic";
        const palmate = leafKind === "palmate";
        const broad = palmate || leafKind === "cordate";
        const small = leafKind === "small";
        // Long or heavy fruit hangs; a cladode stands out from its stem.
        const hang = cluster === "raceme" || kind === "pod" || kind === "caltrop" ? -0.6 : kind === "cladode" ? 0.3 : -0.2;
        const terminal = aquatic
            ? { size: [1.5, 1.7], r: s => 0.7 * s, off: () => 0, draw: rosette(fruit) }
            : { size: [1.0, 1.15], r: s => 0.62 * s, off: () => 0, draw: cluster === "single" ? pairOf(fruit) : group };
        return {
            id: "arbre-fruitier",
            stems: SHOOTS[shoot],
            basal: null,
            nodes: {
                every: broad ? [1.9, 2.7] : aquatic ? [2.2, 3.2] : [1.4, 2.1],
                length: height => palmate ? lerp(2.9, 1.9, height) : small ? lerp(1.7, 1.1, height) : lerp(2.2, 1.4, height),
                angle: [30, 55], below: 1,
            },
            leafProxy: broad ? 0.4 : 0.28,
            leaf,
            leaflet,
            terminal,
            motifs: [
                { name: "fruit", w: 3, smin: 0.75, smax: 1.1, max: 9, layer: LAYER.bloom, upright: hang, staged: true,
                    r: s => 0.46 * s, off: s => 0.48 * s, draw: group },
                { name: "pair", w: 1.2, smin: 0.8, smax: 1.0, max: 3, layer: LAYER.bloom, upright: 0.1, staged: true,
                    r: s => 0.6 * s, off: s => 0.45 * s, draw: second },
                { name: "leaf", w: 2.2, smin: 1.2, smax: 2.0, max: 8, layer: LAYER.leaf, upright: 0.3,
                    r: s => (palmate ? 0.5 : 0.33) * s, off: s => (palmate ? 0.62 : 0.5) * s, draw: (rng, s) => leaf(rng, s, rng.sym(0.25)) },
            ],
        };
    },
};
