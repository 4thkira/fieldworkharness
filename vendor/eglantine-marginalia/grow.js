// The garden's growth, after the grown composition of Kevin Raymond's florilegium (MIT; its notice is in
// florilegium-LICENSE.txt beside this file), which follows
// Wong, Zongker & Salesin, "Computer-Generated Floral Ornament" (SIGGRAPH 1998). Main stems sway up
// the column as smooth noise of their height and leaves hang at their nodes; then, repeatedly, the
// largest free hole within reach of a stem gets a motif that fits it, on a branch from the nearest
// stem point. Big holes go first, so blooms land early and leaves fill the gaps.
//
// The layout is fixed by the seed. Time only reveals it: every item carries the moment of the day
// (0 at its start, 1 at its end) when it appears, and a staged motif buds, opens and goes to seed.
import { createField } from "./field.js";
import { LAYER, resolveVariant } from "./form.js";
import { plantForm } from "./registry.js";
import { arcLength, bezier3, clamp, degrees, distance, lerp, RAD, sample, smoothstep, unit } from "./geometry.js";
import { createRng, fbm1 } from "./random.js";
/** The column the forms are drawn for, in centimetres: a margin beside a page of text. */
export const COLUMN = { width: 6, height: 22 };
const REACH = 3.0;
/** The top of the column stays open sky. */
const SKY = 0.2;
const SMALLEST = 0.36;
const FILLMIN = 0.26;
const FILLERS = 12;
const STEM_PHASE = 0.3;
const BUD_SPAN = 0.1;
/** At fullness 0 a garden already shows this share of its leaves, so the plant is never bare. */
const FOLIAGE_FLOOR = 0.3;
export function growGarden(spec) {
    const form = typeof spec.form === "string" ? plantForm(spec.form, spec.variant) : spec.form.build(resolveVariant(spec.form, spec.variant));
    const formId = typeof spec.form === "string" ? spec.form : spec.form.id;
    const { width: W = COLUMN.width, height: H = COLUMN.height } = spec;
    const G = H * (1 - SKY);
    const root = createRng(Math.imul(spec.seed, 7919) + 13);
    const layout = root.fork();
    const season = createRng(Math.imul(spec.seed, 7919) + 211);
    const items = [];
    let order = 0;
    const column = [0.15, 0.3, W - 0.15, G];
    const field = createField([column]);
    const nearestStemDistance = new Float64Array(field.x.length).fill(Infinity);
    const stemPoints = [];
    const addStemPoints = (points, w0, w1, every = 1) => {
        for (let index = 0; index < points.length; index += every) {
            const a = points[Math.max(0, index - 1)], b = points[Math.min(points.length - 1, index + 1)];
            const [tx, ty] = unit(b[0] - a[0], b[1] - a[1]);
            const p = points[index];
            stemPoints.push({ x: p[0], y: p[1], tx, ty, w: lerp(w0, w1, index / Math.max(1, points.length - 1)) });
            field.eachNear(p[0], p[1], REACH, cell => {
                const d = Math.hypot(field.x[cell] - p[0], field.y[cell] - p[1]);
                if (d < nearestStemDistance[cell])
                    nearestStemDistance[cell] = d;
            });
        }
    };
    const nearestStem = (x, y) => {
        let best = Infinity, found = stemPoints[0];
        for (const point of stemPoints) {
            const d = Math.hypot(point.x - x, point.y - y);
            if (d < best) {
                best = d;
                found = point;
            }
        }
        return found;
    };
    const stem = (points, w0, w1, born, grown, proxy = 0.1, main = false) => {
        const item = { kind: "stem", order: order++, layer: LAYER.stem, main, points, w0, w1, born, grown };
        items.push(item);
        for (let index = 0; index < points.length; index += 2)
            field.disc(points[index][0], points[index][1], proxy, 1);
        return item;
    };
    const motif = (name, at, angle, size, layer, born, staged, draw) => {
        const item = { kind: "motif", order: order++, layer, name, at, angle, size, seed: Math.floor(layout.u() * 4294967295),
            born, staged, seedAt: 2, leafRank: null, draw };
        items.push(item);
        return item;
    };
    // ---------------------------------------------------------------- 1. the foot, then the main stems out of it
    const foot = form.foot ?? null;
    if (foot)
        for (const [x0, y0, x1, y1] of foot.room)
            field.block([x0 * W, y0, x1 * W, y1]);
    const rootAt = foot ? [W * foot.crown[0], foot.crown[1]] : [W * layout.range(0.22, 0.3), 0.75];
    const centre = W * 0.47, amplitude = W * form.stems.amplitude * 2.2;
    const mains = [];
    const mainItems = [];
    const tops = form.stems.tops.map((top, index) => G * (index === 0 ? top : top * layout.range(0.92, 1.06)));
    for (let k = 0; k < form.stems.count; k += 1) {
        const sway = fbm1(layout, 2);
        const phase = layout.range(0, 10), lambda = layout.range(...form.stems.lambda);
        const x0 = rootAt[0] + (k - 1) * 0.2;
        const points = [];
        for (let y = rootAt[1]; y <= tops[k]; y += 0.25) {
            let x = centre + amplitude * sway(y / lambda + phase) + (k - 1) * 0.4;
            x = lerp(x0, x, smoothstep(0, 4, y - rootAt[1]));
            points.push([clamp(x, 0.8, W - 0.8), y]);
        }
        mains.push(points);
    }
    const longest = Math.max(...mains.map(points => arcLength(points).total));
    mains.forEach((points, k) => {
        const w0 = form.stems.width * (k === 0 ? 1 : 0.8);
        const grown = STEM_PHASE * arcLength(points).total / longest;
        mainItems.push(stem(points, w0, Math.max(0.025, form.stems.width * 0.3), 0, grown, 0.1, true));
        addStemPoints(points, w0, 0.028);
    });
    // On bare ground the root curls into a scroll at the corner.
    if (!foot || foot.scroll) {
        const turns = layout.range(1.2, 1.6);
        const scroll = sample(t => {
            const a = Math.PI * 0.5 + t * turns * 2 * Math.PI;
            const r = 0.5 * (1 - 0.85 * t) ** 1.3;
            return [rootAt[0] - 0.5 - r * Math.cos(a), rootAt[1] + 0.05 + r * Math.sin(a)];
        }, 40);
        stem(scroll, form.stems.width * 0.7, 0.012, 0, 0.06);
    }
    // ---------------------------------------------------------------- 2. terminal blooms
    // A foot with no stems above it is the whole garden, and its top is the highest point.
    let crown = foot && form.stems.count === 0 ? [rootAt[0], Math.max(rootAt[1], ...foot.room.map(rect => rect[3]))] : [W / 2, 0];
    mains.forEach((points, k) => {
        const tip = points[points.length - 1], before = points[Math.max(0, points.length - 3)];
        const [hx, hy] = unit(tip[0] - before[0], tip[1] - before[1]);
        const size = k === 0 ? Math.min(form.terminal.size[1], W * 0.27) : layout.range(...form.terminal.size) * 0.85;
        const at = [tip[0] + hx * 0.05, tip[1] + hy * 0.05];
        motif("terminal", at, k === 0 ? 90 : degrees(hx, hy), size, LAYER.bloom, mainItems[k].grown, true, form.terminal.draw);
        const r = form.terminal.r(size);
        field.disc(at[0] + hx * r * 0.6, at[1] + hy * r * 0.6, r * 1.1, 0.85);
        if (at[1] + r * 1.4 > crown[1])
            crown = [at[0], Math.min(H, at[1] + r * 1.4)];
    });
    // ---------------------------------------------------------------- 2b. the day's guest, before the leaves, so they grow around it
    let guest = null;
    if (spec.guest) {
        // Its own stream: the guest's choices never move the rest of the layout's draws.
        const visit = createRng(Math.imul(spec.seed, 7919) + 101);
        const { kind, aspect, size } = spec.guest;
        const wantedWidth = kind === "visitor" ? size * aspect : size, wantedHeight = kind === "visitor" ? size : size / aspect;
        const tilt = kind === "rest" ? 7 : 4;
        const fitAngle = Math.min(tilt * RAD, Math.atan2(wantedHeight, wantedWidth));
        const span = wantedWidth * Math.cos(fitAngle) + wantedHeight * Math.sin(fitAngle);
        const fit = Math.min(1, (W - 0.3) / span);
        const width = wantedWidth * fit, height = wantedHeight * fit, halfSpan = span * fit / 2;
        const reach = Math.max(width, height) * 0.5;
        let best = -Infinity;
        // A foot that spans the column, such as a bed of strata, is the ground the guest stands or lies on.
        const floor = foot ? Math.max(0, ...foot.room.filter(rect => rect[2] - rect[0] > 0.5).map(rect => rect[3])) : 0;
        for (let attempt = 0; attempt < 40; attempt += 1) {
            let at, facing;
            let stemX = null;
            if (kind === "visitor" && mains.length > 0) {
                const points = visit.pick(mains);
                const p = points[Math.floor(points.length * visit.range(0.25, 0.7))];
                const side = visit.chance(0.5) ? 1 : -1;
                at = [p[0] + side * (width / 2 + 0.12), p[1] + height * 0.15];
                facing = side > 0 ? -1 : 1;
                stemX = p[0];
            }
            else if (kind === "visitor") {
                at = [visit.range(width / 2 + 0.3, W - width / 2 - 0.3), floor + height / 2 + visit.range(0.1, 0.6)];
                facing = visit.chance(0.5) ? 1 : -1;
            }
            else {
                at = [visit.range(width / 2 + 0.3, W - width / 2 - 0.3), floor + visit.range(height / 2 + 0.45, 2.2)];
                facing = visit.chance(0.5) ? 1 : -1;
            }
            at[0] = clamp(at[0], halfSpan + 0.15, W - halfSpan - 0.15);
            if (stemX !== null && at[0] !== stemX)
                facing = at[0] > stemX ? -1 : 1;
            const room = Math.min(field.freeAt(at[0], at[1]), field.freeAt(at[0] - width * 0.35, at[1]), field.freeAt(at[0] + width * 0.35, at[1]));
            if (room > best) {
                best = room;
                guest = { kind, at, width, height, angle: visit.sym(tilt), facing, born: kind === "rest" ? 0 : 0.2 };
            }
        }
        if (guest)
            for (const f of [-0.3, 0, 0.3])
                field.disc(guest.at[0] + guest.width * f, guest.at[1], Math.max(guest.height * 0.6, reach * 0.55), 1);
    }
    // ---------------------------------------------------------------- 3. leaves: a basal rosette, then the nodes
    if (form.basal) {
        const count = layout.int(...form.basal.count);
        for (let k = 0; k < count; k += 1) {
            const spread = (k / Math.max(1, count - 1)) * 2 - 1;
            const angle = 90 + spread * 48 + layout.sym(6);
            const length = layout.range(...form.basal.length) * (1 - 0.35 * Math.abs(spread));
            const base = [rootAt[0] + spread * 0.25, rootAt[1] - 0.05];
            const bend = -spread * layout.range(0.08, 0.2);
            motif("basal", base, angle, length, LAYER.leaf, 0.01 + 0.08 * (k / count), false, (rng, size) => form.leaf(rng, size, bend));
            for (const f of [0.3, 0.55, 0.8])
                field.disc(base[0] + Math.cos(angle * RAD) * length * f, base[1] + Math.sin(angle * RAD) * length * f, 0.12 * length, 0.85);
        }
    }
    const leafProxy = form.leafProxy;
    mains.forEach((points, k) => {
        const item = mainItems[k];
        const { at: lengths, total } = arcLength(points);
        let next = layout.range(0.8, 1.4), sideOf = layout.chance(0.5) ? 1 : -1;
        for (let index = 2; index < points.length - 4; index += 1) {
            if (lengths[index] < next)
                continue;
            next += layout.range(...form.nodes.every);
            sideOf = -sideOf;
            const p = points[index];
            if (p[1] / G > form.nodes.below)
                continue;
            const [tx, ty] = unit(points[index + 1][0] - points[index - 1][0], points[index + 1][1] - points[index - 1][1]);
            const angle = degrees(tx, ty) + sideOf * layout.range(...form.nodes.angle);
            const ux = Math.cos(angle * RAD), uy = Math.sin(angle * RAD);
            let length = form.nodes.length(p[1] / G) * layout.range(0.85, 1.1);
            let fits = false;
            for (let attempt = 0; attempt < 3; attempt += 1) {
                if (field.freeAt(p[0] + ux * length * 0.55, p[1] + uy * length * 0.55) >= leafProxy * length) {
                    fits = true;
                    break;
                }
                length *= 0.75;
            }
            if (!fits || length < 0.6)
                continue;
            const bend = sideOf * layout.range(0.05, 0.25);
            const born = lerp(item.born, item.grown, lengths[index] / total) + 0.005;
            motif("leaf", p, angle, length, LAYER.leaf, born, false, (rng, size) => form.leaf(rng, size, bend));
            for (const f of [0.3, 0.55, 0.8])
                field.disc(p[0] + ux * length * f, p[1] + uy * length * f, leafProxy * length, 0.85);
        }
    });
    // ---------------------------------------------------------------- 4. branches to the largest holes
    const counts = new Map(form.motifs.map(row => [row.name, 0]));
    const branchItems = [];
    for (let round = 0; round < 300; round += 1) {
        let best = -1, cell = -1;
        for (let index = 0; index < field.x.length; index += 1) {
            if (nearestStemDistance[index] > REACH)
                continue;
            const value = field.free[index] * layout.range(0.85, 1.15);
            if (value > best) {
                best = value;
                cell = index;
            }
        }
        if (cell < 0 || field.free[cell] < SMALLEST)
            break;
        const free = field.free[cell], px = field.x[cell], py = field.y[cell];
        const eligible = form.motifs.filter(row => row.r(row.smin) <= free * 1.05 && (!row.hard || counts.get(row.name) < row.max));
        if (eligible.length === 0) {
            field.free[cell] = 0;
            continue;
        }
        const weights = eligible.map(row => row.w / (1 + counts.get(row.name) / Math.max(1, row.max)));
        let pick = eligible[eligible.length - 1], roll = layout.u() * weights.reduce((sum, w) => sum + w, 0);
        for (const [index, row] of eligible.entries()) {
            roll -= weights[index];
            if (roll <= 0) {
                pick = row;
                break;
            }
        }
        let size = pick.smax;
        if (pick.r(size) > free * 0.95) {
            let low = pick.smin, high = size;
            for (let step = 0; step < 20; step += 1) {
                const mid = (low + high) / 2;
                if (pick.r(mid) > free * 0.95)
                    high = mid;
                else
                    low = mid;
            }
            size = low;
        }
        const from = nearestStem(px, py);
        const [dx, dy] = unit(px - from.x, py - from.y);
        const [ax, ay] = unit(dx, dy + (pick.upright ?? 0));
        const origin = [px - ax * pick.off(size), py - ay * pick.off(size)];
        let branch = null;
        const leaves = [];
        if (distance(origin, [from.x, from.y]) > 0.12) {
            const path = branchPath(layout, from, origin, [ax, ay]);
            const w = Math.min(from.w * 0.7, 0.045);
            branch = stem(path, w, Math.max(0.012, w * 0.45), 0, 0, 0.07);
            addStemPoints(path, w, Math.max(0.012, w * 0.45), 2);
            const reach = distance(origin, [from.x, from.y]);
            if (reach > 1.5) {
                const count = reach > 2.5 ? 2 : 1;
                for (let j = 1; j <= count; j += 1) {
                    const index = Math.floor(path.length * (0.25 + 0.3 * j / count));
                    const p = path[index], q = path[Math.min(path.length - 1, index + 1)];
                    const angle = degrees(q[0] - p[0], q[1] - p[1]) + (j % 2 === 0 ? 1 : -1) * layout.range(40, 60);
                    const length = layout.range(0.5, 0.8);
                    const bend = layout.sym(0.2);
                    leaves.push(motif("leaflet", p, angle, length, LAYER.leaf, 0, false, (rng, s) => form.leaflet(rng, s, bend)));
                    field.disc(p[0] + Math.cos(angle * RAD) * length * 0.5, p[1] + Math.sin(angle * RAD) * length * 0.5, 0.25 * length, 0.7);
                }
            }
        }
        const placed = motif(pick.name, origin, degrees(ax, ay), size, pick.layer, 0, pick.staged ?? false, pick.draw);
        branchItems.push({ stem: branch, leaves, motif: placed });
        counts.set(pick.name, counts.get(pick.name) + 1);
        field.disc(px, py, pick.r(size), 0.85);
    }
    // Big holes first, slowly; the last branches come quickly.
    branchItems.forEach((branch, index) => {
        const born = 0.28 + 0.55 * (index / Math.max(1, branchItems.length - 1)) ** 0.75;
        if (branch.stem) {
            branch.stem.born = born;
            branch.stem.grown = born + 0.03;
        }
        for (const leaf of branch.leaves)
            leaf.born = born + 0.02;
        branch.motif.born = born + (branch.stem ? 0.03 : 0);
    });
    // ---------------------------------------------------------------- 5. filler: small leaves tucked in near the stems
    const fillers = [];
    for (let round = 0; round < FILLERS; round += 1) {
        let best = -1, cell = -1;
        for (let index = 0; index < field.x.length; index += 1) {
            if (nearestStemDistance[index] > 0.75)
                continue;
            if (field.free[index] > best) {
                best = field.free[index];
                cell = index;
            }
        }
        if (cell < 0 || best < FILLMIN)
            break;
        const px = field.x[cell], py = field.y[cell];
        const from = nearestStem(px, py);
        const [dx, dy] = unit(px - from.x, py - from.y);
        const length = clamp(best * 2.2, 0.35, 0.8);
        const bend = layout.sym(0.2);
        fillers.push(motif("filler", [from.x, from.y], degrees(dx, dy + 0.3), length, LAYER.leaf, 0, false, (rng, s) => form.leaflet(rng, s, bend)));
        field.disc(px, py, best, 0.9);
    }
    fillers.forEach((item, index) => { item.born = 0.84 + 0.1 * index / Math.max(1, fillers.length); });
    // ---------------------------------------------------------------- 6. seasons: the oldest blooms go to seed first, near the end
    const staged = items.filter((item) => item.kind === "motif" && item.staged).sort((a, b) => a.born - b.born);
    staged.forEach((item, rank) => {
        const late = 0.8 + 0.17 * (rank / Math.max(1, staged.length - 1)) + season.sym(0.02);
        item.seedAt = Math.max(item.born + BUD_SPAN * 1.5, late);
    });
    // ---------------------------------------------------------------- 7. foliage comes in as the day fills, lowest and oldest first
    const foliage = items.filter((item) => item.kind === "motif" && item.layer === LAYER.leaf)
        .sort((a, b) => a.born - b.born || a.order - b.order);
    foliage.forEach((item, rank) => { item.leafRank = rank / foliage.length; });
    return {
        form: formId, seed: spec.seed, width: W, height: H, items, mains, crown, guest,
        foot: foot ? { seed: Math.imul(spec.seed, 7919) + 307, draw: foot.draw } : null,
        stemInk: form.stemInk ?? null,
    };
}
/** A branch leaving its stem tangentially and arriving along the motif's axis. */
function branchPath(rng, from, to, axis) {
    const dx = to[0] - from.x, dy = to[1] - from.y;
    const d = Math.hypot(dx, dy);
    let tx = from.tx, ty = from.ty;
    if (tx * dx + ty * dy < -0.3 * d) {
        tx = -tx;
        ty = -ty;
    }
    const turn = (tx * dy - ty * dx > 0 ? 1 : -1) * rng.range(28, 48) * RAD;
    const ox = tx * Math.cos(turn) - ty * Math.sin(turn), oy = tx * Math.sin(turn) + ty * Math.cos(turn);
    return sample(bezier3([from.x, from.y], [from.x + ox * d * 0.45, from.y + oy * d * 0.45], [to[0] - axis[0] * d * 0.4, to[1] - axis[1] * d * 0.4], to), Math.max(6, Math.floor(d / 0.15)));
}
/** The share of the foliage a garden shows at `fullness` (0 empty, 1 full). */
export const foliageShown = (fullness) => FOLIAGE_FLOOR + (1 - FOLIAGE_FLOOR) * clamp(fullness, 0, 1);
/**
 * What a motif shows at moment `t` of the day and its `fullness`, or null when it is not there.
 * Time brings the stems and the blooms' season; fullness brings the leaves, so a quiet day stays sparse.
 */
export function stageAt(item, t, fullness) {
    if (t < item.born)
        return null;
    if (item.leafRank !== null && item.leafRank >= foliageShown(fullness))
        return null;
    if (!item.staged)
        return "bloom";
    if (t >= item.seedAt)
        return "seed";
    return t < item.born + BUD_SPAN ? "bud" : "bloom";
}
/** How much of a stem has grown at moment `t`, from 0 to 1. */
export function stemShown(item, t) {
    if (t < item.born)
        return 0;
    if (item.grown <= item.born)
        return 1;
    return clamp((t - item.born) / (item.grown - item.born), 0, 1);
}
