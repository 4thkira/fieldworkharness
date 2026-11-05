// What a motif is made of, independent of how it is painted. A primitive returns shapes in its own
// frame (origin at its base, axis along +y), already at its final size in centimetres; the engraving
// and the wash paint the same shapes differently.
import { blade, normals, sample, unit } from "./geometry.js";
/** A blade-shaped body (leaf, petal, bract, ligule) with its shadow and grain. */
export function bladeBody(spec, random) {
    const n = spec.samples ?? 28;
    const { outline, centre } = blade(spec.spine, n, spec.halfWidth, spec.halfWidth, spec.edge);
    const normal = normals(centre);
    const side = spec.shade;
    const shadow = [...centre, ...centre.slice().reverse().map((point, index) => {
            const k = centre.length - 1 - index;
            const [nx, ny] = normal[k];
            const reach = spec.halfWidth(k / n) * 1.6 + 0.05;
            return [point[0] + nx * side * reach, point[1] + ny * side * reach];
        })];
    const grain = [];
    const length = centre.reduce((sum, point, index) => index === 0 ? 0 : sum + Math.hypot(point[0] - centre[index - 1][0], point[1] - centre[index - 1][1]), 0);
    if (spec.grain === "across") {
        const cuts = Math.max(2, Math.floor(length / spec.spacing));
        for (let cut = 1; cut < cuts; cut += 1) {
            const v = cut / cuts;
            const [x, y] = spec.spine(v);
            const index = Math.round(v * n);
            const [nx, ny] = normal[index];
            const tangent = unit(normal[index][1], -normal[index][0]);
            // Cuts lean toward the tip, as a burin follows the leaf's growth.
            const dir = unit(nx * side + tangent[0] * 0.5, ny * side + tangent[1] * 0.5);
            const reach = spec.halfWidth(v) * 2 + 0.05;
            const bow = random.range(-0.15, 0.15) * reach;
            grain.push(sample(t => [x + dir[0] * reach * t - dir[1] * bow * t * (1 - t), y + dir[1] * reach * t + dir[0] * bow * t * (1 - t)], 3));
        }
    }
    else {
        const [low, high] = spec.reach ?? [0.3, 0.6];
        const widest = Math.max(...Array.from({ length: 11 }, (_, k) => spec.halfWidth(k / 10)));
        const lanes = Math.max(2, Math.floor(2 * widest / spec.spacing));
        for (let lane = 0; lane <= lanes; lane += 1) {
            const q = -0.92 + 1.84 * lane / lanes;
            const end = random.range(low, high) * (1 - 0.45 * Math.abs(q));
            grain.push(sample(v => {
                const [x, y] = spec.spine(v);
                const index = Math.min(n, Math.round(v * n));
                const [nx, ny] = normal[index];
                const half = spec.halfWidth(v) * q;
                return [x + nx * half, y + ny * half];
            }, 3, 0.02, Math.max(0.05, end)));
        }
    }
    const veins = [...(spec.midrib ? [centre.slice(1, Math.floor(n * 0.92))] : []), ...(spec.veins ?? [])];
    const body = { type: "body", outline, shadow: [shadow], grain, veins, weight: spec.weight };
    if (spec.tone)
        body.tone = spec.tone;
    return body;
}
/**
 * A rounded body (fruit, berry, closed bud) given by its outline: light from the upper left of its own
 * frame, a crescent of shadow opposite, cut with parallel diagonals.
 */
export function roundBody(outline, centre, radius, spacing, weight, light = [-0.6, 0.8], tone) {
    const [lx, ly] = unit(light[0], light[1]);
    const lit = sample(v => {
        const a = Math.PI * 2 * v;
        // The lit disc, pushed toward the light: what lies outside it is in shadow.
        return [centre[0] + lx * radius * 0.45 + Math.cos(a) * radius * 1.05, centre[1] + ly * radius * 0.45 + Math.sin(a) * radius * 1.05];
    }, 32);
    // Shadow = a large frame with the lit disc cut out of it (even-odd).
    const frame = [[centre[0] - radius * 3, centre[1] - radius * 3], [centre[0] + radius * 3, centre[1] - radius * 3],
        [centre[0] + radius * 3, centre[1] + radius * 3], [centre[0] - radius * 3, centre[1] + radius * 3]];
    const grain = [];
    const angle = Math.atan2(ly, lx) + Math.PI / 2 + 0.35;
    const dx = Math.cos(angle), dy = Math.sin(angle);
    const cuts = Math.floor(radius * 4 / spacing);
    for (let cut = -cuts / 2; cut <= cuts / 2; cut += 1) {
        const ox = centre[0] - dy * cut * spacing, oy = centre[1] + dx * cut * spacing;
        grain.push([[ox - dx * radius * 1.6, oy - dy * radius * 1.6], [ox + dx * radius * 1.6, oy + dy * radius * 1.6]]);
    }
    const body = { type: "body", outline, shadow: [frame, lit], grain, veins: [], weight };
    if (tone)
        body.tone = tone;
    return body;
}
