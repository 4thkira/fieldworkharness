// Flat-topped clusters of small flowers: a corymb branching to a dome of five-petalled florets that become
// berries (alisier, sureau), or an umbel whose rays spring from one point to umbellets of tiny florets
// that become ribbed seeds (persil, fenouil, angélique).
import { LAYER, textOf } from "../form.js";
import { lerp, sample } from "../geometry.js";
import { berry, circle, HATCH, line, lobedLeaf, pinnateLeaf, simpleLeaf } from "../kit.js";
import { bladeBody, roundBody } from "../shapes.js";
function floret(rng, at, r, stage, tilt, fruit) {
    if (stage === "bud")
        return [roundBody(circle(at, r * 0.42, r * 0.42, 12), at, r * 0.42, HATCH * 0.6, 0.35)];
    if (stage === "seed") {
        if (fruit === "seeds") {
            const seed = sample(v => [at[0] + Math.cos(v * Math.PI * 2) * r * 0.22, at[1] + Math.sin(v * Math.PI * 2) * r * 0.42], 12).slice(0, -1);
            return [roundBody(seed, at, r * 0.35, HATCH * 0.5, 0.6), line([[at[0], at[1] - r * 0.4], [at[0], at[1] + r * 0.4]], r * 0.04, false)];
        }
        const rr = r * 0.55;
        const calyx = Array.from({ length: 5 }, (_, k) => {
            const a = k / 5 * Math.PI * 2;
            return line([[at[0], at[1] + rr * 0.55], [at[0] + Math.cos(a) * rr * 0.28, at[1] + rr * 0.55 + Math.sin(a) * rr * 0.2]], r * 0.04, false);
        });
        return [berry(at, rr, 0.85), ...calyx];
    }
    const petals = [];
    const start = rng.range(0, Math.PI * 2);
    for (let k = 0; k < 5; k += 1) {
        const angle = start + k / 5 * Math.PI * 2;
        const spine = (v) => [at[0] + Math.cos(angle) * r * v, at[1] + Math.sin(angle) * r * v * tilt];
        petals.push(bladeBody({ spine, halfWidth: v => r * 0.5 * Math.sin(Math.PI * Math.min(1, v * 0.85 + 0.15)) ** 0.6,
            shade: 1, spacing: HATCH * 0.6, grain: "along", reach: [0.12, 0.3], weight: 0.2, samples: 10 }, rng));
    }
    const stamens = { type: "dots", points: Array.from({ length: 5 }, (_, k) => [at[0] + Math.cos(k * 1.26) * r * 0.16, at[1] + Math.sin(k * 1.26) * r * 0.16 * tilt]), radius: r * 0.07, tone: "accent" };
    return [...petals, stamens];
}
function corymb(rng, s, stage, fruit) {
    const count = rng.int(9, 14);
    const shapes = [];
    const nodes = [[0, s * 0.3], [-s * 0.12, s * 0.42], [s * 0.13, s * 0.4]];
    shapes.push(line([[0, 0], nodes[0]], s * 0.022));
    shapes.push(line([nodes[0], nodes[1]], s * 0.016), line([nodes[0], nodes[2]], s * 0.016));
    const florets = [];
    for (let k = 0; k < count; k += 1) {
        const x = (k / (count - 1) * 2 - 1) * s * 0.48 + rng.sym(0.04 * s);
        const y = s * 0.6 + s * 0.1 * (1 - (x / (s * 0.5)) ** 2) + rng.sym(0.06 * s);
        const node = x < -s * 0.15 ? nodes[1] : x > s * 0.15 ? nodes[2] : nodes[0];
        florets.push({ at: [x, y], node });
    }
    for (const { at, node } of florets)
        shapes.push(line([node, [lerp(node[0], at[0], 0.4), lerp(node[1], at[1], 0.75)], at], s * 0.01));
    const size = s * (stage === "seed" ? 0.085 : 0.095);
    for (const { at } of florets.sort((a, b) => b.at[1] - a.at[1]))
        shapes.push(...floret(rng, at, size, stage, rng.range(0.6, 1), fruit));
    return shapes;
}
/** A compound umbel: rays from one point, each ending in a small umbel of tiny florets or seeds. */
function umbel(rng, s, stage) {
    const shapes = [];
    const hub = [0, s * 0.32];
    shapes.push(line([[0, 0], hub], s * 0.022));
    const rays = rng.int(8, 13);
    const spread = stage === "bud" ? 0.35 : stage === "seed" ? 0.85 : 1;
    const tips = [];
    for (let k = 0; k < rays; k += 1) {
        const u = (k / (rays - 1)) * 2 - 1;
        const a = Math.PI / 2 - u * 1.05 * spread;
        const len = s * 0.42 * (1 - 0.12 * Math.abs(u)) * rng.range(0.94, 1.06);
        const tip = [hub[0] + Math.cos(a) * len, hub[1] + Math.sin(a) * len * 0.8 + s * 0.04 * (1 - u * u)];
        tips.push(tip);
        shapes.push(line(sample(v => [lerp(hub[0], tip[0], v), lerp(hub[1], tip[1], v) + s * 0.03 * Math.sin(Math.PI * v)], 4), s * 0.009));
    }
    // Bracts at the hub.
    for (let k = 0; k < 5; k += 1) {
        const a = -Math.PI / 2 + (k - 2) * 0.45;
        shapes.push(line([hub, [hub[0] + Math.cos(a) * s * 0.06, hub[1] + Math.sin(a) * s * 0.06]], s * 0.008));
    }
    for (const tip of tips) {
        const small = rng.int(5, 8);
        const florets = [];
        for (let k = 0; k < small; k += 1) {
            const u = (k / (small - 1)) * 2 - 1;
            const a = Math.PI / 2 - u * 1.1 * spread;
            const end = [tip[0] + Math.cos(a) * s * 0.075, tip[1] + Math.sin(a) * s * 0.06];
            shapes.push(line([tip, end], s * 0.005, false));
            florets.push(end);
        }
        if (stage === "seed") {
            // Hundreds of seeds hang in a ripe umbel: each is a plain oval with one rib, which reads at margin
            // size and keeps the garden light, where a hatched body per seed would not.
            for (const at of florets) {
                const seed = sample(v => [at[0] + Math.cos(v * Math.PI * 2) * s * 0.012, at[1] + Math.sin(v * Math.PI * 2) * s * 0.024], 8).slice(0, -1);
                shapes.push({ type: "body", outline: seed, shadow: [], grain: [], veins: [[[at[0], at[1] - s * 0.018], [at[0], at[1] + s * 0.018]]], weight: 0.5 });
            }
        }
        else {
            shapes.push({ type: "dots", points: florets, radius: s * (stage === "bud" ? 0.008 : 0.013) });
            if (stage === "bloom")
                shapes.push({ type: "dots", points: [tip], radius: s * 0.006, tone: "accent" });
        }
    }
    return shapes;
}
function leafOf(kind) {
    switch (kind) {
        case "pinnate": return (rng, length, bend) => pinnateLeaf(rng, length, bend, 3, 0.36);
        case "divided": return (rng, length, bend) => pinnateLeaf(rng, length, bend, 5, 0.3, true);
        case "simple": return (rng, length, bend) => simpleLeaf(rng, length, bend, 0.3);
        default: return (rng, length, bend) => lobedLeaf(rng, length, bend);
    }
}
export const form = {
    id: "ombelle-corymbe",
    name: "ombelle et corymbe",
    doc: "Flat-topped clusters: a branched corymb of five-petalled florets, or a compound umbel of tiny florets.",
    variants: {
        mode: { doc: "A branched corymb or rays from one point", default: "corymb", values: ["corymb", "umbel"] },
        leaf: { doc: "Leaf kind", default: "lobed", values: ["lobed", "pinnate", "divided", "simple"] },
        fruit: { doc: "What a corymb's florets become: berries or dry seeds (umbels always seed)", default: "berries", values: ["berries", "seeds"] },
    },
    examples: [
        { name: "alisier", variant: {} },
        { name: "sureau", variant: { leaf: "pinnate" } },
        { name: "persil", variant: { mode: "umbel", leaf: "divided" } },
        { name: "angélique", variant: { mode: "umbel", leaf: "pinnate" } },
    ],
    build(variant) {
        const mode = textOf(variant, "mode"), fruit = textOf(variant, "fruit");
        const draw = (rng, s, stage) => mode === "umbel" ? umbel(rng, s, stage) : corymb(rng, s, stage, fruit);
        const leaf = leafOf(textOf(variant, "leaf"));
        const herb = mode === "umbel";
        return {
            id: "ombelle-corymbe",
            stems: { count: 3, amplitude: herb ? 0.1 : 0.14, lambda: [5, 8], width: herb ? 0.06 : 0.075, tops: [0.92, 0.68, 0.46] },
            basal: herb ? { count: [3, 5], length: [2.2, 3.4] } : null,
            nodes: { every: [1.5, 2.3], length: height => lerp(2.2, 1.4, height), angle: [35, 60], below: herb ? 0.75 : 1 },
            leafProxy: 0.3,
            leaf,
            leaflet: (rng, length, bend) => simpleLeaf(rng, length, bend),
            terminal: { size: [1.4, 1.6], r: s => 0.58 * s, off: () => 0, draw },
            motifs: [
                { name: "bloom", w: 3, smin: 0.9, smax: 1.35, max: 5, hard: true, layer: LAYER.bloom, upright: 0.7, staged: true,
                    r: s => 0.55 * s, off: s => 0.5 * s, draw },
                { name: "leaf", w: 2.2, smin: 0.9, smax: 1.6, max: 8, layer: LAYER.leaf, upright: 0.3,
                    r: s => 0.33 * s, off: s => 0.5 * s, draw: (rng, s) => leaf(rng, s, rng.sym(0.25)) },
                { name: "leaflet", w: 1.2, smin: 0.6, smax: 0.9, max: 6, layer: LAYER.leaf, upright: 0.2,
                    r: s => 0.3 * s, off: s => 0.5 * s, draw: (rng, s) => simpleLeaf(rng, s, rng.sym(0.2)) },
            ],
        };
    },
};
