// The four inks a garden is drawn with. A garden's SVG refers to each through a CSS custom property
// with a fallback colour, so a page's stylesheet can retint it and an SVG with no stylesheet still
// prints in soot and bistre on cream.
/** Soot-black ink on cream paper, a rubric-red accent and a bistre wash. */
export const DEFAULT_INKS = { ink: "#2a221c", paper: "#f3ead8", accent: "#9e2b25", wash: "#5a3b22" };
/** The CSS custom property each ink is read from. */
export const INK_PROPERTIES = {
    ink: "--eglantine-ink", paper: "--eglantine-paper", accent: "--eglantine-accent", wash: "--eglantine-wash",
};
/** How a garden's SVG refers to an ink: its custom property, falling back to the default colour. */
export const inkRef = (name) => `var(${INK_PROPERTIES[name]}, ${DEFAULT_INKS[name]})`;
const REFERENCE = /var\((--eglantine-(?:ink|paper|accent|wash))(?:,\s*([^)]+))?\)/gu;
/**
 * The SVG with every ink reference replaced by a colour: for a garden shown as an image or saved as a
 * file, where no stylesheet reaches it. Inks left out keep their fallback colours.
 */
export function withInks(svg, inks = {}) {
    const byProperty = new Map(Object.keys(INK_PROPERTIES).map(name => [INK_PROPERTIES[name], inks[name] ?? DEFAULT_INKS[name]]));
    return svg.replace(REFERENCE, (whole, property) => byProperty.get(property) ?? whole);
}
