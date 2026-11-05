// Seeded randomness for the margin garden. The generator is mulberry32 (Tommy Ettinger, 2017,
// public domain), the one Kevin Raymond's florilegium uses (MIT): small, fast and identical in every
// browser, so a seed always grows the same garden.
export function createRng(seed) {
    let state = seed >>> 0;
    const u = () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const rng = {
        u,
        range: (low, high) => low + (high - low) * u(),
        sym: amplitude => amplitude * (2 * u() - 1),
        int: (low, high) => low + Math.floor((high - low + 1) * u()),
        chance: probability => u() < probability,
        pick: items => {
            if (items.length === 0)
                throw new Error("cannot pick from an empty list");
            return items[Math.floor(items.length * u())];
        },
        fork: () => createRng(Math.floor(u() * 4294967295)),
    };
    return rng;
}
/** FNV-1a over the text's UTF-16 units: a stable seed from a date or any other name. */
export function seedFromText(text) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}
/** Smooth 1-D gradient noise, roughly in [-1, 1], from a seeded gradient table. */
export function noise1(rng) {
    const gradients = Array.from({ length: 256 }, () => rng.sym(1));
    return x => {
        const cell = Math.floor(x);
        const f = x - cell;
        const a = gradients[cell & 255] * f;
        const b = gradients[(cell + 1) & 255] * (f - 1);
        const s = f * f * (3 - 2 * f);
        return 2 * (a + (b - a) * s);
    };
}
/** A fractal sum of 1-D noise: each octave doubles the frequency and halves the amplitude. */
export function fbm1(rng, octaves) {
    const layers = Array.from({ length: octaves }, () => noise1(rng));
    return x => {
        let value = 0, amplitude = 1, frequency = 1;
        layers.forEach((layer, index) => {
            value += amplitude * layer(x * frequency + 17 * (index + 1));
            amplitude *= 0.5;
            frequency *= 2;
        });
        return value;
    };
}
