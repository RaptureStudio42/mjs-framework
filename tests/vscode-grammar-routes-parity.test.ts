// PARITÉ GRAMMAIRE ↔ COMPILATEUR pour la table de routes.
//
// Deux lectures indépendantes d'une même ligne de `<routes target="…">` :
//   A. `parseRoutesLines` (src/transpiler/sections.ts) — celle qui fait ÉCHOUER le build ;
//   B. la grammaire TextMate de l'extension VS Code (editors/vscode/syntaxes/…), tokenisée
//      par le VRAI moteur de VS Code (vscode-textmate + vscode-oniguruma).
// Le contrat : la grammaire pose `invalid.illegal.…` EXACTEMENT sur ce que le compilateur
// refuse. Une couleur qui ment une fois se fait ignorer les suivantes — d'où ce banc.
//
// Deux divergences sont VOULUES, et listées nommément plus bas (TOLERE_MUET / HORS_LIGNE) :
// une ligne en cours de frappe ne se peint pas en rouge, et un doublon de chemin est un
// état de TABLE que la grammaire, qui lit ligne par ligne, ne peut pas voir.
//
// Le troisième volet couvre la table CALCULÉE `@routes = {…}` du `<script>`. Elle
// porte le MÊME verdict que le bloc : une écriture se
// peint pareil où qu'elle soit posée. Le compilateur, lui, ne la relit toujours pas — le
// rouge y dit donc « cette route est fautive », pas « le build va échouer ».

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseRoutesLines } from '../src/transpiler/sections.js'

const require    = createRequire(import.meta.url)
const vsctm      = require('vscode-textmate')
const oniguruma  = require('vscode-oniguruma')

const __dirname   = dirname(fileURLToPath(import.meta.url))
const GRAMMAIRE   = join(__dirname, '..', 'editors', 'vscode', 'syntaxes', 'modularjs.tmLanguage.json')
const ONIG_WASM   = require.resolve('vscode-oniguruma/release/onig.wasm')

// ---------------------------------------------------------------------------
// le vrai moteur : oniguruma (wasm) + vscode-textmate, sur la grammaire du dépôt.
// Aucune grammaire satellite : le corps de <routes> et la table calculée n'en
// incluent aucune pour ce qu'on mesure ici (les `invalid.*` sont tous à nous).
// ---------------------------------------------------------------------------
let tokenise: (src: string) => { txt: string, scopes: string[] }[][]

before(async () => {
  await oniguruma.loadWASM(readFileSync(ONIG_WASM).buffer)
  const registry = new vsctm.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (s: string[]) => new oniguruma.OnigScanner(s),
      createOnigString:  (s: string)   => new oniguruma.OnigString(s),
    }),
    loadGrammar: async (scope: string) => scope === 'text.html.modularjs'
      ? vsctm.parseRawGrammar(readFileSync(GRAMMAIRE, 'utf-8'), 'modularjs.tmLanguage.json')
      : null,
  })
  const grammar = await registry.loadGrammar('text.html.modularjs')
  assert.ok(grammar, 'grammaire text.html.modularjs introuvable')
  tokenise = (src) => {
    let state = vsctm.INITIAL
    return src.split('\n').map((ligne) => {
      const r = grammar.tokenizeLine(ligne, state)
      state = r.ruleStack
      return r.tokens.map((t: { startIndex: number, endIndex: number, scopes: string[] }) =>
        ({ txt: ligne.slice(t.startIndex, t.endIndex), scopes: t.scopes }))
    })
  }
})

const jetons      = (src: string) => tokenise(src).flat()
const aDuRouge    = (src: string) => jetons(src).some(t => t.scopes.some(s => s.startsWith('invalid.')))
const scopesDe    = (src: string, txt: string) => jetons(src).filter(t => t.txt === txt).flatMap(t => t.scopes)
const blocRoutes  = (ligne: string) => `<routes target="vue">\n${ligne}\n</routes>`

/** le compilateur refuse-t-il cette ligne ? (une ligne seule, jamais de doublon possible) */
function compilateurRefuse(ligne: string): boolean {
  try { parseRoutesLines(ligne, 'vue'); return false } catch { return true }
}

// ---------------------------------------------------------------------------
// LE CORPUS — une ligne par forme, telle qu'elle s'écrit dans un vrai composant.
// ---------------------------------------------------------------------------
const CORPUS: string[] = [
  // — formes acceptées —
  '  /                     home-page',
  '  /guide                guide-page',
  '  /guide/:id            guide-page',
  '  /a/:x/b/:y            deux-params-page',
  '  /archive/(:an)        archive-page',
  '  /(fr)/docs            docs-page',
  '  /a/(:x)/b             mid-page',
  '  /docs/*               docs-shell',
  '  /*                    not-found-page',
  '  /profil/plus/:onglet  profile-plus-page',
  '  /Majuscule-Licite     ok-page',
  '  /a\tb-page',
  '  /point.dedans         dot-page',
  '  /accentué             accent-page',
  '  # un commentaire de table',
  "  #pas d'espace apres le diese",
  '',
  '     ',
  // — formes refusées —
  '  sans-slash            no-slash-page',
  '  /trois  jetons  ici',
  '  /Majuscule-Refuse     Mauvais-Composant',
  '  /composant            Underscore_Page',
  '  /composant            0-chiffre-devant',
  '  /mauvais/:id-bis      bad-param-page',
  '  /mauvais/:            bad-param-vide-page',
  '  /perdu/*/suite        bad-wildcard-page',
  '  /pas-ferme/(:x        bad-optional-page',
  '  /vide/()              bad-optional-vide-page',
  '  /deux/(:a:b)          bad-optional-double-page',
  '  /trailing             comment-page   # commentaire de fin',
]

/** lignes que le compilateur refuse et que la grammaire laisse VOLONTAIREMENT muettes */
const TOLERE_MUET = new Set<string>([
  // une ligne en cours de frappe (le chemin est là, le composant pas encore) : la peindre
  // en rouge ferait clignoter l'écran à chaque route qu'on ajoute
  '  /en-cours-de-frappe',
])

describe('extension VS Code — parité grammaire ↔ parseRoutesLines', () => {
  it('le rouge de la grammaire tombe exactement là où le compilateur refuse', () => {
    const ecarts: string[] = []
    for (const ligne of [...CORPUS, ...TOLERE_MUET]) {
      const refuse = compilateurRefuse(ligne)
      const rouge  = aDuRouge(blocRoutes(ligne))
      if (refuse === rouge) continue
      if (TOLERE_MUET.has(ligne) && refuse && !rouge) continue
      ecarts.push(`${refuse ? 'REFUSÉE mais pas peinte' : 'ACCEPTÉE mais peinte en rouge'} : ${JSON.stringify(ligne)}`)
    }
    assert.deepEqual(ecarts, [], `écarts de parité :\n  ${ecarts.join('\n  ')}`)
  })

  it('le corpus couvre bien les deux versants (sinon le test ne prouve rien)', () => {
    const refusees = CORPUS.filter(compilateurRefuse)
    assert.ok(refusees.length >= 10, `trop peu de formes refusées dans le corpus : ${refusees.length}`)
    assert.ok(CORPUS.length - refusees.length >= 10, 'trop peu de formes acceptées dans le corpus')
  })

  it('le nom du composant porte entity.name.tag.route sur chaque ligne acceptée', () => {
    const manquants: string[] = []
    for (const ligne of CORPUS) {
      if (compilateurRefuse(ligne)) continue
      const entrees = parseRoutesLines(ligne, 'vue')
      if (!entrees.length) continue                        // commentaire, ligne vide
      const composant = entrees[0][1]
      if (!scopesDe(blocRoutes(ligne), composant).includes('entity.name.tag.route.modularjs'))
        manquants.push(ligne)
    }
    assert.deepEqual(manquants, [], 'composant non peint sur : ' + manquants.join(' | '))
  })

  it('un doublon de chemin reste invisible à la grammaire — écart ASSUMÉ, pas un bug', () => {
    const table = '  /a  a-page\n  /a  autre-page'
    assert.throws(() => parseRoutesLines(table, 'vue'), /.*/, 'le compilateur doit refuser le doublon')
    assert.equal(aDuRouge(`<routes target="vue">\n${table}\n</routes>`), false,
      'la grammaire lit ligne par ligne : elle ne peut pas voir un doublon, et ne doit pas essayer')
  })
})

// ---------------------------------------------------------------------------
// La table CALCULÉE — le MÊME verdict que le bloc.
//
// Avant : la table calculée n'était que STRUCTURÉE (segments reconnus, aucun verdict), au
// motif que le compilateur ne la relit pas. Mais le ROUTEUR, lui, la lit — et ces formes-là
// y sont cassées pareil : `/a/*/suite` avale le reste et n'atteint jamais `suite`,
// `/a/(:x` cherche les caractères `(:x` dans l'URL, `:id-bis` capture sous un nom qu'aucun
// `&param` ne sait relire. Une faute reste une faute là où elle est écrite.
// ---------------------------------------------------------------------------

/** chemins seuls, sans le nom de composant — le verdict attendu vient du compilateur */
const CHEMINS: string[] = [
  // — acceptés —
  '/', '/guide', '/guide/:id', '/a/:x/b/:y', '/archive/(:an)', '/(fr)/docs', '/a/(:x)/b',
  '/docs/*', '/*', '/profil/plus/:onglet', '/Majuscule-Licite', '/point.dedans', '/accentué',
  // — refusés —
  '/perdu/*/suite', '/pas-ferme/(:x', '/mauvais/:id-bis', '/mauvais/:', '/vide/()', '/deux/(:a:b)',
]

describe('extension VS Code — table calculée @routes : le MÊME verdict que le bloc', () => {
  const bloc     = (corps: string) => `<script>\n${corps}\n</script>`
  const calculee = (chemin: string) => bloc([`  @routes =`, `    'vue':`, `      '${chemin}': 'x-page'`].join('\n'))
  const ciblee   = (chemin: string) => bloc(`  @routes['vue']['${chemin}'] = 'x-page'`)

  it('un chemin fautif rougit dans la table calculée exactement comme dans le bloc', () => {
    const ecarts: string[] = []
    for (const chemin of CHEMINS) {
      const refuse = compilateurRefuse(`  ${chemin}  x-page`)
      for (const [ou, src] of [['table calculée', calculee(chemin)], ['ajout ciblé', ciblee(chemin)]] as [string, string][])
        if (aDuRouge(src) !== refuse)
          ecarts.push(`${refuse ? 'FAUTIF mais pas peint' : 'JUSTE mais peint en rouge'} — ${ou} : ${JSON.stringify(chemin)}`)
    }
    assert.deepEqual(ecarts, [], `écarts de verdict :\n  ${ecarts.join('\n  ')}`)
  })

  it('le corpus couvre bien les deux versants (sinon le test ne prouve rien)', () => {
    const fautifs = CHEMINS.filter(c => compilateurRefuse(`  ${c}  x-page`))
    assert.ok(fautifs.length >= 6, `trop peu de chemins fautifs : ${fautifs.length}`)
    assert.ok(CHEMINS.length - fautifs.length >= 10, 'trop peu de chemins justes')
  })

  it('un chemin littéral est tout de même lu segment par segment', () => {
    const src = calculee('/guide/:id/*')
    assert.ok(scopesDe(src, ':id').includes('variable.parameter.route.modularjs'), 'le paramètre :id doit être reconnu')
    assert.ok(scopesDe(src, '*').includes('constant.language.wildcard.route.modularjs'), 'le joker * doit être reconnu')
    assert.ok(scopesDe(src, 'x-page').includes('entity.name.tag.route.modularjs'), 'le composant doit être reconnu')
  })

  it('le nom de composant, lui, reste SANS verdict (le bloc le refuse, la table se tait)', () => {
    const src = bloc(["  @routes =", "    'vue':", "      '/ok': 'Mauvais-Composant'"].join('\n'))
    assert.equal(compilateurRefuse('  /ok  Mauvais-Composant'), true, 'le bloc doit refuser ce nom')
    assert.equal(aDuRouge(src), false, 'la paire ne matche même pas : rien à peindre, et surtout rien de rouge')
  })

  it("un chemin INTERPOLÉ n'est pas pris pour un chemin littéral", () => {
    const corps = ['  @routes =', "    'vue': {}", '', '  for e in $liste',
                   '    @routes[\'vue\']["/#{e.id}"] = "page-#{e.id}"'].join('\n')
    const src = bloc(corps)
    assert.equal(aDuRouge(src), false)
    assert.equal(jetons(src).some(t => t.scopes.includes('entity.name.tag.route.modularjs')), false,
      'rien de littéral ici : la grammaire ne doit rien désigner comme composant de route')
  })

  it("l'ajout ciblé @routes['vue']['/x'] = 'x-page' est lu comme une route", () => {
    const src = bloc("  @routes['vue']['/extra'] = 'extra-page'")
    assert.ok(scopesDe(src, 'extra').includes('string.unquoted.route.segment.modularjs'))
    assert.ok(scopesDe(src, 'extra-page').includes('entity.name.tag.route.modularjs'))
  })
})
