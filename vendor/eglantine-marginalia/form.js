export const LAYER = { stem: 2, leaf: 3, airy: 4, bloom: 5 };
/** The variant with every key the form knows filled in, refusing unknown keys and values out of bounds. */
export function resolveVariant(module, variant = {}) {
    const resolved = {};
    for (const key of Object.keys(variant))
        if (!(key in module.variants))
            throw new Error(`form ${module.id} has no variant key ${key}`);
    for (const [key, spec] of Object.entries(module.variants)) {
        const value = variant[key] ?? spec.default;
        if (spec.values && !spec.values.includes(value))
            throw new Error(`form ${module.id}: ${key} cannot be ${String(value)}`);
        if (spec.range && (typeof value !== "number" || value < spec.range[0] || value > spec.range[1]))
            throw new Error(`form ${module.id}: ${key} must lie in ${spec.range.join("..")}`);
        resolved[key] = value;
    }
    return resolved;
}
/** A variant's value as a number, a string or a flag, for form builders. */
export const numberOf = (variant, key) => Number(variant[key]);
export const textOf = (variant, key) => String(variant[key]);
export const flagOf = (variant, key) => variant[key] === true;
