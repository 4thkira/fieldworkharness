// The free space of a garden, after florilegium's grow.lua (Kevin Raymond, MIT): points on a lattice
// over the regions, each holding the radius of the largest disc there that stays inside the regions
// and clear of every proxy placed so far. A proxy only visits the lattice cells near it.
export const GRID = 0.2;
const inside = (rect, x, y) => x > rect[0] && x < rect[2] && y > rect[1] && y < rect[3];
/** Distance from (x, y) to the union's outer border; edges shared with another region count as open. */
function border(rects, x, y) {
    let best = -1;
    for (const rect of rects) {
        if (!inside(rect, x, y))
            continue;
        let nearest = Infinity;
        const edges = [
            [x - rect[0], rect[0] - 0.05, y], [rect[2] - x, rect[2] + 0.05, y],
            [y - rect[1], x, rect[1] - 0.05], [rect[3] - y, x, rect[3] + 0.05],
        ];
        for (const [gap, ox, oy] of edges) {
            const open = rects.some(other => other !== rect && inside(other, ox, oy));
            if (!open && gap < nearest)
                nearest = gap;
        }
        best = Math.max(best, nearest);
    }
    return best;
}
export function createField(rects) {
    const xs = [], ys = [], frees = [];
    const lattice = new Map();
    const key = (ix, iy) => ix * 100_000 + iy;
    for (const rect of rects) {
        for (let ix = Math.floor(rect[0] / GRID); ix <= Math.floor(rect[2] / GRID); ix += 1) {
            for (let iy = Math.floor(rect[1] / GRID); iy <= Math.floor(rect[3] / GRID); iy += 1) {
                const k = key(ix, iy);
                if (lattice.has(k))
                    continue;
                const x = (ix + 0.5) * GRID, y = (iy + 0.5) * GRID;
                const room = border(rects, x, y);
                if (room <= 0)
                    continue;
                lattice.set(k, xs.length);
                xs.push(x);
                ys.push(y);
                frees.push(room);
            }
        }
    }
    const x = Float64Array.from(xs), y = Float64Array.from(ys), free = Float64Array.from(frees);
    const maxFree = frees.reduce((best, value) => Math.max(best, value), 0);
    const eachNear = (cx, cy, reach, visit) => {
        for (let ix = Math.floor((cx - reach) / GRID); ix <= Math.floor((cx + reach) / GRID); ix += 1) {
            for (let iy = Math.floor((cy - reach) / GRID); iy <= Math.floor((cy + reach) / GRID); iy += 1) {
                const index = lattice.get(key(ix, iy));
                if (index !== undefined)
                    visit(index);
            }
        }
    };
    return {
        x, y, free, eachNear,
        disc(cx, cy, radius, k = 0.85) {
            eachNear(cx, cy, radius * k + maxFree, index => {
                const gap = Math.hypot(x[index] - cx, y[index] - cy) - k * radius;
                if (gap < free[index])
                    free[index] = gap;
            });
        },
        block([x0, y0, x1, y1]) {
            eachNear((x0 + x1) / 2, (y0 + y1) / 2, Math.max(x1 - x0, y1 - y0) / 2 + maxFree, index => {
                const gap = Math.hypot(Math.max(x0 - x[index], 0, x[index] - x1), Math.max(y0 - y[index], 0, y[index] - y1));
                if (gap < free[index])
                    free[index] = gap;
            });
        },
        freeAt(px, py) {
            const index = lattice.get(key(Math.floor(px / GRID), Math.floor(py / GRID)));
            return index === undefined ? -1 : free[index];
        },
    };
}
