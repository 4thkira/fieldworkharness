// The French Republican calendar's names: its twelve months, and the 360 days Fabre d'Églantine named
// in his report to the Convention (1793), each with its article as he printed it, then the complementary days.
export const MONTHS = [
    "vendémiaire",
    "brumaire",
    "frimaire",
    "nivôse",
    "pluviôse",
    "ventôse",
    "germinal",
    "floréal",
    "prairial",
    "messidor",
    "thermidor",
    "fructidor",
];
/** The day names in calendar order, thirty to a month: plants, with an animal on each quintidi and a tool on each décadi. */
export const DAYS = [
    // vendémiaire
    "du raisin", "du safran", "de la châtaigne", "du colchique", "du cheval",
    "de la balsamine", "de la carotte", "de l'amarante", "du panais", "de la cuve",
    "de la pomme de terre", "de l'immortelle", "du potiron", "du réséda", "de l'âne",
    "de la belle-de-nuit", "de la citrouille", "du sarrasin", "du tournesol", "du pressoir",
    "du chanvre", "de la pêche", "du navet", "de l'amaryllis", "du bœuf",
    "de l'aubergine", "du piment", "de la tomate", "de l'orge", "du tonneau",
    // brumaire
    "de la pomme", "du céleri", "de la poire", "de la betterave", "de l'oie",
    "de l'héliotrope", "de la figue", "de la scorsonère", "de l'alisier", "de la charrue",
    "du salsifis", "de la mâcre", "du topinambour", "de l'endive", "du dindon",
    "du chervis", "du cresson", "de la dentelaire", "de la grenade", "de la herse",
    "de la bacchante", "de l'azerole", "de la garance", "de l'orange", "du faisan",
    "de la pistache", "du macjonc", "du coing", "du cormier", "du rouleau",
    // frimaire
    "de la raiponce", "du turneps", "de la chicorée", "de la nèfle", "du cochon",
    "de la mâche", "du chou-fleur", "du miel", "du genièvre", "de la pioche",
    "de la cire", "du raifort", "du cèdre", "du sapin", "du chevreuil",
    "de l'ajonc", "du cyprès", "du lierre", "de la sabine", "du hoyau",
    "de l'érable-sucre", "de la bruyère", "du roseau", "de l'oseille", "du grillon",
    "du pignon", "du liège", "de la truffe", "de l'olive", "de la pelle",
    // nivôse
    "de la tourbe", "de la houille", "du bitume", "du soufre", "du chien",
    "de la lave", "de la terre végétale", "du fumier", "du salpêtre", "du fléau",
    "du granit", "de l'argile", "de l'ardoise", "du grès", "du lapin",
    "du silex", "de la marne", "de la pierre à chaux", "du marbre", "du van",
    "de la pierre à plâtre", "du sel", "du fer", "du cuivre", "du chat",
    "de l'étain", "du plomb", "du zinc", "du mercure", "du crible",
    // pluviôse
    "de la lauréole", "de la mousse", "du fragon", "de la perce-neige", "du taureau",
    "du laurier-thym", "de l'amadouvier", "du mézéréon", "du peuplier", "de la cognée",
    "de l'ellébore", "du brocoli", "du laurier", "de l'avelinier", "de la vache",
    "du buis", "du lichen", "de l'if", "de la pulmonaire", "de la serpette",
    "du thlaspi", "de la thymèle", "du chiendent", "de la traînasse", "du lièvre",
    "de la guède", "du noisetier", "du cyclamen", "de la chélidoine", "du traîneau",
    // ventôse
    "du tussilage", "du cornouiller", "du violier", "du troène", "du bouc",
    "de l'asaret", "de l'alaterne", "de la violette", "du marceau", "de la bêche",
    "du narcisse", "de l'orme", "de la fumeterre", "du vélar", "de la chèvre",
    "des épinards", "du doronic", "du mouron", "du cerfeuil", "du cordeau",
    "de la mandragore", "du persil", "du cochléaria", "de la pâquerette", "du thon",
    "du pissenlit", "de la sylvie", "du capillaire", "du frêne", "du plantoir",
    // germinal
    "de la primevère", "du platane", "de l'asperge", "de la tulipe", "de la poule",
    "de la blette", "du bouleau", "de la jonquille", "de l'aulne", "du couvoir",
    "de la pervenche", "du charme", "de la morille", "du hêtre", "de l'abeille",
    "de la laitue", "du mélèze", "de la ciguë", "du radis", "de la ruche",
    "du gainier", "de la romaine", "du marronnier", "de la roquette", "du pigeon",
    "du lilas", "de l'anémone", "de la pensée", "de la myrtille", "du greffoir",
    // floréal
    "de la rose", "du chêne", "de la fougère", "de l'aubépine", "du rossignol",
    "de l'ancolie", "du muguet", "du champignon", "de l'hyacinthe", "du râteau",
    "de la rhubarbe", "du sainfoin", "du bâton-d'or", "du chamérisier", "du ver à soie",
    "de la consoude", "de la pimprenelle", "de la corbeille d'or", "de l'arroche", "du sarcloir",
    "de la statice", "de la fritillaire", "de la bourrache", "de la valériane", "de la carpe",
    "du fusain", "de la civette", "de la buglosse", "du sénevé", "de la houlette",
    // prairial
    "de la luzerne", "de l'hémérocalle", "du trèfle", "de l'angélique", "du canard",
    "de la mélisse", "du fromental", "du martagon", "du serpolet", "de la faux",
    "de la fraise", "de la bétoine", "du pois", "de l'acacia", "de la caille",
    "de l'œillet", "du sureau", "du pavot", "du tilleul", "de la fourche",
    "du barbeau", "de la camomille", "du chèvrefeuille", "du caille-lait", "de la tanche",
    "du jasmin", "de la verveine", "du thym", "de la pivoine", "du chariot",
    // messidor
    "du seigle", "de l'avoine", "de l'oignon", "de la véronique", "du mulet",
    "du romarin", "du concombre", "des échalotes", "de l'absinthe", "de la faucille",
    "de la coriandre", "de l'artichaut", "de la giroflée", "de la lavande", "du chamois",
    "du tabac", "de la groseille", "de la gesse", "de la cerise", "du parc",
    "de la menthe", "du cumin", "des haricots", "de l'orcanète", "de la pintade",
    "de la sauge", "de l'ail", "de la vesce", "du blé", "de la chalémie",
    // thermidor
    "de l'épeautre", "du bouillon-blanc", "du melon", "de l'ivraie", "du bélier",
    "de la prêle", "de l'armoise", "du carthame", "des mûres", "de l'arrosoir",
    "du panic", "de la salicorne", "de l'abricot", "du basilic", "de la brebis",
    "de la guimauve", "du lin", "de l'amande", "de la gentiane", "de l'écluse",
    "de la carline", "du câprier", "de la lentille", "de l'aunée", "de la loutre",
    "du myrte", "du colza", "du lupin", "du coton", "du moulin",
    // fructidor
    "de la prune", "du millet", "du lycoperdon", "de l'escourgeon", "du saumon",
    "de la tubéreuse", "du sucrion", "de l'apocyn", "de la réglisse", "de l'échelle",
    "de la pastèque", "du fenouil", "de l'épine-vinette", "de la noix", "de la truite",
    "du citron", "de la cardère", "du nerprun", "de la tagette", "de la hotte",
    "de l'églantier", "de la noisette", "du houblon", "du sorgho", "de l'écrevisse",
    "de la bigarade", "de la verge d'or", "du maïs", "du marron", "du panier",
];
/** The complementary days at the year's end, the sixth only in a sextile year. */
export const COMPLEMENTARY = [
    "jour de la vertu",
    "jour du génie",
    "jour du travail",
    "jour de l'opinion",
    "jour des récompenses",
    "jour de la révolution",
];
