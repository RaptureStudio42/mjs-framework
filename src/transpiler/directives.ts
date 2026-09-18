// transpiler/directives — extraction et traitement des directives racines (@css, @display, @persist, @import).
// Port de la section directives de la V1 Ruby, transpiler.rb.

import { parseVtValue, suggestKey } from '../bundler/config.js'
import { t } from '../messages/index.js'

export interface PersistEntry {
  var: string
  suffix: string | null
}

export interface DirectivesResult {
  /** Contenu source nettoyé des directives. */
  cleaned: string
  /** Mode de préchargement par défaut de TOUS les liens du module (`@preload`). */
  modulePreload: string | null
  /** Vars persistées dans localStorage. */
  persistLocalVars: PersistEntry[]
  /** Vars persistées dans sessionStorage. */
  persistSessionVars: PersistEntry[]
  /** Imports auto-injectés en haut du module. */
  pendingAutoImports: string[]
  /** Vars `$xxx` importées (à exclure du store local). */
  externalReactives: Set<string>
  /** Section i18n du module (`@i18n 'panier'`) — préfixe les clés `µt(...)`
   *  RELATIVES à la COMPILATION ('clé' → 'panier.clé') ; null si absente
   *  (clés inchangées). Un chemin ABSOLU (`µt('/nav.fermer')`) n'est JAMAIS
   *  préfixé, section ou pas. */
  moduleI18nSection: string | null
  /** Override de rendu i18n pendant le chargement (`@i18nPlaceholder <mode>`,
   *  auto|key|wait) — voyage en 3e argument LITTÉRAL de chaque `µ.t(...)` du
   *  module ; null si absente (2 arguments max, jamais de 3e). */
  moduleI18nPlaceholder: string | null
}

export function extractDirectives(content: string): DirectivesResult {
  let modulePreload: string | null = null
  let moduleI18nSection: string | null = null
  let moduleI18nPlaceholder: string | null = null
  const persistLocalVars: PersistEntry[] = []
  const persistSessionVars: PersistEntry[] = []
  const pendingAutoImports: string[] = []
  const externalReactives = new Set<string>()

  // Les directives racines (`@css`, `@display`, `@persist`, `@import`) peuvent
  // apparaître n'importe où dans le fichier (avant ou après `<style>`/`<script>`/HTML).
  // Pour éviter les faux positifs sur les exemples `@persist $foo` à l'intérieur
  // de `<pre><code>` dans les docs/tutos, on masque ces blocs pendant le scan,
  // puis on les restaure à la fin.
  const masks: string[] = []
  // NONCE — le jeton portait un compteur LITTÉRAL (`\x00MASK0\x00`) :
  // un source qui contenait cette suite exacte se faisait remplacer par le contenu d'un <pre>/<code>/
  // commentaire SANS RAPPORT, ailleurs dans le fichier — corruption silencieuse. Le nonce (aléatoire,
  // tiré à chaque appel) rend la collision inatteignable depuis le source.
  const nonce = Math.random().toString(36).slice(2, 12)
  const mask = (m: string) => {
    masks.push(m)
    return `\x00MASK${nonce}_${masks.length - 1}\x00`
  }
  // les COMMENTAIRES HTML rejoignent <pre>/<code> dans ce masquage.
  // Trou de fond (présent sur @viewTransition, mais commun à TOUTES les
  // directives racines lues ici) : ce scan voyait l'intérieur des commentaires, donc mettre une
  // directive de côté en la commentant — `<!-- @viewTransition={x} -->`, `<!-- @persist $x -->` —
  // la RALLUMAIT (ou, pour les formes relogées, faisait échouer la compilation sur une ligne
  // pourtant neutralisée). Traité ICI, en amont et une seule fois, plutôt que directive par
  // directive : le même remède que <routes> (sections.ts § 3-ter) et que les macros <@…>
  // (macros.ts, processGlobalMacros).
  let cleaned = content
    .replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/gi, mask)
    .replace(/<code\b[^>]*>[\s\S]*?<\/code>/gi, mask)
    .replace(/<!--[\s\S]*?-->/g, mask)

  // ----- @css ----- RELOGÉ : `@css` quitte la racine du fichier,
  // c'est désormais un attribut du `<style>` de base (`<style @css="nom1 nom2">`,
  // cf. sections.ts). La forme racine est une ERREUR DE COMPILATION explicite.
  cleaned = cleaned.replace(/^[ \t]*@css[ \t]+([a-zA-Z0-9_ \t-]+?)[ \t]*$/gm, (_m, names) => {
    const clean = (names as string).trim()
    throw new Error(t('transpiler.css-racine-interdite', { ligne: `@css ${clean}`, remplacement: `<style @css="${clean}">` }))
  })

  // ----- @display ----- RELOGÉ : attribut du `<style>` de
  // base (`<style @display="inline-block">`, cf. sections.ts). Forme racine =
  // erreur de compilation explicite.
  cleaned = cleaned.replace(/^[ \t]*@display[ \t]+([a-zA-Z-]+)[ \t]*$/gm, (_m, val) => {
    throw new Error(t('transpiler.display-racine-interdite', { ligne: `@display ${val}`, remplacement: `<style @display="${val}">` }))
  })

  // ----- @i18n ----- (section i18n du module, préfixe les clés `µt(...)` relatives)
  // `@i18n 'panier'` ou `@i18n "panier"` — section validée /^[a-z0-9_-]+$/
  // (mêmes guillemets simples/doubles que `@import`, cf. plus bas).
  // 2 directives @i18n dans le même module écrasaient la
  // 1ère en silence (`moduleI18nSection` réassigné sans vérif) : erreur de
  // compilation EXPLICITE dès la 2e occurrence.
  cleaned = cleaned.replace(
    /^[ \t]*@i18n[ \t]+['"]([^'"]+)['"][ \t]*$/gm,
    (_m, section) => {
      if (moduleI18nSection !== null) {
        throw new Error(t('transpiler.i18n-double', { ancienneSection: moduleI18nSection, section }))
      }
      if (!/^[a-z0-9_-]+$/.test(section)) {
        throw new Error(t('transpiler.i18n-section-invalide', { section }))
      }
      moduleI18nSection = section
      return ''
    }
  )

  // ----- @i18nPlaceholder ----- (mode de rendu pendant le chargement i18n)
  // `@i18nPlaceholder <mode>` nu, mode ∈ auto|key|wait. `wait` exige une
  // section `@i18n` à attendre (validé après extraction, une fois les deux
  // directives lues quel que soit leur ordre d'écriture dans le fichier).
  cleaned = cleaned.replace(
    /^[ \t]*@i18nPlaceholder[ \t]+([a-zA-Z-]+)[ \t]*$/gm,
    (_m, mode) => {
      if (!['auto', 'key', 'wait'].includes(mode)) {
        throw new Error(t('transpiler.i18n-placeholder-mode-invalide', { mode }))
      }
      moduleI18nPlaceholder = mode
      return ''
    }
  )

  // ----- @preload ----- (défaut de préchargement des liens du module ; niveau 2)
  // Formes acceptées : `@preload on`, `@preload = "hover"`, `@preload="off"`.
  // `eager` n'est plus une valeur : refus explicite qui donne le nom retenu
  cleaned = cleaned.replace(
    /^[ \t]*@preload(?:[ \t]*=)?[ \t]*["']?eager["']?[ \t]*$/gm,
    () => { throw new Error(t('transpiler.preload-eager-renomme', { ou: 'directive racine @preload' })) },
  )
  cleaned = cleaned.replace(
    /^[ \t]*@preload(?:[ \t]*=)?[ \t]*["']?(on|hover|off)["']?[ \t]*$/gm,
    (_m, val) => { modulePreload = val; return '' },
  )

  // ----- @viewTransition ----- RELOGÉ : `@viewTransition` quitte
  // la racine du fichier, c'est désormais un attribut POINTÉ du `<style>` de base
  // (`<style @viewTransition.cube={ dir: left }>`, forme nue → `<style @viewTransition>`,
  // cf. sections.ts, même grammaire `parseVtValue`, bundler/config.ts). L'ALIAS `@vt`
  // reste capturé ICI (racine) pour un message clair, mais n'existe plus comme
  // attribut de `<style>` — cf. sections.ts. Toute forme racine — nue ou à point —
  // est une ERREUR DE COMPILATION explicite qui pointe vers l'attribut. La grammaire
  // des options (dont le rejet du suffixe `:direction` dans le nom) reste validée
  // ICI via `parseVtValue` avant le message de relogement, pour un diagnostic
  // précis même sur une valeur fautive. Les erreurs `off`/`on` explicites et
  // l'ancienne écriture ESPACE restent signalées telles quelles (indépendantes
  // du lieu d'écriture).
  cleaned = cleaned.replace(
    /^[ \t]*@(viewTransition|vt)\b(.*)$/gm,
    (_m: string, directive: string, restRaw: string) => {
      const label = `@${directive}`
      // `@vt` n'est plus un alias sur `<style>` : le remplacement propose TOUJOURS
      // le nom long, sinon le lecteur corrige et retombe aussitot sur une 2e erreur.
      const cible = '@viewTransition'
      const rest  = restRaw.replace(/[ \t]+$/, '')

      // Forme nue : rien après la directive (à l'espace près) → attribut nu.
      if (rest.trim() === '') {
        throw new Error(t('transpiler.viewtransition-racine-interdite', { label, ligne: label, remplacement: `<style ${cible}>` }))
      }

      // Forme à POINT (canonique) : `.<nom>[:dir][={ ... }]`.
      const dotMatch = rest.match(/^\.([a-zA-Z][a-zA-Z0-9-]*(?::(?:left|right|up|down))?)(?:[ \t]*=[ \t]*\{([^}]*)\})?[ \t]*$/)
      if (dotMatch) {
        const nameAndDir = dotMatch[1]
        const optsRaw: string | undefined = dotMatch[2]
        const base = nameAndDir.split(':')[0]
        if (base === 'off') {
          throw new Error(t('transpiler.vt-off-nexiste-pas', { label }))
        }
        if (base === 'on') {
          throw new Error(t('transpiler.vt-on-implicite', { label }))
        }
        // Le suffixe `:direction` n'existe plus, la SEULE façon
        // d'orienter est la clé d'option (`${label}.cube={ dir: left }`).
        if (nameAndDir.includes(':')) {
          throw new Error(t('transpiler.vt-direction-plus-dans-nom', { label, example: `${label}.cube={ dir: left }` }))
        }
        const verbatim = optsRaw !== undefined ? `${nameAndDir}={${optsRaw}}` : nameAndDir
        const parsed = parseVtValue(verbatim)
        // Cast explicite : strictNullChecks:false (tsconfig du projet) désactive le
        // narrowing natif des unions discriminées — cf. le même commentaire dans config.ts.
        if (!parsed.ok) {
          throw new Error(t('transpiler.vt-nom-erreur-parsing', { label, nameAndDir, erreur: (parsed as { ok: false; error: string }).error }))
        }
        throw new Error(t('transpiler.viewtransition-racine-interdite', { label, ligne: `${label}.${verbatim}`, remplacement: `<style ${cible}.${verbatim}>` }))
      }

      // Ancienne écriture (espace, ou `=`/`= "nom"` sans point) — détecte
      // d'abord les littéraux on/off explicites (message dédié, prioritaire).
      const legacyMatch = rest.match(/^(?:[ \t]*=)?[ \t]*["']?([a-zA-Z][a-zA-Z0-9-]*(?::(?:left|right|up|down))?)["']?(?:[ \t]+\d+)?[ \t]*$/)
      const legacyName = legacyMatch ? legacyMatch[1] : null
      if (legacyName === 'off') {
        throw new Error(t('transpiler.vt-off-nexiste-pas', { label }))
      }
      if (legacyName === 'on') {
        throw new Error(t('transpiler.vt-on-implicite', { label }))
      }
      throw new Error(t('transpiler.vt-ancienne-ecriture-remplacee', { label }))
    },
  )

  // ----- @persist avec suffixe `by:` (matché en premier) -----
  cleaned = cleaned.replace(
    /^[ \t]*@persist(?:[ \t]+(session|local):)?[ \t]+(\$[a-zA-Z0-9_]+)[ \t]+by:[ \t]+(.+?)[ \t]*$/gm,
    (_m, scope, varName, suffix) => {
      const target = scope === 'session' ? persistSessionVars : persistLocalVars
      target.push({ var: varName, suffix: suffix.trim() })
      return ''
    }
  )

  // ----- @persist multi-vars sans suffixe ----- (séparateur
  // ESPACE, pas virgule : `@persist $a $b`. Le charset de CAPTURE garde la
  // virgule (elle doit encore matcher la ligne, sinon un @persist écrit à
  // l'ANCIENNE — `@persist $a, $b` — ne serait plus reconnu DU TOUT comme une
  // directive et filerait tel quel dans le HTML, erreur bien plus confuse) :
  // seul le SPLIT change, une virgule résiduelle reste collée à son nom
  // (`$a,`) et échoue déjà le garde-fou de validation existant
  // (`^[a-zA-Z_]\w*$`, cf. buildPersistCode plus bas) — message à jour vers
  // l'espace (messages/fr.ts « persist-nom-invalide »).
  cleaned = cleaned.replace(
    /^[ \t]*@persist(?:[ \t]+(session|local):)?[ \t]+([\$a-zA-Z0-9_,\s]+?)[ \t]*$/gm,
    (_m, scope, vars) => {
      const target = scope === 'session' ? persistSessionVars : persistLocalVars
      const list = vars.split(/[ \t]+/).map((s: string) => s.trim()).filter((s: string) => s.length > 0)
      for (const v of list) target.push({ var: v, suffix: null })
      return ''
    }
  )

  // ----- @import ----- (noms séparés par ESPACE ; le
  // DERNIER token de la ligne reste TOUJOURS le chemin quoté (déjà isolé par
  // sa PROPRE capture `(['"])(.+?)\3` en fin de regex — aucune ambiguïté avec
  // les noms, qui ne portent jamais de guillemets). Garde explicite : une
  // virgule résiduelle entre deux noms (ancienne écriture) est rejetée avec un
  // message orientant vers la nouvelle syntaxe — même esprit que le garde-fou
  // @persist (persist-nom-invalide), mais ICI en amont (import n'a pas de
  // validation par nom en aval comme buildPersistCode).
  // DEUX défauts corrigés ICI :
  // (a) l'ancienne capture `['"](.+?)['"]` acceptait un guillemet d'OUVERTURE
  //     et de FERMETURE différents (pas de backreference) : un chemin délimité
  //     par `'…'` contenant un `"` littéral s'arrêtait au premier `"` rencontré
  //     au lieu du `'` réel de fermeture, tronquant la cible et laissant le
  //     reste fuir dans le HTML (ParseError Civet illisible en aval). Backreference
  //     `\3` posée : le guillemet de fermeture est TOUJOURS le même que l'ouvrant.
  // (b) même une fois (a) posé, `targetPath` s'insère tel quel, SANS échappement,
  //     dans `fromClause` (chaîne DOUBLE-QUOTE) : un `"` littéral dans une cible
  //     `'…'` referme la chaîne prématurément, le texte qui suit devient du code
  //     Civet/JS exécuté au chargement du module (injection prouvée avec
  //     `@import Foo 'x"; globalThis.__PWNED__=1337; "'`). Un guillemet,
  //     un antislash, un retour à la ligne ou un NUL dans la cible est donc
  //     désormais une erreur de compilation explicite, AVANT toute interpolation.
  // DEUX trous en plus de (a)/(b)
  // ci-dessus : cible VIDE (`@import x ''`/`""`) — la capture exigeait avant au moins 1
  // caractère (`.+?`), cette ligne ne matchait pas DU TOUT (ni retirée, ni rejetée) et FUYAIT en
  // texte brut dans le template rendu (_mjs_cloneTpl) ; `.*?` matche maintenant aussi la cible vide,
  // rejetée dans le corps ci-dessous. Et `#{…}`/`${…}`/un backtick DANS la cible : elle
  // s'insère dans `fromClause` (DOUBLE guillemet, cf. plus bas), et la Pass 3 du transpiler
  // (convertCoffeeInterpolations, transpiler/index.ts ~1730) réécrit ensuite `"…#{X}…"` en
  // gabarit — `@import Foo 'x#{1+1}y'` compilait SANS erreur en import mort (spécificateur
  // littéral jamais résolu par Node), et une charge à effet de bord
  // (`#{globalThis.__PWNED__=1337}`) ne rejetait que par accident (ParseError Civet illisible,
  // jamais ce message).
  cleaned = cleaned.replace(
    /^[ \t]*@import\s+(?:(default)\s+)?([a-zA-Z0-9_$,\s]+?)\s+(['"])(.*?)\3[ \t]*$/gm,
    (_m, isDefault, rawVars, _quote, targetPath) => {
      if ((rawVars as string).includes(',')) {
        throw new Error(t('transpiler.import-virgule-interdite', { rawVars: (rawVars as string).trim(), targetPath }))
      }
      if (targetPath === '' || /['"\\\n\0`]|#\{|\$\{/.test(targetPath as string)) {
        throw new Error(t('transpiler.import-cible-invalide', { cible: targetPath }))
      }
      const cleanVars: string[] = rawVars.split(/[ \t]+/).map((s: string) => s.trim()).filter((s: string) => s.length > 0)
      for (const v of cleanVars) {
        if (v.startsWith('$')) externalReactives.add(v)
      }

      const isUrl = /^https?:\/\//.test(targetPath)
      const fromClause = isUrl ? `'${targetPath}'` : `"µasset('${targetPath}')"`
      const importClause = isDefault
        ? `import ${cleanVars[0]} from ${fromClause}`
        : `import { ${cleanVars.join(', ')} } from ${fromClause}`

      pendingAutoImports.push(importClause)
      return ''
    }
  )

  // directive racine mal écrite (`@improt`, `@persit`) = ERREUR — la garde exige
  // la FORME de la directive (cible entre guillemets / variable `$`), pas seulement un mot proche : une ligne
  // de prose qui commence par `@importe` ou `@persil` compile (faux positif prouvé)
  const horsSections = cleaned.replace(/<(script|style|theme)\b[^>]*>[\s\S]*?<\/\1>/gi, (m) => m.replace(/[^\n]/g, ' '))
  for (const m of horsSections.matchAll(/^[ \t]*@([a-zA-Z][a-zA-Z0-9]*)\s+(?:default\s+)?[a-zA-Z0-9_$,\s]+?\s+(['"]).*?\2[ \t]*$/gm)) {
    const nom = m[1]
    if (nom === 'import') continue
    const suggestion = suggestKey(nom, ['import'])
    if (suggestion) throw new Error(t('transpiler.directive-racine-inconnue', { nom, suggestion }))
  }
  for (const m of horsSections.matchAll(/^[ \t]*@([a-zA-Z][a-zA-Z0-9]*)(?:[ \t]+(?:session|local):)?[ \t]+\$[a-zA-Z0-9_]/gm)) {
    const nom = m[1]
    if (nom === 'persist') continue
    const suggestion = suggestKey(nom, ['persist'])
    if (suggestion) throw new Error(t('transpiler.directive-racine-inconnue', { nom, suggestion }))
  }

  // `wait` diffère le premier rendu tant que la section n'est pas chargée —
  // sans section @i18n, rien à attendre. auto/key restent autorisés seuls
  // (ils agissent sur les clés racine, hors scope de section).
  if (moduleI18nPlaceholder === 'wait' && moduleI18nSection === null) {
    throw new Error(t('transpiler.i18n-placeholder-wait-sans-section'))
  }

  // Restaure les blocs <pre>/<code>/commentaires HTML masqués pendant le scan. Boucle, car les
  // masques peuvent s'IMBRIQUER depuis l'ajout des commentaires : `<!-- <pre>x</pre> -->` masque
  // d'abord le <pre>, puis le commentaire AVEC son placeholder dedans — une passe unique laisserait
  // un `\x00MASK0\x00` en clair dans la sortie.
  // Bornée à `masks.length + 1` tours : imbrication réelle = profondeur finie, et un source qui
  // porterait un `\x00MASK…\x00` littéral ne peut pas faire tourner la boucle sans fin.
  const maskRe = new RegExp(`\\x00MASK${nonce}_(\\d+)\\x00`, 'g')
  for (let tour = 0; tour <= masks.length && maskRe.test(cleaned); tour++) {
    maskRe.lastIndex = 0
    cleaned = cleaned.replace(maskRe, (_, i) => masks[+i])
  }

  return {
    cleaned,
    modulePreload,
    persistLocalVars,
    persistSessionVars,
    pendingAutoImports,
    externalReactives,
    moduleI18nSection,
    moduleI18nPlaceholder,
  }
}

// ----------------------------------------------------------------------------
// Génération du code de persistance (CoffeeScript) à appendre au script du
// composant. La var doit déjà être déclarée dans le script user (l'init sert
// de défaut), le stored la remplace seulement si typeof correspond.
// ----------------------------------------------------------------------------
export function buildPersistCode(
  moduleName: string,
  localVars: PersistEntry[],
  sessionVars: PersistEntry[]
): string {
  const tagKeyPrefix = `mjs-${moduleName.toLowerCase()}`
  let code = ''
  const sets: [PersistEntry[], string][] = [
    [localVars, 'localStorage'],
    [sessionVars, 'sessionStorage'],
  ]
  // noms de temporaires UNIQUES par entrée. Le suffixe par nom de var
  // (`_mjs_p_key_a`) règle le cas multi-vars DISTINCTES, mais la MÊME var
  // persistée deux fois (local+session, ou doublon `@persist $a` ×2) recréait la
  // collision `_mjs_p_key_a` ×2 dans le même scope. On désambiguïse UNIQUEMENT
  // les répétitions (`_a`, puis `_a_2`, `_a_3`…) : la 1ʳᵉ occurrence garde
  // `_mjs_p_key_<var>` (compat + lisibilité), les suivantes reçoivent un indice.
  const usedNames = new Set<string>()
  const uniqueClean = (clean: string): string => {
    let name = clean
    let n = 2
    while (usedNames.has(name)) name = `${clean}_${n++}`
    usedNames.add(name)
    return name
  }
  for (const [vars, backend] of sets) {
    for (const entry of vars) {
      const clean = entry.var.replace(/^\$/, '')
      if (clean === '') continue
      // un nom invalide (`@persist $a $b` sans virgule → UNE entrée
      // « $a $b ») fabriquait `_mjs_p_key_a $b` → erreur lexer Civet
      // indéchiffrable (ni @persist ni la var cités). Message clair à la place.
      if (!/^[a-zA-Z_]\w*$/.test(clean)) {
        throw new Error(t('transpiler.persist-nom-invalide', { nomVar: entry.var.trim() }))
      }
      const keyExpr = entry.suffix
        ? `"${tagKeyPrefix}:${clean}:" + (${entry.suffix})`
        : `'${tagKeyPrefix}:${clean}'`
      // `.=` (Civet let) pour les vars locales du bloc — Coffee auto-déclarait,
      // Civet exige la déclaration explicite. `:=` aurait été const → blocant
      // pour le try/catch qui réassigne potentiellement. Les temporaires sont
      // suffixés par le nom UNIQUE (cf. uniqueClean ci-dessus) : sans ça, un nom
      // partagé produisait un second `let _mjs_p_key_…` dans le même scope →
      // « Identifier has already been declared » (bug vécu, régression
      // verrouillée par tests/persist.test.ts). NB : la CLÉ de stockage
      // (`keyExpr`) et la var réactive (`$${clean}`) gardent le nom RÉEL.
      const uname = uniqueClean(clean)
      const keyVar = `_mjs_p_key_${uname}`
      const storedVar = `_mjs_p_stored_${uname}`
      const parsedVar = `_mjs_p_parsed_${uname}`
      code += `\n${keyVar} .= ${keyExpr}\n` +
              `${storedVar} .= ${backend}.getItem(${keyVar})\n` +
              `if ${storedVar}?\n` +
              `  try\n` +
              `    ${parsedVar} := JSON.parse(${storedVar})\n` +
              `    if $${clean} is undefined or typeof ${parsedVar} is typeof $${clean}\n` +
              `      $${clean} = ${parsedVar}\n` +
              `  catch _e\n` +
              `    null\n` +
              `µ.effect => ${backend}.setItem(${keyExpr}, JSON.stringify($${clean}))\n`
    }
  }
  return code
}
