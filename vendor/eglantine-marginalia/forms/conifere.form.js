// Conifers shown by their evergreen sprays and their cones. The sprays carry flat two-ranked needles
// (sapin, if), needles in threes (genièvre), tufts on short spurs (cèdre, mélèze), long paired needles
// in brushes (pignon) or cords of scale leaves (cyprès, sabine). The cone buds small, swells green and
// at the end of the day ripens woody and opens, shatters on the branch to its spike (sapin, cèdre),
// darkens as a berry-like cone (genièvre, sabine) or reddens as an aril round its seed (if).
import { LAYER, flagOf, numberOf, textOf } from "../form.js";
import { clamp, lerp, sample, smoothstep, unit } from "../geometry.js";
import { HATCH, circle, line, turnShape } from "../kit.js";
import { bladeBody, roundBody } from "../shapes.js";
const DEG = Math.PI / 180;
const rot = (d, a) => [d[0] * Math.cos(a) - d[1] * Math.sin(a), d[0] * Math.sin(a) + d[1] * Math.cos(a)];
const add = (p, d, k = 1) => [p[0] + d[0] * k, p[1] + d[1] * k];
function tangent(c, v) {
    const a = c(Math.max(0, v - 0.01)), b = c(Math.min(1, v + 0.01));
    return unit(b[0] - a[0], b[1] - a[1]);
}
/** A twig leaving `base` in direction `dir`, bowed sideways by `bow` of its length. */
const twigCurve = (base, dir, length, bow) => v => [base[0] + dir[0] * length * v - dir[1] * bow * length * v * v, base[1] + dir[1] * length * v + dir[0] * bow * length * v * v];
// ---------------------------------------------------------------- needles and sprays
/**
 * The needles along one twig as a single comb stroke, out to each tip and back to the twig, so a row of
 * fifty needles is one path rather than fifty.
 */
function needleRow(rng, twig, length, k) {
    const comb = [];
    const out = (p, d, len, curl) => {
        if (k.soft) {
            const mid = add(p, rot(d, curl), len * 0.5);
            comb.push(mid, add(mid, rot(d, -curl), len * 0.5), mid, p);
        }
        else
            comb.push(add(p, d, len), p);
    };
    const taper = (v) => 0.55 + 0.45 * (1 - v ** 3);
    const dots = [];
    comb.push(twig(0));
    switch (k.needles) {
        case "flat": {
            // Two ranks spread flat either side of the twig.
            const angle = (k.soft ? 62 : 76) * DEG;
            const n = Math.floor(length / 0.052);
            for (let i = 1; i <= n; i += 1) {
                const v = i / n, p = twig(v), t = tangent(twig, v);
                comb.push(p);
                for (const s of [1, -1])
                    out(p, rot(t, s * (angle + rng.sym(6 * DEG))), k.needle * taper(v) * rng.range(0.85, 1.08), s * 0.12);
            }
            break;
        }
        case "whorl": {
            // Stiff prickles in whorls of three: two seen spreading, one foreshortened toward the eye.
            const n = Math.floor(length / 0.13);
            for (let i = 1; i <= n; i += 1) {
                const v = i / n, p = twig(v), t = tangent(twig, v);
                comb.push(p);
                for (const s of [1, -1])
                    out(p, rot(t, s * rng.range(48, 60) * DEG), k.needle * taper(v) * rng.range(0.9, 1.05), 0);
                out(p, rot(t, rng.sym(18 * DEG)), k.needle * 0.4, 0);
                dots.push(p);
            }
            break;
        }
        case "tufts": {
            // Rosettes of needles on short spurs, alternately either side, and one at the shoot's tip.
            const n = Math.floor(length / (k.soft ? 0.22 : 0.18));
            for (let i = 1; i <= n + 1; i += 1) {
                const v = Math.min(1, i / n), p = twig(v), t = tangent(twig, v);
                const s = i % 2 ? 1 : -1;
                const axis = i > n ? t : rot(t, s * 55 * DEG);
                const spur = add(p, axis, i > n ? 0 : 0.045);
                comb.push(p, spur);
                const count = k.soft ? 9 : 11;
                for (let j = 0; j < count; j += 1) {
                    const a = lerp(-72, 72, j / (count - 1)) * DEG + rng.sym(5 * DEG);
                    out(spur, rot(axis, a), k.needle * rng.range(0.65, 1), (a > 0 ? 1 : -1) * 0.15);
                }
                comb.push(p);
                dots.push(spur);
            }
            break;
        }
        case "paired": {
            // A bare twig marked with scale leaves, ending in a brush of long needles in pairs.
            const n = Math.floor(length / 0.09);
            for (let i = 1; i <= n; i += 1) {
                const v = i / n, p = twig(v), t = tangent(twig, v);
                comb.push(p);
                if (v < 0.5) {
                    if (i % 3 === 0)
                        dots.push(add(p, [-t[1], t[0]], (i % 2 ? 1 : -1) * 0.012));
                    continue;
                }
                for (const s of [1, -1]) {
                    const a = s * lerp(70, 18, (v - 0.5) / 0.5) * DEG + rng.sym(8 * DEG);
                    const len = k.needle * rng.range(0.78, 1.02) * (v > 0.95 ? 0.85 : 1);
                    comb.push(add(p, rot(t, a), len), p, add(p, rot(t, a + s * 0.07), len * 0.97), p);
                }
            }
            break;
        }
    }
    const shapes = [line(comb, k.soft ? 0.008 : 0.011, false)];
    if (dots.length > 0)
        shapes.push({ type: "dots", points: dots, radius: 0.016 });
    return shapes;
}
/**
 * A spray of scale leaves: cords branching every way, drawn as one stroke that runs out along each
 * branchlet and back, beaded on alternate sides by the scales (cyprès, sabine).
 */
function scaleSpray(rng, length, bend, k) {
    const w = k.cord;
    const beads = [];
    const tour = (c, len, depth) => {
        const steps = Math.max(3, Math.round(len * 8));
        const children = depth >= 2 || len < 0.2 ? 0 : Math.floor(len / 0.15);
        const at = Array.from({ length: children }, (_, j) => 0.1 + 0.8 * (j + 0.5) / children);
        const forward = [];
        const plain = [];
        let next = 0;
        for (let i = 0; i <= steps; i += 1) {
            const v = i / steps;
            while (next < at.length && at[next] <= v) {
                const u = at[next], base = c(u);
                const s = rng.chance(0.5) ? 1 : -1;
                const a = s * rng.range(0.3, 0.8);
                const childLen = len * rng.range(0.28, 0.55) * (1 - 0.6 * u);
                forward.push(base, ...tour(twigCurve(base, rot(tangent(c, u), a), childLen, rng.sym(0.3)), childLen, depth + 1), base);
                next += 1;
            }
            const p = c(v);
            forward.push(p);
            plain.push(p);
        }
        // The scale leaves: beads at alternate edges, so the cord's outline zigzags.
        const n = Math.floor(len / Math.max(w * 1.3, 0.042));
        for (let i = 1; i <= n; i += 1) {
            const v = i / n, p = c(v), t = tangent(c, v);
            beads.push(add(p, [-t[1], t[0]], (i % 2 ? 1 : -1) * w * 0.45 * (1 - 0.4 * v)));
        }
        return [...forward, ...plain.reverse()];
    };
    const main = v => [bend * 0.6 * length * v * v, length * v];
    return [line(tour(main, length, 0), w, false), line(sample(main, 6), w * 1.3), { type: "dots", points: beads, radius: w * 0.42 }];
}
/** A shoot of the conifer: a leading twig with side twigs, needled or scaled after its kind. */
function spray(rng, length, bend, k) {
    if (k.needles === "scale")
        return scaleSpray(rng, length, bend, k);
    // For node leaves the growth loop bends toward the sky; a larch's shoots hang the other way.
    const up = bend >= 0 ? 1 : -1;
    const curl = k.posture === "drooping" ? -up * 0.28 : bend * 0.6;
    const main = v => [curl * length * v * v, length * v];
    const twigs = [{ c: main, len: length }];
    const sides = length < 0.85 ? 0 : k.needles === "paired" ? 2 : Math.round(length * 1.3);
    for (let j = 0; j < sides; j += 1) {
        const v = 0.22 + 0.55 * (j + 0.5) / sides;
        const s = j % 2 ? 1 : -1;
        const len = length * (0.55 - 0.3 * v) * rng.range(0.85, 1.1);
        twigs.push({ c: twigCurve(main(v), rot(tangent(main, v), s * rng.range(0.55, 0.85)), len, curl * 0.4), len });
    }
    const shapes = twigs.map((t, i) => line(sample(t.c, 6), i === 0 ? clamp(length * 0.016, 0.014, 0.03) : 0.013));
    for (const t of twigs)
        shapes.push(...needleRow(rng, t.c, t.len, k));
    return shapes;
}
// ---------------------------------------------------------------- cones
/** A closed outline symmetric about the axis, from its half-width along the length. */
function profile(len, hw, base = 0, n = 24) {
    const right = sample(v => [hw(v), base + len * v], n);
    const left = right.slice().reverse().map(([x, y]) => [-x, y]);
    return [...right, ...left].filter((p, i, all) => i === 0 || Math.hypot(p[0] - all[i - 1][0], p[1] - all[i - 1][1]) > 1e-4);
}
/**
 * A cone of overlapping scales (sapin, cèdre, mélèze): rows of scallops whose free edges arch upward.
 * Opened, the scales stand apart and the outline goes ragged.
 */
function scaledCone(rng, s, k, stage, base) {
    const bud = stage === "bud";
    const r = s * (bud ? 0.15 : 0.24);
    const len = bud ? r * 2.6 : r * 2 * k.coneLength;
    const open = stage === "seed";
    const flatTop = k.coneLength < 1.8 && !bud && k.cone === "barrel";
    const hw = (v) => {
        const foot = Math.min(1, v / 0.16) ** 0.5;
        const top = flatTop ? 1 - 0.2 * smoothstep(0.8, 1, v) : Math.sqrt(Math.max(0, 1 - Math.max(0, (v - 0.6) / 0.4) ** 2));
        const rag = open ? 1 + 0.14 * Math.abs(Math.sin(Math.PI * v * len / (r * 0.5))) : 1;
        return r * Math.max(0.15, foot) * top * rag;
    };
    const outline = profile(len, hw, base[1]);
    const body = roundBody(outline, [base[0], base[1] + len * 0.55], Math.max(r, len * 0.4), HATCH * (open ? 0.55 : 0.75), bud ? 0.3 : open ? 0.9 : 0.6);
    const rows = Math.max(3, Math.round(len / (r * (k.cone === "ovoid" ? 0.55 : 0.4))));
    const cells = k.cone === "ovoid" ? 2.4 : 3.2;
    const scallops = [];
    const bractTips = [];
    for (let j = 0; j < rows; j += 1) {
        const v = (j + 0.6) / (rows + 0.3);
        const y = base[1] + len * v, w = hw(v) * 0.96;
        const h = len / rows * 0.6;
        const shift = (j % 2) * 0.5;
        scallops.push(sample(u => {
            const x = (u * 2 - 1) * w;
            const f = (u * cells + shift) % 1;
            return [base[0] + x, y - 0.25 * h * (x / w) ** 2 + h * Math.sin(Math.PI * f) ** 0.8];
        }, Math.round(cells * 6)));
        if (k.bracts && !bud)
            for (let c = 0; c < cells; c += 1) {
                const u = (c + 0.5 - shift) / cells;
                if (u > 0.05 && u < 0.95)
                    bractTips.push([base[0] + (u * 2 - 1) * w, y + h * 1.05]);
            }
    }
    body.veins = scallops;
    const shapes = [body];
    if (bractTips.length > 0)
        shapes.push(...bractTips.map(p => line([p, [p[0], p[1] - len / rows * 0.55]], 0.009, false)));
    if (open)
        shapes.push({ type: "dots", points: scallops.flatMap(row => row.filter((_, i) => i % 6 === 3)), radius: s * 0.014 });
    return shapes;
}
/** A cone that has shattered on its branch: the spike stands, scales and winged seeds fall away. */
function shatteredCone(rng, s, k, base) {
    const r = s * 0.24, len = r * 2 * k.coneLength;
    const shapes = [line([base, [base[0], base[1] + len * 0.92]], r * 0.13)];
    // The last scales clinging at the foot.
    const stump = profile(len * 0.2, v => r * 0.85 * Math.min(1, v / 0.25) ** 0.5 * (1 - 0.3 * v), base[1]);
    shapes.push(roundBody(stump, [base[0], base[1] + len * 0.1], r * 0.7, HATCH * 0.6, 0.85));
    for (let j = 0; j < 4; j += 1) {
        const side = j % 2 ? 1 : -1;
        const at = [base[0] + side * r * rng.range(1.4, 2.3), base[1] + len * rng.range(0.1, 0.85)];
        const turnBy = rng.sym(1.4);
        if (j < 2) {
            // A loose fan-shaped scale.
            const scale = bladeBody({ spine: v => [0, r * 0.75 * v], halfWidth: v => r * 0.42 * Math.sin(Math.PI * Math.min(1, v * 0.8 + 0.2)) ** 0.6,
                shade: 1, spacing: HATCH * 0.6, grain: "along", reach: [0.3, 0.6], weight: 0.7, samples: 10 }, rng);
            shapes.push(turnShape(scale, turnBy, at));
        }
        else {
            // A winged seed spinning down.
            const wing = bladeBody({ spine: v => [0, r * 0.9 * v], halfWidth: v => r * 0.26 * Math.sin(Math.PI * v) ** 0.7 * (1 - 0.3 * v),
                shade: 1, spacing: HATCH, grain: "along", reach: [0.1, 0.3], weight: 0.25, samples: 10 }, rng);
            shapes.push(turnShape(wing, turnBy, at), { type: "dots", points: [at], radius: r * 0.14 });
        }
    }
    return shapes;
}
/** A pine cone of woody scales whose ends make a lattice of diamonds (pignon); ripe, it gapes and drops its nuts. */
function pineCone(rng, s, stage, base) {
    const scale = stage === "bud" ? 0.45 : 1;
    const len = s * 0.95 * scale, r = s * 0.36 * scale;
    const open = stage === "seed";
    const n = 13, c = 6 * Math.PI / n;
    const hw = (v) => r * Math.sin(Math.PI * Math.min(1, v ** 0.8 * 0.96 + 0.04)) ** 0.7
        * (open ? 1.12 + 0.1 * Math.abs(Math.sin(Math.PI * v * 7)) : 1);
    const outline = profile(len, hw, base[1], 30);
    const body = roundBody(outline, [base[0], base[1] + len * 0.45], r * 1.1, HATCH * (open ? 0.5 : 0.7), stage === "bud" ? 0.35 : open ? 0.92 : 0.65);
    const lattice = [];
    for (const dir of [1, -1]) {
        for (let j = 0; j < n; j += 1) {
            let run = [];
            for (let i = 0; i <= 24; i += 1) {
                const v = 0.04 + 0.92 * i / 24;
                const theta = 2 * Math.PI * j / n + dir * c * v;
                if (Math.cos(theta) > 0.08)
                    run.push([base[0] + hw(v) * 0.97 * Math.sin(theta), base[1] + len * v - len * 0.04 * Math.cos(theta)]);
                else if (run.length > 0) {
                    if (run.length > 1)
                        lattice.push(run);
                    run = [];
                }
            }
            if (run.length > 1)
                lattice.push(run);
        }
    }
    const umbos = [];
    for (let i = 0; i < 7; i += 1) {
        const v = Math.PI * (i + 0.5) / (n * c);
        if (v > 0.95)
            break;
        for (let j = 0; j < n; j += 1) {
            const theta = Math.PI * (2 * j + i + 0.5) / n;
            if (Math.cos(theta) > 0.3)
                umbos.push([base[0] + hw(v) * 0.97 * Math.sin(theta), base[1] + len * v - len * 0.04 * Math.cos(theta)]);
        }
    }
    const shapes = [];
    if (open) {
        // The gaping scales: the lattice cut deep, and the heavy nuts loose beside the cone.
        shapes.push(body, ...lattice.map(points => line(points, s * 0.014)), { type: "dots", points: umbos, radius: s * 0.02 });
        for (let j = 0; j < 3; j += 1) {
            const at = [base[0] + (j % 2 ? 1 : -1) * r * rng.range(1.5, 2.1), base[1] + len * (0.15 + 0.3 * j)];
            const nut = roundBody(circle([0, 0], s * 0.045, s * 0.085, 14), [0, 0], s * 0.07, HATCH * 0.5, 0.8);
            shapes.push(turnShape(nut, rng.sym(1.2), at));
        }
    }
    else {
        body.veins = lattice;
        shapes.push(body, { type: "dots", points: umbos, radius: s * 0.012 });
    }
    return shapes;
}
/** A round woody cone of shield scales, each with a boss (cyprès); ripe, the shields part. */
function roundCone(rng, s, stage, base) {
    const r = s * (stage === "bud" ? 0.13 : 0.27);
    const centre = [base[0], base[1] + r * 1.05];
    const open = stage === "seed";
    const outline = sample(v => {
        const a = v * Math.PI * 2;
        const bump = open ? 1 + 0.06 * Math.abs(Math.sin(a * 3)) : 1;
        return [centre[0] + Math.cos(a) * r * bump, centre[1] + Math.sin(a) * r * bump];
    }, 32).slice(0, -1);
    const body = roundBody(outline, centre, r, HATCH * 0.6, stage === "bud" ? 0.35 : open ? 0.9 : 0.6);
    const lean = rng.sym(0.3);
    const sutures = [
        sample(v => [centre[0] + r * Math.sin(lean) * 0.6 + r * 0.25 * Math.sin(Math.PI * v), centre[1] - r + 2 * r * v], 8),
        sample(v => [centre[0] - r + 2 * r * v, centre[1] + r * 0.1 - r * 0.25 * Math.sin(Math.PI * v)], 8),
        sample(v => [centre[0] - r * 0.7 + r * 0.25 * Math.sin(Math.PI * v), centre[1] + r * 0.05 + r * 0.75 * v], 5),
    ];
    const bosses = [[-0.45, 0.5], [0.45, 0.5], [-0.35, -0.45], [0.5, -0.4], [-0.85, 0.45]].map(([x, y]) => [centre[0] + x * r, centre[1] + y * r]);
    if (open)
        return [body, ...sutures.map(points => line(points, r * 0.09)), { type: "dots", points: bosses, radius: r * 0.07 }];
    if (stage !== "bud")
        body.veins = sutures;
    return [body, { type: "dots", points: bosses, radius: r * 0.05 }];
}
/** The motif of a woody cone: the cone on a short stalk, with sprigs of needles at its foot. */
function coneMotif(rng, s, stage, k) {
    if (k.cone === "berry" || k.cone === "aril")
        return fruitingSprig(rng, s, stage, k);
    const sprigs = [-1, 1].flatMap(sd => spray(rng, s * 0.55, sd * 0.1, k).map(shape => turnShape(shape, sd * 1.05)));
    const stalk = s * 0.05;
    const base = [0, stalk];
    let cone;
    switch (k.cone) {
        case "pine":
            cone = pineCone(rng, s, stage, base);
            break;
        case "round":
            cone = roundCone(rng, s, stage, base);
            break;
        default: cone = stage === "seed" && k.shatter ? shatteredCone(rng, s, k, base) : scaledCone(rng, s, k, stage, base);
    }
    return [...sprigs, line([[0, 0], base], s * 0.04), ...cone];
}
/** A ripe dark berry: cut all over but for a small highlight. */
function darkBerry(at, r) {
    const body = roundBody(circle(at, r, r, 18), at, r, HATCH * 0.42, 0.95);
    body.shadow = [body.shadow[0], circle([at[0] - r * 0.38, at[1] + r * 0.4], r * 0.26, r * 0.2, 10)];
    return body;
}
/** A berry-like cone: green, then dark when ripe, marked at its top with a three-rayed scar (genièvre, sabine). */
function coneBerry(at, r, stage) {
    const rr = r * (stage === "bud" ? 0.6 : stage === "bloom" ? 0.85 : 1);
    const body = stage === "seed" ? darkBerry(at, rr) : roundBody(circle(at, rr, rr, 18), at, rr, HATCH * 0.6, stage === "bud" ? 0.3 : 0.5);
    const top = [at[0] + rr * 0.1, at[1] + rr * 0.5];
    const scar = [90, 210, 330].map(a => line([top, add(top, [Math.cos(a * DEG), Math.sin(a * DEG) * 0.6], rr * 0.28)], rr * 0.06, false));
    return [body, ...scar];
}
/**
 * An aril hanging from its stalk: a single seed whose fleshy cup grows from the stalk end, a green collar
 * at first, a red cup open at the bottom on the dark seed when ripe (if).
 */
function aril(at, r, stage) {
    if (stage === "bud") {
        const top = [at[0], at[1] + r * 0.45];
        return [line([top, [at[0] + r * 0.22, at[1] + r * 0.72]], r * 0.05), line([top, [at[0] - r * 0.22, at[1] + r * 0.72]], r * 0.05),
            roundBody(circle(at, r * 0.3, r * 0.45, 14), at, r * 0.42, HATCH * 0.5, 0.35)];
    }
    if (stage === "bloom") {
        const seed = roundBody(circle(at, r * 0.36, r * 0.55, 14), at, r * 0.5, HATCH * 0.5, 0.45);
        const collar = profile(r * 0.36, v => r * 0.42 * (1 - 0.2 * v), at[1] + r * 0.18);
        return [seed, roundBody(collar, [at[0], at[1] + r * 0.36], r * 0.4, HATCH * 0.6, 0.5)];
    }
    const cup = roundBody(circle(at, r * 0.82, r, 20), at, r, HATCH, 0.6, [-0.6, 0.8], "accent");
    const mouth = [at[0], at[1] - r * 0.74];
    return [cup, { type: "solid", outline: circle(mouth, r * 0.32, r * 0.16, 12) }];
}
/** A sprig bearing berry-like cones or arils beneath its twig. */
function fruitingSprig(rng, s, stage, k) {
    const shapes = spray(rng, s, 0.08, k);
    const r = s * 0.12;
    const count = k.cone === "aril" ? 2 : k.hanging ? 4 : 3;
    for (let j = 0; j < count; j += 1) {
        const v = 0.3 + 0.55 * j / Math.max(1, count - 1);
        const p = [0.08 * s * v * v, s * v];
        const sd = j % 2 ? 1 : -1;
        let at = [p[0] + sd * r * 1.25, p[1] - r * 0.2];
        if (k.hanging || k.cone === "aril") {
            // On a short stalk that curls down from the twig.
            const end = [p[0] + sd * r * 1.3, p[1] - r * 1.1];
            shapes.push(line([p, [p[0] + sd * r * 0.9, p[1] - r * 0.1], end], r * 0.12));
            at = [end[0], end[1] - r * 0.85];
        }
        shapes.push(...(k.cone === "aril" ? aril(at, r, stage) : coneBerry(at, r, stage)));
    }
    return shapes;
}
const POSTURES = {
    // Layered horizontal branches, longest at the foot: the firs' and cedars' tiers.
    tiered: { count: 2, amplitude: 0.04, width: 0.13, tops: [0.93, 0.72], every: [0.8, 1.15], length: h => lerp(2.9, 1.1, h), angle: [64, 80], upright: 0 },
    // Short sprays held close to the trunk, a flame (cyprès).
    columnar: { count: 3, amplitude: 0.03, width: 0.1, tops: [0.93, 0.86, 0.74], every: [0.4, 0.6], length: h => lerp(1.9, 1.1, h), angle: [14, 26], upright: 1.3 },
    // Branches reaching out and up to a crown (pignon, genièvre, if).
    spreading: { count: 3, amplitude: 0.12, width: 0.12, tops: [0.9, 0.76, 0.62], every: [1.0, 1.5], length: h => lerp(1.8, 2.3, h), angle: [38, 60], upright: 0.4 },
    // Horizontal limbs with their shoots hanging (mélèze).
    drooping: { count: 2, amplitude: 0.06, width: 0.11, tops: [0.93, 0.7], every: [1.0, 1.4], length: h => lerp(2.6, 1.3, h), angle: [66, 82], upright: -0.3 },
    // A low sprawling shrub (sabine).
    low: { count: 3, amplitude: 0.2, width: 0.09, tops: [0.74, 0.62, 0.5], every: [0.9, 1.3], length: h => lerp(2.1, 1.5, h), angle: [40, 66], upright: 0.2 },
};
export const form = {
    id: "conifere",
    name: "conifère",
    doc: "Conifers: needled or scaled sprays, and woody cones that open or shatter, berry-like cones or red arils.",
    variants: {
        needles: { doc: "How the leaves sit: flat two-ranked needles, whorls of three, tufts on spurs, long paired needles in brushes, or scale leaves", default: "flat", values: ["flat", "whorl", "tufts", "paired", "scale"] },
        needle: { doc: "Needle length in centimetres at margin size", default: 0.24, range: [0.12, 1.2] },
        soft: { doc: "Soft, slightly curved needles rather than stiff straight ones", default: false, values: [true, false] },
        cord: { doc: "Thickness of a scale-leaved cord in centimetres (scale sprays only)", default: 0.032, range: [0.015, 0.045] },
        cone: { doc: "The cone: scaled barrel, small ovoid of loose scales, pine cone with diamond scale-ends, round shield cone, berry-like cone, or aril", default: "barrel", values: ["barrel", "ovoid", "pine", "round", "berry", "aril"] },
        coneLength: { doc: "Length of a scaled cone over its breadth", default: 2.4, range: [1.1, 3] },
        coneSize: { doc: "Cone size relative to the fir's", default: 1, range: [0.5, 1.6] },
        bracts: { doc: "Bract tips stick out between the cone scales (sapin)", default: false, values: [true, false] },
        hanging: { doc: "Cones or berry-like cones hang beneath the branch rather than standing on it", default: false, values: [true, false] },
        shatter: { doc: "Ripe cones fall apart on the branch, leaving their spike (sapin, cèdre), rather than opening whole", default: false, values: [true, false] },
        posture: { doc: "How the branches stand: tiered, columnar, spreading, drooping or low", default: "tiered", values: Object.keys(POSTURES) },
    },
    examples: [
        { name: "sapin", variant: { bracts: true, shatter: true } },
        { name: "cèdre", variant: { needles: "tufts", needle: 0.26, coneLength: 1.35, coneSize: 1.25, shatter: true } },
        { name: "mélèze", variant: { needles: "tufts", needle: 0.36, soft: true, cone: "ovoid", coneLength: 1.3, coneSize: 0.75, posture: "drooping" } },
        { name: "pignon", variant: { needles: "paired", needle: 0.95, cone: "pine", coneSize: 1.5, posture: "spreading" } },
        { name: "cyprès", variant: { needles: "scale", cord: 0.038, cone: "round", coneSize: 0.85, posture: "columnar" } },
        { name: "sabine", variant: { needles: "scale", cord: 0.022, cone: "berry", coneSize: 0.6, hanging: true, posture: "low" } },
        { name: "if", variant: { needle: 0.32, soft: true, cone: "aril", coneSize: 0.8, posture: "spreading" } },
        { name: "genièvre", variant: { needles: "whorl", needle: 0.34, cone: "berry", coneSize: 0.75, posture: "spreading" } },
    ],
    build(variant) {
        const k = {
            needles: textOf(variant, "needles"), needle: numberOf(variant, "needle"), soft: flagOf(variant, "soft"),
            cord: numberOf(variant, "cord"), cone: textOf(variant, "cone"),
            coneLength: numberOf(variant, "coneLength"), bracts: flagOf(variant, "bracts"), hanging: flagOf(variant, "hanging"),
            shatter: flagOf(variant, "shatter"), posture: textOf(variant, "posture"),
        };
        const posture = POSTURES[k.posture];
        const size = numberOf(variant, "coneSize");
        const leaf = (rng, length, bend) => spray(rng, length, bend, k);
        const draw = (rng, s, stage) => coneMotif(rng, s, stage, k);
        const long = ["barrel", "ovoid"].includes(k.cone) ? Math.max(1, k.coneLength / 2) : 1;
        return {
            id: "conifere",
            stems: { count: posture.count, amplitude: posture.amplitude, lambda: [5, 9], width: posture.width, tops: posture.tops },
            basal: null,
            nodes: { every: posture.every, length: posture.length, angle: posture.angle, below: 0.96 },
            leafProxy: 0.2,
            leaf,
            leaflet: leaf,
            terminal: { size: [1.0 * size, 1.2 * size], r: s => 0.5 * s * long, off: () => 0, draw },
            motifs: [
                { name: "cone", w: 2.2, smin: 0.8 * size, smax: 1.15 * size, max: 6, hard: true, layer: LAYER.bloom, upright: k.hanging ? -1.1 : 1.2, staged: true,
                    r: s => 0.42 * s * long, off: s => 0.42 * s * long, draw },
                { name: "spray", w: 2.4, smin: 0.9, smax: 1.7, max: 16, hard: true, layer: LAYER.leaf, upright: posture.upright,
                    r: s => 0.3 * s, off: s => 0.5 * s, draw: (rng, s) => spray(rng, s, rng.sym(0.2), k) },
            ],
        };
    },
};
