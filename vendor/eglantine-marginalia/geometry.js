// Plane geometry for the margin garden, after florilegium's ink.lua (Kevin Raymond, MIT). Units are
// centimetres with y pointing up; the renderer flips the page once at the end.
export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
export function smoothstep(edge0, edge1, x) {
    const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
}
export const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export function unit(x, y) {
    const length = Math.hypot(x, y);
    return length < 1e-9 ? [0, 1] : [x / length, y / length];
}
export const degrees = (x, y) => Math.atan2(y, x) * 180 / Math.PI;
export const RAD = Math.PI / 180;
/** Left-hand unit normals of a polyline. */
export function normals(points) {
    return points.map((_, index) => {
        const a = points[Math.max(0, index - 1)], b = points[Math.min(points.length - 1, index + 1)];
        const [x, y] = unit(b[0] - a[0], b[1] - a[1]);
        return [-y, x];
    });
}
/** Cumulative arc length at each point, and the total. */
export function arcLength(points) {
    const at = [0];
    let total = 0;
    for (let index = 1; index < points.length; index += 1) {
        total += distance(points[index], points[index - 1]);
        at.push(total);
    }
    return { at, total };
}
/** The first `fraction` of a polyline by length, ending exactly at that fraction. */
export function prefix(points, fraction) {
    if (fraction >= 1)
        return points.slice();
    if (fraction <= 0 || points.length < 2)
        return points.slice(0, 1);
    const { at, total } = arcLength(points);
    const target = total * fraction;
    const out = [points[0]];
    for (let index = 1; index < points.length; index += 1) {
        if (at[index] >= target) {
            const span = at[index] - at[index - 1];
            const t = span > 1e-9 ? (target - at[index - 1]) / span : 0;
            const a = points[index - 1], b = points[index];
            out.push([lerp(a[0], b[0], t), lerp(a[1], b[1], t)]);
            return out;
        }
        out.push(points[index]);
    }
    return out;
}
/** A closed outline around a centreline whose full width at fraction u is width(u). */
export function ribbon(points, width) {
    const normal = normals(points);
    const { at, total } = arcLength(points);
    const left = [], right = [];
    points.forEach((point, index) => {
        const half = width(total > 0 ? at[index] / total : 0) / 2;
        const [nx, ny] = normal[index];
        left.push([point[0] + nx * half, point[1] + ny * half]);
        right.push([point[0] - nx * half, point[1] - ny * half]);
    });
    return [...left, ...right.reverse()];
}
/** Samples of a curve f(v) at n + 1 evenly spaced parameters from v0 to v1. */
export function sample(curve, n, v0 = 0, v1 = 1) {
    return Array.from({ length: n + 1 }, (_, index) => curve(v0 + (v1 - v0) * index / n));
}
export function bezier3(p0, p1, p2, p3) {
    return v => {
        const u = 1 - v;
        const a = u * u * u, b = 3 * u * u * v, c = 3 * u * v * v, d = v * v * v;
        return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]];
    };
}
/**
 * A blade: a closed outline around a spine with half-widths left(v) and right(v), and an optional
 * edge perturbation along the normal. Petals, leaves, sepals and buds are blades.
 */
export function blade(spine, n, left, right, edge) {
    const centre = sample(spine, n);
    const normal = normals(centre);
    const leftSide = [], rightSide = [];
    centre.forEach((point, index) => {
        const v = index / n;
        const a = Math.max(0, left(v) + (edge ? edge(v, 1) : 0));
        const b = Math.max(0, right(v) + (edge ? edge(v, -1) : 0));
        const [nx, ny] = normal[index];
        leftSide.push([point[0] + nx * a, point[1] + ny * a]);
        rightSide.push([point[0] - nx * b, point[1] - ny * b]);
    });
    return { outline: [...leftSide, ...rightSide.slice(1, -1).reverse()], centre };
}
const trim = (text) => text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
/** A number in an SVG attribute: a hundredth of a centimetre is finer than a pixel at screen sizes. */
export const num = (value) => trim(value.toFixed(2));
/** A stroke width or radius, which can be finer than any coordinate. */
export const fine = (value) => trim(value.toFixed(4));
// Path data is written in hundredths of a centimetre, finer than a pixel at screen sizes. Each subpath
// starts at an absolute point and steps from point to point in relative commands, so most numbers are
// small; the steps are taken between rounded points, so rounding never drifts along a path.
const hundredthsOf = (point) => [Math.round(point[0] * 100), Math.round(point[1] * 100)];
/** A whole number of hundredths written as briefly as path data allows: "3", "-1.2", ".05". */
function hundredths(value) {
    const magnitude = Math.abs(value);
    const whole = Math.trunc(magnitude / 100), part = magnitude % 100;
    const sign = value < 0 ? "-" : "";
    if (part === 0)
        return `${sign}${whole}`;
    return `${sign}${whole === 0 ? "" : whole}.${part < 10 ? `0${part}` : `${part}`.replace(/0$/u, "")}`;
}
/** Numbers of hundredths as path data, with a separator only where one number would run into the next. */
function numbers(values) {
    let out = "", dotted = false;
    for (const value of values) {
        const text = hundredths(value);
        if (out !== "" && text[0] !== "-" && !(text[0] === "." && dotted))
            out += " ";
        out += text;
        dotted = text.includes(".");
    }
    return out;
}
/** A straight polyline or polygon as SVG path data. */
export function polyPath(points, closed = false) {
    if (points.length === 0)
        return "";
    let [x, y] = hundredthsOf(points[0]);
    let d = `M${numbers([x, y])}`;
    if (points.length > 1) {
        const steps = [];
        for (let index = 1; index < points.length; index += 1) {
            const [nx, ny] = hundredthsOf(points[index]);
            steps.push(nx - x, ny - y);
            x = nx;
            y = ny;
        }
        d += `l${numbers(steps)}`;
    }
    return closed ? `${d}z` : d;
}
/**
 * A smooth curve through the points (Catmull-Rom as cubic Béziers) as SVG path data. A Catmull-Rom curve's
 * control points mirror each other about every point it passes through, so each segment after the first is
 * written with the `s` shorthand, which mirrors the last control point; each tangent is rounded once, so
 * the mirroring holds exactly in hundredths.
 */
export function smoothPath(points, closed = false, tension = 1) {
    const count = points.length;
    if (count < 3)
        return polyPath(points, closed);
    const at = (index) => closed ? points[(index + count) % count] : points[clamp(index, 0, count - 1)];
    const k = tension / 6 * 100;
    const segments = closed ? count : count - 1;
    const knots = [], tangents = [];
    for (let index = 0; index <= segments; index += 1) {
        knots.push(hundredthsOf(at(index)));
        const next = at(index + 1), previous = at(index - 1);
        tangents.push([Math.round((next[0] - previous[0]) * k), Math.round((next[1] - previous[1]) * k)]);
    }
    // A segment's second control point and its end, relative to its start.
    const segment = (index) => {
        const [x, y] = knots[index], [nx, ny] = knots[index + 1], [tx, ty] = tangents[index + 1];
        return [nx - tx - x, ny - ty - y, nx - x, ny - y];
    };
    let d = `M${numbers(knots[0])}c${numbers([...tangents[0], ...segment(0)])}`;
    if (segments > 1) {
        const rest = [];
        for (let index = 1; index < segments; index += 1)
            rest.push(...segment(index));
        d += `s${numbers(rest)}`;
    }
    return closed ? `${d}z` : d;
}
