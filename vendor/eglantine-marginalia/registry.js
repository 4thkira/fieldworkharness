// The plant forms the library knows. They are listed by hand, not discovered, so the registry loads the
// same way in a browser, a bundler and Node.
import { resolveVariant } from "./form.js";
import { form as arbreFruitier } from "./forms/arbre-fruitier.form.js";
import { form as capitule } from "./forms/capitule.form.js";
import { form as conifere } from "./forms/conifere.form.js";
import { form as cryptogame } from "./forms/cryptogame.form.js";
import { form as epiAromatique } from "./forms/epi-aromatique.form.js";
import { form as epiGraminee } from "./forms/epi-graminee.form.js";
import { form as feuillage } from "./forms/feuillage.form.js";
import { form as grimpante } from "./forms/grimpante.form.js";
import { form as hiver } from "./forms/hiver.form.js";
import { form as lisBulbe } from "./forms/lis-bulbe.form.js";
import { form as ombelleCorymbe } from "./forms/ombelle-corymbe.form.js";
import { form as racineTubercule } from "./forms/racine-tubercule.form.js";
import { form as rosaceeCoupe } from "./forms/rosacee-coupe.form.js";
export const FORM_MODULES = new Map([
    arbreFruitier, capitule, conifere, cryptogame, epiAromatique, epiGraminee, feuillage, grimpante, hiver, lisBulbe, ombelleCorymbe,
    racineTubercule, rosaceeCoupe,
].map(module => [module.id, module]));
const built = new Map();
/** The plant form for an id and variant; builds are cached, since a form is pure data and functions. */
export function plantForm(id, variant = {}) {
    const module = FORM_MODULES.get(id);
    if (!module)
        throw new Error(`no plant form ${id}`);
    const resolved = resolveVariant(module, variant);
    const key = `${id}:${JSON.stringify(Object.entries(resolved).sort(([a], [b]) => a.localeCompare(b)))}`;
    let form = built.get(key);
    if (!form) {
        form = module.build(resolved);
        built.set(key, form);
    }
    return form;
}
