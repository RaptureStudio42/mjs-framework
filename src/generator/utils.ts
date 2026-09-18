// utils — helpers cleanJs/cleanJsExpr, parseMixedString utilisés par le walker.
//
// `cleanJs(expr)` transforme une expression d'interpolation `{...}` ou de
// directive `@x={...}` en JS valide via une suite de regex — moteur HISTORIQUE
// « symboles + grammaire », utilisé tel quel en `templateLang: 'js'` (repli)
// et pour tous les sites FRAGMENT (têtes de {for}, corps de handlers déjà
// batchés en Civet/Coffee par transpiler/index.ts, callbacks @transition,
// heuristiques de détection filtered).
//
// `cleanJsExpr(expr, externalVars, templateLang, moduleName)` — brique
// finale : pour les sites qui
// manipulent une VRAIE expression autonome (interpolation texte, valeur
// d'attribut, condition {if}/{elsif}/@class{}/@style{}/@flip{}, itérable
// {for}, expression {key}/{const}/{await}), le traitement est SCINDÉ en deux
// passes :
//   (a) SYMBOLES — exactement les mêmes regex que `cleanJs` ($x/@x/§x/µXxx/
//       µread…), TOUJOURS appliquées quel que soit templateLang : leur sortie
//       est du Civet valide PAR CONSTRUCTION (`$.x`, `this.x`,
//       `µ.url.params.id`… — `µ` vérifié accepté comme identifiant Civet par
//       sonde directe, cf. tests/template-civet.test.ts).
//   (b) GRAMMAIRE — si `templateLang === 'js'`, les mêmes regex Coffee/Civet
//       que `cleanJs` (`->`, not/and/or, is/isnt, unless), INCHANGÉES ; si
//       'civet' (défaut), compilation Civet SYNCHRONE de l'expression
//       complète (`compile(src, {js: true, sync: true})`) — Civet comprend
//       nativement `->`/not/and/or/is/isnt/unless (grammaire idiomatique
//       complète, sonde directe) sans repasser par nos regex. Mémoïsée (Map
//       module-level, clé = sortie de la passe symboles) : les mêmes
//       expressions reviennent des centaines de fois sur un projet.
//
// Pourquoi `compile({sync:true})` et pas le duo `parse()`+`generate()` déjà
// écarté (« bug d'état partagé global » —
// `parseProgram()` pose des variables de MODULE (filename/config/sync) et ne
// les nettoie qu'en sortie de SA branche : un `parse()` isolé rappelé ensuite
// hérite d'un état non nettoyé, « Unconsumed input ») ? Parce que `compile()`
// EST déjà le chemin utilisé pour les `<script>` et les handlers inline
// (`civetAdapter.compileToJs`, languages/civet.ts) sans jamais rouvrir ce
// bug — la fonction reste sur SA branche synchrone de bout en bout (pose →
// utilise → nettoie dans le MÊME tour d'exécution) tant que `comptime` n'est
// pas actif (vérifié dans `@danielx/civet/dist/main.js` : seul `comptime`,
// jamais utilisé par ce projet, introduit un `await` avant le nettoyage).
// Seule différence ici : `sync: true` — `cleanJs`/`cleanJsExpr` sont appelés
// en SYNCHRONE (des centaines de fois depuis des callbacks de `.replace()`),
// aucun point d'`await` possible dans leur pile d'appel.

import { RAW_ACCESS_BODY, RAW_ACCESS_PAREN_BODY, RAW_ACCESS_MALFORME_BODY, rawAccessFormeError, RAW_WRITE_BODY, RAW_WRITE_PAREN_BODY, RAW_WRITE_PAREN_OUT_OPEN, RAW_WRITE_OLD_FORME_BODY, RAW_WRITE_OLD_FORME_PAREN_BODY, rawWriteAncienneFormeError, BARE_SECTION_BODY, bareSectionError, RAW_ACCESS_OUT, RAW_ACCESS_STORE_OUT, MU_PASCAL_BODY, MU_SHORT_BODY, MU_LANG_BODY, MU_LANG_OUT, MU_THEME_BODY, MU_THEME_OUT, MU_HOOKS_BODY, MU_DERIVED_BODY, MU_EVERY_BODY, MU_UNIVERSAL_BODY, MU_INSPECT_ARG_BODY, MU_INSPECT_ARG_OUT, MU_MINMAX_ARG_PAREN_BODY, MU_MINMAX_ARG_PAREN_OUT, vaultRemovedError, importedSingletonError, rewriteMuImport, rewriteMuToggle, ouvreUneRegex, scanRegexLiteral } from '../sigils.js'
import { createRequire } from 'node:module'
import { t } from '../messages/index.js'

// regex globales des runes µ — bâties UNE fois sur les corps partagés
// (sigils.ts, source unique lexer↔cleanJs) ; seule la GARDE (lookbehind)
// reste locale à ce moteur
const RE_RAW_ACCESS_G = new RegExp(`(?<![\\w.])${RAW_ACCESS_BODY}`, 'g')
const RE_RAW_ACCESS_PAREN_G = new RegExp(`(?<![\\w.])${RAW_ACCESS_PAREN_BODY}`, 'g')
const RE_RAW_ACCESS_MALFORME_G = new RegExp(`(?<![\\w.])${RAW_ACCESS_MALFORME_BODY}`, 'g')
const RE_RAW_WRITE_G = new RegExp(`(?<![\\w.])${RAW_WRITE_BODY}`, 'g')
const RE_RAW_WRITE_PAREN_G = new RegExp(`(?<![\\w.])${RAW_WRITE_PAREN_BODY}`, 'g')
const RE_RAW_WRITE_OLD_FORME_G = new RegExp(`(?<![\\w.])${RAW_WRITE_OLD_FORME_BODY}`, 'g')
const RE_RAW_WRITE_OLD_FORME_PAREN_G = new RegExp(`(?<![\\w.])${RAW_WRITE_OLD_FORME_PAREN_BODY}`, 'g')
const RE_BARE_SECTION_G = new RegExp(`(?<![\\w.§])${BARE_SECTION_BODY}`, 'g')
const RE_MU_PASCAL_G  = new RegExp(`(?<![\\w.µ])${MU_PASCAL_BODY}`, 'g')
const RE_MU_SHORT_G   = new RegExp(`(?<![\\w.µ])${MU_SHORT_BODY}`, 'g')
const RE_MU_LANG_G    = new RegExp(`(?<![\\w.µ])${MU_LANG_BODY}`, 'g')
const RE_MU_THEME_G   = new RegExp(`(?<![\\w.µ])${MU_THEME_BODY}`, 'g')
const RE_MU_HOOKS_G   = new RegExp(`(?<![\\w.µ])${MU_HOOKS_BODY}`, 'g')
const RE_MU_DERIVED_G = new RegExp(`(?<![\\w.µ])${MU_DERIVED_BODY}`, 'g')
const RE_MU_EVERY_G   = new RegExp(`(?<![\\w.µ])${MU_EVERY_BODY}`, 'g')
// sucre universel µfoo → µ.foo (runes hors liste blanche MU_SHORT_BODY — µraw/µsnap/
// µplay/µminmax/µinspect, mjs_rare_runes.ts) : même garde de tête que les RE_MU_*_G
// ci-dessus, corps PARTAGÉ avec le script (transpiler/index.ts, MU_UNIVERSAL_RE).
const RE_MU_UNIVERSAL_G     = new RegExp(`(?<![\\w.µ])${MU_UNIVERSAL_BODY}`, 'g')
// remodelage d'arguments de µ.inspect/µ.minmax — mêmes corps que le script (aucune
// garde de tête supplémentaire : ils ciblent la forme DÉJÀ pointée `µ.inspect`/
// `µ.minmax`, avec leurs propres gardes internes).
const RE_MU_INSPECT_ARG_G   = new RegExp(MU_INSPECT_ARG_BODY, 'g')
const RE_MU_MINMAX_ARG_PAREN_G = new RegExp(MU_MINMAX_ARG_PAREN_BODY, 'g')

// Applique `fn` uniquement aux segments de CODE (hors littéraux '…', "…", `…`).
// Les regex de sucre ne doivent JAMAIS réécrire le contenu des chaînes :
// avant, `'this is fine'` devenait `'this === fine'` et `' and yet '`
// → `' && yet '` (corruption silencieuse de tout texte anglais).
function mapCodeSegments(src: string, fn: (code: string) => string): string {
  let res = ''
  let i = 0
  const n = src.length
  let codeStart = 0
  while (i < n) {
    const ch = src[i]
    if (ch === '"' || ch === "'") {
      // Chaîne littérale inerte : copiée verbatim (aucun sucre à l'intérieur).
      res += fn(src.slice(codeStart, i))
      let j = i + 1
      while (j < n && src[j] !== ch) { if (src[j] === '\\') j++; j++ }
      const end = Math.min(j + 1, n)
      res += src.slice(i, end)
      i = end
      codeStart = i
    } else if (ch === '`') {
      // Template literal : le TEXTE est inerte, mais chaque `${…}` contient
      // du CODE qui doit passer par le sucre (sinon `` `hi ${$x}` `` laisse `$x`
      // nu → ReferenceError). On récurse via mapCodeSegments sur le contenu du
      // `${…}` (pour re-découper ses propres chaînes correctement).
      res += fn(src.slice(codeStart, i))
      res += '`'
      let j = i + 1
      while (j < n && src[j] !== '`') {
        if (src[j] === '\\') { res += src[j] + (src[j + 1] ?? ''); j += 2; continue }
        if (src[j] === '$' && src[j + 1] === '{') {
          // comptage des `{}` CONSCIENT des chaînes : sans ça,
          // un `}` littéral dans une chaîne de la fenêtre (`` `hi ${fn('}')}` ``)
          // décrémentait `depth` et fermait trop tôt (fin réelle copiée
          // verbatim hors zone traitée par `fn`) — même modèle qu'interpolateSigils
          // (lexer/index.ts:91-123, LE modèle à suivre).
          let k = j + 2, depth = 1, inner = ''
          let inStr = false
          let strCh = ''
          while (k < n && depth > 0) {
            const c = src[k]
            if (inStr) {
              if (c === '\\') { inner += c + (src[k + 1] ?? ''); k += 2; continue }
              if (c === strCh) inStr = false
            } else if (c === '"' || c === "'" || c === '`') { inStr = true; strCh = c }
            else if (c === '{') depth++
            else if (c === '}') { depth--; if (depth === 0) break }
            inner += c
            k++
          }
          res += '${' + mapCodeSegments(inner, fn) + '}'
          j = k + 1
        } else {
          res += src[j]
          j++
        }
      }
      if (j < n) res += '`'
      i = j + 1
      codeStart = i
    } else if (ch === '/' && src[i + 1] !== '/' && src[i + 1] !== '*' && ouvreUneRegex(src.slice(0, i))) {
      // littéral regex `/…/` : ZONE INERTE comme une chaîne — sans ce garde-fou, `/§/` levait la
      // garde « § nu » et `/µTotal/` sortait réécrit `/µ.Total/` EN PLEIN MILIEU du littéral.
      // `src[i + 1] !== '/'/'*'` écarte D'ABORD un commentaire (`//`/`/*`, jamais
      // masqués ICI — hors périmètre de ce correctif, cf. sansCommentaires) : un `/*…*/` pris pour
      // une regex s'arrêterait au premier `/` interne, pas à son vrai `*/`. `scanRegexLiteral`
      // rend -1 si aucun `/` fermant n'apparaît avant la fin de ligne (une division ne se referme
      // jamais) : ce `/` retombe alors sur le `i++` générique, code normal.
      const fin = scanRegexLiteral(src, i)
      if (fin === -1) { i++ }
      else { res += fn(src.slice(codeStart, i)); res += src.slice(i, fin); i = fin; codeStart = i }
    } else {
      i++
    }
  }
  res += fn(src.slice(codeStart))
  return res
}

// Setters de contexte `§x = …`/`§§x = …` — AVANT le découpage des chaînes
// (mapCodeSegments) et communs aux DEUX moteurs (passe SYMBOLES, toujours
// appliquée) : sinon un RHS chaîne littérale (`§§lang = 'fr'`) est
// isolé par mapCodeSegments et le setter capture vide → `_mjs_setRCtx('lang',
// )'fr'` (SyntaxError). On les traite ici sur la source ENTIÈRE (comme le
// lexer pour les scripts) ; le RHS reste brut, ses sigils sont convertis
// ensuite par `applySymbolRegex`/la passe grammaire.
function applyContextSetters(raw: string, _externalVars: string[]): string {
  return raw
    .replace(/(?<![\w.§])§§([a-zA-Z_][a-zA-Z0-9_$]*)\s*=(?!=|>)\s*(.+?)(?=\n|;|$)/g,
      (_m: string, name: string, expr2: string) => `this._mjs_setRCtx('${name}', ${expr2})`)
    .replace(/(?<![\w.§])§([a-zA-Z_]\w*)\s*=(?!=|>)\s*(.+?)(?=\n|;|$)/g,
      (_m: string, name: string, expr2: string) => `this._mjs_setContext('${name}', ${expr2})`)
}

// Passe GRAMMAIRE — idiomes Coffee/Civet historiques, traduits par regex.
// Chemin `templateLang: 'js'` (repli) UNIQUEMENT : en 'civet', cette
// traduction est déléguée à une VRAIE compilation Civet (cf.
// compileGrammarViaCivet plus bas), qui comprend nativement ces mêmes
// idiomes sans repasser par ces regex.
function applyGrammarRegex(seg: string): string {
  let res = seg

  // Coffee thin arrow `->` → JS arrow `=>`. Couvre les expressions inline
  // dans les blocs flow ({for X in $.list.filter (t) -> not t.done}, etc.)
  // où le user écrit du Coffee. Le lookbehind exclut aussi `-` : sinon
  // `$count-->0` (post-décrément) devenait `$count-=>0`.
  res = res.replace(/(?<![=-])->/g, '=>')

  // not / and / or — d'abord car `not` peut affecter les comparaisons qui suivent.
  // Lookahead `(?!\s*[:)\]},;])` : ne PAS transformer quand le mot est une CLÉ
  // d'objet (`{is: 1}`, `{not: 2}`) ou un identifiant isolé (`foo(is)`, `[and]`) —
  // seulement en position d'opérateur. Sans ça, `{is:1,not:2}` → `{===:1,!:2}` (invalide).
  //
  // Analyse du corpus réel (429 fixtures tuto/doc capturées
  // dans tests/snapshots/, via tests/snapshot-stats.mjs) — `not $x`
  // (espace naturel après le mot) devenait `! $x` : l'espace SURVIT au
  // remplacement (seul le mot `not` est substitué par le caractère `!`).
  // CoffeeScript tolère `! x` (opérateur unaire espacé) mais Civet rejette
  // net (« Failed to parse » — vérifié empiriquement, 4 tutos réels cassés :
  // tuto-13-13-7-bindings-instances, tuto-14-14-1/14-2 transitions/animations,
  // tuto-8-8-1 directive-attach, tous des `not $x`/`not item.x` dans un
  // handler inline ou un `{for}.filter`). On consomme aussi l'espace/tab
  // suivant (`[ \t]*`, jamais `\s*` — ne PAS avaler un saut de ligne, qui
  // décalerait les positions dans une grammaire sensible à l'indentation) :
  // `!x` collé reste valide JS/Coffee/Civet dans tous les cas.
  res = res.replace(/(?<![\w.\$])not\b(?!\s*[:)\]},;])[ \t]*/g, '!')
  res = res.replace(/(?<![\w.\$])and\b(?!\s*[:)\]},;])/g, '&&')
  res = res.replace(/(?<![\w.\$])or\b(?!\s*[:)\]},;])/g, '||')

  // `a is b` / `a isnt b` → `===` / `!==` (équivalent Coffee générique)
  res = res.replace(/(?<![\w.\$])\bis\b(?!\s*[:)\]},;])/g, '===')
  res = res.replace(/(?<![\w.\$])\bisnt\b(?!\s*[:)\]},;])/g, '!==')

  // unless cond → !(cond) ; MAIS `expr unless cond` (postfix, idiome Coffee/
  // Civet natif : « fais expr sauf si cond ») doit envelopper le préfixe, pas
  // juste la partie après « unless » — sinon le préfixe intact + le `!(cond)`
  // produit du JS juxtaposé invalide (`$n++ unless
  // $locked` → `$.n++ !($.locked)`, SyntaxError).
  // Forme émise : `(!(cond) && (pre))` — VALIDE en JS ET en CoffeeScript
  // (cleanJs alimente AUSSI les inlines d'événements
  // recompilés en Coffee, où le ternaire `?:` et `void` n'existent pas → tout
  // handler `@event={… unless …}` échouait à la compilation). `pre` s'exécute
  // (effet) seulement si cond est faux, exactement comme le ternaire ; la
  // valeur devient `false` (vs `undefined`) quand cond vrai — sans usage connu.
  // Capture un préfixe optionnel (non-greedy, borné au segment de code
  // COURANT — un préfixe qui traverse une chaîne littérale voisine, coupée
  // par mapCodeSegments en un autre segment, n'est pas couvert : limite
  // assumée).
  res = res.replace(/^([\s\S]*?)(?<![\w.\$])unless\s+(.+)$/, (_m, prefix, cond) => {
    const pre = prefix.trim()
    return pre ? `(!(${cond}) && (${pre}))` : `!(${cond})`
  })

  return res
}

// Passe SYMBOLES — sucre MJS ($x/@x/§x/µXxx/µread…), TOUJOURS appliquée quel
// que soit templateLang : sa sortie est du Civet valide par construction
// (accès `.`, `this.x`, `µ.foo` — de simples identifiants/membres, cf.
// header). C'est le chemin GRAMMAIRE qui bifurque, jamais celui-ci.
// sansCommentaires — texte JETABLE (jamais émis) pour les GARDES qui REFUSENT une
// forme. mapCodeSegments masque les chaînes, pas les commentaires : un `µevery` ou un
// `µread(` simplement CITÉ dans un `//…` faisait échouer le build (les commentaires
// inline sont la norme du projet).
//
// Ne neutralise QUE des LIGNES DE COMMENTAIRE ENTIÈRES — première chose non blanche de
// la ligne = `//` ou `/*`. Volontairement plus étroit qu'un `replace` de tout `//…` :
// un littéral REGEX finissant par un
// slash échappé collé au délimiteur (`/http:\/\//`, motif banal pour une URL) fabrique
// un `//` FANTÔME — la version large effaçait alors la fin de la ligne, garde aveugle,
// et un `µread(compteur)` malformé repartait dans le JS émis. Build vert, ReferenceError
// au clic : la régression était PIRE que le faux refus qu'elle corrigeait.
// Un `//` ou un `/*` en TÊTE de ligne, lui, ne peut PAS être un regex (JS lirait déjà un
// commentaire), donc aucun faux négatif possible par ce chemin. Reste hors périmètre le
// commentaire de FIN de ligne (`a = 1  // µread(x)`) : encore refusé — un faux refus, du
// bon côté de l'erreur.
function sansCommentaires(code: string): string {
  const lignes = code.split('\n')
  const out: string[] = []
  for (let i = 0; i < lignes.length; i++) {
    const nu = lignes[i].trimStart()
    if (nu.startsWith('//')) { out.push(''); continue }
    if (nu.startsWith('#') && !nu.startsWith('#{')) { out.push(''); continue }   // commentaire Coffee (handlers en templateLang js), jamais `#{…}` d'interpolation
    if (nu.startsWith('/*')) {
      // On cherche la FERMETURE avant d'effacer quoi que ce soit. Un drapeau « on est
      // dans un bloc » qui reste collé faute de `*/` effacerait tout le reste du segment
      // — garde aveugle sur des dizaines de lignes de vrai code. Sans fermeture, on ne
      // neutralise RIEN : un commentaire jamais fermé
      // est du code cassé de toute façon, et refuser est le bon côté de l'erreur.
      let j   = i
      let fin = lignes[i].indexOf('*/', lignes[i].indexOf('/*') + 2)
      while (fin < 0 && j + 1 < lignes.length) { j++; fin = lignes[j].indexOf('*/') }
      if (fin < 0) { out.push(lignes[i]); continue }
      for (let k = i; k < j; k++) out.push('')
      out.push(lignes[j].slice(fin + 2))
      i = j
      continue
    }
    out.push(lignes[i])
  }
  return out.join('\n')
}

function applySymbolRegex(seg: string, externalVars: string[]): string {
  let res = seg

  // `@@` AVANT `@name` : sinon le 2e `@` de `@@x` était capturé par la
  // règle `@name` (son lookbehind « pas un mot » est satisfait par `@`)
  // → sortie `@this.x` au lieu de `_mjsThis.x`.
  res = res.replace(/(?<![\w.])@@/g, '_mjsThis.')

  // `µread $x`/`µwrite $x` (et statisation $$ : `µread $$x`/`µwrite $$x` →
  // accès BRUT au store, groupe 1 = '$') — DOIT passer ICI, AVANT la règle
  // `$$x → µ.store.x` juste en dessous : sinon celle-ci consomme le `$$x`
  // de `µread $$x` la première (aucun garde ne l'en empêche, son lookbehind
  // `$` n'exclut pas un `µread ` précédent), laissant `µread µ.store.x`
  // littéral dans le JS final → `ReferenceError: µread is not defined`.
  // Même raisonnement pour `µread $x`/la règle générique `$x → $.x` (plus
  // bas) — parité lexer (règle 3.5) PAR CONSTRUCTION (corps sigils.ts).
  // Parenthèses OPTIONNELLES : `µread($x)` puis `µread $x` — parité lexer
  // (règle 3.5) PAR CONSTRUCTION, corps partagés sigils.ts. Ce qui survit aux deux
  // est une faute de forme, refusée bruyamment plutôt que laissée littérale.
  // µevery : timer POSÉ AU SETUP (file de montage du composant) — hors d'un <script>,
  // elle n'a personne à qui s'accrocher, et finirait en ReferenceError muet. Garde-fou
  // explicite comme µderived, mais testé HORS COMMENTAIRES (cf. sansCommentaires).
  RE_MU_EVERY_G.lastIndex = 0
  if (RE_MU_EVERY_G.test(sansCommentaires(res))) throw new Error(t('generator.every-hors-script'))

  // hooks de cycle de vie (µmount & co) et µderived : réservés au <script> — dans une
  // interpolation ou un handler, erreur claire plutôt qu'un ReferenceError cryptique au
  // runtime. Testés ICI, HORS COMMENTAIRES et AVANT toute la chaîne de sucre (donc a
  // fortiori avant µ-short, cf. µurlChange ⊃ µurl) : posés en `.replace` levant au milieu
  // de la chaîne, ils faisaient échouer le build sur un `// hook : µmount -> foo`
  // simplement CITÉ — même trou que µevery, corrigé du même geste.
  RE_MU_HOOKS_G.lastIndex = 0
  const hookCite = RE_MU_HOOKS_G.exec(sansCommentaires(res))
  if (hookCite) throw new Error(t('generator.hook-cycle-vie-interpolation', { nom: hookCite[1] }))
  RE_MU_DERIVED_G.lastIndex = 0
  if (RE_MU_DERIVED_G.test(sansCommentaires(res))) throw new Error(t('generator.derived-hors-script'))

  const rawAccessOut = (_m: string, dollar: string, name: string) =>
    (dollar ? RAW_ACCESS_STORE_OUT : RAW_ACCESS_OUT) + name
  res = res.replace(RE_RAW_ACCESS_PAREN_G, rawAccessOut).replace(RE_RAW_ACCESS_G, rawAccessOut)

  // µwrite $x, v / µwrite($x, v) — corps arrêtés à la virgule (sigils.ts, RAW_WRITE_BODY) :
  // `v` n'est jamais capturé, il continue tel quel dans `res`. Forme parenthésée : une
  // parenthèse ouvrante FRAÎCHE remplace `µwrite(`, la fermante d'origine (non consommée)
  // referme celle-là.
  const rawWriteParenOut = (_m: string, dollar: string, name: string) =>
    RAW_WRITE_PAREN_OUT_OPEN + (dollar ? RAW_ACCESS_STORE_OUT : RAW_ACCESS_OUT) + name + ' = '
  const rawWriteOut = (_m: string, dollar: string, name: string) =>
    (dollar ? RAW_ACCESS_STORE_OUT : RAW_ACCESS_OUT) + name + ' = '
  res = res.replace(RE_RAW_WRITE_PAREN_G, rawWriteParenOut).replace(RE_RAW_WRITE_G, rawWriteOut)

  // Ancienne forme `µwrite $x = v` / `µwrite($x) = v` (RETIRÉE) : message dédié
  // AVANT la garde générique, plutôt que le message générique moins actionnable.
  RE_RAW_WRITE_OLD_FORME_PAREN_G.lastIndex = 0
  RE_RAW_WRITE_OLD_FORME_G.lastIndex = 0
  if (RE_RAW_WRITE_OLD_FORME_PAREN_G.test(sansCommentaires(res)) || RE_RAW_WRITE_OLD_FORME_G.test(sansCommentaires(res))) throw rawWriteAncienneFormeError()

  RE_RAW_ACCESS_MALFORME_G.lastIndex = 0
  if (RE_RAW_ACCESS_MALFORME_G.test(sansCommentaires(res))) throw rawAccessFormeError()

  // &$x / $$x / §§x / @x
  // &$x → µ.vault.x (store GLOBAL réactif, zéro import) — DOIT passer AVANT
  // la règle $x, sinon le `$` de `&$x` serait capturé (→ `&$.x`).
  res = res
    .replace(/(?<![\w.])&\$([a-zA-Z_][a-zA-Z0-9_$]*)/g, (_m: string, name: string) => { throw vaultRemovedError(name) })
    // &xxx → µ.url.params.xxx : PARAM DE ROUTE, lecture réactive. Même
    // désambiguïsation que le lexer (cf. lexer/index.ts §3.1c), en regex :
    //   • lookbehind : `&` PAS précédé d'un opérande (mot/`)`/`]`/guillemet/
    //     backtick), ni d'un autre `&` (→ `&&`), ni d'un `.` (member-access) ;
    //   • lookahead `(?![\w;])` : identifiant MAXIMAL et PAS une entité HTML
    //     (`&amp;` finit par `;` → non-match, sans backtracking).
    .replace(/(?<![\w)\]"'\x60&.])&([a-zA-Z_]\w*)(?![\w;])/g,
      (_m: string, name: string) => `µ.url.params.${name}`)
    .replace(/(?<![\w.])\$\$([a-zA-Z_][a-zA-Z0-9_$]*)/g, (_m: string, name: string) => {
      // Un singleton importé (`$X` ∈ externalVars, via `@import µ$$X`) se
      // consomme en `µ$$X`, pas en `$$X` (= store GLOBAL, autre espace).
      if (externalVars.includes(`$${name}`)) throw importedSingletonError(name)
      return `µ.store.${name}`
    })
    // §§X : TOUJOURS le contexte RÉACTIF de sous-arbre (plus aucune résolution
    // vers un singleton importé, cf. applyContextSetters) — setter `§§foo = expr`
    // → `_mjs_setRCtx`, getter `§§foo` → `_mjs_getRCtx` (remonte l'arbre + abonne).
    // §§ getter (le setter `§§x = …` est traité en pré-passe, cf. applyContextSetters)
    .replace(/(?<![\w.§])§§([a-zA-Z_][a-zA-Z0-9_$]*)/g, (_m: string, name: string) =>
      `this._mjs_getRCtx('${name}')`)
    .replace(/(?<![\w.@])@([a-zA-Z_][a-zA-Z0-9_$]*)/g, 'this.$1')
    // µXxx (PascalCase) → µ.Xxx et µurl/µonline/µvisible/µready/µserver + les
    // fabriques temps réel µsocket/µsmooth → µ.* : formes courtes des objets
    // framework, mêmes règles que le lexer (§3.8b/3.8c) PAR CONSTRUCTION
    // (corps sigils.ts). La forme déjà pointée (`µ.Router`, `µ.url`) ne
    // matche pas : il faut une lettre collée à `µ`.
    .replace(RE_MU_PASCAL_G, 'µ.$1')
    .replace(RE_MU_SHORT_G, 'µ.$1')
    // µlang → µ.store.__mjsLang (langue courante, clé store cachée) — même
    // sucre que le lexer (§3.8d), corps partagé sigils.ts.
    .replace(RE_MU_LANG_G, MU_LANG_OUT)
    // µtheme → µ.store.__mjsTheme — même sucre que le lexer (§3.8e), CALQUE de µlang.
    .replace(RE_MU_THEME_G, MU_THEME_OUT)
    // sucre universel µfoo → µ.foo — runes minuscules HORS liste blanche ci-dessus
    // (µraw/µsnap/µplay/µminmax/µinspect, mjs_rare_runes.ts) : AVANT ce filet, elles
    // ressortaient littérales dans le JS final (`µraw is not defined` au premier
    // rendu, repro `weatherData={µraw(result)}` en branche `{success result}`).
    // MÊME garde que le script (transpiler/index.ts, MU_UNIVERSAL_RE, corps partagé
    // sigils.ts) : un `µfoo` INCONNU (ni ci-dessus, ni sur `µ` au runtime) est pointé
    // quand même — échoue en `µ.foo is not a function` à l'EXÉCUTION, jamais à la
    // compilation, comportement IDENTIQUE aux deux moteurs (parité assumée, pas une
    // validation nouvelle). `µasset`/`µimage` DEVIENNENT AUSSI `µ.asset`/`µ.image` ici
    // (aucune exclusion pour eux, exactement comme dans le script) — sans danger : leur
    // RÉSOLUTION reste un mécanisme séparé (bundler, preResolveAssets/resolveMagicAssets)
    // dont les regex (ASSET_RE, ASSET_CALL_RE, IMAGE_CALL_RE) acceptent déjà LES DEUX
    // formes, pointée ou non (vérifié empiriquement). Un composant qui les MENTIONNE dans
    // une chaîne ou un commentaire reste hors de portée, comme pour PASCAL/SHORT ci-dessus
    // (`mapCodeSegments` a déjà isolé les chaînes).
    .replace(RE_MU_UNIVERSAL_G, 'µ.$1')
    // µ.inspect($x) → µ.inspect('x') et µ.minmax($x, min, max) →
    // µ.minmax(_mjsThis, 'x', min, max) : remodelage d'arguments identique au script
    // (transpiler/index.ts), sans quoi le préfixe pointé ci-dessus suffirait à éviter
    // le ReferenceError mais appellerait le runtime avec un typage difforme (clé
    // manquante, instance absente).
    .replace(RE_MU_INSPECT_ARG_G, MU_INSPECT_ARG_OUT)
    .replace(RE_MU_MINMAX_ARG_PAREN_G, MU_MINMAX_ARG_PAREN_OUT)

  // $x → $.x sauf si ∈ externalVars (singleton importé : garde `$x`, sa forme
  // compilée). La FAUTE de consommation `$x` au lieu de `µ$$x` est détectée en
  // amont par le lint singleton (sur le code SOURCE du dev), pas ici — cette
  // passe tourne aussi sur du code déjà transformé (double-passe analyzer).
  // `µread $x` / `µwrite $x` (et `$$x`) déjà consommés tout en tête de cette
  // fonction — cf. commentaire là-bas pour le pourquoi de l'ordre.

  // Snapshot `$xxx =: expr` → `$.xxx = µ.snap(expr)` (parité lexer §3.7,
  // incohérence — le lexer gère `=:` dans <script>,
  // cleanJs (interpolations `{...}`/`@x={...}`) l'ignorait, laissant un
  // `=:` littéral dans le JS final → SyntaxError). Contrairement au lexer
  // (dont la sortie repasse par Civet, qui accepte l'appel Coffee « nu »
  // `µ.snap expr`), la sortie de cleanJs est du JS FINAL non re-compilé :
  // parenthèses explicites obligatoires ici. Portée : toute l'expression
  // jusqu'à `;`/fin de ligne/fin de segment (même convention que le
  // pré-passe §x=/§§x= plus haut) — DOIT précéder la règle générique
  // `$x → $.x` juste en dessous, et tourne après le bloc $$/§§ ci-dessus
  // (garantit qu'un `$` restant ici est bien SIMPLE, jamais la queue d'un
  // `$$xxx` déjà consommé).
  res = res.replace(/(?<![\w.\$])\$([a-zA-Z0-9_]+)[ \t]*=:[ \t]*(.+?)(?=\n|;|$)/g,
    (_m, name, valueExpr) => {
      const varName = `$${name}`
      const prefix = externalVars.includes(varName) ? varName : `$.${name}`
      return `${prefix} = µ.snap(${valueExpr})`
    })

  // Garde-fou JUMEAU de la règle 3.8-pré du lexer (src/lexer/index.ts) — même
  // collision `$xxx := expr`, ici côté GÉNÉRATEUR : une expression de template
  // (handler `@click={…}`, tête de {for}, callback @transition — les sites
  // FRAGMENT qui passent par `cleanJs`, PAS `tokenize()`) n'est JAMAIS vue par
  // le lexer. Sans ce garde-fou, la règle `$x → $.x` juste en dessous
  // réécrirait silencieusement en `$.x := expr` — que Civet compile SANS
  // broncher en `const $.x = expr` (cible non-identifiant d'un `const` : JS
  // invalide, mais Civet ne valide pas cette contrainte EN POSITION
  // STATEMENT, seul cas où `:=` est syntaxiquement permis) — filé TEL QUEL
  // dans le bundle, aucun throw (découvert via transpileFile sur `@click={$x
  // := 2}` : `const $.x = 2;return $.x` dans le handler compilé).
  // Portée identique à 3.8-pré : seulement si CE `$xxx` serait RÉELLEMENT
  // réécrit par la règle juste en dessous (donc pas pour un $xxx ∈
  // externalVars — singleton importé, identifiant Civet ordinaire, `:=` y
  // reste valide, aucun risque). Les sites EXPRESSION (interpolation {…},
  // valeur d'attribut — cleanJsExpr/compileGrammarViaCivet, expression
  // TOUJOURS enveloppée de parenthèses) n'ont même pas besoin de ce filet :
  // Civet y rejette déjà nativement `:=` (déclaration, pas une expression) —
  // ce garde-fou y transforme juste ce rejet générique en message pédagogique.
  res = res.replace(/(?<![\w.])\$([a-zA-Z_][a-zA-Z0-9_$]*)[ \t]*:=/g,
    (m: string, name: string, offset: number, full: string) => {
      const varName = `$${name}`
      if (externalVars.includes(varName)) return m
      const preview = full.slice(offset + m.length).match(/^[ \t]*([^\n;]*)/)?.[1]?.trim() || '...'
      throw new Error(t('lexer.symbole-declare-civet', { varName, preview }))
    })

  res = res.replace(/(?<![\w.])\$([a-zA-Z_][a-zA-Z0-9_$]*)/g, (_m, name) => {
    const varName = `$${name}`
    return externalVars.includes(varName) ? varName : `$.${name}`
  })

  // § getContext (le setter `§x = …` est traité en pré-passe, cf. applyContextSetters)
  res = res.replace(
    /(?<![\w.§])§([a-zA-Z_]\w*)/g,
    (_m, name) => `this._mjs_getContext('${name}')`
  )

  // §/§§ NU (non suivi d'un nom) : survécu à applyContextSetters ET aux deux réécritures
  // ci-dessus (aucune ne consomme un §/§§ sans identifiant collé derrière) — refus explicite
  // plutôt qu'un caractère qui atteint Civet tel quel (message cryptique). Testé HORS
  // COMMENTAIRES (cf. sansCommentaires, même garde que RE_RAW_ACCESS_MALFORME_G plus haut) :
  // mapCodeSegments a déjà isolé les chaînes en amont, `res` ne peut donc plus en contenir.
  RE_BARE_SECTION_G.lastIndex = 0
  const bareSection = RE_BARE_SECTION_G.exec(sansCommentaires(res))
  if (bareSection) throw bareSectionError(bareSection[0])

  return res
}

// cleanJs : sucre MJS + idiomes Coffee/Civet courants → JS standard
//   - Runes : $$ / §§ / @ / @@ / § / $
//   - Coffee/Civet : not / and / or / is / isnt / unless / -> (thin arrow)
//
// Moteur HISTORIQUE inchangé (regex bout en bout) — utilisé pour le repli
// `templateLang: 'js'` ET pour tous les sites FRAGMENT (cf. header). Pour les
// sites EXPRESSION en `templateLang: 'civet'` (défaut), voir `cleanJsExpr`.
export function cleanJs(expr: string | null | undefined, externalVars: string[] = []): string {
  // µtoggle(…) EN TÊTE (à l'inverse de µimport, passe finale) : la rune rend une
  // AFFECTATION en syntaxe MJS (`$x = (…)`) — ce sont les passes qui suivent qui
  // la transforment en setter réactif. Sa place est donc avant elles, pas après.
  const raw = rewriteMuToggle((expr ?? '').toString().trim(), 'interpolation {…}/handler')
  const pre = applyContextSetters(raw, externalVars)
  const out = mapCodeSegments(pre, (seg) => applySymbolRegex(applyGrammarRegex(seg), externalVars))
  // µimport('chemin.js') / mjsimport('chemin.js') → µ._mjs_import(µasset('chemin.js'))
  // passe FINALE, sur `out` COMPLET : `mapCodeSegments` isole déjà les
  // chaînes littérales AVANT d'appeler `applySymbolRegex` par segment — or
  // l'argument de µimport EST une chaîne littérale, invisible à un `.replace()`
  // niché DANS ce découpage. rewriteMuImport masque elle-même chaînes/
  // commentaires — source unique sigils.ts, partagée avec
  // le moteur script (applyMjsSugarToScript, transpiler/index.ts).
  return rewriteMuImport(out, 'interpolation {…}/handler')
}

// Symboles SEULS (sans grammaire) — sortie civet-valide, grammaire Coffee/
// Civet (not/and/or/is/isnt/unless/->) laissée INTACTE pour que la vraie
// compilation Civet la traite ensuite (compileGrammarViaCivet) — `isnt` n'est
// PAS compris nativement par Civet (miscompile silencieux en `a(isnt(b))`),
// il y est normalisé en `is not` avant compilation, cf. compileGrammarViaCivet.
function cleanJsSymbolsOnly(expr: string | null | undefined, externalVars: string[]): string {
  // µtoggle(…) en tête — même raison qu'au-dessus (cleanJs)
  const raw = rewriteMuToggle((expr ?? '').toString().trim(), 'interpolation {…}/handler')
  const pre = applyContextSetters(raw, externalVars)
  const out = mapCodeSegments(pre, (seg) => applySymbolRegex(seg, externalVars))
  // µimport(...) — même passe finale que cleanJs ci-dessus, AVANT la
  // compilation Civet de la grammaire (compileGrammarViaCivet, appelant) :
  // `µ._mjs_import(µasset('x.js'))` est un simple appel de fonction, JS/Civet
  // valide par construction, aucune grammaire spéciale à y attendre.
  return rewriteMuImport(out, 'interpolation {…}/handler')
}

// ============================================================================
// cleanJsExpr — passe GRAMMAIRE branchée
// ============================================================================

// Civet chargé en SYNCHRONE via `require` (CJS, `createRequire` depuis ce
// module ESM) — `cleanJs`/`cleanJsExpr` sont appelés en profondeur dans des
// callbacks `.replace()` synchrones (compile.ts, attributes/index.ts) : un
// `await import()` est IMPOSSIBLE à ces call-sites. Chargement PARESSEUX (au
// premier appel civet réel) pour ne rien coûter aux projets `templateLang:
// 'js'` exclusif.
let _civetCompile: ((src: string, opts: Record<string, unknown>) => string) | null = null
function getCivetCompile(): (src: string, opts: Record<string, unknown>) => string {
  if (!_civetCompile) {
    const req = createRequire(import.meta.url)
    _civetCompile = req('@danielx/civet').compile
  }
  return _civetCompile!
}

// Cache mémo module-level : les mêmes expressions (post-passe symboles)
// reviennent des centaines de fois sur un projet réel (ex. `$.active`,
// `$.items.length > 0`…) — évite de rappeler Civet à chaque occurrence.
// Jamais invalidé : fonction PURE de (texte, options Civet FIXES) → (JS),
// aucune raison de rater le cache entre deux composants/compiles.
const civetExprCache = new Map<string, string>()
// Compteur d'appels RÉELS à Civet (cache MISS) — exposé pour les tests
// (préfixé `_`, jamais consommé en prod) : cf. tests/template-civet.test.ts,
// vérifie que 2 composants partageant la même expression ne recompilent pas.
let _civetCompileMisses = 0
export function _civetExprCacheMisses(): number {
  return _civetCompileMisses
}

// Masque chaînes/commentaires par un filler NON-BLANC (`x`) avant de chercher
// un ternaire collé — DUPLIQUÉ volontairement de
// `MASK_STRINGS_AND_COMMENTS_RE`/l'heuristique des handlers inline
// (transpiler/index.ts:1538-1608, hors-périmètre de cette brique — zone déjà
// livrée, on n'y touche pas ; l'importer depuis là créerait en plus un cycle
// transpiler→generator/compile→generator/utils→transpiler). Un filler ESPACE
// ferait disparaître le caractère juste après le `?` (souvent un guillemet,
// `a?'x':'y'`), rendant le motif `\?[^\s?.:]` aveugle à sa propre cible.
const MASK_STRINGS_AND_COMMENTS_RE =
  /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\*[\s\S]*?\*\/|###[\s\S]*?###|\/\/[^\n]*|#[^\n]*/g

// Retire l'UNIQUE couche de parenthèses qu'on vient d'ajouter soi-même pour
// donner à Civet une position d'expression valide (`(${expr})`) — la sortie
// reste ainsi un DROP-IN de l'ancien `cleanJs` (bare expression) pour les
// callers qui l'utilisent en cible d'assignation (bindingStandard, etc.) ou
// la ré-enveloppent eux-mêmes (`(${cleanJsExpr(...)}) ? a : b`, compile.ts).
// Scan conscient des chaînes (un `)` DANS une chaîne, ex. un smiley « :) »,
// ne doit jamais compter comme fermeture) ; ne retire QUE si le PREMIER `(`
// ferme EXACTEMENT sur le DERNIER caractère (un seul groupe enveloppant
// l'expression ENTIÈRE, pas deux groupes juxtaposés `(a)+(b)`). Limite
// assumée : ne traque pas les literals regex (`/…/`) — un `)` à l'intérieur
// d'un tel literal fait décliner le strip (branche `return s`), jamais une
// corruption (l'échec de cette fonction est TOUJOURS du côté sûr :
// parenthèses superflues gardées, jamais du JS cassé).
function stripOuterParens(s: string): string {
  if (s.length < 2 || s[0] !== '(' || s[s.length - 1] !== ')') return s
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch
      i += 1
      while (i < s.length && s[i] !== quote) { if (s[i] === '\\') i += 1; i += 1 }
      continue
    }
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) return i === s.length - 1 ? s.slice(1, -1) : s
    }
  }
  return s
}

// Compile la passe GRAMMAIRE d'une expression déjà nettoyée par la passe
// SYMBOLES (`symbolsCleaned`) via une VRAIE compilation Civet synchrone.
// `rawExprForError` = texte tel qu'écrit par l'utilisateur (avant TOUTE
// passe) — le plus reconnaissable pour un message d'erreur orientant.
function compileGrammarViaCivet(symbolsCleaned: string, rawExprForError: string, moduleName: string | undefined): string {
  const trimmed = symbolsCleaned.trim()
  if (trimmed === '') return trimmed

  // `isnt` (Coffee) → `is not` : Civet ne le connaît pas — il parse `a isnt b` en
  // appel `a(isnt(b))`, miscompile silencieux. même
  // remède que la Pass 2b des <script> (transpiler/index.ts:866), hors chaînes/
  // commentaires (mapCodeSegments), regex prudente calquée sur applyGrammarRegex
  // (`.isnt` propriété intact)
  const normalized = mapCodeSegments(trimmed, (seg) => seg.replace(/(?<![\w.\$])\bisnt\b(?!\s*[:)\]},;])/g, 'is not'))

  const cached = civetExprCache.get(normalized)
  if (cached !== undefined) return cached

  let compiled: string
  try {
    // DRIFT SÉMANTIQUE ASSUMÉ — `coffeeEq: true` fait compiler `==`/`!=` en `===`/`!==`,
    // comme la convention stricte des `<script>` Civet du projet. Par défaut
    // Civet NE fait PAS cette conversion (vérifié par sonde directe :
    // `compile('($.n == 1)', {js:true, sync:true})` renvoie `==` inchangé
    // sans ce flag) — c'est un choix d'harmonisation ASSUMÉ ici, pas un
    // comportement natif Civet. Le repli `templateLang: 'js'` (cleanJs/
    // applyGrammarRegex) NE touche PAS `==` : il reste lâche, aucune
    // régression du repli. Attesté par tests/template-civet.test.ts.
    compiled = getCivetCompile()(`(${normalized})`, {
      js: true,
      sync: true,
      filename: moduleName ? `${moduleName}.expr` : 'mjs-expr',
      parseOptions: { coffeeEq: true },
    })
    _civetCompileMisses += 1
  } catch (err: any) {
    // Erreur orientante — calque le try/catch des handlers inline
    // (transpiler/index.ts:1538+, zone déjà livrée hors-périmètre de cette
    // brique) : même indice ternaire collé (`a?b:c`), même filler non-blanc.
    const civetMsg = err?.message ?? String(err)
    const codeOnly = trimmed.replace(MASK_STRINGS_AND_COMMENTS_RE, (m: string) => 'x'.repeat(m.length))
    const gluedTernaryHint = /\?[^\s?.:]/.test(codeOnly)
      ? t('generator.hint-ternaire-colle')
      : ''
    const moduleHint = moduleName ? t('generator.hint-dans-module', { moduleName }) : ''
    throw new Error(t('generator.interpolation-echec-civet', { moduleHint, rawExprForError, civetMsg, gluedTernaryHint }))
  }

  // Retire le `;`/saut de ligne final éventuel PUIS la parenthèse enveloppante
  // qu'on vient d'ajouter — sortie = expression JS nue, drop-in de cleanJs.
  const result = stripOuterParens(compiled.replace(/;\s*$/, '').trim())
  civetExprCache.set(normalized, result)
  return result
}

// même conversion Coffee `"...#{X}..."` →
// gabarit `` `...${X}...` `` que la Pass 3 du `<script>` (transpiler/index.ts,
// convertCoffeeInterpolations/toTemplateLiteral) — DUPLIQUÉE ici, pas réutilisée : les
// deux fichiers s'importent déjà mutuellement (transpiler/index.ts → generator/state.js
// → generator/utils.js), un import inverse ferait un cycle — transpiler/index.ts reste
// hors périmètre ici, sa propre Pass 3 n'est pas retouchée pour pointer ici.
// Sans cette passe, une interpolation `#{}` DANS une
// expression de template (`{"val: #{$x}"}`) atteint le vrai compilateur Civet SANS avoir
// été convertie : Civet ne comprend PAS `#{}` nativement (seul Coffee le fait) — la
// chaîne compile telle quelle, `$x` reste du texte INERTE dans un Literal JS, jamais
// suivi (cf. docs/03-reactivite.md). Portée VOLONTAIREMENT identique à la Pass 3 :
// double-quote seulement (Coffee n'interpole pas les single-quotes), scan
// contexte-aware (commentaires/chaînes/gabarits natifs intacts).
function toTemplateLiteral(body: string): string {
  return '`' + body.replace(/`/g, '\\`').replace(/\$\{/g, '\\${').replace(/#\{([^}]+)\}/g, '${$1}') + '`'
}
export function convertCoffeeInterpolations(src: string): string {
  let res = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const ch = src[i]
    if (ch === '/' && src[i + 1] === '/') {
      const e = src.indexOf('\n', i)
      const end = e === -1 ? n : e
      res += src.slice(i, end); i = end; continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2)
      const end = e === -1 ? n : e + 2
      res += src.slice(i, end); i = end; continue
    }
    if (src.startsWith("'''", i)) {
      const e = src.indexOf("'''", i + 3)
      const end = e === -1 ? n : e + 3
      res += src.slice(i, end); i = end; continue
    }
    if (ch === "'") {
      let j = i + 1
      while (j < n && src[j] !== "'" && src[j] !== '\n') { if (src[j] === '\\') j++; j++ }
      if (j < n && src[j] === "'") { res += src.slice(i, j + 1); i = j + 1 } else { res += src.slice(i, j); i = j }
      continue
    }
    if (ch === '`') {
      let j = i + 1
      while (j < n && src[j] !== '`') { if (src[j] === '\\') j++; j++ }
      const end = Math.min(j + 1, n)
      res += src.slice(i, end); i = end; continue
    }
    if (src.startsWith('"""', i)) {
      const e = src.indexOf('"""', i + 3)
      if (e === -1) { res += src.slice(i); break }
      const body = src.slice(i + 3, e)
      res += body.includes('#{') ? toTemplateLiteral(body) : src.slice(i, e + 3)
      i = e + 3; continue
    }
    if (ch === '"') {
      let j = i + 1
      while (j < n && src[j] !== '"' && src[j] !== '\n') { if (src[j] === '\\') j++; j++ }
      if (j >= n || src[j] === '\n') { res += src.slice(i, j); i = j; continue }
      const body = src.slice(i + 1, j)
      res += body.includes('#{') ? toTemplateLiteral(body) : src.slice(i, j + 1)
      i = j + 1; continue
    }
    res += ch; i++
  }
  return res
}

// cleanJsExpr : variante « site EXPRESSION » de cleanJs — cf. header pour la
// cartographie complète EXPR vs FRAGMENT. `templateLang`/`moduleName` sont
// transmis par l'appelant depuis `state`/`env.compiler` (CompilerState).
export function cleanJsExpr(
  expr: string | null | undefined,
  externalVars: string[] = [],
  templateLang: 'civet' | 'js' = 'civet',
  moduleName?: string
): string {
  if (templateLang === 'js') return cleanJs(expr, externalVars)
  const raw = (expr ?? '').toString().trim()
  if (raw === '') return raw
  const interpolated = convertCoffeeInterpolations(raw)
  const symbolsCleaned = cleanJsSymbolsOnly(interpolated, externalVars)
  return compileGrammarViaCivet(symbolsCleaned, raw, moduleName)
}

// parse_mixed_string : transforme un raw_val (chaîne avec {expr} interpolés)
// en template literal JS. Chaque `{expr}` est un site EXPRESSION (même
// nature qu'une interpolation texte) → passe par `cleanJsExpr`.
export function parseMixedString(
  rawVal: string,
  externalVars: string[] = [],
  templateLang: 'civet' | 'js' = 'civet',
  moduleName?: string
): string {
  // Cas pur : si tout est dans des braces équilibrées { ... } sans rien autour
  if (rawVal.startsWith('{') && rawVal.endsWith('}')) {
    let balance = 0
    let isPure = true
    for (let i = 0; i < rawVal.length; i++) {
      const c = rawVal[i]
      if (c === '{') balance += 1
      if (c === '}') balance -= 1
      if (balance === 0 && i < rawVal.length - 1) {
        isPure = false
        break
      }
    }
    if (isPure) return cleanJsExpr(rawVal.slice(1, -1), externalVars, templateLang, moduleName)
  }

  let jsEval = ''
  let i = 0
  const n = rawVal.length

  while (i < n) {
    if (rawVal[i] === '{') {
      i += 1
      let expr = ''
      let balance = 1
      let inString = false
      let stringChar: string | null = null

      while (i < n && !(balance === 0 && !inString)) {
        const ch = rawVal[i]

        // échappement en SAUT AVANT (jamais un regard arrière) : un
        // `\\` (antislash ÉCHAPPÉ, deux caractères) juste avant un guillemet
        // faisait croire, avec l'ancien regard arrière (`expr[expr.length-1]
        // !== '\\'`), à un guillemet lui-même échappé → la chaîne n'était
        // jamais refermée, la fenêtre entière avalée. Consomme les DEUX
        // caractères d'un coup, même modèle qu'interpolateSigils
        // (lexer/index.ts:91-123).
        if (inString && ch === '\\') {
          expr += ch + (rawVal[i + 1] ?? '')
          i += 2
          continue
        }

        if (ch === '"' || ch === "'" || ch === '`') {
          if (!inString) { inString = true; stringChar = ch }
          else if (stringChar === ch) { inString = false; stringChar = null }
        }

        if (!inString) {
          if (ch === '{') balance += 1
          if (ch === '}') balance -= 1
        }

        if (balance > 0 || inString) expr += ch
        i += 1
      }

      jsEval += `\${${cleanJsExpr(expr, externalVars, templateLang, moduleName)}}`
    } else {
      const ch = rawVal[i]
      if (ch === '\\') jsEval += '\\\\'
      else if (ch === '`') jsEval += '\\`'
      else jsEval += ch
      i += 1
    }
  }

  // Application du bouclier sur les chaînes mixtes.
  // exiger une lettre/`_` en tête : un `$5` littéral (prix, "5$") n'est PAS
  // une variable et ne doit pas devenir `${$.5}` (SyntaxError). Aligné sur
  // la porte d'aiguillage (`\$[a-zA-Z_]`).
  jsEval = jsEval.replace(/(?<![\w.\$])\$([a-zA-Z_][a-zA-Z0-9_$]*)/g, (_m, name) => {
    const varName = `$${name}`
    return externalVars.includes(varName) ? `\${${varName}}` : `\${$.${name}}`
  })

  return `\`${jsEval}\``
}

// V2 — plus de `getCond`. Les updates n'ont plus de condition `dirty & mask` :
// ils sont enregistrés dans `effectsByVar` indexés par leur liste de deps, et
// le runtime n'invoque que ceux abonnés à la var muée. Les blocs structurels
// (`{if}`, `{for}`, `{await}`, `{key}`) sont émis sans condition aussi —
// regroupés dans `_mjs_renderStruct` qui est rejoué à chaque mutation (coût négligé,
// la structure mute rarement).

// entités HTML NOMMÉES + numériques courantes, table minimale (pas les
// ~2000 entités HTML5 complètes : hors périmètre, cf. appelant).
const NAMED_HTML_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: '\u00A0',
}

// decodeHtmlEntities — même sémantique que le parseur HTML natif pour un attribut
// STATIQUE : le chemin HTML (`staticAttr`, attributes/index.ts) laisse les entités
// telles quelles dans la chaîne injectée (le navigateur les décode LUI-MÊME au parse,
// via innerHTML/`µ._mjs_cloneTpl`) — le chemin DOM (`emitAttrSet`, paths.ts : setAttribute/
// prop directe construits par appel, jamais parsés) ne bénéficie d'AUCUN décodage
// natif, il faut donc le faire ICI, avant `JSON.stringify`. Entités nommées courantes
// + numériques décimales (`&#123;`) et hexadécimales (`&#x7B;`/`&#X7B;`) ; un `&` qui
// n'amorce pas une entité reconnue, ou un nom inconnu, reste intact (jamais de
// décodage agressif qui altérerait un texte contenant un `&` nu).
export function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X'
      const code = isHex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isNaN(code) ? match : String.fromCodePoint(code)
    }
    const named = NAMED_HTML_ENTITIES[body]
    return named !== undefined ? named : match
  })
}
