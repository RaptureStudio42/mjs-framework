// sigils — corps de motifs PARTAGÉS entre les deux moteurs de sucre MJS.
//
// Le sucre est compilé par DEUX moteurs distincts et ASSUMÉS (cf. note archi
// de generator/utils.ts : la bascule sur Civet parse+generate a échoué (bug
// d'état global Civet) : le lexer (scripts, scanner ancré caractère
// par caractère, sortie re-compilée par Civet) et cleanJs (interpolations {…}
// et handlers, replace global gardé par lookbehind, sortie JS FINALE). Chaque
// moteur GARDE son ancre/garde et son mode d'émission — mais les corps de
// motifs identiques vivent ici, en source UNIQUE. C'est la dérive entre
// copies maintenues à la main qui a produit une régression (
// `µread $_secret` reconnu côté lexer, laissé littéral côté cleanJs
// → ReferenceError) ; par construction, plus possible.

import * as acorn from 'acorn'
import * as walk from 'acorn-walk'
import MagicString from 'magic-string'

import { t } from './messages/index.js'

// identifiant après sigil : underscore admis en TÊTE, jamais le chiffre
export const SIGIL_ID = '[a-zA-Z_][a-zA-Z0-9_]*'

// µread $x → accès NON réactif au slot brut, hors Proxy tracké. Statisation $$ — µread $$x →
// accès BRUT au store universel, hors accesseur notifiant : groupe 1 = `$` optionnel (store)
// sinon local, groupe 2 = nom. `µ._mjs_storeRaw.x` (jamais `µ.store.x`) : l'analyzer ne matche que
// `µ.store` — un accès µread ne pose donc AUCUNE dépendance. `µwrite` a SA PROPRE grammaire
// (virgule, valeur en second argument) : corps séparés plus bas
// (RAW_WRITE_BODY et suivants) — `µread` seul ici.
export const RAW_ACCESS_BODY = `µread[ \\t]+\\$(\\$?)(${SIGIL_ID})`
export const RAW_ACCESS_OUT       = '_mjsThis._state.'
export const RAW_ACCESS_STORE_OUT = 'µ._mjs_storeRaw.'

// PARENTHÈSES — `µread($x)` ≡ `µread $x`. Civet rend les parenthèses d'appel
// facultatives : la rune suit la même liberté, les DEUX formes compilent. Sans ce corps, la
// forme parenthésée sortait LITTÉRALE des deux moteurs (`µread($.i)`) — `µread` n'existe nulle
// part au runtime, donc ReferenceError au premier tick avec un build VERT (panne muette de la
// même famille que celle décrite en tête de fichier). Corps SÉPARÉ plutôt qu'une alternance dans RAW_ACCESS_BODY : les
// groupes de capture restent 1 = `$` du store, 2 = nom, identiques dans les deux corps — donc
// un seul consommateur possible côté lexer comme côté cleanJs, aucun décalage d'indice.
// Espaces AVEC saut de ligne (`[ \\t\\r\\n]`) et pas seulement espace/tabulation : trouvé par
// trouvé en testant — `a = µread\n  ($x)` (coupure qu'un formateur pose tout seul,
// et que le contrat « parenthèses optionnelles » invite à écrire) ne matchait AUCUN corps,
// ressortait littéral, et JS n'insère PAS de point-virgule devant une ligne qui commence
// par `(` : ça compilait en un VRAI appel vers un global inexistant. Build vert, ReferenceError
// au montage — et dans un handler, échec totalement SILENCIEUX (une exception de listener ne
// remonte pas au clic). Exactement la panne que ce corps est censé fermer.
export const RAW_ACCESS_PAREN_BODY = `µread[ \\t\\r\\n]*\\([ \\t\\r\\n]*\\$(\\$?)(${SIGIL_ID})[ \\t\\r\\n]*\\)`

// µwrite $x, v → écrit le slot SANS notifier (grammaire à virgule —
// harmonisation : une seule façon d'écrire, l'ancienne forme `= v` devient une erreur explicite
// plus bas). La VALEUR n'est JAMAIS capturée par ce corps : aucune regex ne sait équilibrer les
// parenthèses d'un `v` qui contiendrait son PROPRE appel imbriqué (`µwrite $total, calc(a, b)`)
// — le corps s'arrête à la virgule, `v` continue tel quel dans le flux (même trick que
// l'ancienne forme, qui laissait déjà « = v » intact après le membre de gauche). `µread` ne
// change pas : il n'a pas de valeur à passer, rien à harmoniser.
export const RAW_WRITE_BODY = `µwrite[ \\t]+\\$(\\$?)(${SIGIL_ID})[ \\t]*,[ \\t]*`

// Forme parenthésée `µwrite($x, v)` — même logique : le corps s'arrête à la virgule, SANS
// toucher à `v` ni à la parenthèse fermante d'origine, qui reste dans le flux telle quelle. Le
// consommateur émet en remplacement UNE parenthèse ouvrante fraîche (RAW_WRITE_PAREN_OUT_OPEN)
// à la place de `µwrite(` : la fermante d'origine referme celle-là, quel que soit ce que `v`
// contient (`µwrite($total, calc(a, b))` → `(µ._mjs_storeRaw.total = calc(a, b))`, parenthèse
// englobante surnuméraire mais sans effet sur une expression d'affectation) — aucun comptage
// de profondeur nécessaire.
export const RAW_WRITE_PAREN_BODY = `µwrite[ \\t\\r\\n]*\\([ \\t\\r\\n]*\\$(\\$?)(${SIGIL_ID})[ \\t\\r\\n]*,[ \\t\\r\\n]*`
export const RAW_WRITE_PAREN_OUT_OPEN = '('

// Ancienne forme (RETIRÉE) : `µwrite $x = v` / `µwrite($x) = v`. Détectée à PART,
// AVANT la garde générique ci-dessous, pour un message dédié qui donne la forme attendue —
// sans ce corps, elle retomberait sur RAW_ACCESS_MALFORME_BODY (message générique, moins
// actionnable pour une faute aussi répandue auparavant). `(?!=|>)` exclut `==`/`=>`, même
// garde que MU_DERIVED_BODY plus bas.
export const RAW_WRITE_OLD_FORME_BODY = `µwrite[ \\t]+\\$(\\$?)(${SIGIL_ID})[ \\t]*=(?!=|>)`
export const RAW_WRITE_OLD_FORME_PAREN_BODY = `µwrite[ \\t\\r\\n]*\\([ \\t\\r\\n]*\\$(\\$?)(${SIGIL_ID})[ \\t\\r\\n]*\\)[ \\t]*=(?!=|>)`

export function rawWriteAncienneFormeError(): Error { return new Error(t('transpiler.rune-write-ancienne-forme')) }

// Garde de forme : TOUT `µread`/`µwrite` qui a survécu aux corps ci-dessus est une faute — appel
// malformé (`µread(x)` sans symbole, `µwrite(x, v)` sans `$`), référence nue (`f = µread`), ou
// forme coupée par un saut de ligne (`a = µread` puis `$x` à la ligne suivante, signalée par un
// second cas de test). Toutes finissaient en identifiant littéral : ReferenceError
// au navigateur, build vert. Frontière de mot : un `µreadme` utilisateur reste hors de portée.
// Les chaînes sont déjà masquées en amont (mapCodeSegments côté cleanJs, zones inertes côté
// lexer), les lignes de commentaire le sont par sansCommentaires — le mot CITÉ ne fait échouer
// aucun build. `:` collé immédiatement après (`{ µread: 1 }`, clé d'objet) est admis
// : un simple caractère de lookahead, risque nul — le ternaire
// `c ? µread : x` garde son espace avant le `:` et reste refusé tel quel.
export const RAW_ACCESS_MALFORME_BODY = `µ(?:read|write)(?![a-zA-Z0-9_:])`

export function rawAccessFormeError(): Error { return new Error(t('transpiler.rune-acces-brut-forme')) }

// Garde de forme — `§`/`§§` NU (non suivi d'un nom) : ni les pré-passes §/§§ du lexer ni la
// chaîne SYMBOLES de cleanJs (setter/getter, plus bas dans les deux moteurs) ne consomment un
// `§`/`§§` sans identifiant collé derrière — il atteint Civet tel quel, caractère hors alphabet
// JS, message cryptique (« Unexpected character »). Même refus
// explicite que µread/µwrite ci-dessus. Ne peut PAS vivre dans reserved-symbols.ts (lint du JS
// déjà compilé, AST acorn) : `§` n'est pas un caractère d'identifiant JS, il a disparu — ou fait
// échouer Civet — avant d'y arriver. Corps testé APRÈS les réécritures §x/§§x (pré-passes
// 1/2/2-bis du lexer, chaîne SYMBOLES de cleanJs) : tout §/§§ qui survit jusque-là n'est par
// construction suivi d'aucun nom valide — le lookahead suffit, aucun ordre de test à imposer.
// Lookahead négatif `[a-zA-Z_§]` (pas seulement `[a-zA-Z0-9_]`) : le 2e `§` d'un `§§` PLEIN
// (`§§count`) ne doit pas se faire gober par le `§` NU qui le précède.
export const BARE_SECTION_BODY = '§§?(?![a-zA-Z_§])'

export function bareSectionError(nom: string): Error { return new Error(t('transpiler.symbole-reserve-nu', { nom })) }

// µXxx (PascalCase) → µ.Xxx : classes/objets framework sans le point
export const MU_PASCAL_BODY = 'µ([A-Z][a-zA-Z0-9_]*)'

// allowlist STRICTE des globales framework en forme courte (µurl → µ.url,
// µonline/µvisible/µready, µserver, fabriques µsocket/µsmooth, µnav) ; ajouter
// une globale ICI suffit — les deux moteurs la consomment. `µserver` (→ µ.server) :
// SEULE différence avec online/visible/ready — sa VALEUR n'est pas réactive
// (mjs_store_globals.ts, contexte d'exécution figé pour la vie de l'instance) ;
// la forme courte, elle, suit EXACTEMENT le même sucre (aucune nuance ici).
// `nav` (→ µ.nav, mjs_store_globals.ts) : état de navigation UJS RÉACTIF
// ({active, href}, cf. mjs_ujs.ts) — même sucre que online/visible/ready.
// `t` (→ µ.t, rune i18n) : `µt('clé', vars)` → `µ.t('clé', vars)`, un APPEL
// (jamais une propriété nue) — mais le sucre ne consomme QUE le préfixe `µt`,
// la parenthèse et son contenu suivent tels quels au scanner. Aucune collision
// avec MU_HOOKS (aucun hook ne commence par `t`) ni avec un identifiant
// utilisateur `µtotal`/`µtranslate` (le lookahead négatif exige un caractère
// NON alphanumérique juste après `t` — `o`/`r` le bloquent, cf. sonde lexer).
// `µtoggle` est passé rune du framework (bascule d'état, plus bas
// dans ce fichier) : même garde, il ne se laisse simplement plus écrire par
// l'utilisateur — d'où le changement de témoin dans tests/i18n-compile.test.ts.
// `res` (→ µ.res) : sac de props RENVOYÉES PAR LE SERVEUR pour la page courante
// (protocole de navigation JSON — cf. mjs_ujs.ts µ._mjs_navApplyJson/µ._mjs_resSet,
// docs/21-navigation.md). Même sucre EXACT que les autres globales minuscules de
// cette liste — aucune nuance, juste une entrée de plus. Aucune collision : le
// lookahead `(?![a-zA-Z0-9_])` protège `µresult`/`µresume`/`µresolve` (aucun de
// ces identifiants n'existe par ailleurs dans ce projet, vérifié par grep).
// `confirm`/`ajax`/`error`/`config` (garde de confirmation mjs_ujs.ts,
// client HTTP mjs_ajax.ts, logger d'erreurs mjs_journal.ts/mjs_init.ts, config
// figée au build mjs_init.ts) : même sucre, même garde de frontière (bloque
// µconfirmer/µconfiguration/µerrorX).
// `debug`/`log`/`version`/`pageCache`/`interp`/`predict`/
// `interpolate`/`state`/`viewTransition` : formes courtes de globales runtime
// déjà existantes (flag µ.debug, helper µ.log conditionnel, µ.version de build,
// cache LRU de navigation mjs_ujs.ts, fabriques réseau µ.interp/µ.predict,
// interpolateur de valeur µ.interpolate, rune µ.state mjs_runes.ts, config de
// transition de vue lue par mjs_router.ts) — même garde de frontière ; `interp`
// et `interpolate` cohabitent sans ambiguïté grâce au lookahead (un échec sur
// le préfixe court fait backtracker vers l'alternative longue).
export const MU_SHORT_GLOBALS = 'url|online|visible|ready|server|socket|smooth|nav|res|t|modal|sound|confirm|ajax|error|config|debug|log|version|pageCache|interp|predict|interpolate|state|viewTransition'
export const MU_SHORT_BODY    = `µ(${MU_SHORT_GLOBALS})(?![a-zA-Z0-9_])`

// µlang → µ.store.__mjsLang : langue courante, PROPRIÉTÉ FRAMEWORK dédiée —
// PAS dans MU_SHORT_GLOBALS (qui pointe vers `µ.xxx`) : la langue vit dans
// le STORE (clé interne cachée '__mjsLang', non énumérable — cf.
// mjs_store_globals.ts) pour hériter GRATUITEMENT de toute la plomberie $$
// existante (analyzer → dépendance '$$__mjsLang', réactivité, abonnement au
// montage, écriture top-level réécrite en µ._storeSet). L'espace `$$` reste
// donc 100% à l'application — `lang` n'y est plus une clé réservée (cf.
// docs/29-i18n.md). Garde de frontière calquée sur MU_SHORT_BODY : lookahead
// négatif alphanumérique — bloque µlangue/µlangXXX.
export const MU_LANG_BODY = `µlang(?![a-zA-Z0-9_])`
export const MU_LANG_OUT  = 'µ.store.__mjsLang'

// µtheme → µ.store.__mjsTheme : thème courant, CALQUE EXACT de µlang ci-dessus
// (même mécanisme, même clé store interne cachée, même piège MU_SCRIPT_RUNES
// ci-dessous — la clé runtime __mjsTheme elle-même vit dans mjs_store_globals.ts,
// hors périmètre ici). Garde de frontière calquée sur MU_SHORT_BODY : bloque
// µthemeX/µthematique.
export const MU_THEME_BODY = `µtheme(?![a-zA-Z0-9_])`
export const MU_THEME_OUT  = 'µ.store.__mjsTheme'

// hooks de cycle de vie en RUNES (µmount ->, µdestroy ->, µurlChange (p, a) ->…) :
// la forme @mount -> est RETIRÉE (elle reposait sur un `=` fragile — piège nº1
// historique — et squattait 6 noms de méthodes sur l'instance). `urlChange`
// avant `url` : cosmétique (le lookahead de MU_SHORT_BODY désambiguïse déjà)
export const MU_HOOKS      = 'urlChange|mount|awake|sleep|destroy|failed'
export const MU_HOOKS_BODY = `µ(${MU_HOOKS})(?![a-zA-Z0-9_$])`

// µderived $var = expr, $a, $b — dérivé À DÉPENDANCES FORCÉES. Reconnaissance du
// mot-clé nu ; la grammaire complète (parsing $var/expr/liste de deps) vit dans
// lexer/index.ts.
export const MU_DERIVED_BODY = `µderived(?![a-zA-Z0-9_$])`

// µevery 2500, -> — TIMER de composant (tir immédiat au montage puis période,
// nettoyage au démontage, cf. µ.every dans runtime/mjs_runes.ts). AUCUNE entrée
// dans MU_SCRIPT_RUNES ci-dessous : le sucre universel `µfoo → µ.foo` fait déjà
// tout le travail dans un <script> (`µevery 2500, ->` → `µ.every 2500, ->`, appel
// nu que Civet accepte). Ce corps ne sert donc QU'au garde-fou de cleanJs : la
// rune se pose au SETUP du composant, jamais dans une interpolation {…} ni un
// handler — où elle finirait en ReferenceError muet. Même traitement que µderived.
export const MU_EVERY_BODY = `µevery(?![a-zA-Z0-9_$])`

// runes à COMPILATION LEXER (µread/µwrite → _state brut, hooks → _mjs_hook,
// µlang → µ.store.__mjsLang) : le « sucre universel » µfoo → µ.foo
// d'applyMjsSugarToScript, qui tourne AVANT le lexer, doit les laisser
// INTACTES — les pointer (`µ.read`, `µ.mount`, `µ.lang`) les rendait
// invisibles au lexer ET indéfinies au runtime (CORRECTIF :
// `lang` manquait à cette liste — µlang compilait en `µ.lang`, undefined à
// vie, repro : effet `document.documentElement.lang` figé sur la bascule
// de langue d'une landing). `import` : même piège —
// vérifié empiriquement (`applyMjsSugarToScript` transformait `µimport(...)`
// en `µ.import(...)` AVANT que rewriteMuImport ne puisse le voir) : sans
// cette exclusion, la rune ci-dessous n'est jamais atteinte. `theme` :
// même piège que `lang`, même remède.
export const MU_SCRIPT_RUNES = `read|write|lang|theme|derived|import|toggle|${MU_HOOKS}`

// µimport('chemin.js') / mjsimport('chemin.js') → chargement PARESSEUX d'un
// module ES, chemin LITTÉRAL exigé (empreinte résolue AU BUILD par µasset,
// cf. bundler/index.ts preResolveAssets — un argument calculé est invisible
// à cette pré-résolution côté master, pas de disque dans les workers ; seule
// échappatoire pour ça : `import(variable)` nu, laissé passer par le lint
// assoupli de lintNoRawImport). Garde de frontière calquée sur MU_SHORT_BODY
// (lookahead négatif alphanumérique) : µimporter/mjsimporter restent des
// identifiants utilisateur intacts, jamais cette rune.
export const MU_IMPORT_BODY = `(?:µ|mjs)import(?![a-zA-Z0-9_])`

// ancre + parenthèse ouvrante — garde de tête `(?<![\w.µ])` calquée sur les
// RE_MU_*_G des deux moteurs (évite un faux positif sur un identifiant plus
// long se TERMINANT par le motif, ex. `xmjsimport(`). Sticky (`y`), PAS
// globale : consommée à une position PRÉCISE par le scan manuel ci-dessous
// (même esprit que le scanner ancré `^` du lexer), jamais en recherche libre.
const MU_IMPORT_CALL_RE = new RegExp(`(?<![\\w.µ])${MU_IMPORT_BODY}\\s*\\(`, 'y')

// rewriteMuImport — corps PARTAGÉ des deux moteurs de sucre (lexer/
// applyMjsSugarToScript, cleanJs) : scan manuel caractère par caractère sur
// le texte ENTIER (PAS un `.replace` sur un chunk déjà code-only : l'argument
// de µimport EST une chaîne littérale — un masquage chaînes/commentaires FAIT
// EN AMONT, à la transformCodeOnly/mapCodeSegments, l'aurait déjà isolée hors
// de portée, invisible à tout `.replace()` de code). Cette fonction masque
// donc ELLE-MÊME chaînes/commentaires/regex QUELCONQUES — la LISTE des formes
// inertes (commentaires, chaîne simple '…', littéral regex /…/) vit désormais
// dans skipInertFrom SEUL (même discipline partout : une SEULE source,
// partagée avec rewriteMuToggle) — une chaîne/un commentaire/un regex qui
// MENTIONNE µimport reste, lui, intact — et reconnaît en plus le cas SPÉCIAL
// où une chaîne suit IMMÉDIATEMENT l'ancre `µimport(`/`mjsimport(` : celle-là
// seule est lue comme argument, jamais sautée. Même discipline partout.
export function rewriteMuImport(src: string, sectionLabel: string): string {
  let out = ''
  let i = 0
  const n = src.length
  let codeStart = 0
  while (i < n) {
    const ch = src[i]
    // chaîne INTERPOLABLE "…" / `…` (n'est PAS l'argument d'un µimport/
    // mjsimport tout juste reconnu — ce cas légitime est traité plus bas,
    // avant même d'atteindre une frontière de guillemet ici) : le TEXTE reste
    // inerte, mais chaque fenêtre `${…}` (backtick) / `#{…}` (chaîne double)
    // contient du CODE — un µimport qui s'y cachait restait invisible avant ce
    // correctif (« le trou du gabarit »). RAPPELLE rewriteMuImport sur
    // le contenu de CHAQUE fenêtre trouvée (rewriteMuImportWindows plus bas),
    // réinjecté à sa place — récursion CONSCIENTE des chaînes internes +
    // échappement en SAUT AVANT, même modèle qu'interpolateSigils
    // (lexer/index.ts:91-123, LE modèle à suivre). EN PREMIER, avant
    // skipInertFrom : ce dernier sauterait sinon ces chaînes SANS la
    // récursion sur leurs fenêtres.
    if (ch === '"' || ch === '`') {
      out += src.slice(codeStart, i)
      const quote = ch
      let j = i + 1
      while (j < n && src[j] !== quote) { if (src[j] === '\\') j++; j++ }
      const content = src.slice(i + 1, Math.min(j, n))
      const marker = quote === '`' ? '$' : '#'
      out += quote + rewriteMuImportWindows(content, marker, sectionLabel) + quote
      i = Math.min(j + 1, n)
      codeStart = i
      continue
    }
    // commentaires, chaîne simple '…' et littéral regex /…/ : intacts (jamais
    // vus comme un appel réel) — source UNIQUE skipInertFrom
    const inert = skipInertFrom(src, i)
    if (inert >= 0) { i = inert; continue }
    // ancre µimport(/mjsimport( — hors chaîne/commentaire/regex à ce point du scan
    MU_IMPORT_CALL_RE.lastIndex = i
    if (MU_IMPORT_CALL_RE.test(src)) {
      out += src.slice(codeStart, i)
      let k = MU_IMPORT_CALL_RE.lastIndex
      while (k < n && /\s/.test(src[k])) k++
      const quote = src[k]
      if (quote !== "'" && quote !== '"') {
        throw new Error(t('transpiler.rune-import-litteral-requis', { section: sectionLabel }))
      }
      const pathStart = k + 1
      let j = pathStart
      while (j < n && src[j] !== quote) { if (src[j] === '\\') j++; j++ }
      const chemin = src.slice(pathStart, j)
      let e = j + 1
      while (e < n && /\s/.test(src[e])) e++
      if (src[e] !== ')') {
        throw new Error(t('transpiler.rune-import-litteral-requis', { section: sectionLabel }))
      }
      if (!chemin.endsWith('.js')) {
        throw new Error(t('transpiler.rune-import-extension-js', { section: sectionLabel, chemin }))
      }
      out += `µ._mjs_import(µasset('${chemin}'))`
      i = e + 1
      codeStart = i
      continue
    }
    i++
  }
  out += src.slice(codeStart)
  return out
}

// rewriteMuImportWindows — DANS une chaîne interpolable déjà EXTRAITE (sans
// ses guillemets, cf. rewriteMuImport ci-dessus), retrouve les fenêtres
// `<marker>{…}` (`#` pour Coffee/Civet « … », `$` pour un template literal
// `…`) et RAPPELLE rewriteMuImport sur le code de CHACUNE, réinjecté à sa
// place. Comptage d'accolades CONSCIENT des chaînes internes, des
// commentaires ET des littéraux regex (skipInertFrom) — même
// modèle qu'interpolateSigils (lexer/index.ts:91-123). La récursion
// (rewriteMuImport → chaîne interne → rewriteMuImportWindows → fenêtre →
// rewriteMuImport…) couvre par construction un template IMBRIQUÉ à N niveaux.
function rewriteMuImportWindows(content: string, marker: string, sectionLabel: string): string {
  let out = ''
  let j = 0
  const n = content.length
  while (j < n) {
    if (content[j] === marker && content[j + 1] === '{' && content[j - 1] !== '\\') {
      let depth = 1
      let k = j + 2
      while (k < n && depth > 0) {
        // diese=false : un `#` ICI est un champ privé/
        // `#longueur` Civet, jamais un commentaire (cf. bandeau skipInertFrom ci-dessus)
        const inert = skipInertFrom(content, k, false)
        if (inert >= 0) { k = inert; continue }
        const c = content[k]
        if (c === '{') depth++
        else if (c === '}') { depth--; if (depth === 0) break }
        k++
      }
      // Fenêtre jamais refermée (`depth` n'a pas atteint 0,
      // sortie par épuisement de `content`) : ne PAS synthétiser de `}` ; recopier le reste
      // tel quel et arrêter (HEAD ajoutait déjà un `}` aveugle ici — robustesse en plus)
      if (depth > 0) { out += content.slice(j); return out }
      const inner = content.slice(j + 2, k)
      out += marker + '{' + rewriteMuImport(inner, sectionLabel) + '}'
      j = k + 1
    } else {
      out += content[j]
      j++
    }
  }
  return out
}

// rewriteMuImportAst — voie AST (post-Civet, « trou du
// gabarit ») : acorn-walk sur le JS déjà COMPILÉ (jsInitBase, <script
// module>…) plutôt qu'un scan manuel sur du texte pré-Civet — ferme le trou
// PAR CONSTRUCTION (un µimport niché dans une fenêtre `${…}`/`#{…}`, à
// n'importe quelle profondeur, est un CallExpression comme un autre pour
// acorn — rien à scanner à la main). Options acorn : `sourceType: 'module'`
// (calqué sur parseModuleAst, transpiler/index.ts) + `allowReturnOutsideFunction`
// (calqué sur detectRouterAware, MÊME fichier — même variable jsInitBase :
// corps de composant, pas un vrai module, top-level `this`/`return` légaux)
// — vérifié empiriquement que les deux options combinées acceptent À LA FOIS
// un vrai `import … from …` de tête ET un `return` top-level.
// Repli sur le scanner manuel (rewriteMuImport) si le JS ne parse pas
// (sortie langage exotique, cf. parseModuleAst) : jamais PIRE que l'existant.
export function rewriteMuImportAst(js: string, sectionLabel: string): string {
  if (!js) return js
  let ast: acorn.Node
  try {
    ast = acorn.parse(js, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true })
  } catch {
    return rewriteMuImport(js, sectionLabel)
  }

  const ms = new MagicString(js)

  walk.ancestor(ast, {
    // µimport('chemin.js') / mjsimport('chemin.js') → µ._mjs_import(µasset('chemin.js')).
    // Un argument QUELCONQUE hors chaîne littérale (variable, template avec
    // expression, 0/2+ arguments…) → même erreur que le scanner (parité stricte).
    CallExpression(node: any) {
      const callee = node.callee
      if (callee?.type !== 'Identifier' || (callee.name !== 'µimport' && callee.name !== 'mjsimport')) return
      const args = node.arguments ?? []
      if (args.length !== 1 || args[0].type !== 'Literal' || typeof args[0].value !== 'string') {
        throw new Error(t('transpiler.rune-import-litteral-requis', { section: sectionLabel }))
      }
      const arg = args[0]
      if (!(arg.value as string).endsWith('.js')) {
        throw new Error(t('transpiler.rune-import-extension-js', { section: sectionLabel, chemin: arg.value }))
      }
      // `arg.raw` VERBATIM (guillemets/échappements de l'auteur préservés) —
      // jamais une reconstruction (JSON.stringify etc.) qui reformaterait.
      ms.overwrite(node.start, node.end, `µ._mjs_import(µasset(${arg.raw}))`)
    },
    // BRUYANT PAR CONSTRUCTION : toute AUTRE apparition de l'identifiant
    // (référence nue `f = µimport`, alias, argument passé tel quel…) — auparavant,
    // panne muette au runtime (ReferenceError, µimport n'existe pas).
    // Une mention dans une chaîne/un commentaire N'EST PAS un Identifier ici
    // → intacte par nature (mieux que le scanner manuel).
    Identifier(node: any, _state: unknown, ancestors: any[]) {
      if (node.name !== 'µimport' && node.name !== 'mjsimport') return
      const parent = ancestors[ancestors.length - 2]
      if (parent && parent.type === 'CallExpression' && parent.callee === node) return
      throw new Error(t('transpiler.rune-import-litteral-requis', { section: sectionLabel }))
    },
  })

  return ms.toString()
}


// erreurs de compilation communes aux deux moteurs — même cause, MÊME message
// (les deux copies du message singleton avaient déjà divergé d'un mot avant
// l'extraction ; unifié sur la forme riche du lexer)

// `&$x` : le sigil vault est retiré, fondu dans le store global `$$`
export const vaultRemovedError = (name: string) => new Error(t('sigils.vault-retire', { nom: name }))

// `$$x` sur un singleton importé : il se consomme en `µ$$x`, pas en `$$x`
export const importedSingletonError = (name: string) => new Error(t('sigils.singleton-importe', { nom: name }))

// ============================================================================
// µtoggle — bascule / cycle d'état (rune de COMPILATION)
// ============================================================================
//
// `@click={µtoggle($layout, 'banner')}` remplace un ternaire qui répète le nom
// de l'état trois fois. Sucre PUR : rien n'est embarqué au runtime, la rune
// disparaît à la compilation en une affectation ordinaire.
//
//   µtoggle($ouvert)                  →  $ouvert = !$ouvert
//   µtoggle($layout, 'banner')        →  '' ⇄ 'banner'          (présent / absent)
//   µtoggle($theme, 'gold', 'dark')   →  gold → dark → gold     (cycle FERMÉ)
//   µtoggle($theme, '', 'gold')       →  '' → gold → ''         (le vide, écrit)
//
// LA RÈGLE : la liste des arguments EST la liste des états, dans l'ordre, en
// boucle. Le vide n'entre dans le cycle que si on l'écrit — un cycle à N valeurs
// n'oscille QU'ENTRE les états définis. Le seul cas où
// le vide est implicite est la forme à UNE valeur : un cycle d'un seul état ne
// basculerait rien, c'est donc le raccourci « présent / absent ».
// Valeur courante hors liste → premier état (chute finale du ternaire, pas un
// test de plus) : un état sale ou un défaut jamais posé retombe sur ses pieds.
//
// CIBLE : tout chemin ASSIGNABLE et PUR à la lecture, rendu VERBATIM — ce sont
// les passes du dessous (scanner du lexer, symboles de cleanJs) qui posent le
// bon setter, exactement comme µderived : `µ._set` pour `$x`, `µ._storeSet` pour
// `$$x`/`µtheme`/`µlang`, `µ._mjs_deepSet` pour un chemin `$o.a.b`, l'affectation nue
// pour `@prop` et pour une variable ordinaire. ⚠️ TOUT ce qui est assignable n'est
// pas RÉACTIF : `@prop`, `§x` (contexte figé) et une variable nue basculent bel et
// bien, mais rien ne se re-rend — c'est assumé,
// documenté, et sans piège muet depuis que l'auto-déclaration du batch inline voit
// les vars du `<script>` (cf. `scriptVars`, transpiler/index.ts).
// VALEURS : littérales (chaîne, nombre, true/false, null). Une expression est
// REFUSÉE à la compilation : la chaîne de ternaires la ferait évaluer deux fois,
// et un effet de bord dédoublé serait un piège muet. Message explicite, jamais
// un silence.
export const MU_TOGGLE_BODY = `µtoggle(?![a-zA-Z0-9_])`

// ancre + parenthèse ouvrante — même garde de tête que MU_IMPORT_CALL_RE
const MU_TOGGLE_CALL_RE = new RegExp(`(?<![\\w.µ])${MU_TOGGLE_BODY}\\s*\\(`, 'y')
// même ancre SANS parenthèse : référence nue / forme Coffee sans parenthèses
const MU_TOGGLE_BARE_RE = new RegExp(`(?<![\\w.µ])${MU_TOGGLE_BODY}`, 'y')

// CIBLE — tout CHEMIN ASSIGNABLE et PUR à la lecture. La
// contrainte n'a jamais été « un état » : c'est que la chaîne de ternaires RELIT la cible
// une fois par test — un appel, un `++` ou un index calculé y serait donc évalué N fois,
// effet de bord dédoublé en silence. Racines admises : `$x` (état), `$$x` (store),
// `§x`/`§§x` (contexte), `µtheme`/`µlang` (stores réservés), `@prop`, et le nom NU d'une
// variable ordinaire. Suffixes admis : `.clé` et `[littéral]` en cascade.
const TOGGLE_TARGET_RE  = /^(?:µtheme|µlang|@[a-zA-Z_]\w*|\$\$?[a-zA-Z_]\w*|§§?[a-zA-Z_]\w*|[a-zA-Z_]\w*)(?:\.[a-zA-Z_]\w*|\[(?:-?\d+|'(?:\\.|[^\\'])*'|"(?:\\.|[^\\"])*")\])*$/
// mots que JS ne laisse pas réaffecter : sans cette garde, `µtoggle(null, 'a')` passait la
// regex du nom nu et sortait un `null = …` — SyntaxError du navigateur, sans un mot ici.
// Testée sur la RACINE, jamais sur la chaîne entière : `null.x` sortait sinon un
// `null.x = …` tout aussi cassé (TypeError au premier clic) — trouvé en testant.
const TOGGLE_MOTS_RESERVES = new Set(['true', 'false', 'null', 'undefined', 'this', 'NaN', 'Infinity', 'arguments', 'super', 'new', 'typeof', 'void', 'delete', 'in', 'of', 'instanceof'])
const TOGGLE_LITERAL_RE = /^(?:'(?:\\.|[^\\'])*'|"(?:\\.|[^\\"])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)$/

// skipInertFrom — offset de FIN d'un littéral/commentaire commençant en `i`, ou
// -1 si rien d'inerte ici. MÊMES formes que rewriteMuImport :
// une chaîne ou un commentaire qui MENTIONNE µtoggle reste intact.
// 3e paramètre `diese` : DANS une fenêtre `${…}`/`#{…}`
// (comptage d'accolades de rewriteMuImportWindows/rewriteMuToggleWindows), un `#` est un
// champ privé/`#longueur` Civet, JAMAIS un commentaire Coffee — le traiter comme inerte y
// sautait jusqu'au `\n` (souvent la fin du `content`, une sous-chaîne SANS `\n`), avalait le
// `}` fermant la fenêtre et corrompait la sortie (accolade dupliquée, panne silencieuse).
// Les fenêtres appellent avec `diese=false` ; rewriteMuImport/rewriteMuToggle/splitToggleArgs
// gardent `diese=true` (comportement inchangé, valeur par défaut).
function skipInertFrom(src: string, i: number, diese = true): number {
  const n  = src.length
  const ch = src[i]
  if (ch === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); return e < 0 ? n : e }
  if (ch === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); return e < 0 ? n : e + 2 }
  // Littéral regex `/…/` : même zone inerte, heuristique PARTAGÉE
  // avec le lexer (scanInertAt) et le générateur (mapCodeSegments), cf. ouvreUneRegex
  // /scanRegexLiteral plus bas — une regex qui MENTIONNE µtoggle/µimport reste intacte
  if (ch === '/') {
    if (ouvreUneRegex(src.slice(0, i))) { const e = scanRegexLiteral(src, i); if (e >= 0) return e }
    return -1
  }
  if (diese && ch === '#' && src[i + 1] !== undefined && !/[a-zA-Z_!]/.test(src[i + 1])) { const e = src.indexOf('\n', i); return e < 0 ? n : e }
  if (ch === "'" || ch === '"' || ch === '`') {
    let j = i + 1
    while (j < n && src[j] !== ch) { if (src[j] === '\\') j++; j++ }
    return Math.min(j + 1, n)
  }
  return -1
}

// splitToggleArgs — découpe les arguments d'un appel µtoggle(…) déjà délimité.
// CONSCIENTE des chaînes (une virgule dans `'a,b'` ne coupe rien) et des
// niveaux ()/[]/{} ; rend `null` si la parenthèse fermante manque.
function splitToggleArgs(src: string, start: number): { args: string[]; end: number } | null {
  const n = src.length
  const args: string[] = []
  let cur   = ''
  let depth = 0
  let i     = start
  while (i < n) {
    const inert = skipInertFrom(src, i)
    if (inert >= 0) { cur += src.slice(i, inert); i = inert; continue }
    const ch = src[i]
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ']' || ch === '}') depth--
    else if (ch === ')') {
      if (depth === 0) { args.push(cur); return { args: args.map(a => a.trim()), end: i } }
      depth--
    }
    if (ch === ',' && depth === 0) { args.push(cur); cur = '' } else cur += ch
    i++
  }
  return null
}

// toggleKey — clé de comparaison d'une valeur LITTÉRALE, par sa valeur et non par son texte :
// une chaîne perd ses guillemets et ses échappements, un nombre passe par Number (`1` ≡ `1.0`
// ≡ `1e0`), les mots-clés restent eux-mêmes. Sert UNIQUEMENT à la garde anti-doublon.
function toggleKey(v: string): string {
  if (v[0] === "'" || v[0] === '"')                    return 's:' + v.slice(1, -1).replace(/\\(.)/g, '$1')
  if (v === 'true' || v === 'false' || v === 'null')   return 'k:' + v
  return 'n:' + Number(v)
}

// buildToggle — le corps généré, commun aux deux moteurs.
function buildToggle(args: string[], sectionLabel: string): string {
  const cible = args[0] ?? ''
  const racine = /^[^.[]*/.exec(cible)?.[0] ?? cible
  if (!TOGGLE_TARGET_RE.test(cible) || TOGGLE_MOTS_RESERVES.has(racine)) throw new Error(t('transpiler.rune-toggle-cible', { section: sectionLabel, recu: cible }))
  const valeurs = args.slice(1)
  for (const v of valeurs) if (!TOGGLE_LITERAL_RE.test(v)) throw new Error(t('transpiler.rune-toggle-valeur', { section: sectionLabel, recu: v }))
  // doublon comparé sur la VALEUR, jamais sur le texte source : `'a'` et `"a"` sont la même
  // chaîne, `1` et `1.0` le même nombre — laissés passer, ils tuaient tout le reste du cycle
  // en silence (`µtoggle($t, 1, 1.0, 2)` : l'état 2 devenait inatteignable). Trouvé en testant.
  const cles = valeurs.map(toggleKey)
  for (let k = 0; k < cles.length; k++) if (cles.indexOf(cles[k]) !== k) throw new Error(t('transpiler.rune-toggle-doublon', { section: sectionLabel, recu: valeurs[k] }))
  // 0 valeur → booléen ; 1 valeur → présent/absent ; N → cycle fermé (chute = 1er état)
  if (valeurs.length === 0) return `${cible} = !${cible}`
  if (valeurs.length === 1) return `${cible} = (${cible} === ${valeurs[0]} ? '' : ${valeurs[0]})`
  const tests = valeurs.slice(0, -1).map((v, k) => `${cible} === ${v} ? ${valeurs[k + 1]}`)
  return `${cible} = (${tests.join(' : ')} : ${valeurs[0]})`
}

// rewriteMuToggle — corps PARTAGÉ des deux moteurs de sucre (pré-passe du lexer
// pour les <script>, tête de cleanJs pour les interpolations {…}/handlers).
// Scan manuel caractère par caractère, masquage des chaînes/commentaires FAIT
// ICI (mêmes raisons que rewriteMuImport : les valeurs du cycle SONT des
// chaînes littérales — un masquage fait en amont les rendrait invisibles).
// La sortie reste en syntaxe MJS (`$x`, `$$x` verbatim) : elle est destinée aux
// passes du dessous, jamais au runtime directement.
export function rewriteMuToggle(src: string, sectionLabel: string): string {
  if (!src.includes('µtoggle')) return src
  let out       = ''
  let i         = 0
  let codeStart = 0
  const n       = src.length
  while (i < n) {
    // chaîne INTERPOLABLE : le TEXTE est inerte, mais chaque fenêtre `#{…}`/`${…}` contient du
    // CODE. Sans ce détour, un `{\`etat: ${µtoggle($x, 'a')}\`}` sortait de cleanJs avec la rune
    // INTACTE — sucre non consommé, donc ReferenceError au premier rendu, sans un mot à la
    // compilation. Le lexer, lui, rebouchait le trou par accident (interpolateSigils rappelle
    // tokenize, donc cette passe) : les deux moteurs ne se comportaient pas pareil. C'est le
    // « trou du gabarit », déjà fermé pour µimport — même remède, même forme.
    // Trouvé en testant.
    const ch = src[i]
    if (ch === '"' || ch === '`') {
      out += src.slice(codeStart, i)
      let j = i + 1
      while (j < n && src[j] !== ch) { if (src[j] === '\\') j++; j++ }
      const contenu = src.slice(i + 1, Math.min(j, n))
      out += ch + rewriteMuToggleWindows(contenu, ch === '`' ? '$' : '#', sectionLabel) + ch
      i = Math.min(j + 1, n)
      codeStart = i
      continue
    }
    const inert = skipInertFrom(src, i)
    if (inert >= 0) { i = inert; continue }
    MU_TOGGLE_CALL_RE.lastIndex = i
    if (MU_TOGGLE_CALL_RE.test(src)) {
      const parsed = splitToggleArgs(src, MU_TOGGLE_CALL_RE.lastIndex)
      if (!parsed) throw new Error(t('transpiler.rune-toggle-appel', { section: sectionLabel }))
      out += src.slice(codeStart, i) + buildToggle(parsed.args, sectionLabel)
      i = parsed.end + 1
      codeStart = i
      continue
    }
    // µtoggle SANS parenthèse : référence nue (`f = µtoggle`) ou forme Coffee
    // sans parenthèses (`µtoggle $x, 'a'`). BRUYANT par construction — laissée
    // passer, elle finirait en ReferenceError au navigateur.
    MU_TOGGLE_BARE_RE.lastIndex = i
    if (MU_TOGGLE_BARE_RE.test(src)) throw new Error(t('transpiler.rune-toggle-appel', { section: sectionLabel }))
    i++
  }
  return out + src.slice(codeStart)
}

// rewriteMuToggleWindows — DANS une chaîne interpolable déjà extraite (sans ses guillemets),
// retrouve les fenêtres `<marqueur>{…}` et rappelle rewriteMuToggle sur le code de chacune.
// Comptage d'accolades CONSCIENT des chaînes internes, des commentaires ET des littéraux
// regex (skipInertFrom) : copie exacte de rewriteMuImportWindows ci-dessus.
// La récursion couvre par construction une chaîne à backticks imbriquée.
function rewriteMuToggleWindows(contenu: string, marqueur: string, sectionLabel: string): string {
  let out = ''
  let j   = 0
  const n = contenu.length
  while (j < n) {
    if (contenu[j] === marqueur && contenu[j + 1] === '{' && contenu[j - 1] !== '\\') {
      let depth = 1
      let k     = j + 2
      while (k < n && depth > 0) {
        // diese=false : cf. bandeau rewriteMuImportWindows
        const inert = skipInertFrom(contenu, k, false)
        if (inert >= 0) { k = inert; continue }
        const c = contenu[k]
        if (c === '{') depth++
        else if (c === '}') { depth--; if (depth === 0) break }
        k++
      }
      // Fenêtre jamais refermée : même garde-fou que
      // rewriteMuImportWindows ci-dessus, pas de `}` synthétisé
      if (depth > 0) { out += contenu.slice(j); return out }
      out += marqueur + '{' + rewriteMuToggle(contenu.slice(j + 2, k), sectionLabel) + '}'
      j = k + 1
    } else {
      out += contenu[j]
      j++
    }
  }
  return out
}

// ============================================================================
// sucre universel µfoo → µ.foo — corps PARTAGÉ entre les DEUX moteurs (script :
// transpiler/index.ts, MU_UNIVERSAL_RE ; expressions HTML {…}/attributs : generator/
// utils.ts, RE_MU_UNIVERSAL_G)
// ============================================================================
//
// Le script pointe déjà N'IMPORTE QUEL `µfoo` non réservé au lexer (MU_SCRIPT_RUNES
// ci-dessus) en `µ.foo` — SANS liste blanche, contrairement à MU_SHORT_BODY qui ne
// couvre qu'un sous-ensemble choisi (url/online/.../t/...). cleanJs/cleanJsExpr
// (interpolations de texte, valeurs d'attribut) n'avaient QUE MU_PASCAL_BODY et
// MU_SHORT_BODY : une rune minuscule hors liste blanche (µraw/µsnap/µplay/µminmax/
// µinspect, mjs_rare_runes.ts) ressortait littérale dans le JS final —
// `µraw is not defined` au premier rendu (repro : `weatherData={µraw(result)}` dans
// une branche `{success result}`). La garde d'exclusion (MU_SCRIPT_RUNES) était déjà
// partagée ; seul le corps de regex qui l'enveloppe manquait côté cleanJs — posé ici
// pour que les deux moteurs partent du MÊME texte, jamais deux copies maintenues à la
// main (cf. bandeau de tête de ce fichier).
export const MU_UNIVERSAL_BODY = `µ(?!(?:${MU_SCRIPT_RUNES})\\b)([a-zA-Z]\\w*)`

// µ.inspect($x) → µ.inspect('x') — le runtime (mjs_rare_runes.ts) attend la CLÉ
// d'état en chaîne, jamais la valeur courante. Parenthèses OPTIONNELLES en ENTRÉE
// (`\(?…\)?`, accepte `µ.inspect($x)` ET la forme nue Coffee `µ.inspect $x`),
// TOUJOURS parenthésées en SORTIE — appel JS valide par construction, aussi bien
// recompilé par Civet ensuite (script) que laissé tel quel (cleanJs/cleanJsExpr,
// sortie JS FINALE jamais recompilée sur ce chemin).
export const MU_INSPECT_ARG_BODY = 'µ\\.\\s*inspect[ \\t]*\\(?[ \\t]*\\$([a-zA-Z0-9_]+)[ \\t]*\\)?'
export const MU_INSPECT_ARG_OUT  = "µ.inspect('$1')"

// µ.minmax($x, min, max) → µ.minmax(_mjsThis, 'x', min, max) — le runtime clampe
// `_mjsThis._mjs_limits[key]`, jamais `$x` lui-même. SEULE la forme PARENTHÉSÉE est
// partagée : elle produit un appel COMPLET valide en JS direct (la parenthèse
// fermante d'ORIGINE, non capturée, referme l'appel — même trick que
// RAW_WRITE_PAREN_BODY plus haut). La forme SANS parenthèses (`µminmax $x, 0, 10`,
// sucre Coffee) reste SCRIPT-ONLY (transpiler/index.ts) : sa sortie nue n'est valide
// qu'une fois recompilée par Civet — chemin que cleanJs (repli templateLang:'js',
// sites FRAGMENT) ne garantit pas.
export const MU_MINMAX_ARG_PAREN_BODY = "(?<!µ\\.)µ\\.?minmax\\s*\\(\\s*\\$([a-zA-Z_$][\\w$]*)"
export const MU_MINMAX_ARG_PAREN_OUT  = "µ.minmax(_mjsThis, '$1'"

// ============================================================================
// littéraux regex `/…/` — PARTAGÉS entre les TROIS moteurs de sucre (parser,
// lexer, générateur)
// ============================================================================
//
// Trou trouvé : le parser (Scanner.avaleRegex,
// extractBalanced, src/parser/index.ts) sait déjà reconnaître un littéral regex, mais le
// lexer (scripts, scanner ET pré-passes §/§§) et le générateur (mapCodeSegments,
// interpolations/handlers) l'ignoraient — un `§`/`µXxx`/`$x` À L'INTÉRIEUR d'une regex y
// était traité comme du CODE : `x = /§/` levait la garde « § nu » (transpiler.symbole-
// reserve-nu), `re = /µTotal/` sortait réécrit `/µ.Total/` (corruption SILENCIEUSE du
// motif). Une seule heuristique pour tout le compilateur, logée ICI.

// un `/` en position d'EXPRESSION ouvre une regex littérale ; en position de VALEUR il
// divise. Heuristique JS classique : après une parenthèse/opérateur/virgule (ou en début), c'est
// une regex ; après un identifiant, un nombre, `)` ou `]`, c'est une division.
const REGEX_APRES_SIGNE   = /[({[,;:=!&|?+\-*%<>~^]$/
// `$` et `.` ne sont pas des `\w` : un simple `\b` laissait passer un ÉTAT dont le nom EST le
// mot-clé (`{ $in / 2 }`, `{ $obj.of / 2 }`) — la division partait en regex et avalait le document
// … ni `§`, `@`, `µ`, `&` : `@new / $total / 2` (propriété `new`, division) partait en regex, `$total`
// n'était plus sucré — « $total is not defined » au montage, build vert
const REGEX_APRES_MOT_CLE = /(?<![\w$.§@µ&])(?:return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)$/
// `++`/`--` PRODUISENT une valeur : le `/` qui suit divise (le `+`/`-` final de REGEX_APRES_SIGNE
// ne vise que la forme préfixe/binaire)
const INCREMENT_FINAL     = /(?:\+\+|--)$/

// ouvreUneRegex — vrai si le texte déjà émis (`gauche`) place le prochain `/` en position
// d'EXPRESSION (regex) plutôt qu'en position de VALEUR (division). Consommée par le parser
// (avaleRegex/extractBalanced), le lexer (scanInertAt + règle 3.1a) et le générateur
// (mapCodeSegments) — DÉPLACÉE ici depuis parser/index.ts, comportement
// inchangé.
// PERF : skipInertFrom (plus haut dans ce fichier) appelle
// cette fonction à CHAQUE `/` du source via `ouvreUneRegex(src.slice(0, i))` ; l'ancienne forme
// (`gauche.replace(/\s+$/, '')` sur la chaîne ENTIÈRE) coûtait O(i) par appel — O(n²) cumulé sur
// un fichier à O(n) divisions (mesuré 5-9 ms → 3,4 s sur 220 Ko/20 000 divisions synthétiques,
// 1 ms → 30 ms sur le plus gros fichier réel du corpus). Tous les tests ci-dessous ne portent que
// sur la QUEUE de `gauche` (espace final + 16 derniers caractères, marge ≥ `instanceof` (10) + 1
// caractère de lookbehind) : ne regarder que cette queue rend chaque appel O(1), signature et
// sémantique INCHANGÉES pour les appelants (équivalence vérifiée sur ~1100 fichiers .mjs réels).
export function ouvreUneRegex(gauche: string): boolean {
  let j = gauche.length
  while (j > 0 && /\s/.test(gauche[j - 1])) j--
  if (j === 0) return true
  const net = gauche.slice(Math.max(0, j - 16), j)
  if (INCREMENT_FINAL.test(net)) return false
  // `</…` = balise HTML FERMANTE, jamais une regex (`a < /re/` n'existe pas) — transformCodeOnly voit le source
  // ENTIER, template compris : sans cette garde `</script><p>…</p>` était avalé comme un littéral.
  if (net.endsWith('<')) return false
  return REGEX_APRES_SIGNE.test(net) || REGEX_APRES_MOT_CLE.test(net)
}

// scanRegexLiteral — variante STRING de `avaleRegex` (parser/index.ts, Scanner) : MÊME
// heuristique de fond (classe `[…]` protège le `/`, `\` échappe le caractère suivant,
// drapeaux `[a-z]*` en queue), pour le lexer et le générateur — qui n'ont pas de Scanner à
// position mutable. Coexistent plutôt que fusionnées : `avaleRegex` avance un `Scanner`,
// `scanRegexLiteral` rend un INDEX sur une chaîne brute.
// `i` pointe sur le `/` OUVRANT (pas encore consommé) ; rend l'index JUSTE APRÈS le
// littéral (drapeaux compris), ou -1 si aucun `/` fermant n'apparaît avant la fin de LIGNE
// — une division ne se referme jamais, le lookahead ne doit donc pas manger le reste du
// document.
export function scanRegexLiteral(str: string, i: number): number {
  let j      = i + 1
  let classe = false
  let ferme  = false
  while (j < str.length) {
    const c = str[j]
    if (c === '\n') break
    if (c === '\\') { j += 2; continue }
    if (c === '[') { classe = true; j += 1; continue }
    if (c === ']') { classe = false; j += 1; continue }
    if (c === '/' && !classe) { j += 1; ferme = true; break }
    j += 1
  }
  if (!ferme) return -1
  const drapeaux = str.slice(j).match(/^[a-z]*/)
  return j + (drapeaux ? drapeaux[0].length : 0)
}
