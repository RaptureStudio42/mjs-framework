# Journal des modifications

Toutes les évolutions notables de `mjs-framework` sont consignées ici. Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/), versionnage [SemVer](https://semver.org/lang/fr/).

## [2.4.2] — 2026-09-19

- **Ajouté — le build REFUSE un cœur incomplet.** `mjs_core.js` n'embarque un module optionnel que si le compilateur en reconnaît le marqueur dans le code compilé des composants (`scanCompiledFeatures`). Ce prédicat qui échoue rend « personne n'en a besoin » — mot pour mot ce que rend « rien à embarquer » : le module sort du cœur, le build reste VERT, et l'application meurt au premier clic sur `this.<nom> is not a function`. C'est arrivé : une refonte interne avait renommé une propriété, le générateur émettait encore l'ancien nom, la détection cherchait déjà le nouveau, et neuf vues sont parties en production sans la méthode qu'elles appellent, pendant deux jours, sans une ligne d'erreur nulle part. Le compilateur vérifie désormais son RÉSULTAT : chaque symbole interne (`_mjs_*`, plus les seize helpers courts du cœur) qu'une unité compilée appelle doit exister dans le cœur produit, sinon le build échoue en NOMMANT les symboles absents et en distinguant les deux causes possibles (un `runtime` qui retire un module dont le projet se sert / un bogue de détection du framework). Le contrôle porte sur le texte NON MINIFIÉ des deux côtés (le raccourcissement des propriétés rendrait les symboles invisibles), ignore les mentions en commentaire ou en chaîne, et ne regarde AUCUN nom choisi par l'application : une méthode à soi ne peut pas bloquer un build.

## [2.4.1] — 2026-09-19

- **Ajouté — `mjs --version` / `mjs -v`.** Le flag n'existait pas : il tombait dans le `else` final de `parseArgs`, sortait un « ⚠️ Flag inconnu ignoré », puis la CLI enchaînait sur un build complet — depuis un dossier sans projet, la première commande que tape un nouveau venu répondait donc par un avertissement et un « ❌ Dossier source INTROUVABLE ». Elle imprime maintenant `mjs <version>` sur la sortie standard et sort en 0, AVANT le `chdir` de `--root`, avant la lecture de `mjs.config.json` et avant tout `Bundler` : elle répond dans un dossier vide et n'y écrit rien. Le numéro est lu au runtime dans le `package.json` du paquet (`../package.json`, valide depuis `src/cli.ts` lancé par tsx comme depuis `dist/cli.js` bundlé par esbuild) et non importé statiquement, qu'un `npm version` sans `build:self` ne puisse pas faire annoncer l'ancien numéro ; illisible ou sans champ `version`, la commande le DIT et sort en 1 plutôt que d'inventer un numéro. Sortie identique en français et en anglais — un script qui la parse ne dépend pas de la langue du projet. `-v`/`--version` et `-h`/`--help` sont désormais listés dans l'aide.

- **Modifié — README du paquet.** Les badges npm, licence et site ne sont plus en commentaire : ils affichent la version publiée, la licence MIT et le lien du site officiel, dans les deux moitiés du fichier (française et anglaise). Deux captures de l'accueil — `docs/img/accueil-fr.png` et `accueil-en.png`, cliquables vers le site — précèdent « Pourquoi MJS » et « Why MJS » ; elles sont référencées par leur URL absolue sur `raw.githubusercontent.com`, npmjs.com ne réécrivant pas de façon fiable un chemin relatif. La section anglaise pointe partout `?lang=en`. Le champ `homepage` du `package.json` passe de `modularjs.rapturestudio.fr` (sans DNS, 502) à `mjs.rapturestudio.fr`, et le tutoriel interactif est désormais un lien et non plus une mention. La page npm sert le README du tarball : c'est cette version qui la remplace.

## [2.4.0] — 2026-09-18

- **Corrigé — sous `csp: true`, la feuille de `<@head>` partait sur une URL sans préfixe public.** Le `<link>` du `<head>` thématisé composait son adresse avec le `urlPrefix` DÉCLARÉ, et rien quand le projet n'en déclare pas : `/mjs_ssr_head-….css` au lieu de `/modularjs/mjs_ssr_head-….css` — 404 derrière un back qui sert `public/`, donc une page sans thème alors que le fichier existait, une ligne plus bas dans l'arborescence. Le préfixe se DÉRIVE maintenant du dossier de sortie quand il n'est pas déclaré, par la même fonction que le bundler — et des DEUX côtés : `mjs serve` montait, lui, le dossier de sortie à la racine (`|| ''`), si bien que tout ce que la page référençait tombait à côté ; une chaîne vide DÉCLARÉE reste respectée (le projet dit alors « sers à la racine »). Deux conséquences de la même famille, corrigées avec : sous un préfixe vide, `mjs dev` traitait tout chemin comme un asset et `/` résolvait le dossier servi — la page déclarée pour `/` n'était jamais rendue (un dossier n'est pas un fichier servable : même repli que pour un fichier absent, le cas `url === préfixe` d'un préfixe non vide restant inchangé) ; et `mjs serve` ne dérivait pas non plus le `manifestPath` par défaut, servant une page dont le propre `<script src>` rendait 404 tant que le projet ne déclarait pas la clé.

- **Corrigé — `render.outDir` : un lien symbolique du projet pointant dehors passait la garde.** Le dossier que le prérendu écrit ET dont il retire ses fragments périmés doit rester dans le projet ; la garde comparait des CHAÎNES, un lien posé dans l'arbre suffisait à porter les deux gestes ailleurs. Elle compare désormais des chemins RÉELS des deux côtés — `realpath` du plus proche ancêtre existant, pour qu'un dossier de sortie pas encore créé reste comparable.

- **Corrigé — sous `csp: true`, une page prérendue partait avec des feuilles EN LIGNE, que la politique de sécurité refuse d'appliquer.** Deux trous, un seul symptôme — une page servie non stylée, et rien au build pour le dire. Le mode strict du PROJET n'atteignait pas le rendu : le prérendu et le rendu par requête construisent leur renderer avec les options RÉSOLUES du projet, jamais avec la clé explicite de l'API — même la racine sortait donc un `<style>`. Et la sérialisation d'un composant IMBRIQUÉ inlinait sa feuille sans consulter le mode : seule la racine passait en `<link>`. Désormais un seul émetteur, décidé une fois par renderer et transmis jusqu'au fond de la sérialisation : sous le mode strict, TOUT composant du HTML rendu — racine à ombre, racine légère, sous-composant à ombre, sous-composant léger — sort sa feuille en `<link rel="stylesheet">` vers un fichier haché du dossier de sortie, jamais en ligne. Ces fichiers-là ne sortent d'aucune compilation : la purge des orphelins les prenait pour des restes et les retirait juste après que le prérendu les a écrits, laissant les `<link>` des fragments pointer dans le vide — elle épargne désormais les trois familles que le rendu écrit, et elles seules (`mjs_ssr_style…`, `mjs_ssr_head…`, `mjs_viewer_…`) : `mjs_style_…` reste le stem des unités que le bundler émet pour les feuilles PARTAGÉES (`css: "split"`/`"lazy"`), qui doivent, elles, rester purgeables. En contrepartie, la feuille d'un composant retiré du projet reste sur disque, orpheline — elle n'est plus référencée par aucun fragment et son nom porte l'empreinte de son contenu. Vérifié en Chromium sur une page servie sous une vraie politique `default-src 'self'; style-src 'self'; script-src 'self'` : zéro violation, là où la même page en comptait trois.

- **Corrigé — un projet à fichier unique (`js: "bundle"`) voyait son build DÉFAIT par son propre prérendu.** Le rendu serveur recompile le projet pour monter ses composants, et ce mode d'émission lui est interdit — il relit le cœur et chaque composant fichier par fichier : sa recompilation, forcée en `split`, écrivait dans le VRAI dossier de sortie et y remplaçait le fichier unique par un manifeste éclaté, en semant ses unités à côté. Mesuré sur un projet d'un composant (production, `runtime: "core"`) : `dist/bundle.js` de 29 895 à 2 319 octets, un `mjs_core-*.js` de 30 588 octets et un composant haché de 914 octets apparus à côté, et un `<link rel="modulepreload" href="mjs:unit/app-home">` non résolu en tête du fragment servi. Cette compilation de service se fait désormais dans un dossier temporaire à elle, retiré à la fermeture y compris sur erreur, amorcé d'une copie du cache de noms courts du projet — le dossier de sortie et son fichier unique traversent le prérendu à l'octet près. Les URLs d'assets du HTML rendu (images `µasset`, feuilles du mode `csp`, liens) restent celles du vrai build, et une feuille écrite pour être SERVIE va toujours dans le vrai dossier de sortie. Le mode éclaté, lui, continue de compiler en place : ce qu'il réécrit est exactement ce que le build vient d'écrire. Ce dossier de travail est rendu dans TOUS les cas : `mjs serve` interrompu par Ctrl-C refermait le process sans jamais atteindre la fermeture du serveur de rendu (donc ni le renderer ni son dossier) — il ferme désormais proprement sur `SIGINT`/`SIGTERM`, une seule fois, et sort en 0 — et `mjs dev`, dont le rappel d'arrêt était synchrone, ATTEND désormais la fermeture du handler de rendu au lieu d'en jeter la promesse ; et les deux sorties en erreur de la construction d'un renderer (tri par dépendances impossible, happy-dom absent) refermaient le bundler en laissant le dossier derrière elles. Dans le même mouvement, un projet à fichier unique ne reçoit plus d'en-tête de démarrage dans ses fragments (une ligne de journal le dit) : le fichier que la coquille charge porte déjà le cœur et tous les composants, et les clés de son manifeste désignent des modules virtuels qu'aucun navigateur ne sait aller chercher.

- **Ajouté — `render.routes[url].light` : prérendre une page dont la racine est montée SANS Shadow DOM.** Une coquille qui monte `<mjs-x mjs-light>` n'avait aucun moyen d'obtenir un fragment léger — le rendu serveur construisait toujours un hôte à Shadow DOM déclaratif, et le HTML servi décrivait donc un autre arbre que celui que le client rebâtit. `"light": true` sur la route rend `<mjs-x mjs-light mjs-ssr>`, contenu en enfants directs, sans `<template shadowrootmode>`, la feuille scopée du composant voyageant avec le fragment, `:host` réécrit en nom de balise — un léger n'a pas d'hôte réel à désigner. Vaut pour les deux moteurs (happy-dom et navigateur), au prérendu du build comme au rendu par requête, et l'option `light` existe aussi à l'appel direct de `renderToString`. Côté client, la photo serveur d'un composant léger se REMPLACE comme celle d'un Shadow DOM déclaratif (la balise porte `mjs-ssr`) : sans ce retrait, la vue reconstruite s'ajoutait à celle du serveur — page en double, la photo inerte devant. `mjs-ssr` reste donc réservé au rendu serveur : écrit à la main sur un léger qui porte des enfants d'auteur, il les fait disparaître au montage. Posée sur une route `csr`, où le serveur ne rend rien, la clé `light` n'a rien à décider : la lecture de la configuration le signale en une ligne plutôt que de l'ignorer en silence. Coût mesuré sur l'application du banc (production, `js: "bundle"`, `runtime: "core"`, 8 composants) : 72 485 → 72 557 octets bruts.

- **Modifié — l'enregistrement d'une balise passe par une aide du cœur (`µ._def`), et l'enregistrement de l'alias COURT d'un composant ne suit plus que les projets qui en écrivent un.** Chaque fichier compilé portait la garde de définition en entier — test d'existence, enregistrement, et le message français de collision de 106 signes écrit DEUX fois (branche `µ.warn`, branche `console.warn`) : le même texte pour tous les composants, payé par fichier. Le composant ne garde que sa balise et sa classe (`µ._def("mjs-x", MjsX)`), la garde vit une seule fois dans le cœur, comportement identique — deux bundles qui définissent la même balise : le premier chargé gagne, le second est signalé au même texte et ignoré, jamais une exception. Symétriquement, `µ._al` (l'alias court, `doc/doc-carte.mjs` → `<mjs-carte>`) quitte le cœur pour `mjs_alias.ts`, joint sur le signal EXACT de l'appel que le compilateur émet — un projet dont chaque fichier vit à la racine n'en écrit aucun ; `"runtime": ["alias"]` le force, et le nom `_al` reste réservé au raccourcisseur même sans le module, comme `_p`, `_tm` et `_def`. Mesuré sur l'application du banc (`framework-benchmarks/apps/mjs`, production, `js: "bundle"`, `runtime: "core"`, 8 composants, aucun alias, zlib niveau 9) : 74 824 → 72 485 octets bruts (−2 339, −3,13 %), 23 304 → 23 143 gzip-9 (−161) — dont 151 octets bruts (32 gzip-9) pour la seule brique d'alias, relevés en la forçant sur cette même copie. Sur un site de documentation réel (743 composants, construction de production, manifeste éclaté, 740 balises enregistrées et 658 alias courts) : les fichiers de composants passent de 4 327 850 à 4 074 842 octets bruts (−253 008, −5,85 %) et de 585 893 à 568 364 octets gzip-9 une fois concaténés (−17 529) ; le message de collision y tombe de 1 480 occurrences à une seule, et le cœur grossit de 193 octets bruts (72 gzip-9) — ce site écrit des alias, il garde donc les deux aides. Rien ne change au runtime : ses dix fragments prérendus sont identiques et cent de ses composants montés dans un Chromium réel rendent le même balisage, aux mêmes messages de console.

- **Corrigé — en production, le titre d'une page n'était jamais rendu à la précédente : un composant qui écrit `<title>` gardait la main pour toujours.** Le titre d'avant est mémorisé à la première écriture du composant et rendu à sa mise en sommeil ; cette mémoire se testait par `'_mjs_headTitle' in component`. Le minifieur raccourcit la propriété écrite juste à côté (`component._mjs_headTitle = …`) mais laisse la CHAÎNE d'un `in` telle quelle : le test ne trouvait donc jamais rien — chaque écriture re-mémorisait le titre courant (celui de la page qu'on venait de quitter) et la restauration sortait toujours à son premier `return`, titre figé sur la dernière page visitée. Le test passe par un accès pointé (`component._mjs_headTitle === undefined`), que le raccourcisseur suit. En développement, non minifié, rien ne se voyait.

- **Corrigé — le garde-fou de construction qui interdit de nommer une propriété interne par une chaîne ne voyait pas tout le cœur : un accès ``µ[`_mjs_${clé}`]`` posé dans une zone aveugle partait en production sans un mot.** Il blanchissait commentaires et chaînes par expressions régulières, aveugles au contexte où elles tombent : un `/*` CITÉ dans un commentaire de LIGNE (`// route de repli '/*'`) ouvrait un faux commentaire de bloc jusqu'au premier `*/` rencontré plus bas — 62 606 caractères de code réel invisibles sur la source du runtime (4,8 %), en un seul bloc sur un cœur assemblé ; un `//` à l'intérieur d'une chaîne effaçait la fin de sa ligne ; une apostrophe dans un gabarit (`` `l'état` ``) ou un guillemet dans une classe regex (`/['"]/`) décalait d'un cran toutes les chaînes suivantes. Le blanchiment est désormais une lecture à états (chaînes simples et doubles, gabarits et leurs `${…}` imbriqués, commentaires de ligne et de bloc, littéraux regex) qui ne déplace aucune position : les numéros de ligne des messages restent exacts, et un littéral regex qui DÉCRIT le motif interdit — celui qui sert à le détecter — ne casse plus la construction. Deux formes annoncées de longue date mais jamais cherchées entrent au passage : la concaténation (`'_mjs_' + clé`) et le test d'existence (`'_mjs_X' in obj`) — c'est cette dernière qui a mis au jour le défaut de titre ci-dessus, seule violation réelle de tout l'arbre. Un accès à nom construit ajouté à la fin du cœur fait maintenant échouer la construction (code de sortie 1, aucun fichier livré) là où il passait en silence.

- **Corrigé — en production, une page prérendue arrivait NON STYLÉE : le CSS scopé de chaque composant manquait au HTML servi.** Le rendu serveur lit la feuille scopée et le mode léger d'un composant monté sur l'élément lui-même (`_mjs_baseCss`, `_mjs_isLight`) ; or la construction de production raccourcit les propriétés `_mjs_*` en un ou deux caractères, et ce code-là — le rendu serveur côté Node, les fonctions injectées dans la page du moteur navigateur — n'est PAS compilé avec le bundle : il nommait des propriétés qui n'existent plus sous ce nom, recevait `undefined`, et n'inlinait donc aucun `<style>` dans le `<template shadowrootmode>` ni ne voyait le mode léger d'une racine. Mesuré sur le site de documentation, construction de production : 118 `<template>` prérendus, 0 avec sa feuille (en développement, non minifié, 118 sur 118). Le runtime expose désormais un accès à nom LONG, jamais raccourci (`µ._ssrInfo(el)` → `{ baseCss, isLight, nodes, awaitStates, renderScheduled }`), seul chemin par lequel les deux moteurs de rendu (happy-dom et navigateur) lisent ces valeurs — plus aucune propriété `_mjs_*` n'est nommée depuis le code serveur. Coût : 131 octets bruts (54 gzip-9) dans le cœur, bouclier compris. Le développement est inchangé.

- **Corrigé — le contenu d'une page prérendue disparaissait de l'écran dès l'évaluation du cœur, jusqu'à l'arrivée du module de chaque composant.** Le masquage anti-FOUC du cœur cache tout composant pas encore défini (`:not(:defined)`) : sur une page prérendue, le visiteur voyait le HTML servi, puis une page vide — d'autant plus longtemps que le module tardait —, et le prérendu perdait sa raison d'être. Le rendu serveur marque chaque élément `mjs-*` qu'il rend (attribut `mjs-ssr` : racine, imbriqués, light DOM compris) et la règle du bouclier les épargne (`:not(:defined):not([mjs-ssr])`, dans le document comme dans chaque racine d'ombre) ; la reprise en main garde sa fenêtre à elle (`[mjs-loading]`, posé à la connexion et retiré en microtâche), trop courte pour être repeinte — relevé trame par trame dans un Chromium réel, cœur et modules servis en retard : aucune trame masquée. Un composant que le serveur n'a PAS rendu reste masqué jusqu'à sa définition, le bouclier garde son rôle. Vaut pour les quatre stratégies de reprise (`replace`, `markers`, `positional`, `diff`) et pour `mjs-light` ; l'attribut n'a pas à être retiré côté client.

- **Modifié — toutes les propriétés internes du cœur portent le préfixe `_mjs_`, que la construction de production raccourcit en un ou deux caractères.** Le minifieur ne raccourcit que les propriétés `_mjs_*` (`mangleProps`) : le reste de la mécanique interne (`_updText`, `_var_bits`, `_notifyUniversalChange`, `_renderStructVars`, `_navDispatch`…) gardait son nom entier dans le fichier livré — 170 noms pour 1 092 occurrences rien que sur l'application du banc. 399 noms passent au préfixe dans `src/runtime/`, dans le code que le générateur et le transpileur émettent, et chez leurs lecteurs (rendu serveur, harnais de test, détection des signaux du bundler, suite de tests). Deux familles de noms **construits** par concaténation, que le raccourcisseur ne peut pas suivre, deviennent des objets : le mémo de branche d'un `{if}` (`this._old_<id>` → `this._mjs_old[<id>]`) et le mémo du filtrage par clé (`this._filtIdx_<clé>`/`this._filtPrev_<clé>` → `this._mjs_filt[<clé>] = { idx, prev }`) ; la garde de classe filtrée posée sur un nœud suit (`_mjsCl_<classe>` → `_mjs_cl_<classe>`). Le premier réparait au passage un nettoyage muet : l'invalidation des mémos imbriqués reconstruisait le nom par `this['_old_' + id]`, une forme qu'aucun garde-fou ne voit — le jour où ce nom serait raccourci, un `{if}` niché dans un `{if}` recréé restait vide, sans un mot. **Gardent leur nom long**, chacun pour une raison précise : `_shadow` et `_state`, les deux seuls internes qu'un test ou une sonde peut lire (cf. [33 · Tester son application](docs/33-tester-son-application.md)) ; `_set`, sondé PAR NOM sur un élément qui peut porter des clés de données arbitraires (`<@enfant {...obj}>`) — raccourci, une clé du JSON le masquait et le composant crevait ; les aides du cœur `µ._p`/`µ._tm`/`µ._al` et les marqueurs lus sur une donnée (`_mjs_c`, `_mjsId`) ; les propriétés que le **manifeste** écrit sur `µ` (`_cssLazy`, `_logLevel`, `_runtimeLabels`, `_runtimeLabelsLang`, `_themes`, `_themeAdopt`, `_i18nRecheck`, `_i18nData`, `_themeCss`, `_csp`) — il est émis SANS minification, il ne peut donc citer qu'un nom entier ; celles que le rendu serveur ou le code injecté dans la page ÉCRIT, ou lit sans passer par l'accès long : `_isServer` (posé sur `µ` après l'évaluation du cœur), `_fatalErrors`, `_lightHostCss`, `_hotCss`, la famille i18n (`_i18nLang`, `_i18nLangs`, `_i18nDict`, `_i18nCache`, `_i18nUsed`, `_i18nLoadSync` — semée puis relue depuis le bac à sable du rendu) et la graine de magasin (`_storeSet`, `_storeDeclare`) ; le paramètre réservé `__nodes`, nommé aux utilisateurs ; les deux seules clés des familles temps réel qui voyagent VRAIMENT sur le fil — `_n`, le numéro d'ordre qu'un client glisse dans sa charge (`µ.predict`), et `_ack`, que le serveur reflète dans la trame d'état — plus `_err`, lue sur l'événement de fermeture que fournit le transport, et `_hash`, le crochet d'une poignée de partie qu'un double d'application peut fournir lui-même ; enfin les aides que le code compilé cite ET que la documentation publique montre telles quelles (`µ._esc`, `µ._setHead`, `µ._clearHead`, `µ._glCl`, `µ._glSt`, `µ._updDynEl`, `µ._updModule`) et le dictionnaire `µ._vtPresets`, qu'une application garnit elle-même à son démarrage. Tout le reste de l'état CLIENT des familles temps réel (`µsocket`, `µgame`, `µchat`, `µlobby`, `µlockstep`, `µaccounts`, `µschema`, `µpredict`, `µjournal`… — 127 noms) passe au préfixe : rien de tout cela ne traverse le fil, les homonymes du serveur MJS-WS/MJS-Serveur sont d'autres objets, dans un autre processus. Il reste ainsi 19 noms entiers pour 235 occurrences dans le fichier du banc, contre 170 pour 1 092 — et 51 dans le cœur d'un site réel, contre 190. Mesuré sur l'application du banc (`framework-benchmarks/apps/mjs`, production, `js: "bundle"`, `runtime: "core"`, zlib niveau 9) : 83 496 → 75 164 octets bruts (−8 332, −9,98 %), 24 158 → 23 314 gzip-9 (−844, −3,49 %). Sur un site de documentation réel (743 composants, construction de production, manifeste éclaté) : cœur 273 375 → 254 345 octets bruts (−19 030, −6,96 %), 81 622 → 79 165 gzip-9 (−2 457, −3,01 %), et 12 895 622 → 12 691 453 octets pour tout le dossier de sortie. Sur l'adaptateur `js-framework-benchmark` keyed : cœur 46 319 → 40 194 (−6 125, −13,2 %), fichier du composant 7 613 → 7 260. Second passage (état client temps réel, lectures du rendu serveur routées par l'accès long, cinq aides internes du routeur/UJS/transitions), mesuré au même endroit avec `gzip -9` : fichier du banc 75 241 → 74 824 octets bruts (−417), 23 351 → 23 304 gzip-9 (−47) ; cœur du site de documentation 254 408 → 248 900 octets bruts (−5 508, −2,17 %), 79 177 → 78 534 gzip-9 (−643) et 5 028 933 → 5 021 701 octets pour ses 761 fichiers `.js` (776 535 → 776 067 une fois tout concaténé et compressé). Rien ne change au runtime : 500 composants du site montés avant/après rendent le même balisage — 495 à l'octet, et les cinq restants s'expliquent tous : deux (une horloge, un tirage au sort) rendent déjà un balisage différent d'un montage à l'autre du MÊME build ; les trois autres, montés seuls au lieu d'un paquet de vingt-cinq, rendent le même balisage des deux côtés, et le banc keyed joué dans un Chromium réel (création de 1 000 lignes, mise à jour, permutation, effacement) rend les mêmes temps à la trame près, sans une erreur de page.

- **Ajouté — `render.startup` : le HTML figé d'une page prérendue dit lui-même ce que la page démarre, jusqu'à assembler ses composants en un fichier par page.** Le manifeste est le seul à savoir quels composants une page affiche : ils ne partaient donc qu'après son téléchargement ET son exécution, en seconde vague. La page prérendue le sait dès sa construction. Nouvelle clé du bloc `render`, surchargeable par route, qui ne concerne que les routes `prerender` : `"preload"` (défaut) pose en tête de fragment un `<link rel="modulepreload">` par unité de son **ensemble de démarrage** — les composants dont la balise est dans le HTML rendu, fermés par leurs dépendances directes (un enfant qu'un `{if}` faux n'a pas rendu en fait partie) et les modules qu'ils importent ; `"bundle"` ajoute, en construction de production, un `mjs_page-<page>-<empreinte>.js` qui assemble les COMPOSANTS de la page, le fragment ne portant plus qu'un lien vers ce fichier, un lien par module et une fiche `<script type="application/json" id="__mjs_page">` que le manifeste relit pour y repointer `µ.paths` — son bloc de préchargement ne redemande alors aucun fichier séparé, et l'autoloader, en important n'importe quelle balise de la page, charge le fichier déjà en cache qui définit tous les autres ; `"none"` laisse le fragment nu. Restent externes au fichier de page : le cœur, les feuilles, les animations, les fichiers de langue, le manifeste externe et les **modules** — un module doit rester une instance unique, un store exporté par un module et dupliqué casserait l'état partagé. Les fichiers séparés existent toujours (une autre page les charge seuls, le rendu serveur les lit un par un, et il écarte le fichier de page comme il écarte le manifeste). Une page de moins de deux composants reçoit le préchargement seul ; en développement, `"bundle"` se comporte comme `"preload"` avec une ligne au journal du build ; `"bundle"` avec `js: "bundle"` est refusé au build (le fichier unique livre déjà tout le projet). Le nom du fichier de page vient de l'URL de la route (`/` → `mjs_page-index-…`, `/a/index` → `mjs_page-a-index-…`) et deux routes qui donneraient le même nom sont refusées à la lecture de la configuration, nommées toutes les deux ; les langues d'une même route partagent leur URL, donc leur fichier, qui assemble l'union de leurs composants — chaque fragment déclarant dans sa fiche l'ensemble de démarrage de SA langue, fermé par les dépendances statiques du gabarit (un enfant déclaré dans une branche `{if}` sur la langue est donc déclaré dans les deux). Les fichiers de page entrent dans `mjs-precache.json` comme le reste des sorties, et la purge des orphelins d'un build attend qu'ils soient écrits. Un fragment dont le HTML rendu ne change pas n'est pas réécrit (son en-tête de démarrage est borné par deux lignes de commentaire, que le prérendu retire avant de comparer) : deux constructions de suite laissent les dix fragments du site de référence intacts, à la date près. Mesuré sur une copie du site de référence construite en production, Chromium bridé (RTT 150 ms, 1,6 Mb/s, cache vide), coquille de page qui précharge le fichier de langue, médiane de trois passes, fin du dernier JS : accueil (24 composants) 1 759 ms → 1 566 ms en `"preload"` → 1 465 ms en `"bundle"`, 31 → 31 → 8 requêtes JS et 263,8 → 242,4 → 242,6 Ko transférés (gzip) ; `/doc` (4 composants) 1 322 → 1 136 → 1 123 ms, 9 → 9 → 6 requêtes ; `/tuto` (6) 1 503 → 1 165 → 1 136 ms, 11 → 11 → 6 requêtes. Fichiers de page : accueil 233,4 Ko bruts / 43,7 Ko gzip, `/doc` 56,2 / 16,0, `/tuto` 70,4 / 19,4. Ce que `"bundle"` coûte, en échange : un composant partagé est téléchargé une fois par fichier de page qui l'embarque, et la modification de l'un d'eux change l'empreinte de tout le fichier. Le dossier des pages figées est aussi tenu, et le build n'y touche QUE ce qu'il a écrit : un fragment que plus aucune route prérendue n'attend est supprimé à la construction suivante (une ligne de journal par fichier, le sous-dossier vidé de ses fragments retiré avec eux, rien si le prérendu a échoué) — jusqu'à la dernière page du projet passée en `csr`, dont le fragment part comme les autres, au lieu de rester servi avec des liens vers les fichiers de page que le même build vient de purger. Un fragment se reconnaît à sa première ligne : la marque `<!-- mjs:prerender` (les fragments des constructions antérieures à cette marque sont reconnus à leur ancien bandeau) ; tout autre `.html` du dossier reste intact, et `render.outDir` peut donc être un dossier public partagé ou la racine du projet — il doit en revanche rester dans le projet, un `..` ou un chemin absolu ailleurs étant refusé à la lecture de la configuration.

- **Modifié — les dictionnaires de traduction quittent le manifeste pour un fichier par langue (`mjs_i18n-<langue>-<empreinte>.js`), et la table des chemins ne répète plus son préfixe commun.** Le manifeste est servi sur CHAQUE page : il portait la prose des DEUX langues d'un site bilingue (dictionnaires racine + table des sections, 105 116 octets bruts sur le site de référence, dont un visiteur n'en voit jamais que la moitié) et répétait 1 398 fois le même début d'URL de composant. Le build écrit désormais, dans `outputDir`, un module par langue — racine + table des sections de CETTE langue, nom haché sur son contenu comme un composant — et le manifeste ne garde que les réglages i18n, la liste des langues et l'URL du fichier de chacune ; le préfixe commun des chemins est publié une seule fois (`µ.pathsPrefix`), chaque valeur de `µ.paths` ne gardant que son suffixe (l'Autoloader et le préchargement recollent les deux ; en `js: "bundle"`, forme inchangée). Le runtime décide la langue (`?lang=`, mémoire, navigateur, défaut — validée sur la liste des langues, plus sur les dictionnaires), charge son fichier, PUIS démarre : les composants montés pendant cette attente passent par la file déjà existante (mode `wait` : premier rendu après l'arrivée ; `auto`/`key` : placeholder puis réinvalidation). Quand la langue affichée n'est pas celle par défaut, le fichier de la langue par défaut est chargé EN MÊME TEMPS — c'est lui qui porte les replis de clé et de section, qui restent donc instantanés. Fichier introuvable (bundle périmé, 404) : crié une fois, jamais un gel — les textes retombent sur la langue par défaut, ou sur leur placeholder. Le rendu serveur, lui, a tout en mémoire : il sème chaque langue par le même point d'entrée (`µ._i18nLang`) et démarre sans rien charger. Mesuré sur le site de référence (1 398 composants, 356 sections par langue, fr + en, construction de production) : `bundle_modular.js` 237 762 → 95 302 octets bruts (-60 %), 54 280 → 20 946 octets gzip-9 (-33 334 octets sur chaque page servie), plus le fichier de la langue affichée, téléchargé une fois puis gardé en cache (fr 38 851 bruts/16 708 gzip, en 37 721/16 242). Compté sur une visite ENTIÈRE : la première page paie encore ce fichier, le solde y est donc de -16 626 octets gzip en français (une seule langue) et d'environ zéro en anglais (-384 octets : langue affichée + langue par défaut, qui porte les replis) ; dès la DEUXIÈME page, les fichiers de langue viennent du cache et le gain est plein, -33 334 octets gzip par page. Ce que le manifeste ne PORTE plus, il le garde en empreinte : une traduction modifiée change le fichier de sa langue ET l'URL que le manifeste en publie — le manifeste change donc encore, comme à chaque construction ; les fichiers des autres langues et le JavaScript des composants, eux, ne bougent pas. Une coquille de page qui connaît la langue avant le JavaScript (layout Rails, gabarit PHP) peut annoncer le fichier par `<link rel="modulepreload">` — celui de la langue affichée et, si elle en diffère, celui de la langue par défaut, le runtime attendant les deux avant de démarrer : mesuré sur la page d'accueil, il passe alors de la 2e vague (1 175 → 1 801 ms) à la première (165 → 670 ms, avec le cœur), sans aucune attente ajoutée. Rechargement à chaud : un changement de traduction reste un rechargement complet de la page, comme avant (nouveau fichier de langue, nouvelle URL au manifeste) — pas de correctif ciblé dans ce lot.

- **Modifié — en `js: "bundle"`, l'autoloader n'est plus embarqué ; le moteur d'hydratation SSR suit le bloc `render` ; les mutations profondes, le pool de nœuds texte, l'échappement HTML et le `{for}` imbriqué ne sont joints au cœur qu'à l'usage.** Six briques quittent `mjs_element.ts`, `mjs_init.ts` et `mjs_for.ts` pour leur propre fichier, jointes chacune sur un signal EXACT — un appel que le compilateur émet lui-même, ou une clé de configuration : **autoloader** (`µ.Autoloader`) reste du cœur en `js: "split"`, où chaque composant est un fichier à aller chercher, et sort du cœur en `js: "bundle"`, où le fichier unique définit lui-même tous les composants avant de rendre la main ; à sa place, un contrôle unique signale en console chaque balise `mjs-*` qu'aucun composant ne définit (une faute de frappe se voit, au lieu de rester muette), et `"runtime": ["autoloader"]` le remet. **hydrate** (`mjs_hydrate.ts` — les trois approches d'adoption du DOM serveur : marqueurs, walk positionnel, diff) est joint dès qu'une page du bloc `render` demande `ssr:markers`, `ssr:positional` ou `ssr:diff`, par `render.default` ou par le `mode` d'une route ; `csr`, `prerender` et `ssr`/`ssr:replace` n'adoptent rien. Un serveur qui rend par l'API sans bloc `render`, ou une route `ssr` dont les clients demandent une variante d'hydratation par en-tête HTTP, le réclame par `"runtime": ["hydrate"]` — et si la page demande quand même l'hydratation, rien ne casse : un avertissement une seule fois, puis la vue est reconstruite façon `replace`. **deep** (`mjs_deep.ts` — `µ._deepSet`/`µ._deepCall`/`µ._deepDelete`/`µ._mjs_makeDeepProxy`) est joint dès qu'une source mute en profondeur (`$o.x = v`, `$liste.push(v)`, `delete $o.x`, rune `µproxy`) ; une écriture à la racine n'en a pas besoin, et le filet `_wrapDeep` du cœur couvre toujours les mutations qui échappent au suivi statique. **textpool** (`mjs_textpool.ts` — `µ._getTextNode` et la libération qui va avec) est joint quand le générateur puise ses placeholders de texte dans le pool, c'est-à-dire pour un `{for}` dans une branche `{await}` ; servir et rendre partent ensemble, remplir un pool où personne ne puise ne ferait que retenir des nœuds morts (l'appel du cœur à la libération est gardé). **esc** (`mjs_esc.ts` — `µ._esc`) est joint dès qu'une interpolation d'un `<@head>` ou du repli d'un `<@failed>` part en HTML, et d'office hors production, où le panneau de développement l'appelle pour son propre affichage. **for_nested** (`mjs_for_nested.ts` — `_updList`) est joint pour un `{for}` dans une autre liste ou dans une branche `{await}` ; à la racine, dans un `{if}` ou dans un `{key}`, `mjs_for.ts` suffit. Mesuré sur l'application du banc (`framework-benchmarks/apps/mjs`, construite en production, aucune des six briques utilisée) : fichier unique `js: "bundle"` 89 471 → 83 036 octets bruts (−6 435, −7,2 %), gzip-9 25 941 → 24 045 (−1 896, −7,3 %) ; cœur seul (`js: "split"`, `runtime: "core"`) 56 444 → 52 146 octets bruts, gzip-9 18 398 → 17 211. Poids de chaque brique, isolé en la forçant sur une copie qui ne s'en sert pas (`"runtime": ["<clé>"]` contre `"core"`, octets bruts / gzip-9) : hydratation 2 652/692, mutations profondes 1 124/335, pool de nœuds texte 692/203, `{for}` imbriqué 261/28, échappement HTML 173/75 ; l'autoloader, lui, pèse 2 131 octets bruts (715 gzip-9) du fichier unique. `µ._pushComponent`/`µ._popComponent` (pile du composant en cours d'initialisation) restent dans le cœur : aucun appelant dans le framework, mais deux suites de tests s'en servent comme API — retirés, elles casseraient.

- **Corrigé — dans `<@head>` et dans le repli d'un `<@failed>`, une donnée venue d'ailleurs pouvait ajouter un attribut à une balise, voire fabriquer l'élément entier ; et un guillemet posé « au cas où » derrière un `=` cassait les valeurs qui en contiennent un.** Le contenu de ces deux blocs part en `innerHTML` : l'échappement couvre `<`, `>`, `"`, `'` et `&`, jamais l'espace ni le `=`. Dans une valeur nue (`href=https://x/{$slug}`), à la place d'un attribut (`<meta {$attrs}>`) ou comme nom de balise (`<{$tag}>`), une donnée contenant `x onload=alert(1)` ajoutait donc un attribut exécutable — et, pour le nom de balise, tout un `<img src=x onerror=…>` — sans un mot : ces trois écritures sont désormais une erreur de compilation qui nomme le bloc, la ligne du `.mjs` et la forme correcte (`href="https://x/{$slug}"`), une erreur par interpolation fautive, et la construction échoue. Symétriquement, les guillemets d'une valeur réduite à son interpolation (`content={$x}`) sont posés par le tokeniseur, à l'émission : une interpolation écrite DANS une valeur déjà quotée y reste (`href="…?p={$slug}"`, `data-cfg="k={$x}"` — le guillemet ajouté derrière le `=` du paramètre fermait la valeur et rendait la donnée maîtresse de la balise), et un `=` en TEXTE ne reçoit plus de guillemets inventés (`<title>a={$x}</title>`, `{{…}}` y retrouve son HTML brut). Les positions sont celles d'un navigateur (tokeniseur HTML5) : dans une valeur SANS guillemets, un `"` ou un `=` est un caractère littéral et la valeur s'arrête au premier espace (`a=b=" {$x}"` n'était pas une valeur protégée, mais deux attributs de plus) ; un `=` sans nom d'attribut devant lui (`<meta ={$x}>`, `<meta={$x}>`, `<meta a="b"/={$x}>`) n'ouvre aucune valeur — il est le premier caractère d'un nom d'attribut, ou du nom de balise —, ces écritures sont donc refusées elles aussi ; un commentaire se ferme sur `-->`, `--!>`, `<!-->` et `<!--->` (ne connaître que `-->` classait tout le reste du bloc en commentaire) ; et le blanc est celui du HTML — espace, tabulation, saut de ligne, saut de page, retour chariot —, un espace insécable ou un BOM après le `=` ouvrant une valeur nue. Restent licites : `attr={expr}` et `attr={{expr}}` en valeur d'attribut, toute valeur entre guillemets simples ou doubles, l'interpolation en texte, dans un commentaire ou dans un `<style>`, et une valeur nue SANS interpolation (`title=l'erreur`). Le message cite ce que l'auteur a tapé, symbole du projet compris (`{mjs$slug}` n'est jamais rendu `{µ$slug}`) ; dans un partial inclus, la ligne citée est celle du composant qui l'inclut. Des accolades LITTÉRALES dans une valeur (`data:text/css,body{color:red}`) restent lues comme une interpolation : elles s'écrivent `&#123;`/`&#125;` (documenté).

- **Corrigé — `{{…}}` s'affichait en texte, balises visibles, dans les branches d'un `{await}`, dans le repli d'un `<@failed>` et dans le contenu d'un `<@head>`.** Dans un `{await}`, le compilateur traitait `{{…}}` comme `{…}` : la valeur finissait dans un nœud texte. Dans `<@failed>` et `<@head>`, seul `{…}` était reconnu : `{{$h}}` affichait la valeur échappée entre deux accolades. `{{…}}` pose maintenant du HTML dans les trois, comme partout ailleurs (un instantané à la construction de la branche dans `{await}`, réactif dans `<@head>`) ; `{…}` y reste échappé, et dans une valeur d'attribut de `<@head>` ou de `<@failed>`, `{{…}}` reste lui aussi échappé et mis entre guillemets : une valeur d'attribut n'est jamais du HTML.

- **Corrigé — en production, une variable d'état d'une ou deux lettres (`$g`, `$s`…) pouvait afficher `false`, `1`, un chemin (`/out/`) ou un bout de CSS au lieu de sa valeur ; une prop de nom court écrite dans le code d'un parent et posée sur un enfant pas encore chargé, ou une méthode de nom court (`@r`), pouvait être écrasée de la même façon.** Le minifieur raccourcit les propriétés internes `_mjs_*` en noms d'une ou deux lettres, communs à tous les fichiers du projet (`.mangle-cache.json`), mais il n'écarte un nom déjà pris que dans le fichier qu'il est en train de minifier : le cœur, minifié après les composants, pouvait donc donner à `_mjs_dead` le nom `g` d'un `$g`, et la reprise des valeurs posées avant la mise à niveau de l'élément prenait ensuite la propriété interne pour l'état. La construction relève désormais, dans le code compilé de chaque composant, module `.civet`/`.coffee` et manifeste externe, les noms d'au plus trois caractères qu'une instance peut porter par nom (état, props, méthodes, gestionnaires) et les réserve dans le cache avant la première minification : plus aucune propriété interne ne les prend, une correspondance en conflit déjà enregistrée par une construction précédente est retirée du cache, et sous `mjs dev --prod` les fichiers minifiés avec elle sont re-minifiés dans le même tour (y compris en `js: "bundle"`, où un composant inchangé réutilise sinon son code en mémoire). Rien ne change au runtime. Le relevé est volontairement large (commentaires et chaînes compris : un nom réservé à tort coûte quelques octets, un nom manqué rouvrirait le défaut) ; mesuré sur l'application du banc (`framework-benchmarks/apps/mjs`, production, `runtime: "core"`, zlib niveau 9) : cœur en `js: "split"` 55 958 → 55 966 octets bruts (+8), 18 306 → 18 309 gzip (+3) ; fichier unique en `js: "bundle"` 90 960 → 90 968 octets bruts (+8), 25 935 → 25 936 gzip (+1). Reste hors de portée tout nom qui n'existe qu'à l'exécution : clé d'un objet étalé (`<@enfant {...obj}>`) sur un enfant pas encore chargé, clé de nom court d'un objet reçu (JSON) lue comme un marqueur interne, script de page non compilé qui écrit `el.g = 1`.

- **Corrigé — en production, une clé qui n'existe qu'à l'exécution pouvait vider un composant enfant ou geler une donnée pour de bon.** Le minifieur raccourcit les propriétés internes `_mjs_*` en noms d'une ou deux lettres ; une clé venue d'une donnée (un JSON reçu, l'objet d'une propagation `{...$data}`) n'est écrite nulle part dans le code, et aucune réservation ne peut donc l'écarter. Premier chemin : un parent qui propage un objet sur un enfant **pas encore défini** posait ses clés directement sur l'élément — une clé égale au nom court d'une méthode du composant la masquait, et l'enfant crevait à sa mise à niveau (« this.o is not a function »), vide, sans le moindre message ; en développement, rien ne cassait. Second chemin : un objet d'état qui portait, lui, le nom court du marqueur des valeurs dérivées passait pour une valeur dérivée — le remplacer (`$d = { … }`) ne changeait plus rien, sans erreur ni avertissement. Les props posées sur un enfant pas encore défini sont désormais retenues **hors** de l'élément, dans un registre que le montage reprend clé par clé, dans l'ordre d'arrivée et par le chemin exact d'un enfant déjà défini : l'état d'un enfant servi en retard est identique à celui d'un enfant arrivé à temps, et comme l'état n'est pas l'élément, aucune clé d'exécution n'y masque plus rien. La dernière écriture gagne, d'où qu'elle vienne : une propriété posée à la main sur l'élément (`el.count = 5`, le harnais de test, le rendu serveur) entre dans l'état comme avant, une prop que le parent écrit APRÈS elle passe devant — et une propriété que la page a **figée** (`Object.defineProperty(..., { configurable: false })`) n'est plus retirée : elle reste, gagne à la mise à niveau comme n'importe quelle propriété propre, au lieu de faire lever le rendu du parent (frontière d'erreur : parent vidé, enfant jamais monté). Ce registre ne couvre que les composants **du projet**, ceux du manifeste de distribution : un élément d'une autre bibliothèque (`<my-widget value={$x}>`, `<my-widget {...$props}>`, y compris une balise `mjs-` littérale absente du manifeste, et qu'elle soit déjà définie ou définie plus tard par son propre chargeur) reçoit ses props exactement comme avant, en propriétés de l'élément, qu'il lit à sa mise à niveau. **Changement assumé** : une prop qui porte le nom d'un attribut natif (`id`, `title`, `dir`) posée sur un composant du projet pas encore chargé entre désormais dans son état, comme sur un enfant arrivé à temps, au lieu de poser l'attribut HTML de l'élément. Les marqueurs lus sur une **donnée** gardent leur nom long, jamais raccourci, et les aides du cœur que le code compilé cite (`µ._p`, `µ._tm`, et `µ._al` ci-dessous) voient leur nom réservé dans le cache de raccourcissement — sans quoi une propriété interne pouvait le recevoir et écraser l'aide. Coût mesuré sur l'application du banc, chaque pièce contre l'arbre qui ne la porte pas : 365 octets pour le registre et le marqueur (dont 33 pour le marqueur, 0 pour les deux aides), 169 de plus pour le tri des éléments tiers et la garde de retrait — bundle de 83,1 Ko, +54 octets gzip-9. **Deux composants qui se disputent le même alias court** (`doc/doc-carte.mjs` et `tuto/tuto-carte.mjs`, tous deux candidats à `<mjs-carte>`) n'enregistrent plus cette balise : la clé quitte déjà le manifeste — aucun des deux ne peut la revendiquer — mais la balise courte restait enregistrée par le premier module chargé, et absente du manifeste elle passait pour un élément d'une autre bibliothèque ; les clés d'une donnée étalée dessus devenaient alors des propriétés de l'élément, qui masquent les méthodes du prototype en production (« this.a is not a function », composant vide, mesuré en fichier unique comme en manifeste éclaté). La balise ambiguë est désormais aussi inerte qu'une faute de frappe, chaque composant reste joignable par sa balise complète (`<mjs-doc-carte>`), et la construction le dit : un gabarit qui écrit la balise courte reçoit un avertissement qui nomme les composants en dispute et la balise à écrire à la place. Un alias que personne ne dispute ne change pas. **Une propriété qu'une page a figée en LECTURE SEULE sur un élément d'une autre bibliothèque** (`Object.defineProperty(el, 'value', { writable: false })`) n'emporte plus le rendu de l'hôte : l'écriture lève en mode strict, et l'exception partait du rendu du parent — frontière d'erreur, hôte vidé, rien de dit. Elle est maintenant retenue : la valeur posée par la page reste, un avertissement nomme la balise et la clé, une seule fois par élément et par clé. Enfin, une balise tierce dont le nom EST une clé héritée d'`Object` (`<mjs-constructor>`) reçoit de nouveau ses props comme n'importe quel élément étranger : le manifeste est interrogé en propre, un héritage n'y passe plus pour une entrée. `__proto__`, `constructor` et `prototype` restent refusées comme clés, élément tiers compris. **L'enregistrement d'un alias court est une aide du cœur** (`µ._al`), appelée par le composant avec ses trois arguments — le test lui-même (balise déjà prise, clé au manifeste, sous-classe anonyme) n'est plus recopié dans chaque fichier compilé : sur un site de documentation réel — 755 composants, dont 657 porteurs d'un alias — les fichiers de composants passent de 4 641 325 à 4 551 463 octets bruts (−89 862) et de 1 210 438 à 1 174 769 octets gzip-9 (−35 669), l'aide ne coûtant que 151 octets bruts (32 gzip-9) une seule fois, dans le cœur. Coût de ce lot, mesuré sur l'application du banc (production, `js: "bundle"`, `runtime: "core"`) : 83 120 → 83 496 octets bruts (+376, +0,45 %), 24 173 → 24 288 gzip-9 (+115) — dont 35 octets pour la lecture en propre du manifeste, 151 pour l'aide d'alias (cette application n'écrit aucun alias : elle paie l'aide sans rien économiser), le reste pour la garde de lecture seule.

- **Modifié — le code compilé retrouve ses nœuds par `µ._p(_f,2,0)` et matérialise ses marqueurs texte par `µ._tm(…)`, au lieu d'écrire une chaîne de propriétés et un bloc de quatre instructions.** Une fonction de construction naviguait jusqu'à ses nœuds par `_f.firstChild.nextSibling.nextSibling.firstChild` et remplaçait chacun de ses marqueurs de commentaire par un nœud texte en quatre instructions ; deux aides du cœur (`mjs_dom.ts`, toujours joint) disent la même chose en trois fois moins de signes, en descendant les mêmes index (`childNodes[i]`, soit le i-ème enfant) et en rendant les mêmes nœuds. L'écriture compacte n'est posée que là où le corps est construit UNE fois — racine du composant, branches `{if}`/`{await}`/`{key}` hors boucle — et seulement quand elle est plus courte d'au moins trois octets ; le gabarit de ligne d'un `{for}`, lui, est exécuté une fois par ligne : il garde ses chaînes de propriétés directes, sans appel de fonction, et son code reste identique à l'octet. Mesuré sur l'application du banc (`framework-benchmarks/apps/mjs`, construite en production, `js: "bundle"`) : 90 968 → 89 106 octets bruts (-1 862, -2,05 %) ; gzip -9 25 843 → 25 804 octets (-39, -0,15 % seulement — les chaînes de propriétés répétées se compressent très bien, le gain porte sur les octets livrés sans compression). Vérifié monté : sur une application réelle de 742 composants, les 534 montés des deux côtés (504 dont le code compilé change, plus 30 tirés au hasard) rendent le même balisage, aux trois qui tirent au sort à chaque montage près.

- **Modifié — la frontière d'erreur `<@failed>` (affichage du repli, remontée de l'erreur d'un enfant vers l'ancêtre qui porte un repli, limite de réessai), l'interpolation brute `{{…}}` (`_updHtml`), le rangement des slots indexés (`_injectSlots`), l'attente des feuilles partagées en `css: "lazy"` et le gel du premier rendu i18n en mode `wait` quittent `mjs_element.ts` : chacun n'est joint au cœur que s'il sert.** La frontière rejoint `mjs_failed.ts`, joint comme avant dès qu'une source écrit `<@failed>` ou la rune nue `µfailed` ; sans elles, aucun composant n'a de repli et un crash affiche directement le panneau fatal. `{{…}}` et `<@slot>` deviennent deux éléments détectés dans le code compilé, `html` (`mjs_html.ts`, par l'appel que le compilateur émet pour chaque `{{…}}` ailleurs que dans un `{for}` ou un `{await}`, qui posent le contenu eux-mêmes) et `slots` (`mjs_slots.ts`), tous deux forçables par `"runtime": ["html"]`/`["slots"]` ; le constructeur compilé n'appelle plus `_injectSlots` que pour un composant qui écrit `<@slot` (la méthode ne faisait rien pour les autres). L'attente des feuilles différées suit `css: "lazy"` dans `mjs_lazy_css.ts` (`µ._lazyCssWait`), le gel i18n suit le module `i18n` dans `mjs_i18n.ts` (`µ.i18n._connect`) ; dans le cœur ne restent que les appels gardés par un test d'existence, hors de toute boucle de rendu. Comportement inchangé, vérifié monté : repli propre, repli d'un ancêtre, repli qui jette à son tour, limite de réessai, `{{…}}` rendu puis mis à jour dans chaque bloc, slots indexés et slot par défaut dans un Chromium réel, masquage pendant le chargement d'une feuille différée et bascule de variant concurrente, gel puis rendu i18n. Mesuré sur l'application du banc (`framework-benchmarks/apps/mjs`, construite en production avec `runtime: "core"` et `js: "split"`, aucune des cinq briques utilisée) : le cœur passe de 57 661 à 55 958 octets bruts (−1 703, −2,95 %), gzip-9 de 18 819 à 18 306 octets (−513, −2,73 %) — frontière `<@failed>` −935/−285, `{{…}}` −264/−55, slots −197/−67, `css: "lazy"` −141/−70, gel i18n −166/−36 (octets bruts/gzip-9, retirés dans cet ordre).

- **Modifié — un projet d'au plus 40 fichiers compilés (composants `.mjs` + modules `.civet`/`.coffee`) est transpilé DANS le processus principal, sans démarrer le moindre fil d'exécution.** Le parallélisme par fils coûte le chargement complet du compilateur (paquet du travailleur, SASS, Civet) dans CHAQUE fil, plus l'attente du maître pendant leur démarrage — sur un petit projet, cette mise en route dépasse le travail qu'elle abat. Le corps exécuté est exactement le même des deux côtés (une seule définition, appelée par les deux chemins), la sortie reste identique à l'octet et une erreur de composant remonte pareil dans le compte rendu de construction. Le choix se refait à chaque construction, `mjs dev` compris : un projet qui franchit le seuil repasse aux fils au tour suivant. Mesuré le 16/09/2026 sur 8 cœurs (médiane de 5 constructions `--prod`, en direct contre par fils) : application de référence à 8 composants 616 ms contre 1 089 ms (-473 ms, -43 %) ; à 16 composants 790/1 466 ms, à 24 composants 947/1 649 ms, à 40 composants 1 140/1 892 ms. La minification de production reste séquentielle et triée par nom de module, inchangée : la construction reste déterministe.

- **Modifié — le thème clair/sombre embarqué (`µ._themeSheet`/`µ._themeAppSheet`/`µ._themeAdopt`, 8 variables `--mjs-surface`/`fg`/`fg-muted`/`border`/`hover`/`selected`/`accent`/`shadow`) rejoint les éléments du cœur qui ne sont embarqués que s'ils servent, dans son propre fichier (`mjs_theme.ts`, détaché de `mjs_init.ts`).** Embarqué dès qu'une source lit une des 8 variables (`var(--mjs-x)`, ou `$$x` — réécrit en texte CSS littéral avant la compilation JS), dès que `µtheme` est utilisé, dès qu'un fichier `*.theme.mjs` existe dans le projet, ou dès que `title`/`modal` (les deux SEULS modules du framework qui lisent réellement une des 8 variables, vérifié par grep) est du bundle. Une page servie hors construction qui les lit sans qu'aucune source compilée ne le révèle reste invisible au scan : `"runtime": ["theme"]` la force. Mesuré sur l'application du banc (`framework-benchmarks/apps/mjs`, `--prod`, `js: "bundle"`) : le bloc pèse 817 octets bruts / 251 octets gzip-9 (`gzip.compress` Python) une fois embarqué contre absent — écart isolé en forçant `runtime: ["theme"]` sur une copie sans aucun usage, comparée à la même copie sans ce forçage. Écart connu : le cœur d'un projet qui utilise le thème n'est plus identique à l'octet près à l'historique (bloc déplacé du MILIEU de `mjs_init.ts` vers `mjs_theme.ts`, positionné juste après en ordre de concaténation — la taille et le contenu restent identiques, l'ORDRE des instructions diffère ; la cascade `document.adoptedStyleSheets` entre les feuilles du thème reste inchangée entre elles, rien d'autre n'adoptait de feuille dans l'intervalle).
- **Modifié — les lectures `µ.debug` mortes en production sont réellement éliminées du bundle minifié.** Dans les sources du runtime, les LECTURES (`if (µ.debug)`, `µ.debug &&`, `µ.debug ?`) passent par l'identifiant libre `MJS_DEBUG` ; les écritures (`µ.debug = …`) restent inchangées. En build de production, le minifieur reçoit `define: { MJS_DEBUG: 'false' }` en plus de ses définitions existantes, ce qui élimine chaque branche morte à la compilation. Hors production, la concaténation du cœur remplace `MJS_DEBUG` par `µ.debug` avant minification — la bascule console `µ.debug = true` reste vivante en développement. Mesuré sur l'application du banc (même méthode, `define` désactivé pour isoler l'écart) : 564 octets bruts / 193 octets gzip-9 retirés.

- **Ajouté — `"js": "bundle"` fusionne TOUT (cœur, styles partagés, animations, manifeste externe, modules, composants) dans le seul fichier `manifestPath`, pour une appli qui préfère une requête JS unique à une cascade de petits fichiers.** Défaut inchangé (`"split"`, ou la clé absente) : comportement historique, vérifié byte pour byte identique entre les deux écritures (`js` absent et `"split"` explicite produisent le MÊME `dist/`, sur l'application météo du banc comme sur une fixture parent/2 enfants/module/animation/feuille partagée). En `"bundle"`, l'assemblage passe par `esbuild.build()` en mémoire sur des modules virtuels (jamais un fichier temporaire sur disque) : le cœur, les styles, les animations et chaque composant/module gardent leur code déjà compilé et minifié, réassemblés en un seul module ES en quelques dizaines de millisecondes ; les enfants se définissent toujours avant leurs parents. Exige `"css": "bundle"` (le défaut) : incompatible avec `"css": "split"`/`"lazy"`, message dédié au catalogue. Le rendu serveur et le rendu navigateur restent TOUJOURS en `"split"` en interne, quel que soit ce réglage : ils rechargent le cœur et les composants fichier par fichier pour leurs propres besoins (prérendu, tests Chromium), sans que cela change quoi que ce soit à ce qu'un visiteur reçoit. Mesuré sur l'application météo du banc, mêmes sources compilées dans les deux modes (12 fichiers/12 requêtes JS avant, 1/1 après, requêtes comptées avec un Chromium réel via Playwright) : 96 309 → 93 190 octets bruts (-3,2 %), 32 996 → 26 314 octets gzip-9 (-20,3 %, `gzip.compress` Python sur chaque fichier, jamais `gzip -c`) — le gain gzip dépasse largement le gain brut parce que fusionner supprime l'en-tête/le prologue d'import répété de chaque petit fichier, qui compressait mal séparé des onze autres.

- **Corrigé — un composant `@lightDom` construit dans une branche `{success}`/`{error}` d'un `{await}` rejouée (tag déjà chargé) disparaissait purement et simplement, lui et ses propres enfants `@lightDom` auto-chargés, sans que rien ne le signale.** Ces branches construisent l'enfant en deux temps, `document.createElement(tag)` puis `setAttribute('mjs-light', '')` juste après : une fois le tag défini, `createElement` construit l'instance de façon SYNCHRONE, avant ce `setAttribute` — `hasAttribute('mjs-light')` échouait donc dans le constructeur (mode ombre pris à tort), et surtout, le mode léger insère son propre contenu par `this.appendChild(...)` **dans le constructeur** : la spécification Custom Elements interdit formellement à un élément d'avoir des enfants à la sortie de son constructeur quand celui-ci est déclenché par `createElement` avec le tag déjà défini — le navigateur lève alors `NotSupportedError` (« The result must not have children »), qui remonte non capturée dans le composant appelant et fait avorter toute sa reconstruction. Au tout premier passage (tag pas encore défini), l'upgrade est différé à la connexion réelle : ni la détection ni la construction n'y sont concernées, d'où un premier rendu toujours correct qui masquait le bogue. Le code généré de ces branches pose désormais un drapeau transitoire juste avant `createElement` (effacé juste après), consommé par le constructeur pour cette seule instance — jamais un Set par tag (une première version de ce correctif en essayait un, RETIRÉE : `@lightDom` est une directive d'INSTANCE, pas de définition du composant, deux usages du même tag peuvent différer, un Set partagé aurait forcé le second en mode léger par contamination du premier). L'insertion du contenu léger est différée à `connectedCallback` (qui n'a pas la contrainte « pas d'enfants ») au lieu du constructeur. Un composant sans `@lightDom` (vrai Shadow DOM, jamais concerné : il insère dans son Shadow Root, jamais dans lui-même) n'est pas affecté.

- **Corrigé — une rune du sucre universel (`µraw`, `µsnap`, `µplay`, `µminmax`, `µinspect` — `mjs_rare_runes.ts`) écrite dans une expression du HTML (interpolation de texte `{...}` ou valeur d'attribut simple `prop={...}`) n'était pas réécrite en `µ.raw(...)`/`µ.snap(...)`/... : elle restait littérale dans le JS final et provoquait un `ReferenceError` au premier rendu (`µraw is not defined`), par exemple `weatherData={µraw(result)}` dans une branche `{success result}` d'un `{await}`.** Le `<script>` et les gestionnaires d'événement (`@click={...}`) en étaient déjà protégés (compilés par le même moteur que le script) ; les interpolations de texte et les valeurs d'attribut passent désormais par le même sucre `µfoo → µ.foo`, avec le même remodelage d'arguments pour `µinspect`/`µminmax` (clé d'état passée en chaîne, instance du composant injectée). `µasset`/`µimage`, jusqu'ici pointés dans le script mais laissés littéraux dans une expression HTML, suivent maintenant la même règle — sans effet sur leur résolution par le bundler, qui reconnaissait déjà les deux formes.

- **Documenté — `docs/05-blocs.md` précise qu'une promesse remplacée pendant l'attente d'un `{await}` est ignorée si elle se résout ou échoue après coup : seule la dernière promesse assignée peut encore faire basculer l'affichage.**

- **Modifié — le cœur (`mjs_core-<hash>.js`) se décide désormais d'après le CODE COMPILÉ des composants et des modules, plus jamais d'après un balayage du texte des sources.** `compile()` compile d'abord tous les composants `.mjs`, modules `.civet`/`.coffee` et le manifeste externe en mémoire (le cœur est encore inconnu), déduit les briques nécessaires des appels réellement présents dans leur sortie compilée (`this._updFor(`, `µ.Store`, `this._mjs_emit(`…), construit le cœur, puis écrit tout le reste en résolvant les chemins qui dépendaient de lui. Seul le fichier de variant de mise en page déposé à la main dans le dossier de sortie (`<module>.<nom>.css`, un endroit que la construction ne compile jamais) reste un signal lu en dehors du code compilé. Corrige un `{for}`/`{if}`/`µ.Store`/`@title`… mentionné dans un commentaire HTML ou une chaîne de caractères — auparavant embarqué à tort dans le cœur (faux positif texte, mesuré sur un cas réel : `<!-- {for x in xs} -->` + `'µ.Store'` en chaîne) ; et surtout, plus aucune forme compilée valide ne peut être ratée par une variante d'écriture non prévue par une expression régulière sur le texte source. Coût : le cache par empreinte de contenu est conservé (deux builds identiques ne réécrivent rien) ; un changement du cœur (nouveau module qui entre ou sort) réémet les composants et modules en cache avec le nouveau chemin, comme avant. La minification (build `--prod`) reste séquentielle et triée par nom de module, jamais lancée en parallèle avec la transpilation : le carnet de noms courts (`mangleCache`) est un état partagé, et un ordre d'achèvement aléatoire des compilations concurrentes lui aurait fait attribuer des noms différents d'un build à l'autre pour un même code source — vérifié stable sur 3 builds frais consécutifs, composants, module importé et cœur compris.

- **Corrigé — l'alias ASCII du symbole (`"sigil": "mjs"`) s'applique aussi aux modules `.civet`/`.coffee` importés.** Un module importé qui écrivait `mjs.log(…)` ressortait tel quel, et `mjs` n'existe pas à l'exécution ; il est désormais réécrit en `µ.log(…)`, comme le script d'un composant.

- **Ajouté — une rune séparée de son symbole par un espace ou un retour à la ligne est refusée à la compilation, avec la ligne du fichier et l'écriture attendue** (`µ` puis `.setContext(…)` à la ligne suivante, `µ .emit 'x'`, `µ.` puis `toast(…)` à la ligne suivante ; `mjs` de même quand l'alias est configuré). Coupée ainsi, la rune échappait aux réécritures du compilateur comme à la détection des modules du cœur : le composant compilait, puis plantait à l'exécution (`µ.setContext is not a function`). La règle vaut pour toutes les runes, dans le `<script>`, le `<script module>`, le script des partiels `<@include>` et les modules `.civet`/`.coffee` importés ; chaînes, heredocs, commentaires et littéraux regex exclus, code des interpolations `${…}`/`#{…}` compris. La forme `µ.` puis la rune à la ligne suivante, qui fonctionnait pour `setContext`/`getContext` seulement, est refusée comme les autres : une seule écriture, sur une ligne.

- **Modifié — `_mjs_emit` (`µemit`, `@emit.NOM=`/`@emit.once.NOM=`, le sucre `@geste.emit.NOM`), le contexte de sous-arbre (`§clé` figé, `§§clé` réactif, leurs formes ASCII `__context.clé`/`__shared.clé` de l'option `contextAlias`, et les runes `µsetContext`/`µgetContext`, avec ou sans point), les crochets de cycle de vie en runes (`µmount`/`µawake`/`µsleep`/`µdestroy`/`µurlChange`, et `µfailed` écrite en RUNE NUE — distincte de la balise `<@failed>`, qui reste détectée séparément) ainsi que les balises globales `<@window>`/`<@document>`/`<@body>`/`<@html>`/`<@head>`, dont le code compilé s'attache et se détache par ces mêmes crochets, les variants de mise en page nommés (déclarés par `<style name="…">`, demandés par `layout="…"`/`template="…"`, y compris depuis une page que le build ne lit pas) et le chemin LENT de destruction (orchestration des transitions `@transition`/`@in`/`@out`, des teardowns `@attach`/`@this=!`, de `@flip`) rejoignent les éléments du cœur qui ne sont embarqués que s'ils servent — chacun dans son propre fichier (`mjs_emit.ts`/`mjs_context.ts`/`mjs_lifecycle.ts`/`mjs_layout_variant.ts`/`mjs_destroy_hooks.ts`, détachés de `mjs_element.ts`).** `lifecycle` embarque en plus dès que `every`, `interpolate`, `smooth`, `socket` ou le cache de pages (`router`/`ujs`/`modal`) est du bundle — `µevery` appelle `_onDestroy`/`_onSleep`/`_onAwake` sans aucune garde, les quatre autres s'en servent pour tout défaire à la destruction ; le chemin RAPIDE de destruction (composant sans aucun de ces hooks, drapeau `__mjs_noDestroyHooks` posé au compile) reste dans le cœur, inchangé, pour toute destruction. Sur l'application météo du banc (utilise `µemit` et un hook de cycle de vie, jamais §/§§, variant de mise en page ou transition) : le cœur passe de 63 935 à 57 053 octets bruts (-6 882 octets, -10,8 %), gzip -9 de 20 831 à 18 650 octets (-10,5 %) — l'affichage (météo courante + prévisions sur 7 jours + recherche de ville) reste inchangé. Sur un projet sans aucun des cinq : le cœur passe de 49 703 à 41 375 octets bruts (-8 328 octets, -16,8 %), gzip -9 de 16 231 à 13 639 octets (-16 %).

- **Modifié — le cache de pages hibernées du routeur/UJS (`µ.LRUCache`, `µ._isPageCached`, `µ._destroyEvictedTree`, le panneau d'erreur de route, les libellés `µ._label`/`µ._labelLang`) et le mode CSS différé (`css: "lazy"`, `µ._fetchLazyCss`) rejoignent les éléments du cœur qui ne sont embarqués que s'ils servent, dans leur propre fichier (`mjs_page_cache.ts`/`mjs_lazy_css.ts`, détachés de `mjs_init.ts`) — signal de CONFIGURATION pure, jamais de scan.** Le cache de pages entre au bundle dès que `router`, `ujs` ou `modal` est sélectionné (`mjs_ujs.ts` construit `new µ.LRUCache(10)` à son propre chargement, sans garde ; `modal` lit les libellés traduits du projet pour ses toasts) ; le mode CSS différé entre dès que `css: "lazy"` est configuré.

- **Modifié — les 4 blocs structurels du gabarit (`{for}`, `{if}`, `{key}`, `{await}`) rejoignent les éléments du cœur qui ne sont embarqués que s'ils servent — chacun dans son propre fichier (`mjs_for.ts`/`mjs_if.ts`/`mjs_key.ts`/`mjs_await.ts`, détachés de `mjs_element.ts`).** Le scan reconnaît la forme SOURCE exacte du parseur (`{for `/`{if `/`{key `/`{await `), transitivement dans les modules du cœur du framework utilisés (ex. `<@select>` embarque `{for}`+`{if}`) ; `{key}` et `{await}` embarquent `{if}` en plus (les deux s'appuient sur ses aides internes), `{for}` en plus dès que `flip` est du bundle (`@flip` a besoin de la réconciliation de liste). Sur l'application météo du banc (utilise `{for}`+`{if}`, jamais `{key}`/`{await}`) : le cœur passe de 66 622 à 63 935 octets bruts (-2 687 octets), gzip -9 de 21 489 à 20 831 octets — l'affichage (météo courante + prévisions sur 7 jours) reste inchangé. Sur un projet sans aucun des 4 blocs : le cœur passe de 64 648 à 49 703 octets bruts (-14 945 octets, -23 %), gzip -9 de 20 805 à 16 231 octets (-22 %).

- **Modifié — `<@head>`, `<@body>`/`<@html>`, `<@element>`/`<@module>`, `<@failed>` (et la rune nue `µfailed`, dont le bouton `mjs-reset` relance le composant par le même chemin), et les runes `µplay`/`µminmax`/`µinspect`/`µraw`/`µsnap`/`µimport`/`µon`/`µeffect`/`µevery`/`µ.Ticker` rejoignent `title`/`vt_presets`/`store`/`interpolate` parmi les éléments du cœur qui ne sont embarqués que s'ils servent.** Chacun (un seul fichier pour les six runes rares, qui n'apportent pas grand-chose seules) n'entre au bundle que si une source du projet pose la balise, écrit la rune, ou une syntaxe qui s'appuie sur `µeffect` SANS jamais écrire le mot « effect » — `@persist`, `µdebug $x`, ou les macros `<@head>`/`<@body>`/`<@html>`/`<@element>`/`<@module>`/`<@window scrollX|scrollY=!{…}>` elles-mêmes, qui l'utilisent en silence pour leur propre réactivité —, ou en le demandant explicitement par `runtime` (`"runtime": ["head"]`, etc.). `µ.Ticker` (boucle rAF partagée) suit en plus `spring`/`smooth`/`interpolate`, qui l'appellent sans aucune garde. Le scan qui décide de tout ceci suit maintenant aussi les modules du cœur du framework (`src/core-modules/*.mjs`, ex. `<@select>`) RÉELLEMENT référencés par le projet, jusqu'au point fixe — angle mort qui restait ouvert pour `title`/`store`/`interpolate`. Sur l'application du banc js-framework-benchmark (`runtime: "core"`, sans aucun usage), le cœur passe de 75 055 à 66 189 octets bruts (-8 866 octets, -11,8 %) ; gzip -9 du nouveau cœur : 21 468 octets (contre 24 243).

- **Corrigé — la connexion et la déconnexion d'un composant tolèrent l'absence de `µ._storeSubscribe`/`µ._storeUnsubscribe` (module optionnel `vault`).** `µ._storeUnsubscribe` était appelée SANS garde à CHAQUE déconnexion, même d'un composant qui ne lit aucun `$$x` — un projet dont `runtime` explicite omettait `vault` (ou `"core"`) plantait au premier démontage ; `µ._storeSubscribe` (montage d'un composant qui lit `$$x`) partageait le même trou.

- **Modifié — `bundle.js` n'importe plus le cœur statiquement : il pose d'abord des indications de préchargement (`<link rel="modulepreload">`) pour le cœur, les composants déjà présents dans la page et tout ce qu'ils utilisent eux-mêmes — transitivement, balises de leur gabarit comme modules importés par `@import` —, puis importe le cœur dynamiquement.** Le navigateur découvrait jusqu'ici chaque composant l'un après l'autre au fil du montage (le cœur, puis le premier composant qui l'importe, puis ses propres enfants…) : sur une page à plusieurs niveaux d'imbrication, cette chaîne allongeait d'autant le premier affichage utile. Le manifeste porte désormais aussi une table des dépendances DIRECTES de chaque composant, calculée au build, triée pour qu'un même code produise toujours le même manifeste à l'octet près. Mesuré sur une application météo à quatre niveaux d'imbrication (Lighthouse mobile) : chaîne de requêtes critiques réduite à 2 maillons après le document (contre 8), plus grand affichage mesuré autour de 2,1 s (contre 2,6 s).

- **Corrigé — le dictionnaire i18n du projet (`µ._i18nData`) est de nouveau pris en compte quand il arrive après le premier passage du module i18n, au lieu de laisser les traductions bloquées en attente pour toujours.** Le module i18n retente une seule fois, sur le prochain tour de microtâches suivant son propre chargement ; avec le cœur importé dynamiquement (point précédent), le manifeste pose désormais `µ._i18nData` sur un tour ultérieur, après cette unique retentative — le module i18n ne s'apercevait donc jamais de son arrivée. Le manifeste signale maintenant explicitement au module i18n que la donnée est là, dès qu'il la pose.

- **Ajouté — `mjs dev` sert la page du projet quand aucun bloc `render` n'est configuré : `index.html`, `public/…`, tout fichier de la racine hors fichiers compilés.** Jusqu'ici `mjs dev` ne servait que les fichiers compilés et répondait 404 sur `/` : la page elle-même demandait un second serveur. `/` et tout chemin finissant par `/` servent l'`index.html` du dossier, un fichier caché ou `node_modules/` ne sont jamais servis, un lien symbolique qui sort de la racine répond 404, et une page HTML servie ainsi reçoit le client de rechargement. Un bloc `render` garde la priorité, inchangé.

- **Corrigé — deux familles de messages d'erreur de MJS-Server nommaient une option qui n'existe pas.** Une clé inconnue dans `def.history` était signalée sous `<jeu>.histo.<clé>` au lieu de `<jeu>.history.<clé>`, et quatre messages anglais désignaient par `spectateur` l'option `spectator` de `µgame:play`.

- **Modifié — `store` (classe `µStore`/`µ.Store`) et `interpolate` (`µinterpolate`/`µ.interpolate`) rejoignent `title`/`vt_presets` parmi les modules du cœur qui ne sont plus embarqués d'office : chacun n'entre au bundle que si une source du projet (`.mjs`, `.civet`, `.coffee`) en pose un usage — dans l'un ou l'autre sigil (`µStore`/`µ.Store`/`mjs.Store`, `µinterpolate`/`µ.interpolate`/`mjs.interpolate`) —, ou en le demandant explicitement par la clé `runtime` (`"runtime": ["store"]`/`["interpolate"]`).** Tout reste disponible, c'est le build qui ne garde que ce qu'il détecte, comme il le fait déjà pour `title`/`vt_presets`. Sur l'application du banc js-framework-benchmark (`runtime: "core"`, sans usage des deux), le cœur passe de 81 685 à 75 055 octets bruts (-6 630 octets, -8 %) ; gzip -9 du nouveau cœur : 24 243 octets.

- **Modifié — le rechargement CSS à chaud (`µ._hotCss`) quitte `mjs_element.ts` pour son propre module (`mjs_hotcss.ts`), embarqué seulement hors production — même règle que le panneau d'inspection.** Un bundle de production n'a plus à porter ce poids ; `mjs dev` (seul appelant, via le snippet HMR) reste inchangé.

- **Corrigé — le client HMR recharge la page si `µ._hotCss` est absent, au lieu de rester silencieusement inerte.** `ok` restait à sa valeur initiale `true` quand la fonction manquait (`window.µ` présent mais sans `_hotCss`) : le remplacement de CSS ne se produisait pas et rien ne le rattrapait — ni swap, ni reload.

- **Corrigé — la déconnexion d'un composant tolère l'absence de `µ._cleanupUniversalDeps`.** Défensif : ce module (`mjs_runes.ts`) reste toujours du cœur aujourd'hui, mais un composant ne doit jamais planter au démontage si un cœur futur s'en passait.

- **Ajouté — le dictionnaire du projet peut surcharger les libellés du framework par des clés racine `mjs.<groupe>.<clé>`** (`mjs.toast.success`, `mjs.modal.cancel`, `mjs.router.notFound`, `mjs.ujs.sendFailed`…), lues avant la table fr/en du framework — un projet en allemand ou en espagnol titre ses toasts dans sa langue, un projet français change un mot. Liste complète et ordre de résolution dans docs/29-i18n.md § 5.

- **Modifié — pour ces libellés, la langue DEMANDÉE (`µlang`) prime sur la langue effective du module i18n.** Un toast tiré dans le même tick qu'un clic « EN » sortait encore en français : le module i18n ne bascule l'affichage qu'une fois les dictionnaires arrivés, et les libellés suivaient cette latence.

- **Corrigé — une clé i18n calculée dont l'interpolation contient elle-même un gabarit (`µt(\`/x.${\`a${y}\`}\`)`) est reconnue : slash de tête retiré, arguments suivants correctement découpés.** `parseTemplateLiteralArg` rendait `null` au premier backtick imbriqué, `splitTopLevelArgs` s'y arrêtait et le scan des parenthèses de l'appel s'arrêtait à un backtick écrit dans une chaîne de l'interpolation (`${ "a`b" }`, parenthèse fermante en trop) ; les trois, comme le masque des gabarits, suivent désormais une interpolation `${…}` complète, chaînes et gabarits imbriqués compris, et un gabarit jamais refermé n'est plus pris pour une clé.

## [2.3.0] — 2026-09-12

- **Corrigé — les libellés que le runtime affiche lui-même (titre d'un toast, boutons d'une modale, page introuvable du routeur, échec d'envoi d'UJS) suivent la langue affichée, et non plus une seule langue figée au build.** Le manifest émet la table complète (`µ._runtimeLabels = { fr: …, en: … }`) et `µ._label` (mjs_init.ts) choisit à l'affichage : langue effective du module i18n, puis `µlang`, puis `<html lang>`, puis la langue de repli du build (`µ._runtimeLabelsLang` = `i18n.default` du projet, sinon la clé `lang`) ; une langue absente de la table retombe sur celle du build, puis l'anglais. Un site basculé en anglais montrait un toast titré « Succès » au-dessus d'un message anglais.

- **Corrigé — une clé i18n calculée qui commence par `/` (`µt("/section.#{x}")`) perd son slash à la compilation, et un `µt()` imbriqué dans les variables d'un autre (`µt('a', { x: µt('b') })`) est préfixé par la section, slash retiré et mode de placeholder posé, exactement comme un appel de premier niveau.** Le slash restait jusqu'au runtime (placeholder permanent, prouvé dans les deux navigateurs), et le scan d'`applyI18nPrefixing` sautait le contenu des arguments de chaque appel trouvé : `b` restait nu, `'/b'` gardait son slash.

- **Modifié — deux modules du cœur ne sont plus embarqués d'office : `title` (bulles `@title`) n'entre au bundle que si une source du projet (`.mjs`, `.civet`, `.coffee`) pose `@title` ou l'attribut `mjs-title`, et `vt_presets` (préréglages de `@viewTransition`) qu'avec `router` ou `ujs` ; les deux se demandent explicitement par la clé `runtime` (`"runtime": ["title"]`), seul moyen pour un attribut `mjs-title` posé uniquement côté serveur.** Tout reste disponible, c'est le build qui ne garde que ce qu'il détecte, comme il le fait déjà pour les animations. Un cœur nu sans bulle ni navigation (le cas du banc) perd les deux modules : sur l'application du banc js-framework-benchmark, le cœur passe de 105 763 à 81 609 octets bruts, de ~28,0 à 22,6 Ko brotli (25,8 Ko gzip) — soit ~26 Ko brotli tout compris avec l'application et le manifeste, contre les ~31 Ko publiés.

- **Ajouté — quatre effets de vue appariés sur un élément pour `@transition`/`@in`/`@out` : `reveal`, `flip`, `cube`, `turn`.** Jumeaux des préréglages de page homonymes (docs/17-router.md), mais avec une entrée et une sortie qui sont deux animations distinctes — la sortie ne rejoue pas l'entrée à l'envers. Posés dans un `{key}` ou un `{if}`, le nouveau nœud entre pendant que l'ancien sort ; l'ancien est alors épinglé à sa place (`_mjs_pairedWith`, `µ._fixPosition`), hors du flux, pour que les deux se superposent le temps de l'effet — l'épinglage ne joue que si un remplaçant est arrivé, un `{if}` qui se referme seul joue sa sortie comme les sept effets déjà en place. Directions par défaut : `reveal` `'up'`, `flip`/`cube`/`turn` `'left'` ; la perspective 3D (`cube`, `flip`, `turn`) est posée dans le `transform` de chaque face, jamais sur le parent.

- **Corrigé — en mode léger (`mjs-light`), `:host` écrit dans le `<style>` du composant est réécrit au montage en nom de balise, une fois par composant.** `:host` n'y visait ni le composant lui-même (aucun Shadow DOM en mode léger) ni rien de cohérent selon que sa feuille atterrisse dans le shadow d'un ancêtre ou dans `document.head` — y compris le préfixe `:host{display:X}` que le compilateur pose devant chaque feuille de composant, qui ne matchait donc jamais rien : conséquence, le composant léger passait `display: inline` et passe désormais `display: block`, comme en mode ombre.

- **Corrigé — une transition `.shared` posée dans un composant en ombre (le mode par défaut) joue désormais : le `@keyframes` partagé est injecté dans la racine du nœud (shadow root) et non plus dans le document seul.** Les noms de `@keyframes` sont à portée d'arbre (tree-scoped) — un nœud vivant dans un shadow root ne voit jamais un `@keyframes` injecté dans le document, `node.style.animation` posé restait donc sans le moindre effet. Sous Chromium, `fade.shared` comme `iris.shared` restaient muets dans tout composant en ombre, l'élément jamais retiré du DOM (`animationend` jamais reçu, la promesse de la transition jamais résolue).

- **Ajouté — sept effets de vue sur un élément pour `@transition`/`@in`/`@out` : `zoom`, `zoomOut`, `volet`, `iris`, `swipe`, `bars`, `blocks`.** Jumeaux des préréglages de page de `@viewTransition` (docs/17-router.md), mais posés un par élément qui entre ou sort du DOM plutôt que sur une page entière : sans calque noir, l'élément se révèle à travers un masque ou une découpe (`clip-path`, `mask-image`/`mask-position`), et l'effet est symétrique — la sortie rejoue l'entrée à l'envers. La direction (`dir`/`direction`) s'écrit en chaîne (`'left' | 'right' | 'up' | 'down'`), jamais dans la mini-grammaire texte de `@viewTransition` ; `zoom-out` devient `zoomOut` (un tiret n'est pas permis dans un nom d'animation). `fade` reste inchangé (`@transition.fade`) et le glissement de page se rejoue avec `fly={ x: '100%', opacity: 1 }`.

- **Ajouté — `µ.easing.bezier(x1, y1, x2, y2)` rend une fonction d'easing à partir d'une courbe de Bézier cubique.** La chaîne CSS `'cubic-bezier(x1, y1, x2, y2)'` est acceptée partout où `easing` l'est, au même titre que `'linear'`, `'ease'`, `'ease-in'`, `'ease-out'`, `'ease-in-out'` ; `x1`/`x2` hors de l'intervalle [0, 1] retombe sur `cubicOut`, avec un avertissement en mode debug.

- **Modifié — un toast (`µmodal.notify`) joue désormais la signature sonore de SON type, comme une modale joue celle de son icône.** Succès deux notes, avertissement deux bips, info une note, erreur la scie (déjà correct avant) ; `__toastDisplay` envoyait jusqu'ici `'notify'` (le ping générique) pour tout type autre qu'`error`, alors que success/warning/info ont pourtant leur propre signature embarquée (`__modalPlaySignature`) — le ping reste le repli pour un type sans signature connue.

- **Corrigé — une `<@view>` dont le module ne change pas ne vote plus pour une transition de vue (View Transitions).** `_vtResolveNavigation` faisait voter CHAQUE vue routée, même celle dont la résolution de route rendait encore le module déjà affiché (même dérivation de tag que `_injectView`) — deux composants routés sur une même page, un clic changeant le hash de l'un, faisait ainsi jouer une transition de document entière pour la vue de l'autre, restée sur place.

- **Corrigé — une clé i18n de la RACINE reste résolue même sur une page dont le SSR a semé une section AVANT l'arrivée des données réelles (`µ._i18nData`).** Le lecteur de la graine `#__mjs_i18n` s'exécute au chargement du module i18n, donc avant que le manifest ne pose `µ._i18nData` (spec ES modules) : le dictionnaire qu'il crée pour semer sa section n'avait alors aucune racine à fusionner (`root` encore vide) et restait figé ainsi pour toujours — toute clé racine (`µt('landing.titre')`) rendait le placeholder `⟦landing.titre⟧` dès qu'une page mêlait une section prérendue et une clé racine, en toute langue semée.

- **Corrigé — `sound: true` posé sur un seul appel (`µ.modal.notify`/`µ.modal.fire`) joue désormais un son, même quand `µ.config.modalSound` est coupé.** `__modalPlayOverride` ne consommait que `false` et les chaînes : un `true` retombait sur le GATE global et restait silencieux (aucun son sur les notifications) — il contourne maintenant le gate et joue la signature embarquée du type demandé (fichier de `µ.config.modalSound` objet pour ce type s'il existe, sinon signature WebAudio), exactement comme `sound: 'success'` ou `µ.sound('success')` le font déjà.

- **Corrigé — un `{µt('clé')}` posé dans une branche `{await}`/`{success}`/`{error}` reste préfixé par sa section `@i18n`, comme partout ailleurs.** Le masque compile-time d'`applyI18nPrefixing` avalait un gabarit (backtick) ENTIER, `${…}` compris — un appel `µ.t(...)` niché dans l'interpolation d'un texte statique de branche `{await}` (ou d'une chaîne interpolée de `<script>`) disparaissait donc du masque et gardait sa clé nue, affichée `⟦clé⟧` au lieu de la traduction attendue.

- **Sécurité — un coup (`µgame:move`) ou un hash lockstep reçu après la fin d'une partie (`.end()`) est refusé, la partie restant interrogeable en resync mais plus jouable.** Sans cette garde, la fenêtre de grâce `emptyTtl` laissait un coup tardif muter et rediffuser l'état d'une partie déjà terminée.

- **Sécurité — l'anti-rejeu et le plafond de cadence par joueur sont restaurés depuis la persistance, au même titre que le reste de l'état de partie.** Un rejeu bloqué avant l'arrêt du serveur ne repasse plus une fois la partie restaurée.

- **Sécurité — `mjs serveur` écoute désormais sur `127.0.0.1` par défaut, comme `mjs ws`, au lieu de toutes les interfaces réseau.** `--host` (ou `serveur.host` dans `mjs.config.json`) expose explicitement le serveur de jeu, `--host ::` pour toutes les interfaces ; `--port` est validé entier 1-65535, une valeur hors plage sort en erreur cataloguée avant toute tentative de liaison.

- **Sécurité — la file d'appariement publique de MJS-Server (`µgame:play` sans code) est plafonnée par défaut.** Sans plafond, des identités distinctes qui rejoignent la file sans jamais atteindre le nombre de sièges requis faisaient grossir la mémoire du serveur sans limite.

- **Corrigé — `peerIdOf()` retombe sur l'identifiant de connexion quand l'identité authentifiée porte un `id` vide ou blanc, au lieu de le garder tel quel.** Deux connexions distinctes ne collisionnent plus sur le même siège d'une partie MJS-Server.

- **Corrigé — le démarrage de MJS-Server ignore une sauvegarde de partie dont `id`/`type` sont absents ou vides, plutôt que de tenter de la restaurer.** Un chargement au boot n'échoue plus sur une entrée de persistance malformée.

- **Corrigé — le pont de persistance HTTP (`BridgePersistAdapter`) valide la forme de chaque entrée reçue au `load()` avant de la rendre au moteur.** Une réponse dont un élément ne porte pas `id`/`data` valides est écartée plutôt que de faire échouer la restauration de toutes les autres parties.

- **Documenté — docs/24 (MJS-Server) : hôte d'écoute par défaut (`127.0.0.1`, `--host ::`), absence de filet de tour sans `turns.timeout` déclaré, et vocabulaire des charges `µgame:play`/`µgame:seat`/`deltas` désormais en anglais (`queue`, `seatCount`, `game`/`phase`/`turn`).** docs/32 (CLI et configuration) documente `--host` sur `mjs serveur` au même titre que `mjs ws`.

- **Sécurité — `mjs ws` écoute désormais sur `127.0.0.1` par défaut, comme le pont, au lieu de toutes les interfaces réseau.** Sans `--host` ni `ws.host` dans `mjs.config.json`, le serveur temps réel n'était joignable que sur `localhost` en apparence — en réalité il liait `0.0.0.0`/`::`, exposé à tout le réseau local dès que la machine en a un. Qui veut exposer le serveur le demande explicitement avec `--host ::` (ou `ws.host: "::"`), et la bannière l'affiche.

- **Ajouté — `sock.on(type, handler, { owner })` : dé-abonnement automatique à la destruction du composant `owner`, même mécanisme que `owner` de `µ.smooth`.** Sans `owner`, un composant qui ne rappelait jamais la fonction de dé-abonnement (ni `sock.off()`) laissait le handler enregistré à vie sur le socket, singleton référence-compté partagé entre plusieurs composants.

- **Corrigé — `account:create` n'inscrit plus le compte dans l'index en mémoire avant que `persist.save()` ait réussi.** Un échec de sauvegarde répond une erreur au lieu d'un faux succès : le pseudo reste immédiatement disponible pour une nouvelle tentative, sans jamais laisser de compte fantôme dont le secret d'origine ne rouvre aucune session.

- **Corrigé — `µ.smooth()` porte son avertissement d'échantillon réseau non fini (Infinity/NaN) par flux lissé, plutôt que partagé par tout le module.** Un premier flux déjà averti n'empêche plus un second flux distinct, recevant lui aussi un échantillon non fini, d'avertir à son tour au lieu de rester silencieux à vie.

- **Corrigé — `app.use(pkg)` attend la résolution d'un installeur `async` (ou d'une Promise) avant d'inscrire le paquet comme installé.** Un rejet asynchrone est journalisé au même titre qu'un installeur qui lève, sans jamais devenir une exception non interceptée susceptible d'abattre le process ; le nom reste réinstallable tant que la résolution n'a pas réussi, et l'appel reste synchrone et chaînable dans tous les cas.

- **Sécurité — `stream.add()`/`update()`/`reset()` et les quatre endpoints de push du pont refusent aussi une valeur dont la sérialisation JSON perd de l'information en silence : fonction, `Map`, `Set`, `Symbol`, `BigInt`, ou `undefined` niché (clé d'objet ou élément de tableau) — ainsi qu'un `toJSON` personnalisé (la `Date` native reste acceptée).** `JSON.stringify()` ne lève jamais pour ces cas : la valeur passait la garde puis disparaissait à l'encodage (`{}` ou clé absente), et un abonné ou un client la recevait amputée sans le moindre signal.

- **Sécurité — `app.stream(nom, opts)` accepte une garde d'abonnement avant tout `µ:sub-stream`/`µ:resync` : `canSubscribe(client, nom)` (fonction synchrone ou asynchrone, refus par `false` ou par exception) et/ou le sucre `room: 'nom'` (exige l'appartenance à ce salon).** Sans l'une ni l'autre, un flux reste public à tout client authentifié qui devine ou connaît son nom — à l'application de poser la garde quand son contenu ne doit pas l'être ; un refus répond un `µ:error` explicite, jamais un silence indiscernable d'un flux inconnu.

- **Sécurité — une reprise de session réussie (`µ:hello` avec `session`) applique au client repris l'identité et l'échéance de jeton issues de l'authentification rejouée à cette reprise.** Un rôle révoqué entre la coupure et le retour s'applique dès la reprise ; un jeton renouvelé plus long n'expose pas le client à une expulsion calculée sur l'échéance précédente.

- **Sécurité — `account:create` réserve le pseudo demandé avant le calcul du hachage scrypt, le temps de la création.** Deux créations concurrentes du même pseudo n'aboutissent jamais toutes les deux : la seconde échoue avec `account-name-taken`, jamais un compte fantôme persisté dont le secret ne rouvre aucune session.

- **Sécurité — le plafond `limits.maxConnectionsPerIp` compte une même adresse IPv4 comme une seule IP, qu'elle arrive sous sa forme nue ou mappée IPv6 (`::ffff:a.b.c.d`).** L'adresse distante est normalisée à la source, transport `ws` comme `uws`, avant toute comparaison ; une adresse IPv6 native n'est jamais réécrite.

- **Sécurité — `lobby:advertise` borne la taille sérialisée de `meta` (`listingMetaMaxLength`, 2000 caractères par défaut) et lui applique un débit dédié (`listingRate`, environ 6 par minute par défaut), au même titre que `title`/`code`/`note`.** Une valeur trop grande ou non sérialisable répond `lobby-meta-invalid`, un débit dépassé répond `lobby-rate`, plutôt que de rediffuser au hall entier une charge non bornée à chaque annonce.

- **Sécurité — une exception levée par `opts.moderators`, `opts.canJoin` (chat), `opts.join` ou `opts.canSeePresence` (salons) reste confinée au journal serveur : l'appelant, pas forcément privilégié, reçoit un refus générique catalogué (`chat-denied`, `lobby-denied`, refus de salon ou de présence), jamais le détail de l'exception applicative.** Le même traitement protège `onMessage` dans le paquet de chat.

- **Sécurité — le proxy de décisions (`auth`/`rooms.join` en objet `{url, secret}`) ne suit aucune redirection HTTP : une réponse 3xx du back configuré compte comme un refus, plutôt que d'envoyer la requête signée vers une destination jamais soumise à la garde TLS/loopback.** Sa réponse est en plus lue en flux et plafonnée à 1 Mo, même borne que le corps entrant du pont : au-delà, la lecture s'arrête et la décision est un refus, sans bufferiser une réponse arbitrairement grosse en mémoire.

- **Sécurité — les quatre endpoints de push du pont (`/broadcast`, `/send`, `/room-send`, `/stream`) valident la charge (`p`/`value`/`values`) avant tout envoi : une valeur non sérialisable ou imbriquée au-delà de 64 niveaux répond `400`, jamais un `{ok:true}` alors qu'aucun client n'a rien reçu.** Un échec d'encodage résiduel à l'envoi répond `500` plutôt que le même faux succès.

- **Sécurité — `stream.add()`, `update()` et `reset()` refusent une valeur non sérialisable ou imbriquée au-delà de 64 niveaux, avec une exception qui nomme le flux et l'opération, plutôt que de l'accepter en silence.** Cette garde protège l'état du flux d'un empoisonnement permanent : une seule entrée refusée à l'écriture ne peut jamais rendre muet, pour tout futur abonné, le rejeu par `µ:sub-stream`/`µ:resync`.

- **Corrigé — l'expulsion d'un client pour jeton expiré, engorgement ou débit excessif se déclenche une seule fois par décision : une fermeture déjà décidée n'est jamais rejouée pendant que la fermeture physique de la connexion, toujours asynchrone, achève son cours.** Un client authentifié parqué (reprise de session) est exclu du balayage d'expiration de jeton tant qu'il reste parqué — sa connexion physique a déjà disparu, et une reprise revérifie de toute façon son jeton.

- **Corrigé — pendant une reprise de session, rien n'atteint le client avant son `µ:welcome{resumed:true}` : tout envoi applicatif (`broadcast`, `send`, `room().send`) survenant pendant que le rappel `welcome` de l'application reste en vol est mis en file, dans l'ordre, derrière les trames de la coupure précédente.** Une seconde coupure pendant cette même attente n'inverse jamais l'ordre du rejeu : les trames de la première grâce restent avant celles de la seconde, à la reconnexion suivante.

- **Corrigé — `app.use(pkg)` n'inscrit un paquet comme installé qu'une fois son installeur exécuté sans lever.** Un installeur qui lève voit son erreur journalisée puis relancée telle quelle à l'appelant, et le nom du paquet reste libre : un nouvel `app.use()` du même nom, une fois le paquet corrigé, s'installe normalement.

- **Corrigé — `app.send()`, `app.sendUser()` et `app.broadcast()` rendent `false` quand la charge n'a pas pu être sérialisée à l'envoi, plutôt qu'un échec purement interne, invisible à l'appelant.** La trace journalisée nomme en plus le type de message concerné ; le pont HTTP consomme ce signal et répond `500` plutôt qu'un succès sur une livraison qui n'a jamais eu lieu.

- **Corrigé — un `persist.load()` en échec, au premier accès au paquet de comptes, est retenté au prochain appel plutôt que définitivement abandonné.** Une panne transitoire (réseau, disque) au démarrage ne rend jamais invisibles, pour le reste de la vie du processus, les comptes déjà persistés.

- **Corrigé — `genId()` (identifiants de compte) reboucle tant que l'identifiant tiré existe déjà dans le registre, au même titre que `sessions.ts::issue()`.** Le tirage reste à 64 bits d'aléa dans l'immense majorité des cas ; seule une collision, négligeable en pratique, déclenche un second tirage.

- **Corrigé — `sock.chat(salon).messages`, et les registres internes `_seenIds`/`_retired` qui l'accompagnent, restent bornés aux 100 derniers messages suivis : le plus ancien s'efface des trois registres à la fois au-delà.** Une session de chat ouverte longtemps n'accumule pas indéfiniment ces structures en mémoire côté client, au même plafond que l'historique côté serveur.

- **Corrigé — `mjs ws` accepte un drapeau `--host` (prioritaire sur `ws.host` de la config) et affiche toujours, en bannière de démarrage, l'hôte effectif d'écoute, y compris son défaut « toutes les interfaces (0.0.0.0) ».** `--port` est validé comme `ws.port` (entier 1-65535) : une valeur hors plage sort en erreur cataloguée avant toute tentative de liaison, plutôt qu'un `RangeError` Node brut au moment d'ouvrir le port.

- **Corrigé — le compteur d'essais de reconnexion de `µ.socket` ne se remet à zéro qu'après une connexion tenue deux secondes depuis le `µ:welcome`, jamais au welcome brut.** Un serveur qui accueille puis coupe aussitôt ne peut jamais retenir le client au palier le plus court du backoff à chaque cycle : l'escalade `[500,1000,2000,5000]` s'applique normalement.

- **Corrigé — `µsmooth` ignore un échantillon dont un champ numérique n'est pas fini (`Infinity`, `NaN` — un `1e309` reçu du réseau, par exemple), avec un avertissement qui le signale une fois, plutôt que de le retenir et de propager un `NaN` dans le store affiché.** La déduplication d'échantillons compare par `Object.is` plutôt que par `!==` : un champ figé à `NaN` compte comme identique d'une frame à l'autre, comme n'importe quelle autre valeur stable.

- **Corrigé — `µ.bits([...])` refuse des noms en double côté client, au même titre que côté serveur.** Un schéma déclaré avec un nom répété lève la même exception des deux côtés, plutôt qu'un enregistrement silencieux côté client suivi d'un refus côté serveur.

- **Corrigé — l'option `cooldown` de `sock.send()` passe par la même normalisation que `debounce`/`coalesce` : une valeur non numérique avertit une fois plutôt que de désactiver silencieusement le throttle, la comparaison contre `NaN` étant toujours fausse.**

- **Corrigé — un débordement de la file hors-ligne (`maxQueue`) de `µ.socket` avertit une fois, `µ.warn` et `sock.lastError`, au moment où le message le plus ancien est perdu, plutôt qu'en silence.** Le signal se réarme à la connexion suivante ; le comportement FIFO borné ne change pas.

- **Corrigé — le message journalisé quand `opts.onJoin` (paquet lobby) lève nomme la vraie option, `onJoin`, en français comme en anglais (« onJoin a levé » / « onJoin threw »), plutôt qu'un nom absent de toute interface publique.**

- **Documenté — `docs/20-temps-reel.md` §6 décrit la vraie signature de `µsmooth(source, opts)` (store multi-entités, options `retard`/`maxSamples`/`owner`, aucun `.set()`/`.value()`), avec un tableau des options et un exemple qui compile et s'exécute.** §9 « Pièges » ajoute l'absence d'`owner` sur `sock.on()`/`off()` : un composant qui oublie de rappeler le dé-abonnement laisse son handler enregistré à vie sur le socket partagé entre composants.

- **Documenté — `docs/23-mjs-ws.md` § « Protections de série » liste les trois plafonds actifs par défaut (`limits.maxConnections`, `limits.maxConnectionsPerIp` à 100, `limits.maxRoomsPerClient` à 50), et sa table d'API ajoute `.use(pkg)`, le mécanisme de paquets activables utilisé par le chat, les comptes et le hall.** Les sections « Statut du module » et « Aller plus loin » se reformulent au présent.

- **Documenté — l'exemple de `docs/27-accounts.md` §7 « Rôles » utilise `moderators`/`moderator`, les identifiants réels de l'API, plutôt que `moderateurs`/`moderateur`, qui ne compilent pas.**

- **Documenté — `docs/README.md` décrit le hall d'accueil avec le hook `onJoin`, le nom réel de l'option.**

- **Documenté — `docs/32-cli-et-configuration.md` § « `mjs ws` » précise que la commande écoute sur toutes les interfaces sans `--host` ni `ws.host`, et que `--port` (comme `ws.port`) exige un entier entre 1 et 65535.**

- **Tests — une famille couvre le cœur du protocole MJS-WS : non-répétition des gardes de fermeture (jeton expiré, engorgement) sur un client déjà en cours de fermeture, ordre du rejeu autour d'un `welcome()` de reprise asynchrone y compris une double coupure, rafraîchissement de l'identité et de l'échéance de jeton à la reprise, non-empoisonnement d'`app.use()` par un installeur qui lève, et remontée d'un échec de sérialisation par `app.send()`/`app.broadcast()`.**

- **Tests — une famille couvre le pont, le proxy de décisions et les flux : validation de charge sur les quatre endpoints de push du pont, refus d'une redirection HTTP par le proxy, plafond de taille sur sa réponse, garde d'abonnement (`canSubscribe`/`room`) sur `app.stream()`, refus d'une entrée trop imbriquée à l'écriture d'un flux, et câblage de l'option `room` à l'appartenance d'un salon.**

- **Tests — une famille couvre le hall, les salons, le chat et les comptes : taille et débit d'une annonce (`lobby:advertise::meta`), message générique au client quand `moderators`/`canJoin`/`join`/`canSeePresence` lèvent, mémoire bornée de `sock.chat().messages` côté client, absence de course sur `account:create`, retentative d'un `persist.load()` en échec, et revérification de collision par `genId()`.**

- **Tests — une famille couvre le transport, la CLI et le runtime client : normalisation d'une adresse IPv4 mappée IPv6, bornes de `--port` dans `mjs ws`, stabilisation du backoff de reconnexion, normalisation de l'option `cooldown`, échantillons non finis et déduplication de `µsmooth`, et refus de noms en double par `µ.bits()` des deux côtés.**

- **Corrigé — une route déclarée dans `render.routes` dont l'URL porte une extension (`/sitemap.xml`, `/modularjs/sitemap.xml`…) se rend normalement, comme toute autre page, sur `mjs dev` et `mjs serve`.** Seul un chemin à extension non déclaré et sans fichier garde sa 404 directe ; la distinction se fait par la résolution de route, jamais par la seule forme de l'URL.

- **Corrigé — une erreur de page (`pageerror`) dont la pile ne porte aucune ligne d'appel exploitable — `throw` d'une chaîne ou de toute autre valeur sans `.stack`, par exemple dans `µmount` — fait échouer le rendu au moteur navigateur.** Ne pouvant l'attribuer à un script tiers, elle compte comme un crash du projet ; une pile qui référence bien une ressource étrangère reste un simple avertissement.

- **Sécurité — un lien symbolique posé dans le dossier source et pointant hors de celui-ci est refusé, qu'il désigne un dossier entier, un fichier chargé par `µasset()`/`µimage()`, ou la source d'un `<@img>`.** La compilation échoue en nommant le chemin en cause, plutôt que de copier dans le dossier de sortie un contenu situé hors du projet.

- **Sécurité — un champ de formulaire nommé `__proto__`, `constructor` ou `prototype`, reçu par une action serveur (`application/x-www-form-urlencoded` ou `multipart/form-data`), est refusé et tracé dans les journaux.** Sa valeur n'atteint jamais l'action, ni ne s'absorbe en silence.

- **Sécurité — un fichier SVG contenant un `<script>`, un attribut `on*=` (`onload`, `onclick`…) ou une valeur `javascript:` est refusé à la copie, que la référence passe par `µasset()`, `µimage()` ou `<@img>`.** Le fichier fautif est nommé dans le message, avant toute écriture sur disque.

- **Sécurité — l'atelier de variables de thème (`/__mjs/theme`) et le journal d'erreurs (`/__mjs/errors`) se ferment en production dès que la commande tourne avec `--prod`, indépendamment de la variable `NODE_ENV`.** Une variable `NODE_ENV=production` posée en plus reste acceptée comme second signal, jamais comme condition unique.

- **Sécurité — une URL qui commence par le même mot que le préfixe des ressources compilées de `mjs dev`, sans se trouver réellement dans ce dossier (par exemple `/modularjs-notes` à côté de `/modularjs`), retombe sur le rendu de la page déclarée plutôt que sur une 404 immédiate.** La comparaison respecte la frontière de segment (`/` ou fin de chaîne), jamais un simple préfixe de caractères.

- **Corrigé — `mjs dev` parle le même protocole de navigation que `mjs serve`.** Une requête qui porte l'en-tête `X-MJS-Nav` reçoit une fiche JSON (`module`, `props`, `url`, `title`, `version`) au lieu du HTML complet, et les props posées par un chargeur `serve.server.mjs` arrivent dès le premier chargement HTML — les deux commandes se comportent identiquement pour une même configuration.

- **Corrigé — le rendu SSR déclenché par une requête est plafonné en concurrence (`render.renderQueue`, 4 rendus simultanés et 32 en attente par défaut).** Passé ce plafond, une requête reçoit `503` avec un en-tête `Retry-After`, plutôt que de s'ajouter à un nombre illimité de rendus en cours.

- **Corrigé — `mjs dev` sert le type MIME réel des images et polices (`.webp`, `.woff2`, `.avif`, `.mp3`…) au lieu d'un type binaire générique.** Une seule table de types alimente les deux commandes de serveur.

- **Corrigé — un `setInterval`/`setTimeout` posé par un `µeffect` pendant un rendu SSR, ou pendant un montage dans le harnais de test, s'arrête avec la fermeture du rendu ou du test.** La fenêtre `happy-dom` sous-jacente annule ses tâches en cours à cet instant précis, requête après requête.

- **Corrigé — la sérialisation du store partagé (`$$`) au premier chargement HTML se fait clé par clé.** Une valeur non sérialisable en JSON (référence circulaire créée par le composant, par exemple) est omise avec un avertissement qui la nomme, sans emporter le reste du store avec elle.

- **Corrigé — une promesse `{await}` rejetée sans branche `{error}` pour la consommer produit un avertissement de rendu qui nomme le composant et l'erreur.** Le rendu reste vide côté client ; l'avertissement, lui, reste visible côté serveur.

- **Corrigé — le rendu serveur d'un composant sérialise le shadow DOM de ses sous-composants, à tout niveau de composition.** Un sous-composant imbriqué (`<@x>`) apparaît avec son propre contenu et son propre `<template shadowrootmode>`, plutôt que comme une balise vide.

- **Corrigé — une fenêtre ouverte par `window.open()` pendant un rendu au moteur navigateur est fermée automatiquement, avec un avertissement qui nomme le composant.** Elle ne reste pas vivante dans le contexte partagé entre plusieurs rendus.

- **Corrigé — les erreurs de page capturées pendant un rendu au moteur navigateur restent bornées, en nombre comme en taille de message.** Un composant qui lève massivement pendant la stabilisation ne peut pas faire grossir les journaux au-delà de cette limite.

- **Corrigé — un contexte de navigateur dont la préparation échoue après sa création (script d'initialisation, route réseau, nouvelle page) est refermé avant que l'erreur ne remonte à l'appelant.** Chaque échec de démarrage referme proprement ce qu'il a ouvert.

- **Corrigé — un composant fraîchement recompilé garde son ancien fichier haché sur disque jusqu'à ce que le nouveau manifeste soit écrit.** Le manifeste publié reste, à tout instant du build, cohérent avec les fichiers réellement présents sur disque.

- **Corrigé — un nom de fichier composant hors kebab-case (majuscule, espace, accent) fait échouer la compilation, avec une suggestion de nom valide.** Minuscules, chiffres et tirets seulement : le nom du fichier détermine à la fois la clé du manifeste et le tag du composant.

- **Corrigé — la purge des fichiers orphelins (`prune`) ne retire que les extensions réellement produites par ce bundler, listées dans un registre écrit à côté du manifeste.** Un fichier déposé à la main dans le dossier de sortie, même avec un nom qui ressemble à une sortie hachée, reste hors de portée de la purge tant que son extension n'a jamais figuré au registre.

- **Corrigé — `mjs build` sort en échec (code de sortie non nul) dès qu'une page déclarée dans `render.routes` échoue réellement à se prérendre, et son fichier HTML périmé est supprimé du dossier de sortie.** Une route paramétrée ou un mode non pré-rendable restent de simples avertissements, jamais un échec de build.

- **Corrigé — `render.allowedOrigins` et `render.entry` sont vérifiés à la lecture de `mjs.config.json`.** Une valeur mal typée (chaîne au lieu d'un tableau, nombre au lieu d'un chemin) est refusée avec un message qui nomme la clé fautive.

- **Corrigé — `i18n.default` réglé sur une langue sans dictionnaire réel sous `sourceDir/i18n/` déclenche un avertissement au build.** Le message nomme la langue attendue et les langues effectivement trouvées.

- **Corrigé — une erreur de syntaxe dans `mjs.config.json` s'affiche dans la langue du catalogue de messages, comme les autres erreurs de configuration.**

- **Corrigé — une tâche de compilation confiée à un worker qui ne répond jamais est rejetée au bout de soixante secondes (délai configurable), en nommant le fichier en cause.** Le worker fautif est retiré du pool et n'est jamais redispatché.

- **Corrigé — `--output` et `--manifest` sont vérifiés avant toute compilation : un dossier non accessible en écriture est signalé par un message qui nomme le chemin, dans la langue du catalogue.** Une erreur d'écriture survenant malgré tout en cours de build reçoit le même traitement, plutôt qu'une trace brute de Node.

- **Documenté — `docs/19-ssr.md` décrit le champ `hydrateScript` de `RenderResult` (le script qui active l'hydratation côté client dès que `ssrMode` diffère de `'replace'`, vide sinon) et précise que `props` et `store` partagent la même limite de sérialisation JSON.**

- **Documenté — `docs/32-cli-et-configuration.md` liste les huit éléments créés par `mjs init` (le dossier `examples/` et ses deux fichiers compris), précise que l'atelier de thème et le journal d'erreurs se ferment en production dès `--prod` quel que soit `NODE_ENV`, et retire deux références de ligne de code périmées.**

- **Documenté — `docs/33-tester-son-application.md` précise que le harnais de test ne charge pas les feuilles de style partagées en mode `css: 'lazy'`, et recommande `'bundle'` ou `'split'` pour tester un comportement qui en dépend.**

- **Documenté — `docs/34-deboguer.md` décrit `µ.devPanel(sélecteurCss)` (ouvre le panneau et sélectionne le composant désigné) et `µ.devObject(valeur, nom)` (ouvre l'inspecteur générique sur une valeur choisie à la main, hors composant).**

- **Tests — une famille de tests couvre le serveur de développement : parité avec `mjs serve` sur le protocole de navigation et les props du chargeur, fermeture de l'atelier de thème et du journal d'erreurs en `--prod` sans `NODE_ENV`, table MIME, et plafond de rendus SSR simultanés.**

- **Tests — une famille couvre le rendu serveur et le rendu au moteur navigateur : libération des temporisateurs en fin de rendu ou de test, sérialisation partielle du store partagé, `{await}` rejetée sans branche `{error}`, sérialisation récursive du shadow imbriqué, fermeture d'une popup ouverte pendant le rendu, plafond des erreurs de page capturées, et fermeture d'un contexte de navigateur dont le démarrage échoue.**

- **Tests — une famille couvre le bundler : refus d'un lien symbolique qui sort du dossier source, refus d'un nom de fichier composant hors kebab-case, purge différée de l'ancien fichier haché après le manifeste, purge bornée aux extensions réellement produites, et refus d'un SVG porteur de script.**

- **Tests — une famille couvre la CLI et la configuration : champ de formulaire réservé et champ répété dans le pipeline d'actions, échec de build sur un prérendu réellement en échec avec suppression du fichier périmé, avertissement sur `i18n.default` sans dictionnaire, validation de `render.allowedOrigins`/`render.entry`, message catalogué sur une erreur de syntaxe JSON de config, validation des chemins `--output`/`--manifest`, et délai maximal par tâche de worker.**

- **Sécurité — un lien symbolique posé dans les dictionnaires i18n ou dans les feuilles de style partagées, et pointant hors de sa racine, est refusé au même titre qu'ailleurs dans le dossier source.** La compilation échoue en nommant le chemin en cause, plutôt que de publier en clair le contenu d'un fichier situé hors du projet.

- **Sécurité — le refus d'un SVG dangereux résiste au contournement par entité HTML (`&#106;avascript:`), par injection SMIL (`<set attributeName="onclick">`, `<animate attributeName="onmouseover">`), par un `<foreignObject>` embarquant un `<iframe>`/`<embed>`/`<object>`, ou par un `data:text/html`.** Les animations SMIL portant sur `d`, `opacity`, `transform`… restent permises ; seul l'attribut ciblé change la décision.

- **Corrigé — `render.renderQueue` (`concurrency`, `maxQueue`) est reconnue par le schéma de `mjs.config.json`, au même titre que `render.browserPool`.** Une valeur mal typée ou une sous-clé inconnue est refusée avec un message qui nomme la clé fautive.

- **Corrigé — trois messages du serveur suivent la langue configurée du catalogue, plutôt que de rester figés en français quel que soit `lang` : le refus d'un champ de formulaire au nom réservé, la fermeture d'une popup ouverte pendant un rendu au moteur navigateur, et l'avertissement d'une promesse `{await}` rejetée sans branche `{error}`.** Un projet configuré en `lang: 'en'` les reçoit dans cette langue, comme le reste des messages catalogués.

- **Corrigé — un sous-composant `<@x mjs-light>` imbriqué dans la composition sérialise son contenu à plat, sans le `<template shadowrootmode>` que porte un sous-composant à Shadow DOM classique.** Le mode `mjs-light` est relu au moment de sérialiser, plutôt que déduit du shadow que `happy-dom` peut attacher malgré l'attribut à un composant imbriqué ; l'aplatissement s'applique à tout niveau de composition, pas seulement à la racine.

- **Corrigé — un composant qui lève une erreur non gérée pendant le prérendu (aucune frontière `<@failed>` pour l'absorber) fait échouer sa page.** Un crash absorbé par une frontière `<@failed>` reste un succès ; sur le moteur `browser`, seule une exception non interceptée qui provient du projet, ou qui atteint l'overlay d'erreur fatale du framework, compte comme un tel crash — celle d'un script tiers embarqué dans la page reste un simple avertissement ; un crash reconnu comme tel fait sortir `mjs build` en erreur et retire le fichier HTML périmé, comme n'importe quelle autre page en échec réel.

- **Corrigé — `mjs dev` retombe sur `render.routes` quand un fichier attendu sous `pathPrefix` est absent, plutôt que de répondre `404` immédiatement.** Une page déclarée dans `render.routes` dont l'URL vit sous le préfixe des ressources compilées (par exemple `/modularjs/faq` avec le préfixe par défaut) atteint son rendu, à l'identique de `mjs serve` pour cette situation.

- **Corrigé — `pathPrefix`/`urlPrefix` avec un slash final (`/app/`) est ramené à la forme sans slash final avant de composer la moindre URL d'asset.** `mjs.config.json` exige en plus un slash initial sur `urlPrefix` (chemin sinon ambigu) et refuse sa valeur avec un message qui la nomme.

- **Corrigé — un plafond de rendu (`render.renderQueue`) réglé à zéro retombe sur 1 rendu simultané au minimum, plutôt que de bloquer tout rendu indéfiniment.** `mjs dev` et `mjs serve` retirent tous deux de leur file d'attente une requête dont le client a fermé la connexion avant son tour, plutôt que de lui garder une place jusqu'à épuisement naturel.

- **Corrigé — un fichier `.wasm` est servi avec le type MIME `application/wasm`, dans la table commune à `mjs dev` et `mjs serve`.**

- **Corrigé — un marqueur `.page` mal casé (`Truc.PAGE.mjs`) fait échouer la compilation comme n'importe quel nom hors kebab-case, avec une suggestion qui conserve le marqueur (`truc.page.mjs`).** Le marqueur n'est reconnu que dans sa casse exacte ; toute variante orpheline retombe sur la règle générale de nommage, jamais sur une exemption silencieuse.

- **Corrigé — un registre de purge vide (`{"extensions":[]}`) est traité comme illisible : la purge entière est sautée plutôt que de tourner sur une base qui ne reconnaît aucune extension.** `mjs build` affiche la raison d'une purge sautée (registre illisible, registre vide, ou build resservi depuis le cache), plutôt que de rester silencieux comme un run sans rien à purger.

- **Corrigé — un ancien fichier haché mis en attente de purge par un build dont l'écriture du manifeste a échoué est retiré au premier build qui réussit, même si celui-ci ne recompile rien (cache intégral).** La file d'attente de purge survit d'un build à l'autre ; elle n'est vidée que par une écriture de manifeste réussie, jamais par un simple redémarrage.

- **Corrigé — `--output` pointant vers un fichier déjà existant, ou vers le même chemin que `--manifest`, est refusé avant toute compilation, avec un message qui nomme le chemin en cause.** Une erreur `ENOTDIR`/`EISDIR` survenant malgré tout en cours de build reçoit le même traitement catalogué que les autres erreurs d'écriture, plutôt qu'une trace Node brute.

- **Corrigé — un dictionnaire `i18n.default` vide (fichier de 0 octet, ou `{}`) déclenche le même avertissement qu'un dictionnaire manquant, plutôt que de compter comme trouvé du seul fait d'exister.** La liste des langues affichée par l'avertissement le distingue par un libellé dédié (`fr (vide)`).

- **Documenté — `docs/19-ssr.md` précise que `hydrateScript` reste vide pour tout composant `mjs-light`, quel que soit `ssrMode` (aucun Shadow DOM, donc aucun nœud à reprendre en main), et que seule une référence circulaire fournie par l'appelant (dans `props` ou dans `store`) fait lever `renderToString` — celle créée par le composant lui-même pendant son rendu est écartée clé par clé, avec un avertissement.**

- **Documenté — `docs/31-themes.md`, `docs/32-cli-et-configuration.md` et `docs/34-deboguer.md` distinguent le choix du build (minification, panneau d'inspection embarqué), qui ne regarde que `--prod`, de la fermeture des routes de développement (`/__mjs/theme`, `/__mjs/errors`), qui accepte `--prod` OU `NODE_ENV=production`.**

- **Documenté — `docs/32-cli-et-configuration.md` ajoute la section `render.renderQueue` (`concurrency`/`maxQueue`, défauts et `503`/`Retry-After`) et précise, dans le paragraphe `prune`, qu'un registre `.mjs-outputs.json` illisible ou de forme inattendue fait sauter la purge entière plutôt que de deviner.**

- **Tests — une famille complète le serveur de développement et de production : transmission de l'environnement à `mjs dev`, fermeture de l'atelier de thème et du journal d'erreurs côté `mjs serve`, `Retry-After` côté `mjs serve`, catalogue des messages serveur, repli sur `render.routes` sous `pathPrefix`, type MIME de `.wasm`, et abandon d'une requête en file d'attente de rendu.**

- **Tests — une famille couvre le rendu serveur et le rendu au moteur navigateur : sérialisation en light DOM d'un sous-composant `mjs-light` imbriqué, et échec du prérendu sur une erreur non gérée, aux deux moteurs.**

- **Tests — une famille couvre le bundler : confinement d'un lien symbolique dans les dictionnaires i18n et les feuilles de style partagées, marqueur `.page` mal casé, registre de purge vide, purge différée après un cache-hit intégral, vecteurs de contournement d'un SVG dangereux, schéma de `render.renderQueue`, et normalisation de `pathPrefix`/`urlPrefix`.**

- **Tests — une famille couvre la CLI : `--output` vers un fichier existant ou identique à `--manifest`, et avertissement sur un dictionnaire `i18n.default` vide.**

- **Sécurité — le jeton CSRF pouvait fuiter chez un tiers : une page posant `<base href>` vers une autre origine faisait juger `_mjajaxMemeOrigine` (`mjs_ajax.ts`) « même origine » (résolution contre `location.href`) alors que le `fetch()` réel partait bien chez ce tiers (résolution native contre `document.baseURI`), qui recevait donc l'en-tête `X-CSRF-Token`.** `_mjajaxMemeOrigine` résout désormais contre `document.baseURI` (repli `location.href` en son absence), exactement comme `fetch()`.

- **Sécurité — `µ._navApplyJson` (`mjs_ujs.ts`) posait `pushState` sur une destination hors origine sans le moindre filtre, levant un `SecurityError` natif non intercepté qui bloquait net la navigation, et `µ._hardNav` assignait n'importe quelle destination à `location.href` telle quelle, protocole `javascript:`/`data:`/`blob:` compris — EXÉCUTÉ au lieu de naviguer (un `blob:` de MÊME origine, dont `URL.origin` vaut par spec l'origine qui l'a créé, contournait même le filtre d'origine et atteignait `pushState` tel quel, qui le rejette lui aussi avec un `SecurityError` non catché).** L'origine de la destination est désormais résolue contre `document.baseURI` (comme `mjs_ajax.ts`), et son protocole vérifié EN PREMIER, inconditionnellement, aux deux sites d'appel — non `http:`/`https:` (`blob:` même origine compris) → `µ.warn` et abandon, jamais `pushState` ni `µ._hardNav` ; sinon, hors origine, la navigation part en dur via `µ._hardNav` plutôt que par `pushState` ; `µ._hardNav` garde lui-même, en défense en profondeur, le même refus de protocole avant de toucher `location.href`.

- **Corrigé — `typeof localStorage`, posé hors du `try` (`mjs_i18n.ts` : détection de la langue au boot et persistance après bascule ; `mjs_accounts.ts` : `_accountStorage`), levait lui-même sur une origine opaque (sandbox, `about:blank`) : le boot i18n entier plantait, ou la persistance de langue avortait le reste de son `.then()` en rejet non intercepté.** Le `typeof` vit désormais À L'INTÉRIEUR du `try` existant, aux 3 sites.

- **Corrigé — le `<style>` d'un `<@x mjs-light>` imbriqué sous un ancêtre à Shadow DOM est sérialisé dans le rendu serveur, une seule fois même si ce composant revient plusieurs fois dans une boucle.** Côté client, sa feuille rejoint la racine qui le contient réellement — le shadow de l'ancêtre, ou `document` s'il n'y a pas de shadow au-dessus — au lieu de rester posée dans `document.head`, où le shadow d'un ancêtre ne la voit jamais : le style du composant s'applique.

- **Corrigé — un crash qu'aucune frontière `<@failed>` n'absorbe se signale, au rendu serveur, par un compteur que le runtime pose au moment où le panneau d'erreur fatale est réellement construit, plutôt que par la recherche du texte `mjs-fatal-error` dans le HTML sérialisé.** Une page dont la prose cite littéralement cette classe — une explication de ce mécanisme, par exemple — sans qu'aucun crash ne survienne reste un succès.

- **Corrigé — sur le moteur `browser`, seule une exception qui provient d'une ressource du projet (le bundle, ses chunks, un composant) fait échouer le rendu d'une page.** Une exception levée par un script tiers embarqué dans la page — widget, mesure d'audience… — reste un simple avertissement, sans faire échouer un composant par ailleurs sain.

- **Documenté — `docs/19-ssr.md` précise le contrat d'un composant qui lève sans frontière `<@failed>` pour l'absorber : la réponse part en `500` à la volée (`mjs serve`), et la page part en échec au prérendu (`mjs build` sort en erreur, fichier HTML périmé supprimé) ; `docs/15-elements-speciaux.md` renvoie vers cette section pour le cas du rendu serveur.**

- **Sécurité — la compilation confine chaque dictionnaire i18n au dossier `sourceDir/i18n` : un lien symbolique posé dedans mais pointant vers un autre fichier du projet, situé hors de ce dossier, est refusé.** Un lien symbolique pendant (cible absente), qu'il vive dans les dictionnaires i18n ou dans les feuilles de style partagées, est lui aussi refusé, par un message qui nomme le chemin en cause plutôt que par une erreur brute du système de fichiers.

- **Corrigé — sous le préfixe des ressources compilées, un asset absent dont le nom porte une extension (`.js`, `.css`…) reçoit une réponse `404`, sur `mjs dev` comme sur `mjs serve`, au lieu du HTML de la page.** Un chemin sans extension, ou une requête qui porte l'en-tête `X-MJS-Nav`, retombe sur le rendu de la page.

- **Corrigé — un `urlPrefix` dont les slashs se répètent, en tête comme au milieu (`//app`, `/a//b`), est ramené à un seul slash à chaque occurrence, pas seulement en fin de chaîne.** Un préfixe mal formé composait une URL d'asset protocole-relative (`//app/fichier`, qui pointe vers un autre hôte côté navigateur) plutôt qu'un chemin du même site.

- **Corrigé — `--manifest` pointant vers un dossier déjà existant est refusé avant toute compilation, avec un message qui nomme le chemin en cause.** Symétrique au contrôle déjà posé sur `--output` : le manifeste attend un fichier, jamais un dossier.

- **Tests — une famille couvre la sérialisation du style d'un composant `mjs-light` imbriqué (rendu serveur et rendu au moteur navigateur), le signal structurel d'un crash sans frontière `<@failed>`, le filtre qui écarte une exception venant d'un script tiers, le refus d'un asset absent sous le préfixe des ressources compilées, la normalisation des slashs répétés d'un préfixe, le refus d'un `--manifest` désignant un dossier, et le confinement des dictionnaires i18n à leur propre dossier.**

- **Corrigé — un 2e `µ.modal.fire()` appelé pendant qu'une modale bloquante était déjà affichée écrasait la fermeture mémorisée de la 1ère (`mjs_modal.ts`) : celle-ci restait affichée à l'écran, sa promesse ne se résolvait plus jamais (fuite, notamment avec `allowOutsideClick:false`/`allowEscapeKey:false`).** `fire()` ferme désormais la modale courante (même résultat que `µ.modal.close()`, `dismiss:'close'`) avant d'en ouvrir une nouvelle — plus jamais deux boîtes empilées ni de promesse orpheline.

- **Corrigé — retirer du DOM (`el.remove()`, démontage réactif) l'élément survolé PENDANT l'affichage d'une bulle `@title` (`mjs_title.ts`) ne déclenche aucun `mouseout` natif : la bulle restait affichée, orpheline, avec un `aria-describedby` pointant un nœud disparu.** Un `MutationObserver` dédié (childList/subtree sur la racine) détecte la déconnexion (`isConnected`) et referme la bulle.

- **Corrigé — `µ._ujsConfirmRefire` (`mjs_ujs.ts`) relançait `target.requestSubmit(confirmEl)` dès que `confirmEl.form === target`, sans vérifier que `confirmEl` est un vrai bouton de soumission : un porteur `@confirm` form-associated mais non-bouton (`<fieldset mjs-confirm>` englobant le bouton d'envoi) levait une `TypeError` native hors de tout `.catch`, jamais rattrapée — le formulaire n'était jamais soumis malgré l'acceptation.** `confirmEl` est désormais validé (bouton/`input[type=submit]`/`input[type=image]`) avant d'être passé tel quel, avec repli sur `submitter`/le bouton cliqué/`requestSubmit()` nu ; tout échec de secours est désormais signalé par `µ.warn` plutôt qu'avalé en silence.

- **Corrigé — `µ._isPreloadableLink` (`mjs_ujs.ts`) ne consultait jamais `mjs-method` : un lien `@method="delete"` (ou tout autre verbe muté) porteur de `@preload` déclenchait un vrai `fetch` GET au survol ou au montage, perdu à coup sûr (le clic réel passe par `µ._navDispatch`, jamais ce cache) et potentiellement dangereux sur un serveur pas strictement REST.** Un lien porteur de `mjs-method` n'est désormais préchargeable QUE si ce verbe vaut `GET`.

- **Corrigé — `µ._navHibernate` (`mjs_ujs.ts`) sortait AVANT `_saveScroll` dès que la page affichée avait été montée en `method:'replace'` (`µ._navCacheZone()` rend `null`) : sa position de scroll n'était jamais mémorisée, contrairement à la politique `'no-cache'` qui appelait déjà `_saveScroll` avant sa propre sortie.** `_saveScroll(path)` est désormais appelé inconditionnellement, hors de la garde d'absence de zone, même schéma que la sortie `'no-cache'`.

- **Corrigé — un `*` catch-all mal placé (pas en dernière position) dans une table `@routes` déclarée en script compilait et routait en silence, absorbant tout le reste du chemin (les segments après le `*` n'étaient plus jamais lus) — seul le bloc HTML `<routes target>` refusait ce cas à la compilation, jamais la forme script.** `µ.Router.register` (`mjs_router.ts`) refuse désormais aussi ce cas, au montage, via le nouveau `_findMidRouteWildcard`.

- **Corrigé — `html[data-mjs-vt="nom"]`, hook d'extensibilité documenté pour cibler une transition de page en CSS de projet, n'était posé nulle part par le runtime (`mjs_router.ts`, `mjs_ujs.ts`) — la promesse de la doc n'avait pas de code derrière.** L'attribut est désormais posé sur `document.documentElement` pour chaque préréglage NATIF (jamais les rideaux `iris`/`swipe`/`bars`/`blocks`, qui ne passent pas par `startViewTransition`) et retiré à la fin de la transition via un jeton de séquence partagé qui protège du chevauchement de deux navigations successives.

- **Corrigé — une exception utilisateur dans `cfg.tick()` (`mjs_easing.ts`) était avalée en silence hors `µ.debug` (retentée à chaque frame jusqu'à épuisement de la durée, promesse résolue comme un succès), la même exception dans `cfg.css()` (mode `.shared` et mode CSS classique) n'était interceptée nulle part et remontait non capturée à l'appelant, et une exception dans `setup()` n'était pas davantage rattrapée.** Les 4 points (`tick`, `css` partagé, `css` classique, `setup`) sont désormais tous protégés par un `try/catch` symétrique : `µ.warn` inconditionnel et fermeture propre de la transition, jamais un crash ni un succès menteur.

- **Corrigé — un ressort composite (`mjs_spring.ts`, objet ou tableau) n'animait jamais une clé/un indice présent SEULEMENT dans la cible (apparition d'un coup à la dernière frame), gelait TOUT le ressort dès la 1ère frame si une clé était ABSENTE de la cible, et perdait `current` en changeant de type (scalaire ↔ composite) ou de NATURE de conteneur (objet ↔ tableau) — dans les deux derniers cas, `current`/`velocity` n'étaient pas reformés (objet → tableau produisait un hybride non-`Array`, tableau → objet figeait le ressort à vie).** `_mjsSpringStep` itère désormais l'UNION des clés/indices de `current` et de la cible, chaque axe suivant sa propre règle (absent de la cible = figé, absent de `current` = apparaît direct) ; une bascule de type OU de nature de conteneur reforme `current` ET `velocity` dans la forme de la cible ; un `µ.warn` unique (posé au `set`, jamais par frame) signale une forme différente.

- **Corrigé — recibler `µ.interpolate(...).value` sur une valeur ÉGALE à `current` (mais différente de l'ancienne cible) ne court-circuitait pas (`mjs_interpolate.ts` ne comparait qu'à l'ancienne cible) : toute la `duration` s'écoulait à notifier les abonnés à chaque frame alors que `current` ne bougeait jamais.** Le setter court-circuite désormais aussi ce cas (0 frame, point de départ réaligné sur l'instant présent) ; `_step` gagne un garde-fou symétrique qui l'arrête immédiatement si plus rien ne reste à animer.

- **Corrigé — l'animation intégrée `typewriter` (`animations/typewriter.ts`) lisait et réécrivait `node.textContent` en bloc, détruisant silencieusement tout markup imbriqué (`<b>…</b>`) dès le 1er tick, alors que la doc enseigne explicitement de lever une erreur sur un nœud non textuel unique pour un tick personnalisé — le built-in ne suivait pas son propre contrat documenté.** `setup` refuse désormais un enfant ÉLÉMENT (`@transition.typewriter exige un unique nœud texte`) tout en tolérant les nœuds texte de blancs d'indentation (voisins d'une interpolation seule sur sa ligne), et n'anime plus que le nœud texte réel.

- **Corrigé — `@transition.draw` (`animations/draw.ts`) sur un nœud non-SVG était un no-op total et silencieux (`getTotalLength` absent, longueur figée à 0, aucune erreur ni avertissement).** `setup` avertit désormais (`µ.warn`) quand `node.getTotalLength` n'est pas une fonction ; le no-op reste inoffensif, il n'est plus tu.

- **Corrigé — `µ.sound(type, chemin)` (`mjs_modal.ts`) ignorait en silence un chemin relatif sans préfixe reconnu (`'sons/ding.mp3'`, ni `/`/`./http`) : `__modalPlayOverride` rendait `false`, et l'appelant retombait sur le bip WebAudio intégré à la place du fichier demandé, sans le moindre avertissement.** Un tel chemin est désormais résolu contre `document.baseURI` puis joué comme fichier ; si la résolution elle-même échoue, `µ.warn` explicite plutôt qu'un repli muet vers une autre source.

- **Documenté — `docs/06-evenements.md` annonçait un repli figé (`#fdecea`/`#a33`) pour `--mjs-modal-error-bg`/`-fg` alors que le CSS réel calcule `color-mix(...)`/`var(--mjs-modal-icon-error)`, et affirmait que `notify()` utilise `µ.modal.close()` en interne comme `wait()`, alors que `notify()` a son propre retrait (poignée `{ close() }`, jamais la fermeture mémorisée par `wait()`).** Les deux passages sont corrigés pour refléter le code réel.

- **Documenté — `docs/09-directives-dom.md` citait un facteur « ×80 mesuré sur un HUD réel » pour le surcoût d'un `@this` réactif, chiffre introuvable ailleurs dans le dépôt (aucun banc, aucun script de mesure retrouvé).** La mise en garde conserve son constat (surcoût « massif ») sans ce chiffre non retrouvé.

- **Documenté — `docs/10-transitions.md` : contrat de l'animation intégrée `typewriter` précisé (même exigence « nœud texte unique » qu'un tick personnalisé), `.shared` reformulé (pas de vraie dispute entre deux transitions qui se chevauchent, juste une reprise qui redémarre à 0 plutôt qu'une dispute de propriété CSS), `mjs-flip-delay` précisé comme ignoré (ramené à 0) côté liste qui REÇOIT l'élément, et le `fallback` du cross-fade précisé comme symétrique (joue aussi côté réception orpheline, effet inversé).**

- **Documenté — `docs/17-router.md` : le hook `µurlChange` seul, sans `@routes`, rend bien le composant *router-aware* (les deux passages qui affirmaient le contraire sont corrigés), une clé de query dupliquée (`?a=1&a=2`) garde la dernière valeur (pas de tableau), et `html[data-mjs-vt]` précisé comme posé pour les préréglages NATIFS seulement, jamais pour les rideaux (`iris`/`swipe`/`bars`/`blocks`, qui ont leur propre calque).**

- **Documenté — `docs/21-navigation.md` : le jeton CSRF précisé comme jamais transmis hors origine (même sur un `µ.ajax` direct), la désactivation automatique des boutons de soumission (+ `aria-busy`) et son opt-out `mjs-no-disable` ajoutés, l'exemple `µ$$draft` rendu autonome (store déclaré à part et importé), et `multipart/form-data` ajouté comme Content-Type accepté au même titre qu'`application/x-www-form-urlencoded` (bascule automatique dès qu'un fichier réel est joint, champs fichier retirés côté serveur avec avertissement).**

- **Documenté — `docs/29-i18n.md` : `vars` de `µ.t()` précisé comme jamais échappé (danger réel combiné à `{{ }}`/`@html=`) et coercé via `String()` sans avertissement pour une valeur non-string (`[object Object]` pour un objet, jointure par virgule pour un tableau, `null` littéral).**

- **Tests — `tests/ujs-hashchange-query-refresh.test.ts` posait un `µ` global minimal sans jamais le restaurer, polluant tout le reste du process Mocha (fichiers suivants) : leur propre repli sur un `µ` par défaut ne se déclenchait plus, ce `µ` étant déjà « défini » mais incomplet.** Sauvegarde et restauration systématiques par `beforeEach`/`afterEach`.

- **Tests — 21 fichiers de tests neufs couvrent les correctifs ci-dessus (CSRF cross-origin, navigation dure, ressort et interpolateur composites, typewriter, modale, bulle `@title`, routeur, transitions de page), chacun écrit rouge puis vert.**

- **Tests — `tests/view-transition.test.ts` ne restaurait `requestAnimationFrame` que s'il préexistait déjà : absent au départ, le faux rAF posé par `loadRouter()` pour ce describe fuitait dans tout le reste du process Mocha (cassait `tests/ujs-scroll-pos-bounded-deferred.test.ts` en combinaison).** Le `after()` retire désormais la clé si elle était absente au départ, plutôt que de ne rien faire.

- **Corrigé — la garde `@confirm` (clic ET soumission) pouvait être sautée dans un composant en Shadow DOM FERMÉ imbriqué dans un autre (`<mjs-showcase-dialog>` dans `<mjs-landing-next>`) : le pont UJS du composant EXTERNE marquait l'événement « déjà traité » sans avoir trouvé le porteur `[mjs-confirm]`, invisible depuis l'extérieur d'un shadow fermé — la suppression partait sans la moindre confirmation.** Le marqueur `_mjsConfirmGated` (`mjs_ujs.ts`, gardes clic ET submit) ne se pose plus qu'au moment où le porteur est RÉELLEMENT trouvé ; l'idempotence déjà couverte en shadow OUVERT (double passage pont/document sur le même événement) reste inchangée.

- **Corrigé — un attribut STATIQUE portant des entités HTML (`title="A &amp; B"`, forme objet de `@confirm`) restait littéral (`&amp;`, `&#123;`…) dès que le compilateur bascule en construction DOM impérative (`document.createElement`/`setAttribute`/prop directe, ex. dans une branche `{await}`/`{success}`), alors que le chemin HTML (`cloneNode` d'un template parsé) les décode déjà nativement au parse.** Nouveau helper `decodeHtmlEntities` (`generator/utils.ts` — entités nommées courantes + numériques décimales/hexadécimales), appliqué avant `JSON.stringify` sur ce chemin (`generator/paths.ts`, `emitAttrSet`) pour tout attribut statique, pas seulement `mjs-confirm`.

- **Changé — un `@xxx` inconnu sur un ÉLÉMENT est un écouteur d'événement, toujours : le compilateur ne compare plus un nom d'événement à rien — ni à la casse d'une directive (`@Confirm`), ni à sa proximité (`@stlye`, `@confirn`, `@next`) — un nom d'événement est libre.** Les deux gardes posées sur ce chemin (`generator.directive-casse`, `generator.attr-directive-typo`) sont retirées avec leurs messages. La vigilance se déplace là où elle a un sens : sur les balises de SECTION, qui n'atteignent jamais le DOM, un attribut inconnu est une ERREUR de compilation avec suggestion — `<style @dsplay="inline">` → `@display`, `<script modul>` → `module`, `<theme @foo>`, `<routes tagret>` (`transpiler.section-attribut-inconnu`, `-suggestion`) — et une directive racine mal écrite (`@improt`, `@persit`) aussi (`transpiler.directive-racine-inconnue`) ; auparavant tous compilaient sans un mot, `<script modul>` perdant même son statut de module. Docs : `09-directives-dom.md`, `22-aide-memoire.md`, `02-composant.md`.

- **Changé — sur une balise de COMPOSANT (`<@x>`, `<mjs-x>`), un attribut écrit sans valeur passe `true` à l'enfant (`<@checkbox disabled>` désactive enfin la case), comme `disabled={true}` ; auparavant la prop recevait la chaîne vide `''`, sans un mot.** Le générateur écrit `disabled='true'`, que le runtime lit déjà comme un booléen ; `title=""` (valeur écrite mais vide) reste `''` ; `popover`, `translate` et les marqueurs `mjs-*` gardent leur forme nue ; les balises natives ne changent pas. Dans du HTML servi par un back, sans compilateur, on écrit `disabled="true"`. Doc : `04-props.md`.

- **Ajouté — `indeterminate={$x}` sur `<@checkbox>` : la case à trois états (« Tout sélectionner » au-dessus d'une liste partiellement cochée).** La prop est transmise à la case native du module (propriété `indeterminate`, donc lecteur d'écran et clavier natifs), le tiret est dessiné dans le style du module et remplace la coche quand les deux sont vrais ; la valeur de formulaire n'en dépend pas. `<@switch>` et `<@radio>` n'en ont pas. Doc : `30-modules-coeur.md`.

- **Changé — les modules cœur (`<@select>`, `<@radio>`, `<@color>`, `<@field>`, `<@checkbox>`, `<@switch>`, `<@img>`) écrivent leurs valeurs par défaut de props avec `=`, comme l'enseigne le chapitre des props, et non plus `?=`.** Aucun changement de comportement : le `<script>` d'un composant tourne au constructeur, les attributs du parent arrivent au montage et gagnent toujours, quel que soit l'opérateur — `?=` n'ajoutait qu'une forme que la doc déconseille deux pages plus loin.

- **Changé — `@import $x 'chemin'` (nom importé à dollar simple, sans `µ$$`) compilait sans erreur : un singleton s'importe et se consomme UNIQUEMENT par `µ$$x`.** La directive `@import` refuse maintenant tout nom commençant par `$` non précédé de `µ$`, avec un message qui oriente vers `@import µ$$x` (déclaration `export µ$$x = …` côté module) ; le contrôle est posé avant la réécriture interne `µ$$x → $x`, pour qu'un singleton canonique reste distinguable d'un nom à dollar tapé à la main.

- **Corrigé — `this[\`routes\`]` (notation gabarit SANS expression, backtick) contournait encore la garde `.page.mjs` et la détection routeur-aware : seule la notation crochet `this['routes']` était couverte.** `detectRouterAware`/ `detectRoutesReassignment` reconnaissent désormais aussi cette forme (`TemplateLiteral` sans expression valant littéralement `routes`).

- **Corrigé — le préfixe de module (`'<moduleName>' : …`) sautait dès qu'une LETTRE du nom de module apparaissait par hasard dans le message (ex. `moduleName: 'a'`, présent dans n'importe quel mot) : faux négatif, jamais préfixé.** La détection « déjà préfixé » exige désormais une mention QUOTÉE du nom de module, jamais une simple sous-chaîne.

- **Corrigé — un `<!--` littéral DANS la valeur d'un attribut (ex. `<div title="<!--">`) était pris pour un vrai commentaire par le masquage `preprocessHtml` et avalait tout le HTML jusqu'au PROCHAIN `-->` réel, directive légitime comprise (perdue sans erreur).** Le masquage des commentaires HTML utilise désormais un scanner qui ne reconnaît `<!--` comme départ de commentaire QUE hors balise (guillemets d'attribut respectés).

- **Corrigé — la détection de directive dupliquée sur une même balise (`transpiler.directive-dupliquee`) était trompée par un `>` littéral dans la VALEUR d'un AUTRE attribut de la même balise (ex. `<a @confirm="A" data-x=">" @confirm="B">`) : deux occurrences passaient sans erreur.** « Même balise » se détermine désormais par le même scanner respectant les guillemets (partagé avec le masquage des commentaires ci-dessus), plus par une simple recherche de `>` dans le texte.

- **Corrigé — la détection de hook dupliqué (`transpiler.hook-duplique`) scannait TEXTUELLEMENT le JS compilé : une simple CHAÎNE de caractères contenant `_mjs_hook('mount', 1)` (ex. message de démo dans le `<script>`) déclenchait un faux positif, refusant un build pourtant légitime.** Le comptage se fait désormais par AST (appels `_mjs_hook(...)` réels uniquement), repli textuel identique à l'ancien comportement seulement si le JS ne parse pas.

- **Corrigé — le remappage de ligne d'erreur Civet ne couvrait que le `<script>` composant : une erreur de syntaxe DANS `<script module>` citait encore une ligne relative au texte compilé du module seul, jamais la vraie ligne du `.mjs`.** Même remappage désormais appliqué à la compilation de `<script module>`.

- **Corrigé — `aliasTag` (tag custom-element alias additionnel) s'insérait SANS échappement dans le JS généré (`customElements.get("${aliasTag}")`/`customElements.define("${aliasTag}", …)`) : un alias portant un guillemet double exécutait du code arbitraire dans le composant compilé.** Même `escapeJsString` que `moduleName`/`tagName` (reliquat du correctif d'injection déjà listé plus haut), appliquée aux deux points d'insertion.

- **Corrigé — une liaison une-sens booléenne (`disabled={$d}`) sur une balise SANS propriété IDL native (`<div disabled={$d}>`, ou tout composant custom) ne retirait jamais l'attribut à `false` : `µ._updAttrNode` se contentait d'écrire la propriété JS et comptait sur la réflexion DOM native, absente sur ces balises.** La présence d'une IDL native pour l'attribut est désormais vérifiée (`attr in Object.getPrototypeOf(node)`, capturée avant l'assignation) ; en son absence, `removeAttribute`/`setAttribute('')` reflètent explicitement la valeur. Balises natives (`<button disabled>`, `hidden` sur n'importe quel `HTMLElement`) et la forme deux-sens `!{…}` (déjà corrigée) inchangées.

- **Corrigé — régression : `<@slot>` nu (sans repli) en toute dernière ligne d'un composant levait désormais `[BALISE NON FERMÉE]`.** La garde-fou ci-dessus, qui traite toute balise HTML non refermée jusqu'à EOF comme une erreur, ne distinguait pas `@slot` des autres balises réservées (`AT_RESERVED_NAMES`) — l'excluant du carve-out qui rend déjà void un raccourci `<@x>` jamais refermé. Idiome pourtant documenté (`docs/13-contexte.md`, `docs/12-snippets.md`). `<@slot …>` jamais refermé et suivi UNIQUEMENT de blanc jusqu'à EOF redevient void, comme `<@slot/>` (même arbre) ; un `<@slot>` porteur de repli (`<@slot>texte`) reste soumis à l'erreur — le HTML impose une fermante pour délimiter où le repli s'arrête. `<@slot>…</@slot>`, `<@slot/>` et un `<div>` réellement jamais refermé sont inchangés.

- **Corrigé — un attribut posé deux fois sur la même balise (`<a @confirm="A" data-x=">" @confirm="B">`, `<div title="a" title="b">`…) pouvait passer inaperçu.** La détection textuelle de `preprocessHtml` (`transpiler.directive-dupliquee`) ne couvre que SES marqueurs `@…=` reconnus, à guillemets — un attribut natif dupliqué, ou une directive déjà réécrite (`mjs-confirm='A' mjs-confirm='B'`), lui échappait. Le parseur pose maintenant un filet générique dans `parseAttrs` : un NOM d'attribut vu deux fois sur la même balise lève `parser.attribut-duplique` (fr/en), nommant l'attribut, la balise et la ligne — casse conservée (`@Title` ≠ `@title`, la casse est traitée ailleurs) ; `@class{cond}`/`@style.prop{cond}` incluent la condition/propriété dans le nom, donc deux conditions différentes ne collisionnent jamais. Scan des 721 `.mjs` réels : une anomalie réelle trouvée, `tuto/9/9-4/tuto-transitions-css.mjs` — un exemple de code affiché dans un `<pre><code>` sans échappement HTML (`L<span class="<span" class="string">"string"</span>>'animation custom '`) produit un `<span>` avec deux `class`, non corrigé ici (hors périmètre).

- **Corrigé — après un `<script>`/`<style>`/`<theme>`/`<routes>`, toute ligne citée par le parseur ou le générateur sur le HTML restant était FAUSSE.** `extractSections` (transpiler/sections.ts) retirait chaque bloc par plage d'offsets sans rien laisser à sa place : les lignes qui suivaient remontaient d'autant (un `{await}` réellement en ligne 6 du `.mjs` était cité « ligne 2 »). Chaque bloc MULTI-LIGNES retiré est maintenant remplacé par un commentaire HTML inerte de MÊME hauteur (mêmes `\n`) : le parseur ne produit aucun nœud pour un commentaire (zéro trace dans l'AST ni dans `surgicalHtml`), seuls les offsets de ligne du reste du gabarit restent justes. Limite connue : un bloc tenant sur UNE SEULE ligne (0 retour à la ligne interne) n'est pas paddé — `extractSections(...).html` reste byte-identique à avant pour ce cas précis (`tests/sections-macro-tag.test.ts`, fixtures `<script>real=1</script>`), et un décalage résiduel d'1 ligne y subsiste, non corrigé.

- **Corrigé — une interpolation Civet `"...#{$x}..."` À L'INTÉRIEUR d'une expression de template (`{"val: #{$x}"}`) s'affichait littéralement (`val: #{$x}`) et ne suivait jamais sa dépendance.** Le vrai compilateur Civet ne comprend pas nativement `#{}` (seul Coffee le fait) : sans conversion préalable en gabarit natif `` `...${$x}...` ``, la chaîne compilait telle quelle et son contenu restait invisible au suivi de dépendances (un texte de `Literal` JS, jamais un nœud d'accès `$.x`). La même conversion déjà appliquée au `<script>` s'applique maintenant à ce chemin : `{"val: #{$x}"}` affiche `val: 1` puis se met à jour normalement quand `$x` mute ; les guillemets simples restent volontairement littéraux (Coffee/Civet n'interpolent que les doubles). Doc : `03-reactivite.md`.

- **Corrigé — une méthode nommée `@__proto__` (`@__proto__ = () -> 1`) faisait planter le compilateur avec un `TypeError: reads is not iterable` totalement muet dès qu'elle était appelée dans le template.** Même famille que `$__proto__`/`$constructor` côté état (déjà refusés) : ce nom, côté méthode, résolvait au prototype JS natif au lieu d'une entrée absente. Refusé maintenant AVANT l'analyse avec un message qui cite le nom fautif (`analyzer.nom-methode-reserve`) ; tous les dictionnaires internes indexés par un nom de méthode/état/computed sont en plus construits sans prototype hérité (`Object.create(null)`), en défense en profondeur.

- **Corrigé — une clé de store `$$__proto__`/`$$constructor`/`$$prototype` compilait sans le moindre avertissement, puis toute écriture ultérieure était silencieusement ignorée au runtime.** Le point de collecte de ces clés au moment de la compilation n'est pas couvert ici ; la garde qui existait déjà côté runtime (`µ._storeDeclare`) se contentait de sauter la clé en silence. Elle lève maintenant une erreur claire citant le nom fautif dès le chargement du module compilé, au lieu d'un skip muet.

- **Reformulé — la doc `03-reactivite.md` promettait que « toute forme de la grammaire Civet » était suivie par la réactivité, sans réserve.** La phrase cite maintenant les formes réellement couvertes (appel sans parenthèses, tube, `unless`, interpolation `#{}`, et les idiomes usuels) sans promesse d'exhaustivité, et rappelle que le build avertit et nomme l'expression quand l'analyse échoue à parser.

- **Corrigé — la garde `<p>` + élément de flow content ne regardait que le SOMMET de la pile d'éléments ouverts : `<p>a<b>x<div>y</div>z</b>b</p>` passait (l'élément courant à l'ouverture du `<div>` est `<b>`, pas `<p>`) alors qu'un navigateur conforme referme le `<p>` ET le `<b>` (arbre éclaté, chemins faux) ; et la garde n'existait QUE dans `extractPaths`, jamais dans le marcheur impératif (`generateCreateFnBodyImperative`), atteint dès qu'une branche `{await}` voisine un `{for}` — `<p>avant{for x in items}{x}{end}<div>flow</div>apres</p>` compilait sans erreur.** Nouveau helper commun `checkFlowInsideP(stack, tagName, line)` : refuse dès qu'un `<p>` est présent N'IMPORTE OÙ dans la pile ouverte (approximation acceptée), appelé par les DEUX marcheurs.

- **Corrigé — `<foreignObject>` (SVG) ne rendait jamais la main au HTML pour ses enfants : `<svg><foreignObject><div>` émettait `createElementNS(svg, "div")`, un élément jamais affiché.** `foreignNamespace` remonte désormais la pile et s'arrête au premier de `foreignobject`/`svg`/`math` rencontré : `foreignobject` (et ses ancêtres SVG plus haut) rend le namespace HTML (`createElement` nu) à ses descendants directs, jusqu'à un éventuel `<svg>`/`<math>` réimbriqué — même stratégie « premier trouvé en remontant » que `isRawTextTag` pour `<title>`.

- **Corrigé — ni `{if}`/`{for}`/`{await}`/`{key}`/`{const}` ne posaient `.line` sur leur PROPRE nœud ; `compileAwait` retombait sur `nearestLine()`, qui cherchait la ligne du PREMIER DESCENDANT muni de `.line` — pas celle du mot-clé `{await}` lui-même. Un `{await}` sur sa propre ligne suivi de `{success}`/contenu sur une ligne ultérieure citait la ligne de ce contenu (ou d'un texte blanc intercalaire), jamais celle de `{await}`.** Le parseur (`parser/index.ts`, `parseFlow`) pose maintenant `.line` directement sur chacun de ces cinq nœuds, comme `tag`/`text`/`expr` le font déjà ; `compileAwait` lit `node.line` directement ; `nearestLine()` (devenue inutile, plus aucun appelant) est retirée. Limite documentée, HORS PÉRIMÈTRE ici : la ligne citée reste relative au TEMPLATE tel que `compile()` le reçoit — via `transpile()`, ce template a déjà perdu les lignes du `<script>` précédent (`sections.ts` retire le bloc par plage d'offsets, sans les remplacer par des lignes vides), donc un `{await}` réellement en ligne 6 du `.mjs` entier peut être cité « ligne 2 » (relatif au template post-extraction) ; décalage préexistant, commun à TOUTE ligne citée par le générateur ou le parseur (vérifié aussi sur `parser.balise-non-fermee`), vit dans `transpiler/sections.ts` — hors des 3 fichiers touchés ici.

- **Corrigé — la forme conditionnelle `@style.<prop>{cond}="valeur"` bénéficie enfin des mêmes protections que `@style.<prop>={expr}`.** Une valeur qui vaut `null`/`undefined` (expression pleine `{expr}`) ne pose plus la chaîne littérale `"null"`/`"undefined"` en CSS, et un suffixe `!important` embarqué (texte ou expression) est désormais détaché et posé comme priorité CSS réelle au lieu de faire rejeter la valeur ENTIÈRE en silence (`setProperty` à deux arguments). La branche conditionnelle appelait `setProperty` directement, un chemin de code distinct de la forme pleine, jamais couvert par les deux corrections précédentes ; condition fausse : `removeProperty`, inchangé. Syntaxe déjà documentée (`09-directives-dom.md`, `17-router.md`), aucun changement de doc.

- **Corrigé — le proxy `coll` de `µ.state()` (Array/Map/Set/Date) refuse enfin `__proto__`/`constructor`/`prototype` en écriture, comme le reste du runtime.** `st.arr['__proto__'] = {...}` ou `st.arr['constructor'] = 'evil'` remplaçaient le PROTOTYPE de l'INSTANCE sans la moindre garde ni avertissement (`Array.prototype` global resté intact, mais `st.arr.push` disparaissait) — ce proxy, posé plus tôt, avait été oublié : `µ._guardPath` (mjs_init.ts), `_wrapDeep` (mjs_element.ts) et `µ.Store` (mjs_store.ts) filtrent déjà cette même famille de clés. Même garde (`µ._safeKey`), même avertissement (`[ModularJS] µ.state : clé refusée (« clé ») — mutation ignorée.`), sur `set` et `deleteProperty`.

- **Corrigé — le proxy `coll` ne viole plus l'invariant Proxy sur une propriété gelée/non-configurable (`Object.freeze(st.arr)` puis écriture, `delete st.arr.length`).** `set`/`deleteProperty` retournaient `true` inconditionnellement, y compris quand l'écriture réelle échouait sur une propriété non-configurable/non-writable du tableau brut — le moteur JS lève alors une `TypeError` interne (« trap returned truish… ») déconnectée de la vraie cause. Les deux traps rapportent maintenant le résultat RÉEL de `Reflect.set`/`Reflect.deleteProperty`, et ne notifient que sur une écriture qui a vraiment réussi.

- **Corrigé — un objet imbriqué DANS un élément de collection (`st.list[0].x = 999`) est enfin réactif.** Le trap `get` de `coll` rendait chaque élément BRUT (contrairement au proxy `nested` juste en dessous, qui rappelle `_wrap` sur toute valeur lue) : muter une propriété d'un objet stocké dans un tableau/une map/un set ne notifiait jamais. Même enveloppe que `nested`, même `rootKey` — l'identité (`st.list[0] === st.list[0]`) reste stable via le cache `_proxyCache` déjà partagé par `_wrap`.

- **Corrigé — le proxy `nested` de `µ.state()` (objets PLATS) refuse enfin `__proto__`/`constructor`/`prototype` en écriture/suppression, et ne viole plus l'invariant Proxy sur une propriété gelée/non-configurable.** `st.obj['__proto__'] = {...}` remplaçait le PROTOTYPE de l'objet BRUT sans la moindre garde ni avertissement — ce proxy, juste en dessous de `coll` dans le même `_wrap`, avait été oublié. `set`/`deleteProperty` gagnent la même garde (`µ._safeKey`, factorisée dans `_guardKey`, partagée avec `coll`), le même avertissement (`[ModularJS] µ.state : clé refusée (« clé ») — mutation ignorée.`), et rapportent désormais le résultat RÉEL de `Reflect.set`/`Reflect.deleteProperty` (plus de `true` en dur, plus de « trap returned truish » sur `Object.freeze(st.obj)` puis écriture).

- **Corrigé — une faille d'injection JS via la cible de `@import`.** La cible citée (`@import nom 'chemin'`) pouvait être délimitée par un guillemet d'ouverture différent de celui de fermeture, et son contenu s'insérait sans échappement dans la chaîne JS générée : un guillemet double au milieu d'une cible entre guillemets simples cassait cette chaîne, le texte suivant devenant du code exécuté au chargement du module. La capture exige le même guillemet aux deux bouts, et toute cible portant un guillemet, un antislash, un retour à la ligne ou un NUL est refusée avant toute interpolation (`transpiler.import-cible-invalide`, fr/en). Même regex et même garde dans une entry serveur `.server.mjs` (`cli/server-entry.ts`).

- **Corrigé — `<@window constructor=!{$x}>`/`toString=!{$x}>`/`hasOwnProperty=!{$x}>` faisait planter la compilation (`TypeError: def.events is not iterable`) au lieu du message « propriété non liable ».** Le nom hérité de `Object.prototype` rendait une fonction truthy sur le lookup `WINDOW_BINDABLE[prop]`, contournant le garde qui protège la suite du traitement. Le lookup passe par `hasOwnProperty` : tout nom hérité tombe proprement dans le message existant (`transpiler.window-propriete-non-liable`).

- **Corrigé — une accolade d'attribut jamais refermée sur une macro globale (`<@window @click={foo(bar>` sans `}` de fermeture) faisait scanner jusqu'au premier `}` suivi de `>` n'importe où plus loin dans le document, avalant le HTML intermédiaire comme attributs de la macro et le réinjectant comme corps de handler — sans la moindre erreur.** Une `<` en tête de ligne suivie d'une lettre, `/`, `@` ou `!`, alors que la profondeur d'accolade reste ouverte, signale qu'une autre balise s'ouvre plus loin : le scan s'arrête et l'erreur `macro-balise-non-fermee` nomme la macro fautive. Un `<` de comparaison en plein milieu d'une expression (`if a < b`) n'est jamais concerné, n'étant précédé que de code sur sa ligne.

- **Corrigé — `role="presentation"`/`role="none"` sur un élément non interactif portant un `@click` coupait l'alerte d'accessibilité, alors que ces deux valeurs retirent explicitement la sémantique de l'élément au lieu de la lui donner.** Ces deux valeurs précises ne comptent plus comme justification ; tout autre rôle (dont un rôle dynamique `role={…}`) reste accepté sans changement.

- **Corrigé — une entry `.civet` brute (`ws.civet`, variante §13.3) contenant une directive MJS (`@import`, `@css`…) compilait en silence vers un appel de méthode ordinaire (`@import a './a.civet'` → `this.import(a("./a.civet"))`), l'erreur ne se voyant qu'au runtime, sans rapport avec la vraie cause.** Une ligne en colonne 0 qui commence par une des directives MJS (`@import`/`@css`/`@routes`/`@i18n`/`@i18nPlaceholder`/`@display`/`@lang`) est refusée avant toute tentative de compilation (`cli.entry-civet-brut-directive`, fr/en), en pointant vers `.server.mjs`. Doc : `23-mjs-ws.md`.

- **Corrigé — `moduleName`/`tagName` s'inséraient SANS échappement dans le JS généré : un nom de fichier `.mjs` portant un guillemet exécutait du code arbitraire dans le composant compilé.** `escapeJsString` (échappe `\`, `'`, `"`, retours à la ligne, U+2028/U+2029) protège les trois points d'insertion (`this._mjs_modName` posé deux fois — constructeur et `init()` —, et le tag auto-enregistré) ; `[[BASE_CSS]]` restait déjà protégé par `escapeTpl`, seule cible distincte (échappement de template literal, pas de littéral simple/double-guillemet).

- **Corrigé — `this['routes'] = …` (notation crochet) contournait la garde de nommage `.page.mjs` et le marquage routeur (`_mjs_is_router_aware`).** `detectRouterAware`/`detectRoutesReassignment` ne reconnaissaient que `this.routes` (accès pointé) ; la notation calculée, pourtant strictement équivalente en JS, échappait aux deux détections — page de routes sans le marqueur attendu compilée sans erreur, composant routeur-aware jamais enregistré auprès de `µ.Router`.

- **Corrigé — `@no-ujs="valeur"`/`@noUJS="valeur"` avalaient silencieusement une valeur au lieu de la refuser, contrairement à `@permanent` sur la même famille de directives.** Même garde désormais des deux côtés : une valeur explicite est un refus de compilation (`transpiler.no-ujs-valeur-refusee`), la forme nue reste inchangée. Doc : `docs/21-navigation.md` (« directive nue, sans valeur »).

- **Corrigé — une erreur de compilation levée par `preprocessHtml` (~25 sites) ou remontée depuis l'analyseur ne portait jamais le nom du module ni de ligne : sur un build multi-fichiers, impossible de savoir LEQUEL des composants avait échoué.** `transpile()`/`transpileFile()` préfixent désormais le message du nom du module (`'<moduleName>' : <message>`) quand il est connu et pas déjà présent dans le message — jamais deux fois, jamais sans `moduleName` fourni.

- **Corrigé — une forme de directive refusée (ex. `@permanent="nom"`) écrite dans un COMMENTAIRE HTML purement documentaire faisait échouer la compilation du composant.** `preprocessHtml` masque désormais les commentaires `<!-- … -->` avant ses réécritures, comme il le faisait déjà pour `<pre>`/`<code>`.

- **Corrigé — une directive posée deux fois sur la même balise (`@confirm="A" @confirm="B"`) compilait en deux attributs HTML de même nom, sans erreur ni avertissement — seule la première valeur survit au DOM, la seconde est silencieusement perdue.** `replaceQuotedDirective` détecte désormais un doublon sur la MÊME balise et refuse la compilation (`transpiler.directive-dupliquee`, nomme la directive et la balise).

- **Corrigé — deux hooks du même nom dans un composant (`µmount ->` écrit deux fois, par exemple) compilaient sans erreur : le second écrase le premier au runtime, le premier ne s'exécute jamais, sans le moindre signal.** Compté sur le script déjà compilé et refusé à la compilation (`transpiler.hook-duplique`, nomme le hook dupliqué).

- **Ajouté — un avertissement quand deux bundles ModularJS définissent le même tag de composant sur une même page.** `customElements.define` était gardé (`if (!customElements.get(tag))`) mais sans `else` : la seconde définition était silencieusement ignorée. Le composant du second bundle avertit désormais une fois (`µ.warn`, repli `console.warn`) plutôt que de disparaître en silence.

- **Corrigé — une erreur de syntaxe dans un `<script>` Civet citait parfois une ligne fausse (décalée de la position du bloc `<script>` dans le `.mjs`).** La position remontée par l'adaptateur est désormais remappée sur la vraie ligne du fichier source, même décalage que celui déjà appliqué à la carte de source en cas de succès.

- **Corrigé — un gabarit à backtick imbriqué dans une interpolation `${…}` corrompait la compilation.** Le scanner principal du lexer (`tokenize`) utilisait encore, pour les gabarits à backtick, l'ancienne regex non récursive `` `(?:\\.|[^\\`])*` `` — elle se refermait au premier backtick INTERNE rencontré (typiquement le backtick ouvrant d'un gabarit imbriqué dans une interpolation), tronquait le token, et la passe d'interpolation des symboles complétait alors avec une `}` fantôme, absente de la source : le JS produit ne compilait pas. Le lecteur à niveaux `scanTemplateAt` (déjà en place pour les pré-passes `§`/`§§`) est maintenant branché aussi dans la grande alternance du scanner principal : un gabarit imbriqué sur plusieurs niveaux (`` `a${ `b${$z}` }` ``) compile intact, symboles réécrits jusque dans l'interpolation la plus profonde.

- **Corrigé — `§nom = expr` / `§§nom = expr` suivi d'un commentaire de fin de ligne cassait la compilation, y compris sur l'exemple canonique de la doc contexte.** La pré-passe § masquait le commentaire puis posait la parenthèse fermante de `_mjs_setContext(...)`/`_mjs_setRCtx(...)` APRÈS le placeholder masqué : au démasquage, le `#`/`//` restauré avalait tout le reste de la ligne, `)` comprise, et Civet partait en erreur de parse sur la ligne suivante. Un commentaire masqué en toute fin d'expression sort maintenant AVANT la parenthèse fermante (une chaîne/regex/heredoc masqué en fin d'expression légitime, lui, reste dans l'expression — seul le contenu du slot masqué tranche entre les deux cas).

- **Corrigé — un commentaire HTML `<!-- … -->` n'était pas reconnu par le parseur : son contenu s'affichait comme texte dans le DOM, et une `{expr}` posée dedans devenait une VRAIE expression compilée.** `<!-- … -->` est maintenant consommé en bloc, multi-lignes compris, sans produire aucun nœud (ni texte ni expr), y compris à l'intérieur d'un `{if}`/`{for}`/`{await}`/`{key}` ; un `<!--` jamais refermé lève une erreur explicite citant la ligne d'ouverture (`parser.commentaire-non-ferme`, fr/en). Doc : `02-composant.md` documente le comportement dans la section du markup, et son exemple d'attribut `<img {src} …>` (raccourci jamais supporté par le parseur, `parser.attribut-nu-non-supporte`) est corrigé en `<img src={src} …>`.

- **Corrigé — une balise HTML jamais refermée jusqu'à la fin du fichier compilait en silence, la balise ouvrante emportant tout le reste du document comme descendants.** Même famille que la fermante orpheline (`parser.balise-fermante-orpheline`, cas symétrique) : une balise non vide, non auto-fermante, qui atteint la fin de fichier sans sa fermante lève désormais une erreur explicite (`parser.balise-non-fermee`, fr/en) nommant la balise la plus profonde concernée et sa ligne d'ouverture.

- **Corrigé — le suivi des dépendances (`getEffectVars`) perdait en silence toute forme Civet que son moteur regex historique ne connaît pas : appel sans parenthèses (`fmt $x`), tube `|>`, `unless` postfixé, et le 2e argument TABLEAU d'un `µt` sans parenthèses (`µt 'clé', [$x, 2]`).** Le code ÉMIS, lui, passait déjà par le vrai compilateur Civet et restait correct — seule l'ANALYSE des dépendances utilisait un chemin plus faible (tokenize + regex), désynchronisé du premier : l'affichage se mettait à jour au montage puis restait figé à vie, sans le moindre avertissement. Quand la tentative JS nue échoue à parser, l'expression est désormais recompilée par le même pipeline que l'émission (même normalisation `isnt`, même cache) avant de conclure à l'absence de dépendance ; si les deux tentatives échouent alors que l'expression contient textuellement un `$xxx`, le build avertit et nomme l'expression au lieu de se taire (`generator.deps-non-analysables`). Doc : `03-reactivite.md`.

- **Corrigé — `$__proto__`/`$constructor`/`$prototype` comme nom d'état faisaient planter le compilateur avec un `TypeError: sub is not iterable` totalement muet, sans jamais nommer la variable en cause.** Ces trois noms résolvent, sur un objet JS nu, au prototype ou au constructeur natif plutôt qu'à une entrée absente — l'analyseur de dépendances y trébuchait loin du point de déclaration. Ils sont désormais refusés AVANT l'analyse, avec un message qui cite le nom fautif (`analyzer.nom-etat-reserve`) ; tout autre nom, y compris un nom proche comme `$proto`, continue de compiler normalement.

- **Corrigé — un `$xxx` mentionné dans un commentaire HTML (`<!-- $fantome -->`) était auto-déclaré comme variable d'état réactive, alors qu'aucun binding réel ne le lit jamais.** L'auto-déclaration depuis le template retire désormais les commentaires HTML du texte avant d'y chercher des `$xxx` — une variable fantôme de ce type n'apparaissait dans aucun effet et ne servait donc à rien, hormis alourdir le registre de présence des variables.

- **Corrigé — un `<div>` (ou tout autre élément de flow content) ouvert alors qu'un `<p>` est l'élément courant provoquait un CRASH réel au montage : le navigateur referme le `<p>` tout seul devant l'élément, le chemin calculé au build visait alors un enfant qui n'existe jamais dans l'arbre réel.** La compilation refuse ce cas explicitement (`generator.p-contenu-interdit`, fr/en), en nommant la balise fautive et sa ligne — liste couverte : `address article aside blockquote details dialog div dl fieldset figcaption figure footer form h1..h6 header hgroup hr main menu nav ol p pre section table ul` (règle HTML5 « p end tag can be omitted »).

- **Corrigé — le premier retour à la ligne collé à l'ouverture d'un `<pre>`/`<textarea>`, avalé par tout navigateur conforme, restait dans le HTML compilé : happy-dom ne l'avale pas, le chemin calculé décalait le binding sur le mauvais enfant en production.** Le premier `\n`/`\r\n` est retiré de la chaîne source elle-même (extraction de chemins ET marcheur impératif), pour que navigateur réel et happy-dom voient exactement le même arbre — un éventuel second retour à la ligne, lui, reste.

- **Corrigé — un `<svg>` compilé en mode impératif (déclenché par une branche `{await}` avec un bloc structurel voisin) créait ses éléments via `document.createElement`, sans namespace : élément jamais affiché.** `generateCreateFnBodyImperative` suit l'ancêtre `svg`/`math` (pile locale, plus un relais explicite depuis `compileAwait` pour le contenu d'une branche `{await}`, compilé à part de son `<svg>` englobant) et émet `createElementNS` pour la racine et ses descendants.

- **Corrigé — `{await}` imbriqué dans un `{for}` compilait en silence un `<span class='mjs-error'>[Await imbriqué non supporté]</span>` visible en production, sans la moindre erreur de compilation.** La compilation refuse ce cas explicitement (`generator.await-imbrique-interdit`, fr/en, nommant la ligne) — un `{await}` imbriqué dans un `{if}` à la racine reste permis (asymétrie volontaire, documentée dans `05-blocs.md`).

- **Corrigé — un guillemet d'attribut resté ouvert jusqu'à la fin d'un gabarit faisait disparaître en silence le tag fautif et tout ce qui le suit (fragment vide, aucune erreur).** La compilation refuse ce cas explicitement (`generator.attribut-guillemet-non-ferme`, fr/en, nommant la balise), dans `extractPaths` et dans le marcheur impératif.

- **Documenté — `{key {a: $x}}` (un littéral objet ou tableau comme expression de clé) fabrique une valeur différente à chaque évaluation : le bloc remonte à chaque passe de `_renderStruct`, même quand la valeur « logique » ne change pas.** Prouvé par montage (compteur de `µmount` d'un sous-composant : remonte à chaque re-rendu non lié à la clé, une clé primitive équivalente reste stable). Doc : `05-blocs.md` § `{key}` — l'expression doit être une valeur stable (nombre, chaîne, identifiant).

- **Corrigé — `05-blocs.md` affirmait qu'une mutation profonde (`$liste[i].champ`) faite depuis une méthode ordinaire du `<script>` ne re-rend pas le `{for}` : contredit par `03-reactivite.md` et par le comportement réel (réactivité profonde suivie d'où qu'elle vienne).** Phrase corrigée pour dire ce que le code fait réellement.

- **Corrigé — `@style.<prop>={expr}` et `--var={expr}` avec une expression qui vaut `null`/`undefined` ne posent plus la chaîne littérale `"null"`/`"undefined"` en CSS.** La valeur brute est testée AVANT toute conversion en chaîne (un gabarit `` `${expr}` `` coerçait null/undefined en texte non vide, qui passait le test d'absence sans broncher, visible surtout sur une custom property `--var` — aucune validation de syntaxe ne la rejette) ; `0` reste une valeur posée (n'est pas traité comme vide). Doc : `08-class.md`.

- **Ajouté — `@style.<prop>={expr}` reconnaît un suffixe `!important` en fin de valeur (casse et espaces libres) et le pose comme priorité CSS réelle.** `style.setProperty(prop, value)` à deux arguments rejette la valeur ENTIÈRE quand elle porte `!important` embarqué, en silence ; le suffixe est désormais détaché et posé en 3ᵉ argument (`'important'`) ; sans suffixe, la priorité reste vide comme avant. Doc : `08-class.md` (note complémentaire : une propriété de longueur veut son unité, la valeur est posée telle quelle).

- **Corrigé — un binding two-way (`disabled=!{$x}` et les autres booléens de `MJS_BOOLEAN_PROPS` : `open`, `selected`, `required`, `hidden`…) retire enfin l'attribut sur une balise sans propriété IDL native (`<div>`, composant custom).** L'ancien code ne comptait que sur la réflexion native (`node.disabled = false` → attribut retiré tout seul), absente hors des tags qui la portent réellement ; un retrait/pose explicite complète désormais l'assignation de propriété, avec un test de présence IDL sur le PROTOTYPE de l'élément (jamais sur l'instance — une assignation crée une propriété expando qui aurait faussé le test dès le 2ᵉ passage de l'effet, au mount comme sur `<button>`). Résiduel connu, hors périmètre ici : la forme UNIDIRECTIONNELLE (`disabled={$x}`, sans `!`) délègue entièrement à `src/runtime/mjs_element.ts` (`µ._updAttrNode`) et porte le même défaut, non corrigé ici.

- **Changé — une directive connue mais mal casée (`@Confirm`, `@Style.color`…) est désormais une ERREUR de compilation qui nomme l'écriture correcte, au lieu de tomber en écouteur d'événement fantôme puis de planter ailleurs (Civet, modificateur d'événement inconnu…) sans rapport apparent avec la vraie cause.** Seule une correspondance EXACTE avec une directive connue, hors casse, déclenche l'erreur — une faute de frappe à distance (`@stlye`) est refusée elle aussi (entrée plus haut).

- **Corrigé — `µ.state()` notifie enfin une écriture DIRECTE sur une collection (`Array`/`Map`/`Set`/`Date`) : `arr.length = 0`, `arr[i] = x`, `arr[10] = 'x'`, `delete arr[i]`.** Le proxy posé par `_wrap` sur ces collections n'avait qu'un trap `get` — seules les méthodes mutatrices (`push`, `sort`, `set`, `add`…) notifiaient ; une affectation ou une suppression nue mutait le tableau/la map/le set brut sans déclencher aucun re-rendu, ni la moindre erreur. `set`/`deleteProperty` rejoignent `get` sur le même proxy, même schéma que `µ.Store._buildProxy` : `rootKey` notifié à chaque écriture, `µ._STRUCT` en plus sur ajout de clé/index ou suppression. Le singleton `µ$$X` (bâti sur `µ.state`) en profite sans code séparé, puisqu'il partage la même fonction.

- **Corrigé — `µminmax` avec des bornes inversées (`min > max`) avertit au lieu de clamper en silence.** `µminmax $x, 100, 0` (faute de frappe plausible sur l'ordre des arguments) ramenait toute valeur au maximum sans le moindre signal. Un `µ.warn` (`[ModularJS] µminmax : bornes inversées (min X > max Y)`) part une seule fois par couple `(min, max)` fautif — le clamp lui-même reste inchangé.

- **Corrigé — `µraw` est enfin respecté par les mutations profondes (`$prices.push(99)`, `$prices[0] = 0`) : elles ne re-rendent plus.** `µ._deepSet`/`µ._deepCall` notifiaient systématiquement, y compris sur une racine marquée `µraw` — contrairement au Proxy d'état local (`_wrapDeep`), qui respectait déjà la marque. Un `µraw` mute silencieusement à toute profondeur, la réaffectation de la variable (`$prices = µraw([...])`) restant le seul déclencheur de re-rendu, exactement comme documenté (`11-etat-brut.md`).

- **Corrigé — l'adaptateur Coffee garde la position (ligne, colonne, ligne source, caret) d'une erreur de compilation au lieu de la perdre entièrement.** Seul le motif nu (« missing " ») survivait jusqu'au message final ; l'erreur brute de CoffeeScript porte pourtant `.location` et un `.toString()` complet, reconstruits dans `.message` avant d'être relancée.

- **Corrigé — `µderived` refuse désormais un `await` dans son corps, à la compilation.** `µderived $total = await f($x), $x` compilait sans la moindre erreur mais `$total` restait figé sur `"[object Promise]"` pour toujours (un dérivé est évalué en synchrone, jamais réawaité). Le corps capturé (`realExpr`) est testé sur la vue déjà masquée par `maskInert` — un `await` DANS une chaîne ou un commentaire (ex. `g('await')`) n'y apparaît plus littéralement et ne déclenche donc jamais le refus, à la différence d'un vrai mot-clé `await`.

- **Corrigé — `µ._deepDelete` respecte enfin `µraw`, comme `_deepSet`/`_deepCall`.** `delete $x.clé` sur une racine marquée `µraw` notifiait quand même un re-rendu, contrairement à la réassignation et à l'accès Proxy (`_wrapDeep`), qui respectaient déjà la marque. Même garde `isRaw` que ses deux voisins : la suppression s'écrit toujours, mais ne notifie plus quand la racine est `µraw`.

- **Précisé — le commentaire du veilleur d'erreurs (`mjs_journal.ts`) décrit la VRAIE forme d'écoute.** « window.onerror + onunhandledrejection » (API à handler unique, jamais utilisée ici) devient « écoute error + unhandledrejection (addEventListener) » — même imprécision que celle déjà corrigée en note de config (mjs_init.ts), aucun changement de comportement.

- **Corrigé — doc : bindings, directives, cycle de vie, stores, état brut, snippets, événements, modules cœur** : `07-bindings.md` disait `value=!{$a}` toujours-chaîne y compris `type="number"`/`"range"` (le code y convertit d'office en nombre) et l'avertissement XSS n'était présent que sous `{{ }}`, pas sous `@html=!` (même sink) ; `09-directives-dom.md` donnait un exemple `@confirn="Supprimer ?"` qui casse la compilation (le `?` invalide comme code) et ne disait pas qu'une directive à valeur entre guillemets dupliquée sur une balise est refusée à la compilation ; `12-snippets.md` ne documentait pas qu'un chemin absolu est accepté par `<@include>`, sans confinement au projet ; `30-modules-coeur.md` n'énumérait que 5 modules cœur sur 8 (pastille couleur et image absentes, sans renvoi vers `35-images.md`) ; `16-cycle-de-vie.md` ne disait ni que le `µmount` d'un enfant tourne avant celui du parent, ni qu'un hook dupliqué (ex. deux `µmount ->`) est refusé à la compilation ; `14-stores.md` ne mettait pas en garde contre `Object.assign($$x, JSON.parse(...))` sur du JSON non filtré (pollution de prototype) ; `11-etat-brut.md` ne signalait pas que `structuredClone` échoue sur un état réactif, y compris lu via `µread` — seul `µraw` donne une valeur clonable ; `06-evenements.md` empilait deux composants dans un seul bloc de code non compilable, séparés en deux blocs nommés.

- **Changé — l'entry `.server.mjs` de `mjs ws`/`mjs serveur` est un VRAI fichier MJS : compilée vers un fichier réel sous `<root>/node_modules/.cache/mjs/server/` (repli `os.tmpdir()`), plus jamais une URL `data:`, et passe par la grammaire `@import` des composants pour importer un fichier du projet, un paquet npm ou un module `node:*`.** Seule `@import` a un sens hors DOM dans un fichier serveur : une cible relative est résolue à côté de l'entry puis sous `--root` et compilée récursivement (même dialecte Civet, détection de cycle) ; un paquet npm nu se résout normalement dès que `<root>/node_modules` existe (le cache y vit justement, sous `.cache/mjs/server/`) ; un `node:*` et une URL `https://` passent tels quels. Toute autre directive (`@i18n`, `@routes`, `@css`…) devient une erreur de compilation explicite. Un `import … from` natif, un `import('…')` dynamique d'un chemin littéral, ou un ré-export `export … from '…'` sont une erreur de compilation qui nomme l'entry et la cible visée (clés `cli.entry-import-natif-interdit`/`cli.entry-import-dynamique-interdit`/`cli.entry-reexport-interdit`) — seule `@import` importe un fichier du projet ; `import(variable)`, calculé à l'exécution, reste autorisé. Une entry `.civet` brute (sans le dialecte des composants, sans `@import`) suit la même mécanique de fichier réel + cache-busting. Un commentaire (`#…`, `###…###`, `//…`, `/*…*/`) ou une chaîne, même multi-lignes, contenant du texte qui ressemble à une directive (`@param`, `@foo`…) n'est jamais lu comme telle : la détection masque commentaires et chaînes avant de chercher `@import` ou une autre directive. Un spécificateur avec sous-chemin ou `@scope` (`mjs-framework/ws`, `@scope/pkg/sub`) est un paquet npm, jamais un chemin de projet ; un `.json` s'importe avec l'attribut de type qu'exige Node. Les spécificateurs de la doc et des squelettes sont ceux du paquet publié, `mjs-framework/ws` et `mjs-framework/mjs-server`. Doc : `23-mjs-ws.md`, `24-mjs-server.md`.
- **Ajouté — le prérendu sème dans la page les sections i18n qu'il a consultées : nouvelle balise `#__mjs_i18n`, juste à côté de `#__mjs_store`.** Le moteur happy-dom charge sur disque, en plus des sections de la langue effective, toutes les sections de la langue par défaut quand elle diffère — une section pas encore traduite se résout dès le premier rendu par le même repli que le client, jamais par son placeholder ; il marque ensuite chaque couple (langue, section) réellement consulté au montage, repli compris. Le moteur navigateur relit son cache de fragments réellement chargés, quelle que soit leur langue. Les deux sérialisent `{ lang, sections }` avec le même échappement que `#__mjs_store`, `sections` nichée par langue puis par section (`{ "en": {…}, "fr": { "panier": … } }`) : une section servie en repli sort sous la langue qui la porte, pas sous la langue affichée. Aucune section consultée → aucune balise. Le client relit la graine au démarrage, avant tout montage : une section déjà rendue par le serveur, repli de langue compris, n'est plus jamais redemandée. La graine du moteur navigateur n'étiquette jamais une section repliée sous la langue affichée en plus de sa langue réelle. Côté happy-dom, le rendu serveur ne précharge plus tout le dictionnaire d'une langue : il lit paresseusement, sur disque, la seule section consultée, une fois par fragment, mise en cache pour la durée de vie du renderer. Doc : `19-ssr.md`, `29-i18n.md`.
- **Ajouté — option `debounce` (anti-rebond) sur `send()` du client MJS-WS.** Silence de N ms sur un type avant émission : chaque envoi remplace la charge en attente et remet la minuterie à zéro, seule la dernière charge part à la première pause — à la différence de `coalesce` (cadence fixe même sous activité continue), utile pour un champ de recherche ou un curseur qu'on relâche. `cooldown` s'applique avant, comme pour `coalesce` ; `debounce: true` retombe sur `debounceMs` (200 ms par défaut) ; avec `coalesce`, `debounce` l'emporte. `close()` (et `destroy()`) annule tout `debounce`/`coalesce` en vol — rien ne repart à la reconnexion suivante ; `debounce: 0` déclenche l'anti-rebond au tour de boucle suivant, une valeur négative est ramenée à 0. `debounce` et `coalesce` acceptent une chaîne numérique (`'300'`), `coalesce: 0` regroupe au tour de boucle suivant, et toute valeur invalide est ignorée avec un avertissement unique par socket et par option. Doc : `20-temps-reel.md`.
- **Ajouté — clé de config `logLevel` : un seul réglage pilote la console du navigateur (`µ.log`/`µ.warn`/`µ.error`) ET ce que le build retire du bundle.** Chaîne (`"logLevel": "warn"`) ou objet `{ dev?, prod? }`, niveaux `'log' > 'warn' > 'error' > 'silent'`, défauts `dev: 'log'`, `prod: 'warn'` (comportement de production inchangé par défaut). Le niveau de PROD gouverne la liste `pure` du minifieur (`src/bundler/minify.ts`, `buildPureList`) : `'log'` ne retire rien, `'warn'` reprend la liste actuelle, `'error'` ajoute `console.warn`/`µ.warn`, `'silent'` ajoute encore `console.error`/`µ.error` — `drop` reste écarté (viderait aussi les corps de `µ.error`/`µ.warn`, cf. le commentaire déjà en place). Côté navigateur, `µ._logLevel` (posé par le build dans le manifeste, repli `'log'` si absent) est consulté par `µ.log`/`µ.warn`/`µ.error` (`src/runtime/mjs_init.ts`) ; `µ.debug = true` force toujours `'log'`, quel que soit le réglage. Les avertissements du terminal (`mjs build`/`mjs dev` — runtime manquant, `sharp` absent, module `require` introuvable, résumé `stats.warnings`, échec de purge) respectent aussi le niveau de l'environnement courant (`Bundler.buildWarn`) ; restent hors périmètre les avertissements émis PENDANT la validation de `mjs.config.json` elle-même (l'environnement dev/prod n'y est pas encore connu) et ceux du prérendu/SSR et de `mjs-ws`, sur leur propre canal. Validation stricte, même patron que `lint` (`bundler.config.log-level-*`, fr/en). Doc : `32-cli-et-configuration.md`, `34-deboguer.md`.

- **Ajouté — lint `lint.ujsForm` : avertissement quand un `<form>` n'a ni `action`, ni `@method`/`mjs-method`, ni `@noUJS`.** Le pont UJS (`µ._ujsShadowAttach`, `src/runtime/mjs_ujs.ts`) intercepte TOUT `<form>` en phase capture, y compris dans le Shadow DOM — le contrat reste entier, mais sans destination déclarée la soumission repart en navigation vers l'URL courante (`action=""` compte comme absente, même piège). Un `@submit.prevent` posé sur le formulaire n'y change rien : le pont capture avant le `_bindEvents` du composant. Simple avertissement de compilation (`transpiler/ujs-form.ts`, clé de message `transpiler.lint.ujs-form`), **activé par défaut**, coupable via `"lint": { "ujsForm": false }` (validation stricte, même patron que `lint.a11y`). Doc : `32-cli-et-configuration.md`.

- **Corrigé — `<@failed retry="N">` borne le nombre de réessais (un seul par défaut) : `reset()` ne remonte plus une instance fraîche à l'infini sur une erreur déterministe.** Le compte de tentatives déjà consommées est porté par l'attribut DOM `mjs-retry-used`, recopié d'une instance à l'autre par `µ._resetComponent` (seul support qui survit au remplacement de nœud) — un compteur posé sur l'instance elle-même serait remis à zéro à chaque reset. `retry="0"` interdit tout réessai ; la limite atteinte affiche le fallback avec l'erreur, `reset` devient sans effet, et un message de console (`transpiler.failed-boundary-retry-epuise`, fr/en) signale l'abandon. Doc : `15-elements-speciaux.md`, `22-aide-memoire.md`.

- **Corrigé — `{µt 'clé', { x: $v }}` (appel Civet sans parenthèses) perdait la réactivité en silence.** `getEffectVars` (generator/state.ts) tentait l'expression entière via un parseur JS pur (acorn), qui ne comprend pas le sucre Civet « appel sans parenthèses » ; la décomposition de secours en extrayait alors le contenu de l'objet littéral SANS ses accolades (`x: $v`, un label invalide comme élément de tableau), l'analyse échouait et la dépendance disparaissait sans avertissement. Chaque bloc de la décomposition est désormais testé dans les deux lectures (nu, puis avec ses accolades) et retient celle qui parse — la forme parenthésée n'est pas affectée.

- **Changé — `µwrite` s'écrit désormais avec une virgule : `µwrite $x, v` / `µwrite($x, v)`, valeur en second argument.** L'ancienne forme `µwrite $x = v` / `µwrite($x) = v` est retirée et devient une ERREUR DE COMPILATION dédiée (`transpiler.rune-write-ancienne-forme`) qui donne la nouvelle écriture, plutôt que de laisser une assignation muette sortir du build. La valeur n'est jamais capturée par une regex — le corps s'arrête à la virgule, elle continue telle quelle dans le flux (même mécanisme que l'ancien `= v`), ce qui la laisse contenir ses propres parenthèses (`µwrite $total, calc(a, b)`) sans aucun comptage de profondeur. `µread` ne change pas : pas de valeur à passer, rien à harmoniser. Doc : `11-etat-brut.md`, `14-stores.md`, `22-aide-memoire.md`.

- **Changé — préchargement : `on` devient le nom canonique, `eager` disparaît de `mjs.config.json`.** `VALID_PRELOAD_MODES` (bundler) est désormais `off`/`hover`/`on` ; un projet qui écrit encore `eager` dans sa config se le voit refuser au build, le message listant `on` comme valeur valide. Au runtime, `_normPreload` s'inverse : `eager` devient l'alias TOLÉRÉ (normalisé en `on`), jamais une erreur — un attribut `data-mjs-preload` déjà compilé ou un `µ.preload` forgé à la main peuvent encore le porter, et cette fonction tourne à chaque survol/scan, hors de toute vérification de build. Le compilateur continue d'accepter les deux orthographes pour la directive/l'attribut `@preload` (hors périmètre ici) ; seule la configuration devient stricte. Doc : `17-router.md`, `22-aide-memoire.md`.

- **Corrigé — cinq défauts : nom de page vide, remède absurde sur un marqueur mal casé, marqueur `.page` en double, `@title={{{ … }}}` qui compilait en `[object Object]` au survol, et une phrase de doc devenue fausse sur `mjs serve`.** Un fichier reconnu `.page.mjs` dont le nom tombe à vide une fois le marqueur retiré (`.page.mjs` seul), ou qui en porte un second résiduel (`x.page.page.mjs`), est refusé au build (clés `bundler.page-nom-fichier-vide`/`bundler.page-marqueur-double`) plutôt que de produire un tag/une clé de manifeste vides ou un point résiduel dans le tag (`mjs-x.page`). Le remède proposé quand le marqueur est mal casé (`x.PAGE.mjs`) cite désormais le nom PROPRE (`x.page.mjs`), jamais l'ancien renommage absurde (`x.PAGE.page.mjs`). `@title={{{ expr }}}` (trois accolades accolées ou plus) est refusé (`transpiler.title-html-triple-accolade`) au lieu de glisser la troisième accolade dans le corps comme un objet littéral. Le seul test de sécurité existant de la bulle HTML (un `<script>` injecté reste inerte) est complété par un test qui prouve qu'un attribut `onerror`/`onload` posé via `mjs-title-html` s'exécute VRAIMENT — avertissement renforcé en conséquence dans `30-modules-coeur.md` et l'en-tête de `mjs_title.ts`. Doc : `32-cli-et-configuration.md` corrigée sur un point voisin trouvé au passage — `mjs serve` sort en erreur AVANT d'ouvrir son port dès que la compilation initiale échoue (rien n'est jamais servi), contrairement à `mjs dev` qui garde un filet (dernière version valide, avec avertissement) ; l'encart affirmait à tort que les deux commandes se comportaient pareil.

- **Ajouté — convention de nom `.page.mjs` pour tout module qui déclare un bloc `<routes>`, la
  directive `@routes` ou une balise `<@view>` — hors d'un tel fichier, ces trois formes sont
  désormais un refus de compilation (message : fichier, forme trouvée, renommage attendu).** Le
  marqueur `.page` est retiré du nom AVANT toute dérivation (tag, classe, alias court, clé de
  manifeste, sortie hachée) : `accueil.page.mjs` produit le même `<mjs-accueil>` qu'`accueil.mjs`.
  Une des trois formes vivant dans un partiel inclus (`<@include nom>`) ne compte pas pour lui :
  c'est le fichier HÔTE qui doit porter le marqueur. `µurlChange` seul (sans aucune des trois
  formes) n'est pas concerné. Doc : `17-router.md`.

- **Ajouté — `@title` accepte une quatrième forme, HTML BRUT (`@title={{ expr }}`) : le contenu de
  la bulle est posé en `innerHTML` (élément réel, réactif) au lieu de `textContent` — même
  convention que `{{ }}`/`{ }` en interpolation de texte.** Disambiguation par les deux premiers
  caractères après `@title=` : deux accolades ouvrantes ACCOLÉES (`{{`) déclenchent la forme HTML,
  compilée en l'attribut `mjs-title-html` (distinct de `mjs-title`) ; un espace entre les deux
  (`@title={ { text: '…' } }`) garde la forme simple, l'objet littéral y restant une expression
  ordinaire — cas rare, à connaître. Sur un élément portant les deux attributs, le HTML
  gagne. `{{` jamais refermé par `}}` est une erreur de compile explicite. Sécurité : porte ouverte
  volontaire, comme `{{ }}` en interpolation — aucune désinfection. Doc : `30-modules-coeur.md`.

- **Changé — un composant qui échoue à compiler ne garde plus son ANCIENNE sortie référencée
  pendant un `mjs build`.** Le repêchage du manifeste (introduit pour éviter l'écran blanc)
  reste actif en `mjs dev` et `mjs serve`, où le site doit rester utilisable le temps de
  corriger ; en build il est coupé, parce que la version repêchée peut importer un
  `mjs_core-<hash>.js` supprimé depuis — la page meurt au navigateur alors que le build
  s'achève sans rien signaler d'autre qu'un avertissement. Option `keepFailedComponents`
  du bundler (défaut `true`), passée à `false` par le CLI hors dev/serve.

- **Modifié — `@title` remplace entièrement le `title` natif de l'élément qu'elle décore, au lieu de coexister avec lui.** Le `title` natif est mis de côté (attribut retiré, valeur mémorisée, chaîne vide comprise) tant que `mjs-title` reste posé, et restitué à l'identique dès que `mjs-title` disparaît (retiré par un effet, élément recyclé par une navigation, composant détruit). Si le retrait laissait l'élément sans aucun nom accessible (pas de texte visible, pas de `aria-label`/`aria-labelledby` déjà posé), un `aria-label` reprenant la valeur native prend le relais le temps de la substitution — jamais si l'auteur en a déjà un. Doc : `30-modules-coeur.md`.

- **Ajouté — directive `@permanent` (forme nue, sans valeur) pour un élément qui traverse une navigation UJS sans être recréé — compile en l'attribut `mjs-permanent`, casse insensible comme `@no-ujs`.** L'attribut plat écrit à la main reste valide (forme équivalente). `@permanent="nom"` (avec valeur) est refusé au build : l'appariement entre deux navigations se fait par `id`, jamais par un nom porté par la directive. Doc : `21-navigation.md`, `22-aide-memoire.md`.

- **Ajouté — `@confirm` accepte une troisième forme, EXPRESSION (`@confirm={$message}`, `@confirm={$a || $b}`, `@confirm={calculerMessage()}`) : passe-plat réactif, le message est relu à chaque clic (jamais figé à celui du montage).** Distinguée de la forme objet par son contenu, même disambiguation que `@title={...}` : un hash d'options porte toujours au moins une `clé:` en tête, tout le reste est une expression. La forme objet (`@confirm={ text: '…', ok: '…', cancel: '…' }`) et la forme chaîne restent inchangées. Doc : `06-evenements.md`.

- **Ajouté — le joker `*` d'une route pose désormais DEUX clés : `all` (le tableau des segments décodés, `&all`) et `rest` (ce même tableau rejoint par `/`, `&rest`) — `rest` reprend exactement ce que rendait `all` jusqu'ici ; `all` n'est donc plus une chaîne, un template qui le lisait comme texte doit passer à `&rest`.** Vaut aussi côté serveur (`mjs serve`/`mjs build`) : `matchPattern` pose désormais les deux mêmes clés dans les `props` passées au composant. Doc : `17-router.md`, `19-ssr.md`, `22-aide-memoire.md`.

- **Ajouté — `@pageTransition` sur un lien accepte la syntaxe OBJET (`@pageTransition="cube={ dir: left }"`), même mini-grammaire que `@viewTransition` sur `<@view>`/`<style>` (`parseVtValue`) ; le suffixe `nom:direction` (`@pageTransition="cube:left"`) devient une erreur de compilation, comme aux quatre autres positions.** `on`/`off` et le nom seul restent inchangés. `priority`/`p` est refusé au build : la cascade d'un lien n'a que deux niveaux (lien, config), rien à départager (l'arbitrage départ/arrivée reste réservé au routeur/`<@view>`). Doc : `17-router.md`.

- **Ajouté — `<@img src="hero.jpg">` : un `src` littéral se résout au build comme un
  `µimage('hero.jpg')`, la balise ressortant avec `srcset`/`sizes`/`width`/`height` remplis.**
  Un attribut posé à la main (`sizes`, `width`, `height`, `srcset`) garde toujours la main —
  seuls les attributs absents sont ajoutés ; `widths="320 640"` (espaces ou virgules) choisit
  les largeurs de variantes pour cette image seule et ne survit pas dans le HTML émis. Un
  `src={…}` dynamique, un chemin absolu ou une URL passent tels quels ; un fichier introuvable
  fait échouer le build, comme pour `µimage`/`µasset` — chemin qui sort de `sourceDir` compris,
  et quelle que soit la casse de la balise (`<@IMG>` est résolu comme `<@img>`, son nom restant
  celui qu'a écrit l'auteur). Un `widths` calculé, ou un `src`/`widths` écrit deux fois sur la
  même balise, est refusé au build plutôt que retiré en silence. Doc : `35-images.md`.

- **Corrigé — le message d'erreur du suffixe `nom:direction` interdit (`@viewTransition.cube:left`)
  proposait le même exemple à POINT pour `@pageTransition` sur un lien, alors que sa vraie forme
  est une CHAÎNE (`@pageTransition="cube={ dir: left }"`), `@pageTransition.cube={...}` n'existant
  pas.** Les 4 positions `@viewTransition` (racine, `<@view>`, `<style>`, balise ordinaire) gardent
  leur exemple à point ; `@pageTransition` reçoit désormais le sien.

- **Corrigé — un `{if}`/`{key}` racine englobant un `{await}` : le contenu de ce dernier ne
  réapparaissait jamais après un masquage puis un ré-affichage (même un `<p>` statique, sans
  aucun binding).** L'ancre TEXTE du `{await}` (`s-<id>`/`e-<id>`, frère du contenu) sortait de
  `_destroyNodeAndChildren` sans passer par la purge d'état de sous-arbre : `_awaitMap`/
  `_awaitLastRender` survivaient à la fermeture de la branche englobante, et `_updAwait`
  retrouvait au ré-affichage la même promesse et le même dernier statut rendu, sans jamais
  redéclencher la création du contenu. La purge s'applique désormais aussi à cette ancre.

- **Corrigé — `@group=!{...}` (radios/checkboxes) et `@text=!`/`@html=!` (contenteditable) dans une
  branche `{await}` (et un `{if}`/`{key}` imbriqué dedans) : seule l'écoute DOM→modèle était câblée,
  la lecture modèle→DOM n'était jamais émise.** Un groupe de radios n'affichait AUCUNE sélection à
  l'ouverture ni après mutation du modèle (`@group=!{$choix}`, idem checkbox groupée en tableau) ;
  un `<div contenteditable @text=!{$t}>`/`@html=!{$h}` restait VIDE dès lors qu'aucun `{for}` ne
  l'englobait. La pose initiale et la réactivité ultérieure suivent désormais le même point d'entrée
  que le two-way standard (`value=!`/`checked=!`).

- **Corrigé — un formulaire `method="dialog"` (ou un bouton `formmethod="dialog"`) dans un
  `<dialog>` voyait sa fermeture native BLOQUÉE : l'UJS annulait l'événement puis tombait sur un
  verbe HTTP refusé, sans repli.** La méthode `dialog` (HTML : ferme la boîte, n'envoie rien au
  réseau) n'est désormais jamais interceptée — le navigateur ferme le `<dialog>` nativement ;
  `@confirm` continue de jouer avant, comme pour toute autre soumission. Vaut uniquement pour
  l'attribut `method`/`formmethod` : un champ caché `_method=dialog` n'est PAS une méthode HTML, il
  est refusé explicitement (`µ.error`), jamais laissé filer vers le `method` réel du formulaire.
  Doc : `21-navigation.md`.

- **Corrigé — `<@element>`/`<@module>` : un `@click={…}` (ou tout `@événement`) posé DIRECTEMENT
  sur la balise cessait de répondre dès le premier remplacement de nœud (`$tag`/`$comp` différent
  du placeholder `<div>`, le cas quasi général) — l'id de routage événementiel (`_mjs_ids`, posé
  par `_registerRefs`, lu par la délégation `_bindEvents`) restait sur l'ancien nœud DÉTACHÉ,
  jamais recopié vers le nouveau, en silence.** `µ._updDynEl`/`µ._updModule` recopient désormais
  cette propriété vers le nouveau nœud avant le remplacement. Un enfant portant son propre
  `@click` n'était pas concerné (il est DÉPLACÉ vers le nouveau nœud, jamais recréé) ; les
  modificateurs (`.prevent`, `.propagate`…) restent intacts, encodés par id et non par nœud.

- **Corrigé — `<@element>`/`<@module>` : une liaison réactive (`@style.*`, attribut) posée sur la
  balise devenait ORPHELINE dès le premier remplacement de nœud (`$tag`/`$comp` différent du
  placeholder `<div>`, le cas quasi général) — elle continuait d'écrire sur le nœud DÉTACHÉ, en
  silence, pour toujours.** `µ._updDynEl`/`µ._updModule` resynchronisent désormais toute entrée de
  `component._nodes` qui pointait sur l'ancien nœud vers le nouveau ; le `style` en cours (posé par
  un effet `@style.*` juste avant le remplacement) est en plus recopié explicitement. Limite
  connue : une propriété IDL non reflétée en attribut (`value`, `checked`) posée par un effet AVANT
  le remplacement ne suit pas automatiquement, sa propre liaison réactive la réapplique au prochain
  changement. Doc : `15-elements-speciaux`.

- **Corrigé — `<@element>`/`<@module>` : 2 effets de bord du remplacement de nœud introduits par
  les 2 correctifs précédents.** Le filet explicite pour `style` copiait `cssText` même VIDE
  (`cur.style` est TOUJOURS truthy, tout nœud DOM porte un `CSSStyleDeclaration`) : un nœud SANS
  aucun style héritait d'un `style=""` parasite dès le premier remplacement. Un `.once` déjà
  déclenché (`_mjs_once_fired`, `WeakMap<nœud, Set<clé>>`) se redéclenchait à CHAQUE
  remplacement suivant, le nouveau nœud étant une clé neuve — `@click.once={…}` posé sur la
  balise repartait à chaque bascule au lieu de rester définitivement consommé.
  `µ._updDynEl`/`µ._updModule` ne recopient désormais le style que s'il est réellement présent,
  et transfèrent l'entrée `.once` déjà déclenchée vers le nouveau nœud avant le remplacement.
  Limite connue (pré-existante, non corrigée ici) : `@this=!{ref}` sur ces balises capture le
  nœud INITIAL (placeholder), jamais le nœud courant — la référence ne suit aucune bascule.
  Doc : `15-elements-speciaux`.

- **Corrigé — réponse JSON 404 (`module: null`) : en mode `routeNotFound: 'silent'` ou `'warn'`,
  aucun panneau n'est affiché mais `_lastUjsPath` avançait quand même vers la destination 404 (et
  la page défilait) — incohérence entre l'adresse mémorisée et le DOM réellement affiché.**
  `_lastUjsPath` (et le défilement) ne bougent désormais que si le panneau **Page introuvable** est
  réellement installé (mode `'error'`, le défaut) ; `mjs:load` reste émis dans tous les cas. Une
  réponse 404 arrivée en retard, après qu'une navigation plus récente a déjà pris la main,
  n'installe plus rien par-dessus elle non plus.

- **Corrigé — soumission de formulaire GET sans action explicite (`formaction=""` ou repli sur
  l'URL de la page) : un fragment (`#…`) présent dans l'URL du document faisait atterrir la query
  APRÈS lui, syntaxiquement DANS le fragment — les champs soumis étaient perdus au fetch réel, en
  silence.** Le fragment est désormais retiré avant que cette URL ne serve de repli ; une action
  EXPLICITE portant sa propre ancre (`action="/x#ancre"`) garde celle-ci, la query s'insère avant.

- **Corrigé — soumission de formulaire GET dont l'action porte déjà une query (`action="/x?existing=1"`,
  `action="?"`) : la query du formulaire s'AJOUTAIT à celle de l'action au lieu de la REMPLACER**
  (`/x?existing=1&q=hello` au lieu de `/x?q=hello` ; `action="?"` produisait `?&q=hello`, un `&`
  orphelin). Conforme au comportement natif d'un `<form method="get">` : la query du formulaire
  REMPLACE désormais celle de l'action ; un formulaire sans aucun champ garde l'action telle quelle.

- **Corrigé — navigation UJS (clic, retour arrière, soumission) recevant une réponse JSON sous
  transition de vue DIFFÉRÉE : la page « actuellement affichée » (`_lastUjsPath`, clé d'hibernation
  du cache de pages) changeait AVANT que le swap réel n'ait lieu.** Une 2e navigation démarrée
  pendant ce délai hibernait le contenu ENCORE affiché sous la clé de la destination de la 1re
  (jamais réellement montée), corrompant le cache de pages. La mise à jour a désormais lieu dans le
  swap lui-même, sur tous les chemins qui affichent réellement quelque chose — y compris le panneau
  « Page introuvable » d'une réponse 404 (`module: null`).

- **Corrigé — `<@element>`/`<@module>` : la variable de balise doit venir en premier, et doit
  être présente.** Un attribut posé AVANT elle était avalé comme expression de balise, sans
  erreur — attribut à valeur (`<@element accept="iframe" $tag>` compilait en
  `µ._updDynEl(@, '0', (accept="iframe"))`, `$tag` fuyait tel quel dans le HTML rendu) comme
  attribut booléen sans `=` (`<@element hidden $tag>`) ; et une balise sans AUCUNE variable
  (`<@element>` seul) laissait l'ouvrante littérale face à sa fermante convertie, dépareillées.
  Toutes ces formes sont maintenant une erreur de build ; `<@element tag>` (identifiant nu seul,
  rien après) reste licite.

- **Corrigé — `<@element {expr}>`/`<@module {expr}>` : une expression entre accolades en 1ʳᵉ
  position (`<@element {a || 'div'}>`) était tronquée au premier espace interne, le reste
  (`|| 'div'}`) fuyait tel quel dans le HTML rendu, sans erreur.** Le tag est une variable
  (`$tag`), jamais une expression entre accolades — cette forme est maintenant une erreur de
  build explicite qui cite l'expression entière ; calcule la valeur dans une dérivée
  (`$tag = a || 'div'`).

- **Corrigé — `<@element/>`/`<@module/>` auto-fermés SANS espace avant le `/` échappaient à la
  garde « auto-fermeture interdite ».** Seule la forme espacée (`<@element $tag/>`) était
  détectée ; collée au nom (`<@element/>`), la balise traversait intacte, sans erreur. La
  frontière `/` collée est maintenant reconnue au même titre que `>` collé, la garde s'applique
  aux deux formes.

- **Corrigé — `<@element>`/`<@module>` : un attribut `accept="…"` DUPLIQUÉ ne retirait que sa
  première occurrence, la seconde fuyait telle quelle dans le HTML rendu.** Toutes les
  occurrences sont désormais retirées ; un doublon est une erreur de build.

- **Corrigé — `µ._updDynEl`/`µ._updModule` (`<@element>`/`<@module>`) : un `display` posé par le
  RUNTIME (masquage d'une valeur falsy) et un `display` posé par l'AUTEUR (`style="display:flex"`)
  se mélangeaient.** Un nœud masqué puis basculé vers un autre tag héritait du masque — élément
  créé mais invisible, en silence (la copie d'attributs recopiait le `style` de l'ancien nœud) —
  et un `display` d'auteur était détruit dès le tout premier rendu, masquage ou pas. Le runtime ne
  retire (et ne pose) plus que SON PROPRE masque, jamais un `display` qu'il n'a pas lui-même
  écrit ; un `style` statique de l'auteur, `display` compris, survit à la bascule et se restaure
  après un cycle masquage/démasquage.

- **Corrigé — `µ._updDynEl`/`µ._updModule` : un tag/nom de composant réduit à des espaces après
  épuration (`'   '`) traversait la garde de masquage et atteignait `document.createElement('')`,
  qui lève.** La garde teste maintenant la valeur ÉPURÉE : un tag/composant blanc est masqué
  comme n'importe quelle valeur falsy, sans exception.

- **Corrigé — `µ._updDynEl`/`µ._updModule` : un tag/nom de composant entouré d'espaces
  (`' div '`) passait le contrôle d'acceptation mais ne matchait jamais le tag existant**
  (recréation à chaque appel) et levait `InvalidCharacterError` sur un vrai navigateur (happy-dom
  laissait passer en silence). Une seule valeur trimmée sert désormais à la comparaison, la
  création et le message d'avertissement.

- **Corrigé — liaison bidirectionnelle (`=!{...}`) dans une branche `{await}` (et un `{if}`/`{key}`
  imbriqué dedans) : seule l'écoute DOM→modèle était câblée, la lecture modèle→DOM n'était jamais
  émise.** `<input value=!{$v}>` y restait vide, `<select value=!{$v}>` figé sur la 1re option, une
  case `checked=!{$c}` jamais cochée à l'ouverture — et une mutation du modèle après montage restait
  sans effet, même quand la valeur initiale s'affichait par ailleurs. La pose initiale suit
  désormais le même point d'entrée que `{for}`/la racine (valeur d'un `<select>` posée après ses
  options, comme le binding simple) et la réactivité ultérieure passe par le même mécanisme que la
  racine.

- **Corrigé — `<select multiple value={tableau}>` en liaison SIMPLE (pas `=!{...}`) : `node.value =
  tableau` ne sélectionnait rien, en silence** (le setter DOM natif attend un scalaire). La
  sémantique multi-sélection déjà utilisée par la liaison bidirectionnelle (comparaison en chaîne
  des valeurs d'option) s'applique désormais aussi à ce chemin.

- **Corrigé — dans une branche `{await}` (et un `{if}`/`{key}` imbriqué dedans), un attribut interpolé
  ne suivait pas la sémantique du reste du rendu.** `disabled={d.v}`/`checked={d.v}` restaient PRÉSENTS
  pour toute valeur fausse (`false`, `null`, `0`, `''` : la valeur était coercée en chaîne, `'false'` est
  vrai), `<textarea value={d.txt}>` restait vide (attribut posé au lieu de la propriété), `<select
  value={d.v}>` retombait sur sa première option (valeur posée avant les `<option>`), et une expression
  composée (`disabled={!d.v}`, `d.list[0]`, `d.a + ' ' + d.b` — celle-ci coupée au premier guillemet,
  template non terminé) partait en chaîne. Toute valeur formée d'une seule interpolation est désormais
  passée BRUTE au même point d'entrée que le montage initial et le `{for}` (`µ._updAttrNode` : booléens,
  `value` en propriété, `null`/`false` → retrait, filtre XSS conservé) ; la valeur d'un `<select>` est
  posée après ses options.

- **Corrigé — liste de paramètres de fonction : un commentaire de bloc refermé SUR la ligne `) ->`
  (`b /* x\n y */) ->`) faisait encore perdre tous les paramètres**, et une ligne commençant par un
  commentaire de bloc suivi de code (`/* c */ x = 1`) n'auto-déclarait jamais `x`. La passe d'auto-
  déclaration travaille désormais sur des lignes dont les commentaires sont blanchis à longueur égale
  (seules les lignes situées dans une chaîne restent inertes), les réécritures conservant les
  commentaires d'origine.

- **Corrigé — fins de ligne CRLF : un composant enregistré avec des `\r\n` (édition Windows) perdait
  tout le sucre mono-ligne (`k = (a, b) ->` jamais déclaré).** Le source est normalisé en LF à l'entrée
  de la compilation ; la sortie est en LF pour tout le monde.

- **Corrigé — quatre mineurs du transpileur.** Un chemin d'asset résolu contenant `$&`/`$1` aurait été
  interprété comme motif de remplacement ; le préfixage i18n des clés `µt('…')` réécrivait aussi une clé
  CITÉE dans une chaîne ou un commentaire du `<script>` ; les variables du `<script module>` étaient
  collectées par une lecture ligne à ligne du source (une affectation en colonne 0 dans un commentaire
  `###…###` passait pour une variable de module et empêchait l'auto-déclaration d'une homonyme dans le
  `<script>`) — elles sont lues dans l'arbre du code compilé ; les `export let`/`export const`/`export
  function` du module n'étaient pas vus par les gestionnaires inline (`@click={x = 3}` déclarait un `x`
  local, écriture perdue).

- **Sécurité — `<@element $tag>`/`<@module $comp>` refusent désormais aussi `iframe`, `object`, `embed`,
  `base`, `link`, `meta` et `style` (avec `script`), même avertissement nommant la balise.** Le nouvel
  attribut `accept="iframe style"` (liste de noms séparés par des espaces, littérale) remplace ce pool
  par une liste FERMÉE : présent, seul un nom qu'il contient est créé — pool ou pas, `div` compris ;
  une liste normalisée vide (`accept=""`) n'autorise donc plus rien. Une valeur vide, dynamique ou mal
  formée est une erreur de build ; côté runtime, un `accept` d'un type qui n'est ni chaîne ni tableau
  vaut absent (avertit, ne rend pas le composant muet) et une liste passée en chaîne est tolérée.
  Doc : `15-elements-speciaux`.

- **Corrigé — transitions : une transition `.shared` pouvait rejouer l'easing d'une autre** (la signature
  du `@keyframes` partagé reposait sur la LONGUEUR du code de la fonction d'easing — `bounceIn` et
  `sineIn` ont la même) ; `steps: 0` produisait des offsets NaN, `steps: Infinity` une boucle infinie
  (mémoire épuisée), `steps: NaN`/`'abc'` des keyframes vides — le pas est borné (non fini → 60, inférieur
  à 1 → 1) ; `µ.easing.resolve('bounceOut')` (nom inconnu en chaîne) avertit en mode debug avant de
  retomber sur `cubicOut`.

- **Corrigé — rideau de transition de vue : une permutation de page qui levait laissait l'écran NOIR à
  vie** (la phase de révélation ne venait jamais). La permutation est isolée ; l'erreur est tracée et le
  rideau se lève toujours.

- **Corrigé — composant `<mjs-radio>` : un `name` contenant un guillemet faisait lever le sélecteur du
  groupe** au changement de valeur. Le nom est échappé (`CSS.escape`, repli sans lui).

- **Sécurité — état des composants et `µ.Store` : `Object.setPrototypeOf(...)` et
  `Object.defineProperty(..., '__proto__', ...)` contournaient les gardes des traps `set`/`delete`.**
  Les deux traps manquants sont posés (refus bruyant : `TypeError` pour `Object.*`, `false` pour
  `Reflect.*`), une clé sûre passe comme avant.

- **Corrigé — navigation UJS : un formulaire contenant un champ nommé `action` ou `target` échappait à
  l'interception** (les propriétés `form.action`/`form.target` sont masquées par un champ homonyme :
  `new URL(élément)` levait depuis l'écouteur → soumission native, ou UJS se retirait en silence) ; un
  `_method` porté par un champ fichier tuait la soumission. Les attributs sont lus, l'action résolue
  sous garde. Le bouton soumissionnaire impose désormais `formaction`, `formtarget` et `formmethod`
  (le champ `_method` reste l'override explicite du verbe).

- **Corrigé — navigation UJS sous transition de vue : la resynchronisation du routeur, l'événement
  `mjs:load` (zone indéfinie) et, pour une soumission, la redirection après envoi partaient AVANT
  l'installation quand la transition différait le swap** ; le retour en haut de page du chemin JSON
  précédait aussi le swap. Tout cela s'exécute désormais dans le swap lui-même ; sans transition, l'ordre
  est inchangé. Une fiche serveur dont `module` n'est pas une chaîne recharge la page au lieu de lever.

- **Amélioré — préchargement des liens : le HTML préchargé porte les mêmes en-têtes de navigation qu'un
  clic** (`X-MJS-Nav` posé, `version`/`reload`/`target`/`method`/`cache` mémorisés avec l'entrée) : la
  garde « bundle périmé » et les consignes du serveur s'appliquent aussi à une page servie depuis le
  cache de préchargement.

- **Corrigé — `render.forwardOrigin.trustedHosts` : une IPv4 mappée en notation pointée
  (`::ffff:1.2.3.4`) ou une IPv4 non canonique (`01.02.03.04`, `0x7f.1`, `2130706433`) était acceptée
  au build mais ne matchait jamais l'en-tête `Host` à l'exécution** (forwarding mort en silence). La
  validation passe par la même normalisation d'adresse que l'exécution et refuse ces formes en indiquant
  celle à écrire ; un hôte interne (localhost, loopback, réseaux privés, lien-local, métadonnées) —
  toujours bloqué par la défense en profondeur — déclenche un avertissement au build.

- **Corrigé — macros globales : une balise `<@window>`/`<@head>`/`<@element>`… dont une accolade ou un
  guillemet n'est jamais refermé est désormais une ERREUR de build** (avant : laissée en texte dans la
  page, sans un mot) ; un `<@include` qui ne correspond pas à la forme `<@include chemin>` (attributs,
  chemin absent) l'est aussi. Le masquage de `<@head>`/`<@failed>` lors de la découpe en sections
  reconnaît la profondeur des accolades (module partagé `macro-tag.ts`).

- **Amélioré — l'heuristique « ce `/` ouvre un regex ou divise » ne relit plus tout le texte déjà émis
  à chaque `/`** (queue bornée, sémantique identique prouvée sur chaque `/` de 1 100 composants) : un
  script de 20 000 divisions passe de plusieurs secondes à quelques millisecondes, le plus gros
  composant réel de 30 ms à 1 ms, dans le lexer, le parser, le générateur et le transpileur.

- **Corrigé — un littéral regex `/…/` placé juste avant `µimport(…)`/`µtoggle(…)` sur la même
  ligne pouvait laisser la rune non consommée, ou corrompre la sortie.** Le scanner PARTAGÉ
  (`rewriteMuImport`/`rewriteMuToggle`/`skipInertFrom`, `src/sigils.ts`) ne reconnaissait pas le
  littéral regex comme zone inerte, contrairement au lexer et au générateur : un `#` non
  alphabétique dans la regex (`/#-/`) était pris pour un commentaire Coffee et sautait le reste
  de la ligne ; un `'` ou un backtick dans la regex (`/'/`, `` /`/ ``) ouvrait une fausse chaîne
  qui courait jusqu'au prochain guillemet du source, ou ajoutait un backtick fantôme en sortie ;
  un `//` interne (slashes échappés, `/\/\//`) était pris pour un commentaire de ligne. La rune
  restait alors littérale dans le JS livré — `ReferenceError` au navigateur, build resté vert.
  Effet de bord corrigé en prime : une regex qui MENTIONNE la rune (`re = /µtoggle/`) ne lève
  plus d'erreur de forme d'appel.

- **Corrigé — un `>` niché dans l'accolade d'un handler de macro globale (`<@window>`,
  `<@document>`, `<@element>`, `<@module>`, `<@failed>`) tronquait la balise en silence.** Une
  comparaison (`window.scrollY > 100`), un `if…then…else` ou un attribut dynamique voyaient leur
  balise se refermer au premier `>` rencontré — handler amputé, résidu de texte dans le HTML rendu.
  Un commentaire `//` dans un `<script>` de `<@head>` avalait aussi la ligne suivante (le saut de
  ligne était écrasé en espace) : les deux scans reconnaissent désormais la profondeur des
  accolades/guillemets et préservent les sauts de ligne réels.

- **Amélioré — un `<@include>` compilé sans chemin de fichier (`baseDir` absent) est désormais signalé par un avertissement explicite au lieu d'être retiré du HTML en silence.**

- **Sécurité — trois gardes runtime renforcées : élément/composant dynamique, store réactif,
  décodage binaire de schéma.** `<@element $tag>`/`<@module $comp>` laissaient un état choisir la
  balise `script` — un élément/composant dynamique ne peut plus devenir un script (les enfants
  déplacés dedans, souvent une interpolation de donnée, s'exécutaient sinon comme du JS à
  l'insertion). `µ.Store` filtre désormais `__proto__`/`constructor`/`prototype` sur ses traps
  `set`/`deleteProperty` (parité avec le store global) — une donnée réseau versée dans un store ne
  peut plus polluer son prototype. Le décodeur binaire client (`µ.schema`) borne explicitement
  chaque lecture à la fenêtre logique de la trame — une trame reçue comme vue d'un buffer plus
  grand ne peut plus lire des octets voisins hors trame.

- **Corrigé — `readImageSize` pouvait planter sur une image corrompue, et un hôte mal formé dans
  `trustedHosts` restait accepté sans jamais matcher (forwarding muet).** Un PNG tronqué levait une
  erreur au lieu de rendre `null`, un JPEG avec bourrage ou marqueur sans longueur désynchronisait
  le balayage, un `<svg>` sans `width`/`height` propres pouvait hériter de ceux d'un enfant au lieu
  de son `viewBox`. Un élément de `render.forwardOrigin.trustedHosts` avec port, crochets, chemin
  ou espace est désormais refusé au build (il ne matchait jamais l'hôte comparé au forwarding).

- **Amélioré — le calcul de la ligne d'un nœud, dans le parseur, ne recompte plus le texte entier
  à chaque appel** (index paresseux + recherche dichotomique) : ~45 % de moins sur un HTML de
  100 Ko (58,8 ms → 32,2 ms, médiane de 5 passes).

- **Corrigé — une liaison ou un handler d'événement disparaissait en silence quand deux
  attributs du même élément se disputaient le même événement natif.** `@text=!{$x}`/`@html=!{$x}`
  (contenteditable) et `@group=!{$x}` (radios, cases) écrasaient la route d'un `@input=`/
  `@change=` voisin au lieu de s'y empiler, selon l'ordre des attributs dans le gabarit. Dans une
  branche `{await}`, une prop dynamique posée sur un composant enfant ne s'appliquait plus du
  tout, et un attribut statique portant une variable nue restait vide après résolution — les
  trois corrigés.

- **Sécurité — un attribut dynamique posé dans une branche `{await}` (ex. `href={d.url}`)
  n'était jamais filtré contre les schémas `javascript:`/`data:text/html`, contrairement au même
  attribut au montage initial ou dans un `{for}`.** Il passe désormais par le même filtre que le
  reste du rendu.

- **Corrigé — une liste de paramètres de fonction écrite sur plusieurs lignes cassait le build si
  le corps réassignait l'un d'eux.** Une fermeture `) ->`/`) =>` n'était reconnue comme liste de
  paramètres que sur son UNIQUE ligne ; étalée sur plusieurs lignes, aucun nom n'était retenu — la
  réassignation d'un paramètre dans le corps levait « Identifier 'a' has already been declared »,
  et une valeur par défaut de continuation se faisait hisser en déclaration fantôme. La liste est
  maintenant reconstituée quelle que soit son indentation, y compris déstructurée. Un commentaire
  sur une ligne de continuation (seul sur sa ligne, en fin de ligne de paramètre, `#` Coffee
  compris) faisait perdre le paramètre suivant par la même mécanique — il est désormais retiré
  avant reconstitution de la liste. Un commentaire de BLOC `/* … */` (mono-ligne ou multi-lignes,
  `###…###` Coffee compris) glissé au même endroit — entre deux paramètres, après le dernier, ou
  au milieu d'une liste tenant sur une seule ligne — provoquait la même perte ; un commentaire posé
  APRÈS la flèche (`f = (a) -> // note`) empêchait même la portée de s'ouvrir, hissant le paramètre
  en déclaration fantôme au niveau racine au lieu de le reconnaître. Les deux formes de commentaire
  sont désormais retirées avant reconstitution de la liste, quelle que soit leur position.

- **Corrigé — un `#` À L'INTÉRIEUR d'un littéral regex était pris pour un commentaire Coffee par
  la Pass 1 de compilation.** `re = /#\d/` voyait son `#` converti comme en tête de ligne
  (`re = ///\d/`) — échec de compilation bruyant mais faux, `/#\d/` est un regex légitime. La Pass 1
  reconnaît désormais le littéral regex comme zone inerte, même heuristique que le reste du
  compilateur (`ouvreUneRegex`/`scanRegexLiteral`).

- **Sécurité — trois défenses SSRF/open-redirect renforcées côté rendu par requête et actions
  serveur.** Le forwarding d'origine (`render.forwardOrigin: { trustedHosts }`) lisait
  `X-Forwarded-Proto` sans validation (un en-tête portant une URL complète détournait l'hôte
  visé par la requête sortante) et un `Host` en syntaxe userinfo (`hote:80@attaquant`)
  franchissait l'allowlist sous le nom de l'hôte légitime avant de pointer ailleurs au moment
  de composer l'URL — les deux sont désormais restreints à une forme stricte, avec une
  vérification finale sur l'URL réellement composée. La détection d'IP interne canonicalise
  maintenant l'hôte via le parseur d'URL avant de le tester : les formes IPv4 non standard
  (décimal pur, hexadécimal, octal, notation courte) désignaient bien une adresse interne mais
  échappaient à la reconnaissance ; les plages CGNAT et multidiffusion/réservées sont aussi
  couvertes. Enfin, une cible de redirection portant un caractère de contrôle (tabulation, saut
  de ligne) passait la garde anti-open-redirect des actions serveur — le navigateur les retire
  en lisant l'en-tête `Location`, ce qui rouvrait une redirection externe ; ces caractères sont
  désormais refusés.

- **Corrigé — le message d'erreur de rendu brut pouvait fuiter malgré `--prod`.** Seul
  `NODE_ENV=production` masquait le détail ; l'option `--prod` de `mjs serve` est maintenant
  prise en compte à elle seule.

- **Ajouté — un bloc de slot côté appel : `<@fill nom>…</@fill>`** (constante `FILL_DIRECTIVE` du parser). Sucre de compilation : le bloc pose `slot="nom"` sur chacun de ses enfants
  (composants compris, blocs `{if}`/`{for}`/`{await}`/`{key}` traversés) quand plusieurs éléments visent le même
  slot nommé ; un texte nu, un enfant qui porte déjà `slot=`, un bloc imbriqué ou un nom dynamique sont refusés au
  build avec la ligne. L'attribut natif `slot="x"` reste la forme pour un seul élément. 12e balise réservée.

- **Ajouté — `mjs build` retire les orphelins de son dossier de sortie.** Le build remplaçait déjà l'ancienne
  empreinte d'un fichier qui change, mais un nom qui disparaît (composant renommé ou supprimé) laissait son
  fichier pour toujours : mesuré sur un site réel, 893 fichiers dans `outputDir` pour 330 produits par le
  dernier build. Après un build sans erreur, avant le prérendu, `mjs build` retire tout fichier nommé comme
  ses propres sorties (`nom-<empreinte>.ext`, son `.map`, une variante d'image) qu'il n'a pas produit, et
  les liste (`🧹 8 fichiers orphelins retirés de public/modularjs`, vingt noms au plus). Jamais touchés :
  les sous-dossiers, le manifeste, les `.css` de layout, ses fichiers de travail, tout fichier étranger ;
  un build en erreur ne retire rien. Clé de config `prune` (booléen, `true` par défaut) ; `mjs dev` et
  `mjs serve` ne purgent jamais.

- **Ajouté — le build refuse une variable, un paramètre, un import ou une écriture nue nommée
  `$`, `$$` ou `µ`.** Ces trois symboles désignent l'état du composant, le store et le runtime ;
  un paramètre `($) -> $.style.color = 'red'` les masquait en silence, build vert, mutation
  perdue (l'écriture repartait dans l'état du composant plutôt que sur l'élément voulu). Le
  message cite le nom fautif et la ligne du JS compilé qui le porte. Le refus couvre aussi la
  variable et l'index d'un `{for}` (et tout autre nom introduit par le template). Même refus
  explicite pour un `§`/`§§` (contexte figé/réactif) isolé, sans nom derrière — au lieu d'un
  message cryptique du compilateur sous-jacent.

- **Corrigé — un motif de destructuration à index calculé échappait à l'auto-déclaration.**
  `[arr[0], tmp] = […]`, `[$$liste[k], tmp] = […]`, `[[a, b], c] = […]`, `{a: {b}} = o` : le crochet
  interne rendait le motif invisible à la passe, `tmp` (ou `a`, `b`, `c`) n'était jamais déclaré —
  `ReferenceError` au premier clic, build vert. Les crochets internes sont maintenant lus : un accès
  membre (`arr[0]`, `$$liste[k]`, `@items[i]`) est une cible membre, jamais une variable, les noms lus
  dans l'index ne sont jamais déclarés, un motif imbriqué déclare les siens. Même passe : un motif mixte
  entre un nom déjà déclaré et un nom neuf (`[x, tmp] = [tmp, x]`) hisse maintenant le neuf au lieu de le
  laisser non déclaré. Une valeur par défaut dans le motif (`[a = 1, b]`) reste hors de la passe.

- **Corrigé — `placeholder: 'wait'` posé dans le config ne différait RIEN, et le différé
  lui-même laissait passer un rendu.** Deux défauts empilés (flash de
  `⟦tuto.chap_…⟧` pendant ~60 ms au chargement d'une page du tuto). (1) Le mode était lu depuis
  le seul override par module (`@i18nPlaceholder wait`) : un `"placeholder": "wait"` global était
  honoré pour le rendu du placeholder mais jamais pour l'attente, à rebours de ce que la doc
  annonce — il y a maintenant UNE définition du mode effectif, partagée par les deux. (2) Même
  avec le mode actif, on se contentait d'ANNULER le rendu programmé (`_pending_full`,
  `_pending`) : le batch déjà en file relançait quand même le rendu structurel et les effets
  (`_pending_struct_dirty`, posé par les écritures d'état du setup), et toute mutation survenant
  avant l'arrivée du fragment repeignait la page en placeholders. Le composant est désormais
  **gelé** jusqu'à la résolution — aucun rendu, quelle qu'en soit la cause — et la levée du gel
  déclenche un rendu COMPLET qui rattrape tout ce qui a bougé entre-temps. Le gel est levé même
  si le composant a été démonté entre-temps, et la promesse d'attente aboutit toujours (échec
  réseau compris) : jamais de composant blanc à vie.

- **Corrigé — une transition d'entrée déclenchée PAR le montage était sautée en silence.** Le
  drapeau « premier rendu » (`_mjs_initial_render`, qui empêche toute la page d'animer au
  chargement) n'était baissé qu'APRÈS le tir du montage. Or une écriture faite par un callback
  de montage repasse par le fast-path SYNCHRONE de l'invalidation : le DOM était repatché avec
  le drapeau encore levé, et la garde d'intro sautait. Symptôme : un `{key}` changé par le
  premier tir de `µevery` apparaissait **d'un bloc**, sans son `@in`, alors que les suivants
  s'animaient normalement (leçon `blocs-key` du tuto : le premier message s'affichait entier,
  sans typewriter). Le drapeau est désormais baissé au tout début du tir de montage — le premier
  rendu est terminé à ce moment-là, par construction. Conséquence à connaître : un `µmount ->`
  qui écrit un état fait maintenant **jouer** les transitions d'entrée des nœuds que cette
  écriture crée, comme le `onMount` de Svelte.

- **Corrigé — un corps de timer `async` qui échouait ne prévenait personne.** Le `try/catch`
  autour du tick est synchrone : ce qui rejette APRÈS le premier `await` lui échappait. L'échec
  ne partait vers aucune frontière d'erreur, `_has_crashed` n'était jamais posé, le timer
  rejouait indéfiniment — et chaque rejet devenait un `unhandledRejection`, fatal sous Node.
  Le motif était pourtant l'exemple vedette de la doc (`$etat = await sonderLaConversion()`).
  Une promesse rendue par le corps ou par `onStop` est désormais suivie et routée comme une
  exception ordinaire. Dans la foulée : une condition `while` `async` rend une promesse,
  toujours vraie — la répétition ne se serait jamais arrêtée ; c'est maintenant un avertissement
  explicite suivi d'un arrêt. Et les clés d'options ne sont plus lues sur la chaîne de
  prototypes (faux « option inconnue » sur un hash fabriqué hors du DSL).

- **Ajouté — hash d'options sur `µevery`**, facultatif, entre le délai et la fonction
  (`µevery 3000, pause: true, ->`) : `immediate: false` (pas de tir au montage), `times: n`
  (n tirs puis arrêt), `while: -> cond` (évaluée avant chaque tir, faux = arrêt sans tirer),
  `pause: true` (suspend quand le composant quitte le DOM sans être détruit — hibernation du
  cache de pages — et reprend à son retour), `onStop: ->` (appelé une seule fois à l'arrêt,
  quelle qu'en soit la cause : main d'arrêt, `times` épuisé, `while` tombé, démontage, crash).
  `times` et `while` dispensent d'écrire la main d'arrêt soi-même dans les deux cas courants ;
  `pause` ferme le trou de l'hibernation, jusqu'ici documenté comme un piège. Une clé inconnue
  est signalée dans la console et une valeur du mauvais type retombe sur le défaut de sa clé :
  le timer tourne quand même. La forme courte à deux arguments est inchangée. Au passage, deux
  files de callbacks internes symétriques de `_mjs_mount_cbs` (`_onSleep` / `_onAwake`) : une
  rune qui suspend ne peut donc pas écraser le `µsleep ->` / `µawake ->` de l'utilisateur.

- **Ajouté — la rune `µevery 2500, ->` : un timer de composant qui part TOUT DE SUITE.** Le
  motif « `setInterval` au montage, `clearInterval` au démontage » s'écrivait à la main en deux
  hooks, et laissait de toute façon l'écran vide pendant le premier délai — `setInterval`
  n'appelle jamais son corps immédiatement. La rune tire une première fois **au montage**, répète
  ensuite, et coupe l'intervalle au démontage définitif. Elle rend une **main d'arrêt**
  (`arreter = µevery 1000, ->` puis `arreter()`) pour cesser avant. Branchée sur le montage et
  pas sur le setup : au SSR les hooks client ne jouent pas, donc aucun timer ne tourne dans le
  rendu serveur, et le premier tir arrive APRÈS le premier rendu — un `{#key}` qui change à ce
  tir fait donc jouer sa transition d'entrée normalement. Elle passe par une FILE de callbacks
  de montage (`_mjs_mount_cbs`) et jamais par `_mjs_hooks.mount`, qui n'a qu'une case par nom :
  un `µmount ->` utilisateur et plusieurs `µevery` cohabitent sans s'écraser. Hors du `<script>`
  (interpolation, handler), erreur de compilation explicite.

- **Ajouté — parenthèses optionnelles sur `µread` / `µwrite`.** `µread($x)` compile désormais à
  l'identique de `µread $x`, et `µwrite($x) = v` de `µwrite $x = v` — comme tout appel en Civet.
  La forme parenthésée n'était reconnue par aucun des deux moteurs de sucre et sortait LITTÉRALE
  (`µread($.i)`) : `µread` n'existant nulle part au runtime, c'était un `ReferenceError` au
  premier tick avec un build vert. Ce qui n'est pas un symbole d'état entre les parenthèses
  (`µread(compteur)`, `µwrite($x, v)`) est maintenant refusé au build au lieu de survivre en
  identifiant littéral — de même que la référence nue (`f = µread`) et la forme coupée par un
  saut de ligne, qui étaient muettes elles aussi. En regard, deux formes cessent de lever :
  l'accès MEMBRE (`obj.µread`, `a.µwrite = 1` — une propriété qui porte ce nom, pas la rune ;
  le lexer n'avait pas le garde de frontière que cleanJs a toujours eu, et compilait
  `a.µread $x` en `a._mjsThis._state.x`, en silence), et le mot simplement CITÉ dans une ligne
  de commentaire.

- **Corrigé — les gardes `µderived` et hooks de cycle de vie refusaient un build sur le mot
  simplement CITÉ dans un commentaire.** `// exemple : µderived $x = 1` ou `// hook : µmount ->
  foo` dans un handler ou une interpolation faisait échouer la compilation : ces deux gardes
  testaient le texte brut, où les chaînes sont masquées mais pas les commentaires — or le
  commentaire inline est la norme du projet. Ils passent maintenant par la même neutralisation
  des lignes de commentaire que `µevery` et `µread`/`µwrite`. Le vrai code reste refusé, y compris
  derrière un littéral regex piégeux (`/http:\/\//`) et en commentaire de FIN de ligne.

- **Corrigé — sept défauts des trois entrées
  ci-dessous, tous invisibles pour les 5036 tests de la suite.** (1) `mjs build` avec un
  `mjs.config.json` PRÉSENT dont le `sourceDir` a été renommé rejouait le sinistre à
  l'identique — « ✅ 2 fichiers écrits », code 0, manifeste écrasé : la garde ne couvrait que
  l'absence de config, elle refuse maintenant tout dossier source introuvable, et couvre aussi
  `mjs check` et `mjs dev`. (2) Des composants derrière un **lien symbolique** étaient comptés
  zéro (`Dirent.isDirectory()` ne suit pas les liens) : un projet valide se faisait refuser —
  même parcours que `Bundler.findFiles` désormais (`statSync` + `realpathSync`, cycles fermés).
  (3) Une variable du `<script>` déclarée `:=` (constante) réaffectée depuis un handler
  produisait un « Assignment to constant variable » au premier clic : refusée au build, en
  nommant l'opérateur à changer. (4) Un `nom = valeur` posé dans un **commentaire** ou une
  **chaîne multi-ligne** du `<script>` était pris pour une variable du script → `ReferenceError`
  au clic : les noms sont maintenant lus sur l'**AST du JS compilé**, jamais sur le texte.
  (5) Le nom d'un `{const}` et l'argument d'un `{success}`/`{error}` n'étaient pas enregistrés
  comme locaux du template : un homonyme du `<script>` se faisait écraser au clic, sans un mot.
  (6) `TOGGLE_MOTS_RESERVES` ne testait que la forme nue : `µtoggle(null.x, …)` passait et
  plantait au clic — la garde porte sur la RACINE. (7) Faux positif du contrôle de zone morte
  sur un helper récursif local (`fact = (n) => … fact(n - 1)`) : seule la part évaluée
  immédiatement est jugée, une relecture dans un corps de fonction ne condamne rien.

- **Ajouté — le repli `templateLang: "js"` (handlers en Coffee) écrit lui aussi dans les
  variables du `<script>`.** Coffee auto-déclare nativement et n'a pas de `predeclared` : on le
  laisse compiler, puis on retire de sa sortie, sur l'AST, les `var` sans valeur portant un nom
  qui vit déjà dans le corps de fonction du composant. Même résultat que le chemin Civet, par
  l'autre bout — les locales de travail et les variables de boucle gardent le leur.

- **Corrigé — un gestionnaire d'événement peut enfin ÉCRIRE dans une variable ordinaire du
  `<script>`.** Le batch des handlers est compilé à part du `<script>` composant, et sa passe
  d'auto-déclaration ne connaissait aucun des noms déclarés à côté — alors qu'ils vivent dans le
  MÊME corps de fonction, visible par closure. Elle posait donc un `let` LOCAL sur chaque
  écriture : `@click={n = 'b'}` écrivait dans une copie jetée à la sortie du handler (écriture
  PERDUE, sans un mot) et `@click={n = n + 1}` levait un « Cannot access 'n' before
  initialization » au premier clic. Les vars top-level du `<script module>` et du `<script>` sont
  désormais passées au batch, MOINS les noms que le template y introduit lui-même (variable et
  index de chaque `{for}`, reconstruits en tête de handler) — sans ce filtre, un `<script>`
  portant un homonyme de la variable de boucle se serait fait écraser à chaque clic. Dernier cas,
  celui du `$` oublié : un nom que RIEN ne déclare et qui se relit dans sa propre valeur est
  maintenant refusé AU BUILD, message nommant la variable et les deux issues (déclarer dans le
  `<script>`, ou écrire `$nom`). 7 tests (`tests/handler-vars-script.test.ts`), 5 prouvés rouges.

- **Modifié — `µtoggle` bascule tout chemin ASSIGNABLE, plus seulement `$x`/`$$x`.** La contrainte
  réelle n'a jamais été « un état » : c'est que la chaîne de ternaires RELIT la cible une fois par
  test. Sont donc admis `$x`, `$$x`, `§x`, `§§x`, `µtheme`, `µlang`, `@prop`, une variable
  ordinaire, et les chemins `.clé` / `[littéral]` qui en descendent (`$o.a.b`, `$arr[0]`). Restent
  refusés, parce qu'ils seraient évalués plusieurs fois : un appel, un `++`, un index calculé
  (`$arr[$i]`) — et les mots que JS ne laisse pas réaffecter (`null`, `this`…), qui sortaient
  jusqu'ici en SyntaxError du navigateur. ⚠️ Tout ce qui est assignable n'est pas RÉACTIF :
  `@prop`, `§x` et une variable ordinaire basculent bel et bien, mais rien ne se redessine — c'est
  documenté, et ce n'est plus un piège muet depuis le correctif ci-dessus.

- **Ajouté — `mjs build` refuse de construire quand il n'y a rien à construire.** Lancé depuis le
  mauvais dossier — ou visant une racine sans sources — le build écrivait un projet VIDE en
  annonçant « ✅ 2 fichiers écrits », code de sortie 0 : le manifeste du site servi se retrouvait
  remplacé par un `µ.paths = {}`, plus un seul composant connu, page blanche, et rien pour arrêter
  un script de déploiement qui enchaîne sur un `rsync`. Deux refus, distincts dans le message :
  ni `mjs.config.json` ni dossier source sous la racine visée, ou un dossier source présent mais
  sans le moindre `.mjs`. Rien n'est écrit, code de sortie 1. La garde est dans le CLI seulement —
  l'API `Bundler` n'y touche pas. 3 tests (`tests/cli-build-garde-racine.test.ts`), 2 prouvés
  rouges.

- **Ajouté — `µtoggle` : basculer ou faire cycler un état, sans répéter son nom.**
  `@click={µtoggle($layout, 'banner')}` remplace le ternaire qui écrivait le nom de l'état trois
  fois. Sucre de COMPILATION pur : la rune disparaît du code livré, remplacée par l'affectation
  qu'on aurait écrite à la main (rien n'est embarqué au runtime). **La liste des arguments EST la
  liste des états**, dans l'ordre, en boucle : `µtoggle($theme, 'gold', 'dark')` oscille entre les
  deux valeurs et ne passe JAMAIS par le vide ; le vide n'entre dans le cycle que s'il est écrit
  (`µtoggle($x, '', 'a', 'b')`). Deux raccourcis : une seule valeur = présent/absent
  (`'' ⇄ 'banner'`), aucune valeur = bascule booléenne. Une valeur courante hors liste retombe sur
  le PREMIER état. Cible : `$x` (état local) ou `$$x` (store global) — la rune la rend verbatim,
  ce sont les passes du dessous qui posent le setter réactif (`µ._set`, `µ._storeSet`), donc elle
  marche à l'identique dans un `<script>` et dans une interpolation/handler. Refusés à la
  compilation, avec message : une cible qui n'est pas un état, une valeur calculée (la chaîne de
  ternaires l'évaluerait deux fois), une valeur répétée dans le cycle, la forme nue ou sans
  parenthèses. 28 tests (`tests/rune-toggle.test.ts`), 25 prouvés rouges.
  **3 défauts trouvés, tous corrigés et couverts.** (1) MUET —
  la rune nichée dans une fenêtre d'interpolation (`` {`etat: ${µtoggle($x, 'a')}`} ``) n'était pas
  consommée par `cleanJs` : le sucre survivait dans le fichier livré → *ReferenceError* au premier
  rendu, sans un mot à la compilation (le `<script>`, lui, s'en sortait par accident, la passe étant
  rappelée par `interpolateSigils`). C'est le « trou du gabarit » déjà fermé pour `µimport` — même
  remède : `rewriteMuToggleWindows`, récursive à toute profondeur. Effet de bord réparé du même
  coup : dans un handler, ce cas produisait un message d'erreur MENTEUR (« reçu `$.layout` »).
  (2) MUET — la garde anti-doublon comparait le TEXTE source : `µtoggle($t, 1, 1.0, 2)` passait, le
  cycle rebouclait sur lui-même et l'état `2` devenait inatteignable à vie ; comparaison faite
  désormais sur la valeur (`'a'` ≡ `"a"`, `1` ≡ `1.0` ≡ `1e0`). (3) la notation exponentielle
  (`1e3`) était refusée alors que négatifs et décimaux passaient — acceptée.
  ⚠️ `µtoggle` n'est plus un identifiant utilisateur libre : témoin de `tests/i18n-compile.test.ts`
  déplacé sur `µtotal`.

- **Ajouté — `$x` adossé à `$$x` : la variable de thème est aussi une donnée du build.** Un `$$x`
  déclaré dans le `<theme>` SANS NOM expose désormais son nom au SASS : un `<style>` du même
  composant qui lit `$x` sans l'avoir déclaré reçoit la valeur de déclaration en préambule. C'est
  le remède aux trois pièges muets — `@each $t in $tailles` déroule vraiment,
  `@if $accent == …` compare vraiment, une fonction de couleur accepte la valeur — et il tient en
  un caractère de moins. Bornes : valeur FIGÉE à la déclaration de RACINE du bloc (une surcharge —
  `&.chaud` dans le même `<theme>`, thème nommé, thème de document — ne la change pas, c'est toute
  la différence avec `$$x`) ; seul le bloc sans nom nourrit le préambule ; une variable SASS
  déclarée à la racine du `<style>` garde la main, une déclarée sous un sélecteur reste locale à ce
  sélecteur ; un `$x` sans `$$x` derrière échoue toujours sur *Undefined variable*. Le préambule se
  glisse APRÈS un éventuel `@use`/`@forward` (dart-sass les exige en tête), et décale donc les
  numéros de ligne des erreurs SASS du nombre de variables injectées — uniquement dans les fichiers
  qui utilisent la nouveauté. 29 tests (`tests/theme-sass-adosse.test.ts`), 15 prouvés rouges.
  **Sept défauts trouvés, tous corrigés et
  couverts** : une surcharge sous sélecteur devenait la valeur figée (MUET) ; une valeur
  contenant `#{…}` était tronquée au `}` de l'interpolation ; une valeur SCSS multi-lignes entre
  parenthèses coupée au saut de ligne ; un `$x` local à un sélecteur désarmait l'adossage pour tout
  le fichier ; les compteurs ne couvraient qu'`#{…}`, pas une accolade nue
  (`$$config: {a:1}` capturé tronqué, MUET), et une parenthèse jamais refermée faisait fuiter le nom
  de la déclaration voisine dans la valeur. La capture est donc refondue autour du NIVEAU
  d'ouverture — une déclaration ne se referme qu'au retour à son propre niveau d'accolades et de
  parenthèses, et se referme d'office avant qu'une nouvelle s'ouvre. Sortie compilée
  vérifiée IDENTIQUE à l'octet près entre les deux versions.

- **Corrigé — `theme={expr}` posé en PROP ne faisait RIEN** : le CSS d'un thème nommé est déjà dans
  le composant, mais son sélecteur exige l'attribut sur l'hôte
  (`:where(:host([theme='gold']), mjs-x[theme='gold'])`). Une prop posait donc un état et rien
  d'autre — aucune erreur, aucun style, panne muette. `layout={expr}` avait son relais depuis
  toujours ; `theme=` n'en avait pas. Le reflet est posé dans `_set`, avec la même garde
  `_var_bits` : un composant qui déclare son propre `$theme` métier garde la main. Une valeur
  vide RETIRE l'attribut plutôt que de poser `theme=""`. 5 tests
  (`tests/theme-prop-reactive.test.ts`), 3 prouvés rouges avant correctif.

- **Corrigé — un commentaire `//` en fin de ligne partait dans la valeur d'une variable de thème** :
  dart-sass ne parse pas la valeur d'une custom property, elle passe telle quelle. `$$accent: #3b82f6
  // palette` sortait donc en `--mjs-accent: #3b82f6 // palette` : valeur invalide, et le `var()` qui
  la lisait retombait MUETTEMENT à sa valeur initiale. Sur une propriété ordinaire (`color: red //
  note`) dart-sass retirait déjà le commentaire — seules les custom properties étaient touchées, donc
  tout le contenu d'un `<theme>` et toute déclaration `--x:` / `$$x:` d'un `<style>`. La passe `$$`
  retire maintenant ces commentaires elle-même, dans les trois langages. Inchangé : un `//` seul sur
  sa ligne (déjà retiré, et il documente la variable suivante), un `//` dans une chaîne, le `//` de
  `url(http://…)`, et un commentaire `/* … */` (CSS valide, écarté par le navigateur).
  Deux gardes posées dans la foulée, chacune sur un test prouvé rouge : un `//` qui OUVRE la valeur
  est la valeur (`--cdn: //cdn.tld/lib.js`, URL sans protocole) et n'est plus mangé ; et le scanner
  rafraîchit désormais `lineStart` en traversant un commentaire `/* … */` **multi-lignes** — sans
  ça il attribuait à la ligne suivante l'identité de celle du `/*` (numéro de ligne faux au
  registre des variables de thème, et commentaire d'une autre ligne pris pour une valeur).


- **Corrigé — deux blocs `{key}` voisins : le second se vidait pour de bon** : quand deux `{key}` de
  niveau racine changent de clé dans le MÊME tick, le second perdait le contenu de ses
  interpolations — définitivement, sans qu'aucun rendu ultérieur ne le rattrape. Au root, les mises à
  jour du contenu d'un `{key}` ne vivaient qu'en effets par-variable ; or une seconde écriture dans
  le même tick REPORTE la passe structurelle en microtask alors que ses effets, eux, tournent tout de
  suite. La passe reportée reconstruisait donc le bloc après le passage des effets, et plus rien ne
  venait le remplir. `{key}` applique désormais la mécanique que `{if}` a toujours eue : les mises à
  jour de son contenu sont rejouées en ligne, juste après la reconstruction. Symptôme observé : un
  fil d'Ariane à trois maillons dont celui du milieu partait vide dès qu'on changeait de chapitre
  (12 navigations sur 23, mesurées au navigateur).

- **Corrigé — `<title>` sous un `<svg>` était un piège muet** : `title` porte deux natures selon son
  contexte, et le parseur des navigateurs en change au passage de la frontière « foreign content » du
  standard — texte BRUT sous `<head>` (le titre de l'onglet, jamais analysé), élément ORDINAIRE sous
  `<svg>`/`<math>` (le nom accessible d'un dessin, analysé comme les autres). Le mini-analyseur du
  compilateur appliquait la première règle partout : une interpolation posée dans
  `<svg><title>{µt('…')}</title>` n'était jamais recensée et restait telle quelle dans la page. Build
  vert, aucun avertissement, page normale à l'écran — seule une personne qui navigue au lecteur
  d'écran s'en apercevait. `script` et `style` restent bruts sous `<svg>` (leur contenu y est du JS et
  du CSS) et `<foreignObject>` ramène au contexte HTML, où `<title>` redevient brut.

- **Modifié — `name` devient FACULTATIF sur `<@field>`** : le champ enveloppé porte déjà le sien —
  sans lui, aucun formulaire ne le ramasse — et l'enveloppe n'a qu'un seul enfant projeté, donc
  forcément celui-là. Écrire `name` deux fois n'apportait rien. À défaut d'attribut sur l'enveloppe,
  elle lit maintenant le `name` du champ projeté (ou, s'il est lui-même dans un conteneur, du premier
  descendant qui en porte un) et s'en sert comme clé dans `µres.errors`. Un `name` explicite sur
  `<@field>` reste PRIORITAIRE — c'est ce qui permet une clé serveur différente de celle du champ
  (`user[email]` d'un côté, `email` de l'autre). L'erreur au montage ne se déclenche plus que si
  personne, ni l'enveloppe ni le champ, ne porte de nom.

- **Corrigé — un `<table>` sans `<tbody>` tuait le composant au montage** : tout navigateur enveloppe
  d'office les `<tr>` enfants directs d'un `<table>` dans un `<tbody>` qu'il fabrique lui-même (mode
  d'insertion « in table » du standard). Le mini-analyseur du compilateur, lui, ne le faisait pas :
  les chemins de nœuds qu'il calculait sautaient cet étage, la fonction de construction cherchait le
  frère d'un nœud absent et le composant mourait au premier montage sur
  `Cannot read properties of null (reading 'nextSibling')` — une page entière blanche, sans le
  moindre avertissement au build. Les deux modes de génération (clone et impératif) posent désormais
  les `<tbody>` et `<tr>` implicites exactement là où le navigateur les mettrait ; un `<tbody>`
  explicite n'est jamais doublé. ⚠️ `happy-dom` n'applique PAS cette insertion : un test de montage y
  passe avec ou sans le correctif, la preuve se fait donc sur les chemins eux-mêmes.

- **Ajouté — `icon-checked` / `icon-unchecked` sur `<@select multiple>`** : la coche d'une option
  sélectionnée était un `✔` fixe, sans réglage possible. Les deux attributs prennent sa place —
  `icon-checked` pour l'état coché (défaut `✔`, inchangé), `icon-unchecked` pour le décoché
  (défaut vide, inchangé aussi) — un mot, un caractère ou un glyphe de police d'icônes, au choix.
  Même contrat que `icon` sur `<@option>` : la valeur est lue par `getAttribute`, rendue par une
  interpolation ÉCHAPPÉE — jamais du HTML.

- **Modifié — l'environnement du build vient de la COMMANDE, et de rien d'autre** : `mjs build`
  construit en développement, `mjs build --prod` en production. Ni clé de `mjs.config.json`, ni
  `NODE_ENV` : un fichier versionné suit le dépôt sur toutes les machines, et une variable héritée
  d'un shell bascule un build sans que personne ne l'ait demandé — les deux ont retiré le panneau
  d'inspection à qui ne demandait rien. Ce qu'un build de production change reste inchangé :
  minification (via `minify: 'auto'`), hachage des fragments i18n, `window.µ` non exposé, cartes de
  source, absence des modules d'inspection. Un `mjs.config.json` qui porte encore une clé `env`
  fait échouer le build avec la marche à suivre, plutôt que d'être ignoré en silence.
  `mjs build`, `mjs check`, `mjs dev` et `mjs serve` annoncent en clair le mode retenu et d'où il
  vient : c'est la ligne qu'on relit dans un journal de déploiement.

- **Corrigé — le panneau d'inspection ancré ne mange plus le bas de la page** : ancré en bas, il se
  posait par-dessus le document et le dernier écran devenait inatteignable. Il pose maintenant un
  `padding-bottom` de sa hauteur sur l'élément qui défile (les pages à défilement document gagnent
  la course qu'il leur prend) **et** `--mjs-devpanel-h` sur `<html>`, que les mises en page à
  hauteur de fenêtre lisent pour se rétrécir d'elles-mêmes (`height: calc(100vh - var(--mjs-devpanel-h, 0px))`) —
  le viewport réel n'étant réductible que par le navigateur lui-même. Rendu à la page dès que le
  panneau est détaché ou fermé.

- **Corrigé — la saisie dans le panneau n'est plus emportée par son rafraîchissement** : le rendu
  périodique (700 ms) réécrit tout son contenu ; le champ qu'on remplissait disparaissait sous les
  doigts, focus et texte en cours avec lui. Le rafraîchissement passe désormais son tour tant que
  le focus est dans un de ses champs, et reprend dès qu'on en sort. Le défilement de l'arbre est
  conservé d'un rendu à l'autre (le volet de droite aussi, tant qu'on reste sur le même onglet du
  même composant).

- **Modifié — `minify` ne fait plus que minifier** : la clé valait auparavant « build de
  production », si bien qu'un projet qui la posait pour alléger son bundle local perdait sans le
  savoir le panneau d'inspection, les cartes de source et `window.µ` — aucun message ne le disait.
  Elle accepte maintenant `'auto'` (défaut, suit le mode du build), `true` (minifie même en développement) et
  `false` (ne minifie jamais, même en production). En interne, `minifyJs({ force })` traite `force`
  comme un veto explicite dans les deux sens ; `undefined` seul retombe sur `NODE_ENV`.

- **Modifié — `i18n.hash` accepte `'auto'`** : `'auto'` (nouveau défaut) hache les fragments en
  production seulement, comme avant ; `true` les hache **partout**, développement compris — le bon
  réglage pour un site servi localement par un vrai serveur, où un nom de fragment en clair suffit à
  laisser un navigateur resservir une prose périmée ; `false` ne hache nulle part.

- **Ajouté — `@EVENEMENT.emit.NOM`, émettre sur le geste sans écrire de handler** : la très grande
  majorité des `µemit` ne fait qu'une chose, émettre un nom fixe au clic ; les deux lignes de
  `<script>` que ça imposait étaient du bruit. Le suffixe `.emit.NOM` se pose sur n'importe quel
  événement écouté et n'exécute aucun autre code — `<button @click.emit.increment>` remplace le
  couple méthode + `@click={inc}`. La charge utile est la valeur d'attribut, une expression comme
  partout ailleurs (`<li @click.emit.select={row.id}>`, lue par le parent dans `e.data`), y compris
  ligne par ligne dans un `{for}`. Les modificateurs de dispatch se posent AVANT et gardent leur
  rôle (`@submit.prevent.emit.saved={$draft}`) : `emit.NOM` **clôt** le nom d'attribut, pour que le
  nom émis se lise toujours en dernier. En aval, rien de spécifique : le corps synthétisé emprunte
  le chemin commun des handlers inline (reconstruction de row, `cleanJs`, sucre `µemit` →
  `_mjsThis._mjs_emit`). À ne pas confondre avec `@emit.NOM={valeur}`, déjà présent, qui est piloté
  par une valeur qui change et non par un geste.

- **Modifié — un suffixe sur une macro globale fait désormais échouer le build** : les écouteurs de
  `<@window>`/`<@document>`/`<@body>`/`<@head>` sont posés en direct, hors du routeur délégué ; leur
  lecteur refusait par construction tout `@evt.suffixe` — en l'**ignorant**, sans un mot. Tolérable
  tant que les modificateurs n'existaient que sur les éléments, c'était devenu un piège avec
  l'arrivée de `@click.emit.NOM` : `<@window @resize.emit.sized={…}>` compilait vert et n'émettait
  jamais rien. Le build s'arrête maintenant avec un message qui dit quoi écrire à la place
  (`@resize={…}` et `µemit` dans le corps).

- **Modifié — un modificateur d'événement inconnu est désormais une ERREUR de compilation** : la
  liste des suffixes reconnus était consultée par inclusion (`parts.includes('stop')`), si bien que
  `@click.stopp`, `@click.prevnet` ou `@click.emit` sans nom compilaient en vert et ne faisaient
  **rien**, sans un mot. Seuls `.prevent`, `.stop`, `.self`, `.once`, `.propagate` — plus le sucre
  `.emit.NOM` — sont acceptés ; tout autre suffixe arrête le build, avec la suggestion quand la
  faute est à distance 2 ou moins d'un modificateur réel. Corollaire assumé : **un nom d'événement
  ne peut pas contenir de point** (`@user.created` se lit « événement `user`, modificateur
  `created` »), ce qui n'était de toute façon pas une écoute qui fonctionnait — elle routait
  silencieusement sur `user`. Écrire `user-created`.

- **Ajouté — extension VS Code 1.7.0, la table CALCULÉE `@routes` et trois trous muets ailleurs** :
  la 1.6.0 avait donné ses couleurs au bloc `<routes>` ; l'autre façon de déclarer une table — celle
  qui se construit en boucle, `@routes = {…}` dans le `<script>` — sortait toujours en chaînes
  ordinaires. Elle est lue avec le MÊME vocabulaire que le bloc (segments, `:param`, `(:opt)`, `*`,
  nom du composant), sur la ligne d'affectation et tout ce qui est indenté dessous, plus l'ajout
  ciblé `@routes['vue']['/x'] = 'x-page'`. Deux bornes : seul un chemin **littéral** est lu comme un
  chemin — `"/#{page.slug}"` reste une chaîne, l'extension ne devine pas ce que la boucle produira ;
  et **aucun verdict** ne s'y pose — le compilateur ne valide RIEN de cette table (`validateRoutePath`
  n'est appelé que par `parseRoutesLines`, donc par le bloc seul) et le routeur accepte au montage
  des formes que le bloc refuse, donc y peindre du rouge mentirait sur une compilation qui passe.
  Le même examen a été passé aux trois autres constructions, et trois trous muets sont comblés :
  `$$nom` en contexte de style est une variable de **thème** (`--mjs-nom`) et non une variable SASS —
  la grammaire SASS coupait le symbole en deux et lui donnait la couleur d'un `$sass` ordinaire, deux
  choses différentes sous la même couleur ; `<style name="Compact">` et `<theme name="Gold">` font
  **échouer le build** (`THEME_NAME_RE`) sans que rien ne le signale à l'écran, désormais en
  `invalid.illegal` ; et `<@include "./x.html">`, dont la cible ne matche pas `INCLUDE_RE`, laissait
  le tag **brut dans le DOM final, en silence** — le pire des trois. Au passage, le `@` d'un attribut
  de bloc (`<style @css="…">`) entre enfin dans le jeton. Mesuré sur 1 772 fichiers `.mjs` / 98 376
  lignes avec les vraies grammaires : **zéro** `invalid.illegal` nouveau, **zéro** caractère qui perd
  sa couleur. Le banc `tests/vscode-grammar-routes-parity.test.ts` rejoue la parité
  grammaire ↔ `parseRoutesLines` sur 31 formes — dont 13 que le compilateur refuse : 12 peintes en rouge, 1 volontairement muette
  (la ligne en cours de frappe) — avec le vrai moteur de VS Code
  (`vscode-textmate` + `vscode-oniguruma`, en devDependencies), et vérifie qu'aucun verdict ne fuit
  vers la table calculée.

- **Ajouté — extension VS Code 1.6.0, le bloc `<routes>`** : la table de routes déclarative n'avait
  aucune règle à elle. Sa balise passait par le motif générique des balises inconnues, et son CORPS —
  une quarantaine de lignes de chemins et de noms de composants, sur une application réelle — sortait en texte
  brut, sans une couleur. Il est désormais coloré ligne à ligne : segments littéraux du chemin,
  paramètres `:id`, segments facultatifs `(:an)` et `(fr)`, joker `*`, nom du composant visé (à la
  couleur de la balise qu'il produit) et commentaires `#`. Les motifs sont ceux du compilateur
  (`parseRoutesLines`, `ROUTE_PARAM_RE`, `ROUTE_OPTIONAL_PARAM_RE`, `ROUTE_OPTIONAL_LITERAL_RE`,
  `validateRoutePath`) : ce que la table refuse porte `invalid.illegal.…` — chemin sans `/` initial,
  trois jetons sur la ligne, composant hors kebab-case, paramètre mal formé, `(` non refermée, `*`
  ailleurs qu'en dernier segment. Parité vérifiée forme par forme sur 26 lignes, dont 13 que le
  compilateur rejette : zéro écart. Au passage, `routes` rejoint `script|style|theme` dans les
  marqueurs de pliage — une table de quarante routes se replie enfin d'un clic.

- **Corrigé — le rendu serveur tombait sur un composant dont le nom finit par « import »** :
  `stripEsm`, qui retire les instructions `import`/`export` d'un module avant de l'évaluer, ancrait
  ses motifs sur une simple limite de mot. Or le tiret n'est pas un caractère de mot : dans le
  manifeste JSON, une clé de composant comme `"dir-import"` en offrait une, et le motif y mordait —
  il avalait le guillemet fermant, le deux-points et le guillemet ouvrant du chemin qui suit,
  cassant le JSON et faisant échouer toute la chaîne SSR/prérendu sur un `SyntaxError`. Les cinq
  motifs (imports nommés, espace de noms, défaut, effet de bord, bloc d'export) exigent désormais
  que le mot-clé ne soit précédé ni d'un caractère d'identifiant ni d'un tiret.

- **Corrigé — fragment de section absent dans la langue courante : placeholder à vie** :
  `µ.i18n._ensure(lang, section)` ne consultait que `µ._i18nData.sections[lang][section]` — une
  langue partiellement traduite (ou un fragment rejeté par le contrôle d'empreinte, cf. entrée
  suivante) ne déclenchait alors **aucun** fetch, jamais rattrapé par la suite (`detect: true`,
  visiteur en anglais, page dont seule la version
  française existe → page définitivement vide). Le repli déjà en place au niveau d'une **clé**
  (`µ.t` retombe sur `i18n.default`) n'avait pas d'équivalent au niveau d'un **fragment entier**.
  `_ensure` charge désormais le fragment de la langue par défaut quand la section en manque dans la
  langue courante — même cache-singleton (aucune requête réseau supplémentaire), bascule atomique
  et mode `wait` inchangés. Détail : [29 · i18n § Dictionnaires — racine vs section](docs/29-i18n.md#dictionnaires).

- **Ajouté — contrôle d'empreinte des traductions (`i18n.source`)** : clé opt-in dans le bloc
  `i18n` de `mjs.config.json` — déclarer une langue **source** (`fr` typiquement) fait porter à
  chaque dictionnaire d'une autre langue un sceau `__source`, l'empreinte (12 hex, insensible au
  format et à l'ordre des clés) du dictionnaire source qu'il traduit. Au build, un dictionnaire
  (racine ou fragment de section) dont le sceau est absent, périmé ou sans source correspondante
  est **rejeté** — ni émis, ni inscrit au manifeste — avec un avertissement nommant le fichier et
  l'empreinte attendue ; le runtime retombe alors sur son repli de langue habituel, aucun
  changement côté `mjs_i18n.ts`. Absente, `i18n.source` laisse le comportement d'aujourd'hui
  intact. Détail : [29 · i18n § Contrôle d'empreinte](docs/29-i18n.md#empreinte).

- **Corrigé — trois `{for}` imbriqués : la boucle la plus interne affichait son contenu en double** :
  le `uniqueCacheId` d'une boucle imbriquée ne composait que son parent **direct** — sa clé si le
  parent était keyé, l'identité d'objet sinon, l'**index** pour des items primitifs. Le grand-parent
  n'y entrait nulle part : deux branches sœurs donnaient donc le même identifiant de cache à leur
  boucle interne, et se partageaient les mêmes cases. Au premier rafraîchissement, `_reconcileList`
  retrouvait les clés de la **dernière** branche rendue, déplaçait ses nœuds entre les ancres de la
  **première**, et ceux que celle-ci avait créés restaient en place, inconnus du cache — contenu
  affiché deux fois, sans une ligne d'erreur (relevé en production : une carte de réglages rendait
  chaque bouton en double, la donnée servie étant pourtant juste). Le discriminant compose désormais
  **toute la chaîne des ancêtres** ; les niveaux au-dessus du parent direct passent par leur
  `_mjs_idx_N`, le seul handle d'index qu'une boucle plus proche ne masque pas. Le cas courant à deux
  niveaux émet exactement le même code qu'avant.

- **Ajouté — extension VS Code 1.5.0, le langage des blocs `<script>`** : la balise suit désormais
  son attribut `lang=` comme le faisait déjà `<style>` — `ts` en TypeScript, `js` en JavaScript,
  `coffee` et `civet` en CoffeeScript (aucune extension ne publie `source.civet` ; le
  `contentName` est posé, il n'y aura qu'un mot à changer le jour où une grammaire existe). Les
  clés `embeddedLanguages` du manifeste, jusqu'ici écrites en `source.*`, ne s'appliquaient
  **jamais** : inclure une grammaire externe n'empile pas son `scopeName`. Recléées sur les scopes
  réellement émis (`meta.embedded.block.*`), un bloc hérite enfin des commentaires, de
  l'indentation et des paires de son langage. Et les symboles du framework (`$x`, `$$x`, `§x`,
  `µx`, `@x`) gardent leur couleur **au fond** d'une construction du langage hôte — dans tous les
  blocs `<script>`, `coffee` compris — sans jamais déteindre sur une chaîne ni un commentaire
  (+1 620 symboles colorés sur 164 fichiers d'un corpus de 1 863, zéro perte).

- **Corrigé — un coup au nom inexistant n'entamait pas le quota** : dans le serveur temps réel, le nom du coup était résolu **avant** la consommation du seau à jetons (`limits.moves`), si bien qu'un client qui envoyait en boucle des noms de coups inconnus se faisait certes refuser chaque coup, mais sans jamais entamer son quota — le garde-fou anti-abus était contournable à volonté. Le jeton est désormais consommé **d'abord**, dans la branche classique comme dans la branche à intentions (le mode lockstep, qui accepte tout nom, n'est pas concerné).
- **Ajouté — `serveur.antiCheat.codePerIp`** : le verrou qui plafonne les tentatives de **partie par code** venues d'une même adresse IP existait dans le code depuis toujours, avec son défaut actif `[10, 60000]` (dix tentatives par minute), mais aucun moyen n'était offert de le régler — la clé était rejetée par la validation de `mjs.config.json`. Elle est désormais exposée de bout en bout, à côté de `movesPerIdentity` : `[n, fenêtreMs]` pour la régler, `null` pour la désactiver, absente pour garder le défaut.
- **Corrigé — `µimport 'chemin.js'` sans parenthèses échappait au suivi de dépendances** : la forme nue (appel sans parenthèses, légale depuis longtemps côté compilation) était invisible de la regex du bundler, qui exigeait la parenthèse ouvrante. L'asset visé n'entrait donc ni dans le calcul de fraîcheur ni dans la carte inverse du watch : en `mjs dev`, l'éditer ne recompilait pas le composant qui s'en sert. Le build complet, lui, restait correct.
- **Corrigé — ordre de rendu non déterministe au SSR** : la liste des composants non-runtime était construite depuis un parcours de répertoire (ordre non garanti par le système de fichiers) et le tri topologique préserve l'ordre d'entrée pour tout ce qui n'a pas de dépendance mutuelle. Elle est maintenant triée par nom de fichier, comme l'était déjà sa jumelle côté runtime — deux machines rendent la même page dans le même ordre.

- **Ajouté — les thèmes, les variables et les variants** (chapitre de référence
  [31 · Thèmes](docs/31-themes.md)). Dans un contexte de style, `$$nom` est une **variable de
  thème** : elle se lit partout (`<style>`, `<theme>`) et compile en `var(--mjs-nom)` ; elle se
  **déclare** dans un bloc `<theme>`, jamais dans `<style>` (erreur de compilation explicite). Un
  composant peut poser ses variables de base (`<theme>`) et des thèmes nommés activés sur l'instance
  (`<theme name="gold">` + `theme="gold"`). Un fichier `nom.theme.mjs` est un **thème de document** :
  il ne rend rien, son nom vient du fichier, et il s'applique à **tout élément** portant
  `theme="nom"` — donc imbricable à volonté, et pas seulement sur `<html>`. Un thème n'émet que
  ce qu'il déclare, jamais une copie de ce qui l'entoure : le reste continue de descendre depuis
  au-dessus (calque). Deux réglages arrivent dans `mjs.config.json` : `varPrefix` (`mjs` par défaut —
  un seul préfixe pour tout le monde, jamais dérivé du nom du module) et `defaultTheme` (`light` —
  le seul dont les variables sont aussi posées sur `:root`). Le build tient un **registre des
  variables** : un nom lu que personne ne déclare sort en avertissement (faute de frappe probable,
  symptôme muet à l'écran), un nom déclaré par deux composants sort en information.
- **Modifié — `$$nom: valeur` déclare aussi dans un `<style>`** : la syntaxe se dit désormais
  identique dans tous les contextes de style (`<theme>`, `<style>`, `<style name="…">`, un fichier
  `*.theme.mjs`) — un `$$nom:` en tête de ligne déclare ou surcharge la variable, le compilateur pose
  lui-même le préfixe (`--mjs-nom:`). Une surcharge a besoin d'un sélecteur au-dessus d'elle : à la
  racine d'un `<style>`, elle fait échouer le build (SASS refuse une déclaration nue), exactement
  comme dans un `<theme>`. L'écriture `--mjs-nom: valeur` continue de marcher partout où elle
  marchait déjà : c'est du CSS ordinaire, rien n'est retiré.
- **Ajouté — `<style name="…">` et l'attribut `layout="…"`** : un **variant** du
  composant (grille, ordre, masquage), sorti par le build dans un fichier à part et chargé
  seulement quand il sert. Un nom que le composant ne déclare pas ne passe jamais : écrit en dur,
  il fait **échouer le build** (fichier fautif, nom demandé, noms connus) ; calculé, il fait **partir
  le composant en erreur** à l'exécution (boundary `<@failed>` la plus proche, ou panneau fatal),
  toujours sans aucune requête réseau. À ne pas confondre avec un thème :
  le variant porte des **règles** et reste dans le composant, le thème porte des **valeurs** et
  descend chez les enfants ; les deux attributs se cumulent sur la même instance.
- **Déprécié — l'attribut `template="…"`** : il reste accepté, sans message, comme synonyme de
  `layout="…"` (le nom mentait, ce mécanisme n'a jamais touché au gabarit — il ne chargeait qu'une
  feuille de style). `layout` est la forme à écrire ; `template` disparaîtra à la prochaine version
  majeure. `theme` et `layout` deviennent au passage des **noms d'attribut réservés par
  convention** : ils restent lisibles comme props, mais le framework s'en sert — leur donner un
  autre sens dans un composant se retournera contre lui. Aucune garde de compilation ne l'interdit.
- **Modifié — `µtheme` accepte les thèmes de l'application**, en plus de `light` et `dark` : la
  liste des thèmes déclarés au build est injectée dans le manifeste. Un nom inconnu reste refusé,
  avec un avertissement qui liste désormais les noms disponibles. La feuille interne du framework
  perd son `:root` (le thème clair reçoit son propre sélecteur d'attribut) — sans quoi une section
  sombre dans une page claire, ou l'inverse, resterait bloquée à la racine.
- **Ajouté — un nom de fichier de composant ne peut plus commencer par `mjs-`** : le préfixe
  appartient au framework (le tag d'un composant est *déjà* `mjs-<nom de fichier>`, et tout attribut
  `mjs-*` est réservé aux internes). Erreur de build de la même famille que les 11 noms de balises
  réservés, message indiquant le nom à donner au fichier.
- **Modifié — vocabulaire du build** : une feuille référencée par `@css nom` s'appelle désormais une
  **feuille partagée** et non plus un « thème » — le mot est maintenant pris par le vrai bloc
  `<theme>`. Seuls les messages changent, aucun comportement.

- **Modifié — l'habillage par défaut du toast.** `µ.modal.notify()` rendait une carte au thème de
  la page, bordée de la couleur du type, message et croix. Elle devient une carte à trois colonnes :
  icône SVG teintée à gauche (les cinq formes déjà embarquées par les modales — aucun octet ajouté),
  titre en gras puis message au centre, croix à droite ; fond en dégradé partant de la couleur du
  type vers `--mjs-toast-bg-base` (`#22242F`), texte blanc, barre de vie en haut avec son halo, et
  une entrée qui glisse depuis le bord d'ancrage avec un léger dépassement — une pile ancrée à
  gauche entre par la gauche. Conséquences à connaître : un **titre** apparaît là où il n'y en avait
  pas (option `title` — une chaîne l'impose, une valeur fausse le retire, le toast redevient
  d'une ligne), le fond ne suit plus le thème clair/sombre (`--mjs-toast-bg` reprend la main), et la
  carte est plus large (`--mjs-toast-width`, `400px`, bornée par `calc(100vw - 32px)`) donc moins
  de toasts tiennent d'un coup. Sept variables de réglage s'ajoutent : `--mjs-toast-bg-base`,
  `-width`, `-cols`, `-padding`, `-icon-size`, `-title-size`, `-entree-duree`. Les titres par défaut
  (`Succès`/`Erreur`/`Attention`/`Info`) passent par le manifest, comme les libellés de boutons, et
  suivent donc la clé de configuration `lang`.
- **Ajouté — `µ.config.notifyFlow`** (`'auto'` par défaut, `'up'`, `'down'`) : le sens du flux des
  toasts, c'est-à-dire de quel côté des précédents le nouveau apparaît. À ne pas confondre avec le
  sens de croissance de la pile, dicté lui par l'ancrage. Les préréglages de position tranchaient
  déjà la question (un ancrage bas empile vers le haut), mais un **placement libre**
  `{ top, bottom… }` n'avait aucun moyen de le dire : il empilait toujours vers le bas, à l'inverse
  du préréglage équivalent, ce que la documentation affirmait pourtant sans exception. Relu à chaud
  comme `notifyMax` et `notifyPosition`, valeur inconnue → avertissement et repli sur `'auto'`.
- **Corrigé — `value=!{$x}` est désormais bidirectionnel sur `<@color>`.** Le module posait la
  couleur choisie sur `--mjs-color-value` et émettait `change`, mais sans jamais réassigner `$value`
  en interne : la liaison two-way restait donc morte dans un sens, alors que `<@select>`, dont le
  two-way porte lui aussi sur `value`, mettait déjà la valeur à jour de son côté (`<@checkbox>` et
  `<@switch>`, eux, portent leur two-way sur `checked`, pas sur `value`). `<@color editable
  value=!{$x}>` reflète maintenant `$x` des deux côtés. La documentation annonçait ce comportement,
  elle n'était simplement pas encore vraie.
- **Corrigé — la file des toasts repart quand la fenêtre s'agrandit.** Elle n'avançait qu'au retrait
  d'un toast : agrandir la fenêtre libérait de la place sans rien réveiller, et une pile de toasts
  permanents (`duration: 0`) bloquait l'attente indéfiniment. Un écouteur de redimensionnement,
  posé à la première mise en file seulement (jamais au chargement, jamais côté serveur), draine la
  file. Rétrécir, en revanche, ne chasse toujours personne — la règle « zéro éviction » vaut aussi
  pour un toast devenu hors écran.
- **Corrigé — `<@select>` se dimensionne sur sa plus longue option**, et non sur celle qui se
  trouve affichée. Un select posé sur `3` se réduisait à la largeur de ce `3`, panneau compris :
  l'option `illimité` y était tronquée, donc illisible avant même d'être choisie. Une jauge
  invisible de hauteur nulle empile toutes les étiquettes dans la même cellule de grille et donne
  au contrôle sa largeur intrinsèque — purement CSS, donc suit tout seul un ajout d'option, un
  changement de police ou une traduction. Mesuré : 51 px pour `3/5/8`, 72 px avec `illimité`,
  157 px avec `quarter-bottom-right`, zéro option tronquée. Dans un conteneur qui impose sa
  largeur, rien ne change. Deux bornes évitent qu'une option à rallonge ne tire toute la page :
  la largeur préférée est plafonnée par `--mjs-select-max` (22rem par défaut) et le contrôle reste
  compressible — dans une ligne `flex` trop étroite il rétrécit au lieu de faire déborder la ligne.
- **Corrigé — la pile de toasts ne sort plus de l'écran.** `µ.config.notifyMax` plafonnait un
  *nombre* de toasts affichés, pas une hauteur : réglé sur `false` (« illimité »), l'empilement
  continuait sous le bord de la fenêtre, là où plus rien ne va le chercher — mesuré à 430 px de
  pile pour 322 px de fenêtre. La place réellement disponible devient un **second plafond, toujours
  actif** : un toast qui ferait sortir la pile n'est pas affiché, il **reste en file** et apparaît
  quand une place se libère. La règle « zéro éviction » est intacte — rien n'est chassé, rien n'est
  perdu — et le plafond effectif est simplement le plus bas des deux. Ce sont les toasts eux-mêmes
  qui sont mesurés, jamais leur conteneur : un placement libre posant `top` **et** `bottom` donne à
  celui-ci une hauteur imposée par la fenêtre, aveugle au débordement dans un sens et bloquante
  dans l'autre. Seul le bord opposé à l'ancrage est contrôlé. Trois garde-fous : un toast seul
  n'est jamais refusé ; un ancrage lui-même hors écran sort avec sa pile (aucun calcul ne rattrape
  ça) ; sans mise en page mesurable (rendu serveur), seul `notifyMax` s'applique. 9 tests neufs,
  et 16 géométries mesurées en navigateur réel — 0 px de débordement partout où le point d'ancrage
  est visible.
- **Corrigé — `SqlPersistAdapter` ne restaurait plus aucune partie**, et **cassant** : ses colonnes
  passent de `donnees`/`maj` à `data`/`updated_at`. Les deux points n'en font qu'un : l'anglicisation
  de MJS-Server avait renommé la *lecture* de la ligne (`row.donnees` → `row.data`) sans renommer la
  *colonne* citée dans le `SELECT`, resté `SELECT id, donnees`. Un pilote (mysql2, pg) clé ses lignes
  par le nom de colonne : `row.data` valait donc `undefined`, chaque entrée était comptée « illisible »
  et `load()` rendait une liste vide — sauvegarde intacte, restauration morte. Les colonnes rejoignent
  le reste de l'API en anglais, ce qui remet les deux moitiés d'accord. **Une table existante doit être
  migrée** (`ALTER TABLE … RENAME COLUMN donnees TO data`, idem `maj` → `updated_at` ; recette complète
  et variante MySQL 5.7 en [24 · MJS-Server §8](docs/24-mjs-server.md)) : sans elle, chaque `save()`
  échoue sur une colonne inconnue (avertissement, jamais un crash) et le serveur repart sans
  restauration. Le nom de **table**, lui, reste libre (option `table`). Un test de cohérence neuf
  compare désormais les colonnes du `CREATE TABLE`, de l'upsert et du `SELECT`, et les faux pilotes
  des tests projettent les lignes sur les colonnes réellement demandées — cette divergence-là ne peut
  plus passer inaperçue.
- **`<@head><title>…</title></@head>` change enfin le titre de l'onglet.** Le contenu d'un `<@head>`
  était ajouté au `document.head` nœud par nœud, `<title>` compris — or la spécification HTML dit
  que le titre du document est celui du **premier** `<title>` de l'arbre, et toute page en a déjà
  un : le second était inerte. La documentation et la leçon de tutoriel enseignaient donc un titre
  réactif qui ne changeait jamais rien. Un `<title>` dans `<@head>` n'est plus un nœud ajouté, il
  écrit `document.title`. Le titre trouvé à la première écriture est mémorisé et **rendu** quand le
  composant s'endort (hook `sleep`, celui-là même qui retire les autres nœuds injectés) : une page
  quittée n'emporte pas son titre. Deux pages empilées se dépilent dans l'ordre ; un
  `document.title` écrit à la main entre-temps n'est jamais écrasé (la restauration n'a lieu que si
  l'affiché est encore celui qu'on avait posé). Inchangé côté SSR : comme tout `<@head>`, ce titre
  est posé à l'exécution, le HTML servi porte celui du gabarit hôte jusqu'à l'hydratation.
- **Cassant — MJS-Server passe entièrement en anglais.** Dernier pan du sous-système temps réel
  (après Chat, Lobby, Accounts et la surface publique de Game) : la classe `Partie` devient `Game`,
  et avec elle tout ce que l'auteur d'un jeu écrit ou lit.
  - Définition de jeu : `def.places` → `def.seats`, `def.histo` → `def.history` (`histo.extraire`
    → `history.extract`), `def.antiRejeu` → `def.antiReplay`. Les autres clés étaient déjà anglaises.
  - Instance : `partie.vueDe()` → `game.viewFor()`, `partie.rembobiner()` → `game.rewind()`,
    `partie.instantVuPar()` → `game.timeSeenBy()`. Les arguments des hooks et des `moves` se lisent
    désormais `(game, player, p)`.
  - Exports : `creerPartie`/`restorerPartie` → `createGame`/`restoreGame`, `creerSpace`/`creerHisto`/
    `creerLockstep`/`creerMatchmaking`/`creerPersistEngine` → `create…`, `graineDeterministe` →
    `deterministicSeed`, `asTypedPartie`/`TypedPartie`/`MjsPartieLoose` → `asTypedGame`/`TypedGame`/
    `MjsGameLoose`, `MjsServerPartieSnapshot` → `MjsServerGameSnapshot`, `MjsServerStatsJeu` →
    `MjsServerGameStats`, `MjsServerSuspectContexte`/`Resultat` → `…Context`/`…Result`,
    `MjsServerLockstepOrdre` → `…Order`, `SqlDialecte` → `SqlDialect`. Côté MJS-WS :
    `definirPaquet`/`paquetEcho` → `definePackage`/`echoPackage`, `MjsWsStatsGarde`/`MjsWsStatsSalons`
    → `MjsWsStatsGuard`/`MjsWsStatsRooms`.
  - Configuration : `serveur.antiTriche` → `serveur.antiCheat` dans `mjs.config.json` et dans les
    options de `mjsServer()` ; `persist: { adaptateur }` → `persist: { adapter }` ;
    `new SqlPersistAdapter({ dialecte })` → `{ dialect }` (le TYPE `SqlDialect` avait déjà été
    renommé, l'option était restée en français — dernière clé d'option publique de MJS-Server).
  - Statistiques : `app.stats().jeu` → `app.stats().game` (`coupsSuspects`/`coupsRejetesAntiTriche`
    → `suspectMoves`/`rejectedMoves`).
  - **Sur le fil** : `µgame:move { partie, coup, p }` → `{ game, move, p }` (idem `µgame:hash`,
    `µgame:resync`, `µgame:leave`) ; `µgame:seat { places, sieges:[{siege, connecte}] }` →
    `{ seatCount, seats:[{seat, connected}] }` ; fin annulée `{ annulee, raison }` →
    `{ cancelled, reason }` ; minuteries réservées `'µtour'`/`'µappariement'`/`'µvide'` →
    `'µturn'`/`'µmatch'`/`'µempty'`. Client et serveur doivent être mis à jour ENSEMBLE.
  - Runes netcode : `µ.predict(game, { champs, appliquer })` → `{ fields, apply }`,
    `µ.interp(game, { champs, retard })` → `{ fields, delay }`,
    `µ.lockstep(game, { etat0, appliquer, chaque })` → `{ state0, apply, every }`,
    `µ.optimistic(store, { appliquer, puis })` → `{ apply, after }` et sa promesse résout
    `{ ok, response }` / `{ ok, error }` (au lieu de `reponse`/`erreur`).
  - **Clé du hash Redis** : `RedisPersistAdapter` écrivait dans `<prefix>parties` alors que la
    documentation annonçait déjà `<prefix>games` — c'est le code qui suit :
    `RENAME mjs-server:parties mjs-server:games`.
  - **Identifiant de partie** : `app.game()` fabriquait `partie1`, `partie2`… — désormais `game1`,
    `game2`… Cette chaîne circule sur le fil (`µgame:*.game`) et nomme le fichier d'instantané.
    Ne pas migrer ne casse rien (les deux formes ne se croisent jamais), mais la base continue de
    parler français. **Lockstep** : la graine est re-dérivée de l'id, renommer l'id d'une partie
    lockstep EN COURS change donc son flux d'aléatoire au retour — migre entre deux parties.
  - **Migration des instantanés persistés** : `scripts/migrate-games-fr-to-en.mjs <dossier>`
    (`--dry-run` disponible, idempotent, écriture atomique) — réécrit `minuteries`→`timers`,
    `{nom, à}`→`{name, at}`, le journal `{coup, joueur, à}`→`{move, player, at}`, les ordres
    lockstep et l'`id` `partie<n>`→`game<n>` (**avec** le fichier qui le porte ; jamais d'écrasement
    d'une cible existante). Adaptateur SQL : table par défaut `mjs_server_parties` →
    `mjs_server_games`, plus `UPDATE <table> SET id = REPLACE(id, 'partie', 'game')` pour la clé.
    Adaptateur pont : le corps HTTP passe de `{op, id, données}` à `{op, id, data}` et la réponse
    du `GET` de `{ok, parties}` à `{ok, games}` — le back doit suivre.
- **Cassant — la page d'état du pont passe de `GET /etat` à `GET /state`.** Dernière route HTTP
  du pont restée en français (`/health`, `/stats`, `/metrics` l'étaient déjà) ; même règle de
  signature qu'avant, seule l'URL change. La bannière de `mjs ws` affiche le nouveau chemin.
- Cassant — le tutoriel et la documentation de MJS-Server enseignaient encore l'API française :
  chapitre 35 (les 23 leçons temps réel) aligné sur `game`/`player`/`seats`/`status`, y compris
  les aperçus vivants qui parlaient encore l'ancien protocole `µgame:*` et les anciennes options
  de `µ.interp`/`µ.predict` — ils ne fonctionnaient plus. La convention d'identité lue par les
  paquets Chat/Lobby/Accounts est `identity.name` (les exemples montraient `identity.pseudo`).
- Corrigé : trois messages d'erreur du CLI (`mjs ws` et `mjs serveur`, rechargement à chaud et
  compilation Civet en échec) affichaient `undefined` à la place du détail de l'erreur — la clé
  passée au catalogue avait été renommée d'un côté seulement.
- Corrigé : la garde anti-collision d'identifiant de partie (une partie fraîche ne doit jamais
  recevoir l'id d'une partie restaurée encore vivante) ne reconnaissait plus aucun identifiant —
  elle attendait `game<n>` quand le générateur produisait encore `partie<n>`. Deux parties
  pouvaient partager un id après un redémarrage, la seconde écrasant silencieusement la première.
- Corrigé : trois commentaires de source (`chat.ts`, `lobby.ts`) décrivaient la résolution
  d'identité par une phrase où les DEUX champs cités avaient été renommés en un seul
  (« `identity.name`, repli `identity.name` ») — la règle réelle est `identity.name`, repli
  `peerIdOf(client)`.
- Corrigé : `$x++` / `$x--` / `++$x` posé AILLEURS qu'en dernière ligne d'un bloc plantait à
  l'exécution — `TypeError: µ._set(...) is not a function`. La réécriture émettait une forme
  fidèle commençant par une parenthèse ; comme le JS produit ne porte pas de point-virgule en fin
  d'instruction, l'insertion automatique (ASI) ne s'appliquait pas et la ligne précédente était
  lue comme un APPEL. Le JS restait syntaxiquement valide : build, contrôle ESM, tests et SSR
  passaient tous, la panne n'apparaissait qu'au clic de l'utilisateur — et seulement quand
  l'incrément n'était pas la dernière ligne (là, le `return` ajouté coupait la continuation).
  En position d'instruction, la valeur de retour est ignorée par définition : on émet désormais
  `µ._set(_mjsThis, 'x', $.x + 1)`, qui n'ouvre plus sur une parenthèse (et n'alloue plus de
  fermeture). La forme fidèle (`$x++` rend l'ancienne valeur, `++$x` la nouvelle) est conservée
  partout où la valeur est réellement consommée : `return`, argument d'appel, condition.
- Corrigé : une liaison two-way et une directive `@événement` posées sur le MÊME élément pour le
  MÊME événement — `<input value=!{$x} @input={chercher()}>`, le gabarit d'une recherche en direct
  ou d'un compteur de caractères — s'écrasaient l'une l'autre EN SILENCE. La table de routes
  n'acceptait qu'une valeur par couple (événement, nœud) et le routeur s'arrêtait à la première
  correspondance ; le perdant dépendait de l'ordre d'écriture des attributs (liaison écrite avant
  la directive ⇒ la liaison mourait, `$x` cessait de suivre la frappe ; directive écrite avant
  ⇒ le handler de l'application disparaissait). Aucun avertissement, aucun contournement. La route
  accepte maintenant une liste de handlers, tous exécutés, **liaison d'abord** — la directive lit
  donc la variable déjà à jour. Même correction pour deux liaisons qui partagent un événement
  (`volume=!{}` et `muted=!{}` écoutent toutes deux `volumechange`). Le cas sans collision garde
  la forme courte : aucune inflation du paquet. `.once` ne désarme que sa propre directive.
- Nouveau : `µ.modal.fire(options)` (`mjs_modal.ts`, module runtime optionnel `'modal'`) — modale
  maison inspirée de SweetAlert2 (même forme de résultat familière,
  `{isConfirmed, isDenied, isDismissed, value, dismiss}`), 100% implémentée en interne, ZÉRO
  dépendance externe. `title`/`text`/`html`, 5 icônes (`success`/`error`/`warning`/`info`/
  `question`, dessinées en SVG inline, pas d'image externe), 2-3 boutons
  (`confirmButtonText`/`cancelButtonText`/`denyButtonText`,
  `showCancelButton`/`showDenyButton`), `timer` (auto-fermeture, `dismiss:'timer'`),
  `allowOutsideClick`/`allowEscapeKey` (défaut `true` tous les deux), `customClass` (classes
  ajoutées, zéro style inline — règle nº1 MJS), piège-focus (Tab/Shift+Tab bouclent dans la
  modale) + retour de focus à l'élément précédemment actif à la fermeture, inputs
  `text`/`textarea`/`select`/`checkbox` avec `inputValidator(value)` (message d'erreur si
  non-null) et `preConfirm(value)` (peut transformer la valeur finale ou annuler en renvoyant
  `false`). Libellés par défaut des boutons (OK/Annuler/Non) alignés sur la clé `lang` du projet
  (fr/en, repli fr si absente). `µ.modal` est utilisable directement par une application
  (`µ.modal.fire({...})`), indépendamment de `@confirm`. Les options sont validées ET recopiées
  AVANT que la promesse n'existe : un appel malformé (mauvais type, valeur non convertible en
  texte, getter qui lève, faux `Map`) provoque une `TypeError` **synchrone** nommant l'option
  fautive, au lieu d'un rejet de promesse qui contredisait le contrat annoncé ; un nom INCONNU
  d'`icon`/`input` reste toléré (avertissement + repli). Chaque option n'est lue qu'une fois, à
  la validation — un getter piégé au second accès ne peut donc plus rien casser.
- Corrigé : un attribut HTML5 booléen écrit NU sur un tag à tiret (`<mjs-enfant hidden>`,
  composant MJS ou web component tiers) repart dans le template au lieu d'être routé vers
  `_set()`/`node[nom]` — sans quoi l'attribut disparaissait du DOM et l'élément n'était plus
  caché. Le sucre reste actif sur les balises natives (`<input disabled>`, `<ol reversed>`).
- Cassure (avant publication) : `µ.config.confirm` passe d'un branchement `null` (défaut) /
  `'sweetalert2'` (adaptateur `window.Swal`) / classe-objet personnalisée, à un simple booléen —
  `true` (nouveau défaut) route vers la modale maison `µ.modal.fire` ci-dessus, `false` vers
  `window.confirm` natif. Sans rien poser en configuration, un `@confirm` ouvre donc désormais
  la modale du framework, aux couleurs de la CSS du projet, et non plus la boîte grise du
  navigateur. L'ancien branchement `'sweetalert2'` et l'ancien branchement classe/objet
  personnalisé sont RETIRÉS (toute autre valeur retombe sur `window.confirm` avec un
  avertissement) — `µ.confirm` réassigné directement par l'application reste le chemin pour un
  branchement 100% custom, et prime toujours sur cette clé.
- Cassure (avant publication) : le routeur matche désormais les routes de façon **EXACTE**. Une
  route `'/a'` ne matche plus `/a/b` : tous les segments de la route ET tous ceux de l'URL
  doivent être consommés. Un sous-arbre (layout dont un enfant route la suite du chemin) se
  déclare explicitement avec le catch-all : `'/admin/*'` au lieu de `'/admin'` — le reste du
  chemin devient au passage lisible dans `&all`. Motifs : l'absorption silencieuse faisait
  rendre une page PLAUSIBLE sur une URL fautive (`/admin/nimportequoi` servait `/admin`), et
  dans une table `{'/a': X, '/a/*': Y}` le motif préfixe `'/a'` captait `/a/b` avant le
  catch-all, qui restait mort. Même contrat que React Router v6 (`path="admin/*"` obligatoire
  pour des routes descendantes déclarées ailleurs) et que Vue Router. La racine `'/'`, les
  segments `:param`, `(:optionnels)` et `*` sont inchangés par ailleurs.
- Nouveau : quand AUCUNE route d'AUCUN composant routé ne matche l'URL courante, le framework
  ne se contente plus de vider les `<@view>` en silence — il écrit une erreur en console et
  affiche un panneau « Page introuvable » (libellés fr/en) dans la première zone. Le vidage
  d'UNE zone reste silencieux (une page à plusieurs `<@view>` aux tables indépendantes a le
  droit de n'en remplir qu'une). Déclarer une route de repli (`'/*': 'not-found-page'`) rend le
  cas inatteignable — c'est la façon recommandée de servir sa propre 404. Réglage :
  `µ.config.routeNotFound` = `'error'` (défaut) / `'warn'` (console seule) / `'silent'`.
- Corrigé : une réactivité déclarée avec DEUX interpolations séparées par du texte littéral dans
  un même binding (ex. `title="{$a} — {$b}"`) pouvait rester figée après le montage initial (mise
  à jour ratée) même quand les deux variables apparaissent normalement dans le binding — un
  chemin de détection des dépendances traitait à tort ce cas comme un bloc unique, produisant une
  analyse invalide silencieusement écartée. Aucun changement pour un binding à un seul bloc
  (`{$a}` seul), déjà correct.
- Corrigé : une fonction top-level du `<script>` déclarée en flèche fine (`->`, pas une vraie
  méthode `@nom = -> …`) qui touche l'état du composant (`§§clé`, raccourci `@x`) et se fait
  appeler SANS receveur (expression du gabarit, alias, imbrication) ne plante plus — le
  compilateur détecte désormais ce cas en AST et réécrit automatiquement l'accès sur le
  composant capturé par fermeture (même mécanisme que `@@x`, généralisé), au lieu de laisser
  `this` valoir `undefined` au site d'appel. Plus besoin de connaître ce piège ni de déclarer la
  fonction en flèche grasse (`=>`) ou d'utiliser `@@x` pour ce cas précis — les deux restent
  valides par ailleurs. Aucun changement pour une vraie méthode d'instance (`@nom = -> …`), une
  méthode d'objet/classe explicite, ou une fonction assignée à une propriété d'un autre objet
  (`cible.nom = -> …`, `this` y reste dynamique comme avant). Un rebinding explicite de
  l'appelant (`.call(x)`, `.bind(x)()`, `thisArg` d'un `forEach`/`map`…) reste également respecté
  — seul un appel vraiment nu (`this === undefined`) déclenche la correction.
- Nouveau : point d'accroche remplaçable `µ.confirm(message, élément)` pour la confirmation
  `@confirm` (`mjs-confirm`) — défaut `window.confirm` ; accepte un booléen synchrone ou une
  promesse de booléen (modale personnalisée asynchrone). À `true`, relance automatiquement
  l'action d'origine (navigation, lien à verbe `@method`, soumission de formulaire) ; les clics
  sont ignorés le temps qu'une confirmation asynchrone reste en attente.
- Interne : cache par instance de la résolution d'ancêtre `§§` (`_mjs_getRCtx`) — invalidé par
  un compteur global de topologie (connexion/déconnexion/écriture de contexte) ; sémantique de
  lecture strictement inchangée.
- Nouveau : rune `µderived $var = expr, $a, $b, …` — dérivé à dépendances FORCÉES. Compile en
  JS final strictement identique à `$var = expr` (zéro artefact runtime), mais enregistre
  `$a`/`$b` comme dépendances supplémentaires du computed — pour les cas où la vraie dépendance
  n'apparaît pas textuellement à droite du `=` (ex. lue par une fonction séparée appelée sur le
  RHS). Sans dépendance forcée (`µderived $var = expr`, pas de virgule), dégénère en computed
  ordinaire, sortie strictement identique à `$var = expr` écrit à la main. Réservée au niveau
  racine du `<script>` du composant (erreur de compilation explicite sinon).
- Nouveau : directives `@emit.NOM_EVENEMENT={expr}` (réactif — tire au montage puis se
  re-déclenche à chaque changement d'une dépendance réactive de `expr`, comme n'importe quelle
  liaison `={expr}` du framework) et `@emit.once.NOM_EVENEMENT={expr}` (tir unique au montage,
  jamais ensuite) — sucre pour `this._mjs_emit('NOM_EVENEMENT', expr)` (méthode runtime déjà
  existante).
- Cassure (avant publication) : les listes de noms de `@import`/`@persist` passent de la
  virgule à l'ESPACE comme séparateur (`@persist $a $b`, au lieu de `@persist $a, $b`) ; pour
  `@import`, le dernier token de la ligne reste toujours le chemin, et une virgule résiduelle
  entre deux noms devient une erreur de compilation orientant vers la nouvelle syntaxe. `@css`
  accepte désormais plusieurs thèmes espacés sur une même ligne (`@css theme1 theme2`, au lieu
  d'un seul nom max) ; un thème référencé sans fichier `.sass`/`.scss`/`.css` correspondant dans
  `stylesheetsDir` fait maintenant ÉCHOUER le build (au lieu de silencieusement traiter comme du
  CSS vide).
- Cassure (avant publication) : l'auto-fermeture (`/>`) devient une erreur de compilation sur
  `<@view>`, `<@element>`, `<@module>` et `<@failed>` (même règle que `<@include nom/>`,
  généralisée) — ces quatre balises attendent toujours un contenu et une fermeture explicite.
  `<@window>`, `<@document>`, `<@body>`, `<@html>`, `<@head>` et `<@slot>` restent inchangées,
  l'auto-fermeture y reste légitime (`<@head @event={…} />` cible `document.head` au même titre
  que les autres écouteurs globaux — seule sa forme à contenu `<@head>…</@head>` relève de la
  règle d'injection, jamais de l'auto-fermeture).
- Cassure (avant publication) : le singleton importé s'écrit désormais `@import µ$$X 'chemin'` et se consomme en `µ$$X` (câblage inchangé, réduit toujours en `$X` réactif externe) ; `@import §§X` (ancienne forme) devient une erreur de compilation guidée vers la migration. `§§X` redevient PUR contexte réactif d'ancêtres — plus aucune résolution vers un singleton, même en présence d'un import du même nom ailleurs dans le fichier.
- Préparation de la première publication publique (npm + GitHub) : identité projet, contact sécurité via GitHub Security Advisories, nettoyage des références internes.
- Nouveau : clé de config `lang` (`fr` défaut / `en`) — messages du CLI, du compilateur et des serveurs Node bilingues (catalogue `src/messages/`, 670 clés).
- Pluriel : clé `zero` explicite façon Rails — prioritaire sur la catégorie CLDR quand n vaut 0 et que le dictionnaire la fournit.
