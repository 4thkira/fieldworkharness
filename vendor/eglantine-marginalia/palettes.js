import { INK_PROPERTIES } from "./inks.js";
export const PALETTES = [
    { id: "puce", name: "Couleur de puce", period: "1775",
        note: "A garden washed in flea’s back, with the flustered nymph’s blush for its pistils.",
        light: { ink: "#492b2c", paper: "#f8f2e8", accent: "#ae345e", wash: "#643b31" },
        dark: { ink: "#d5c7b0", paper: "#261416", accent: "#e77393", wash: "#d1a499" } },
    { id: "olive", name: "Boue de Paris", period: "1775–1781",
        note: "Washed in toad, the green of the Salon Louis XVI, with Dutch cheese for the pistils.",
        light: { ink: "#3d3223", paper: "#f7f3e1", accent: "#bc752e", wash: "#3e4b13" },
        dark: { ink: "#d1caad", paper: "#1f180f", accent: "#f2a35a", wash: "#a3b774" } },
    { id: "cockade", name: "Palais-Royal", period: "12 juillet 1789",
        note: "The garden in cockade green, touched with the red of Paris.",
        light: { ink: "#283341", paper: "#f6efe1", accent: "#b72a28", wash: "#1f4f13" },
        dark: { ink: "#d2c9b6", paper: "#131a24", accent: "#f37065", wash: "#86bd7a" } },
    { id: "iron-gall", name: "Le Vieux Cordelier", period: "frimaire – pluviôse an II",
        note: "Brown washes were laid in bistre or in iron-gall ink; this is the ink of the manuscripts, aged, with sealing wax for the pistils.",
        light: { ink: "#23201d", paper: "#f4ecdd", accent: "#b12e23", wash: "#603a1a" },
        dark: { ink: "#dfd5c2", paper: "#1a1510", accent: "#ec7061", wash: "#cda486" } },
    { id: "pansy", name: "Germinal an II", period: "21 March – 19 April 1794",
        note: "Pansy, with jonquil for the pistils: the yellow eye of a pansy.",
        light: { ink: "#343249", paper: "#f4f5eb", accent: "#9b852e", wash: "#5f2e8b" },
        dark: { ink: "#cdcab4", paper: "#181729", accent: "#cfb340", wash: "#c69df4" } },
    { id: "porcelain", name: "Fonds de Sèvres", period: "1752–1763",
        note: "Painted en camaïeu bleu, with the gilding for the pistils.",
        light: { ink: "#2a354d", paper: "#f9f6ed", accent: "#b47d36", wash: "#16419f" },
        dark: { ink: "#d0cbbc", paper: "#0d1a37", accent: "#e2ac6e", wash: "#8fb1f4" } },
    { id: "madder", name: "Toile de Jouy", period: "1770–1790s",
        note: "A madder print, with indigo pencilled in by hand, as at Jouy.",
        light: { ink: "#492a2b", paper: "#f6f1e5", accent: "#386399", wash: "#762f14" },
        dark: { ink: "#d1c8b6", paper: "#261415", accent: "#719ad0", wash: "#ee997c" } },
    { id: "red-chalk", name: "Aux trois crayons", period: "c. 1715–1720",
        note: "Bistre, the brown wash of soot, with red chalk for the touches of colour.",
        light: { ink: "#2a2521", paper: "#dac8ae", accent: "#7d3216", wash: "#3b2912" },
        dark: { ink: "#f6f3e8", paper: "#2a3f54", accent: "#f7b098", wash: "#dac5ac" } },
];
/** A palette's inks in one reading, in the shape `withInks` takes. */
export function paletteInks(id, reading) {
    const palette = PALETTES.find(candidate => candidate.id === id);
    if (!palette)
        throw new Error(`no palette ${id}`);
    return palette[reading];
}
const declarations = (inks) => Object.keys(INK_PROPERTIES).map(name => `${INK_PROPERTIES[name]}: ${inks[name]};`).join(" ");
/**
 * The palettes as a stylesheet: `data-eglantine-palette="madder"` on any element tints the gardens inside
 * it, following the system's colour scheme; `madder-light` and `madder-dark` fix a reading. The package
 * ships it as `eglantine-marginalia/palettes.css`.
 */
export function palettesCss() {
    const blocks = PALETTES.flatMap(({ id, name, light, dark }) => [
        `/* ${name} */`,
        `[data-eglantine-palette="${id}"], [data-eglantine-palette="${id}-light"] { ${declarations(light)} }`,
        `[data-eglantine-palette="${id}-dark"] { ${declarations(dark)} }`,
        `@media (prefers-color-scheme: dark) { [data-eglantine-palette="${id}"] { ${declarations(dark)} } }`,
    ]);
    return `/* Églantine's palettes, generated from src/palettes.ts. */\n${blocks.join("\n")}\n`;
}
