// Garde du CONTRAT générateur ⟷ cœur (src/bundler/core-contract.ts) : le build REFUSE de finir
// quand une méthode interne appelée par une unité compilée n'existe nulle part dans le mjs_core.js
// produit.
//
// Le cas réel qu'elle rattrape (septembre 2026) : `scanCompiledFeatures` décide d'embarquer
// `mjs_for_nested.ts` en cherchant `._mjs_updList(` dans le code compilé. Entre deux versions, le
// générateur émettait encore l'ANCIEN nom `._updList(` ; le scan n'a rien trouvé, le module est
// sorti du cœur, le build est resté VERT, et neuf vues d'une application sont mortes en production sur
// « this._updList is not a function ». Un prédicat de détection qui échoue rend « personne n'en a
// besoin » — indiscernable de « rien à embarquer » (socle §7).
//
// La garde ne peut pas surveiller le scan depuis le scan : elle regarde le RÉSULTAT. Les deux sens
// sont éprouvés ici, et le sens NÉGATIF compte autant que l'autre — une garde jamais vue refuser
// n'a jamais rien prouvé.
//
// Patron repris de tests/bundler-core-after-components.test.ts (Bundler réel, artefact sur disque).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { findConfig, resolveBundlerOpts } from '../src/bundler/config.js'
import { collectCoreCalls, missingCoreSymbols } from '../src/bundler/core-contract.js'
import { mjsTmp } from './helpers/tmp.js'

// `{for}` DANS un `{for}` : la seule forme qui compile en `this._mjs_updList(` (une liste à la
// racine, dans un `{if}` ou dans un `{key}` compile en `this._mjs_updFor(`, servi par mjs_for.ts).
const LISTE_IMBRIQUEE = [
  '<script>$groupes = [[1, 2]]</script>',
  '{for g in $groupes}<ul>{for x in g}<li>{x}</li>{end}</ul>{end}',
].join('\n')

// un appel que RIEN ne détecte : `mjs_head.ts` n'entre dans le cœur que si le scan voit
// `µ._setHead(` (REGEX_HEAD, features.ts) — `µ._clearHead(`, son jumeau du même module, n'est
// cherché par aucune regex. Un composant qui n'appelle QUE celui-là part donc avec un cœur qui ne
// le porte pas : le trou de détection du cas réel, à l'identique, sans rouvrir le générateur.
const APPEL_NON_DETECTE = [
  '<p>vide</p>',
  '<script>',
  '  @vider = -> µ._clearHead()',
  '</script>',
].join('\n')

async function build(cfgExtra: Record<string, unknown>, files: Record<string, string>): Promise<{ outDir: string; errors: Error[] }> {
  const root   = mjsTmp('core-contract')
  const srcDir = join(root, 'app/modularjs')
  mkdirSync(srcDir, { recursive: true })
  for (const [nom, contenu] of Object.entries(files)) writeFileSync(join(srcDir, nom), contenu)
  writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
    sourceDir: 'app/modularjs', outputDir: 'out', manifestPath: 'bundle.js', ...cfgExtra,
  }))
  const found = findConfig(root)
  assert.ok(found, 'mjs.config.json doit être trouvé')
  const opts  = resolveBundlerOpts(found!.config, found!.configDir)
  const stats = await new Bundler(opts as never).compile()
  return { outDir: join(root, 'out'), errors: stats.errors }
}

function coeur(outDir: string): string {
  const f = readdirSync(outDir).find((n) => /^mjs_core-/.test(n))
  assert.ok(f, 'mjs_core-*.js doit exister')
  return readFileSync(join(outDir, f!), 'utf-8')
}

describe('bundler — garde du contrat générateur ⟷ cœur', () => {
  after(() => { terminateSharedWorkerPool() })

  // ---- SENS POSITIF : un build normal ne dit rien -------------------------------------------
  it('laisse passer un projet dont le cœur porte tout ce que les composants appellent', async () => {
    const { outDir, errors } = await build({}, { 'liste-imbriquee.mjs': LISTE_IMBRIQUEE })
    assert.deepEqual(errors, [], 'un build sain ne doit rien signaler')
    const core = coeur(outDir)
    assert.ok(core.includes('_mjs_updList'), 'mjs_for_nested doit être dans le cœur pour ce composant')

    // et la garde, relancée à la main sur les artefacts écrits, ne trouve rien à redire
    const appels = new Set<string>()
    for (const f of readdirSync(outDir).filter((n) => n.endsWith('.js') && !n.startsWith('mjs_core-'))) {
      for (const n of collectCoreCalls(readFileSync(join(outDir, f), 'utf-8'))) appels.add(n)
    }
    assert.ok(appels.has('_mjs_updList'), 'le composant doit bien réclamer _mjs_updList')
    assert.deepEqual(missingCoreSymbols(core, appels), [], 'aucun symbole ne doit manquer')
  })

  // ---- SENS NÉGATIF : le cœur amputé fait ÉCHOUER le build --------------------------------
  // Le chemin est le MÊME que dans le cas réel, à la lettre : un symbole du cœur appelé par un
  // composant, un scan qui ne le cherche pas, un module qui sort du bundle — sauf qu'ici le trou
  // est celui de `µ._clearHead(`, encore ouvert, plutôt qu'un ancien nom à réintroduire à la main.
  it('REFUSE de finir quand un module du cœur manque à un composant qui l\'appelle', async () => {
    const { outDir, errors } = await build({ runtime: [] }, { 'vide-la-tete.mjs': APPEL_NON_DETECTE })

    // compile() ne lève pas : elle RANGE ses erreurs (comportement historique, partagé par toutes
    // les erreurs de build). Ce qui compte est ce que la CLI en fait — `mjs build` sort en 1, donc
    // le `sh` d'un crochet rake lève, `assets:precompile` s'arrête et un deploy.sh en `set -e`
    // coupe avant d'envoyer quoi que ce soit.
    assert.equal(errors.length, 1, 'le build doit signaler exactement une erreur')
    assert.match(errors[0].message, /_clearHead/, 'le message doit NOMMER le symbole manquant')
    assert.match(errors[0].message, /runtime/, 'le message doit dire quoi faire')

    // et le cœur amputé n'est pas écrit : rien à déployer par mégarde
    assert.equal(readdirSync(outDir).some((n) => /^mjs_core-/.test(n)), false, 'aucun mjs_core-*.js ne doit être écrit')
  })

  // ---- le périmètre surveillé ne mord pas sur les noms de l'application ---------------------
  it('ignore les méthodes de l\'application, et les mentions en commentaire ou en chaîne', () => {
    const appels = collectCoreCalls(`
      class X {
        recharger() { this._maMethode(); this.rafraichir() }
        _maMethode() { µ._p(this, 'x') }
      }
      // ce commentaire appelle this._mjs_jamaisVu( pour de faux
      const doc = 'écris this._mjs_inexistant( dans ta prose, rien ne se passe'
    `)
    assert.deepEqual([...appels].sort(), ['_p'], 'seuls les noms réservés au framework comptent')
  })

  // une propriété que le composant se pose à LUI-MÊME n'est pas une promesse du cœur : le
  // générateur émet `this._mjs_fallback = (err, reset) => …` pour toute balise <@failed>, et le
  // cœur n'a pas à la porter.
  it('ne réclame pas au cœur ce qu\'une unité se pose à elle-même', () => {
    assert.deepEqual([...collectCoreCalls('this._mjs_fallback = (err, reset) => {}')], [])
    assert.deepEqual([...collectCoreCalls('static _mjs_noDestroyHooks = false')], [])
  })

  // le nom manquant doit être reconnu ENTIER : `_p` ne se reconnaît pas dans `x._pause`, et
  // `_mjs_upd` ne se reconnaît pas dans `_mjs_updFor` — sans ces bornes, la garde se tairait
  // exactement là où elle devrait parler.
  it('compare des noms entiers, jamais des préfixes', () => {
    assert.deepEqual(missingCoreSymbols('µ._pause = function(){}', ['_p']), ['_p'])
    assert.deepEqual(missingCoreSymbols('µ.Element.prototype._mjs_updFor = function(){}', ['_mjs_upd']), ['_mjs_upd'])
    assert.deepEqual(missingCoreSymbols('µ.Element.prototype._mjs_updFor = function(){}', ['_mjs_updFor']), [])
  })

  // un nom qui ne survit que dans un commentaire du cœur EST absent : c'était mot pour mot l'état
  // de `_updList` dans le cœur parti en production — deux commentaires, aucune définition.
  it('ne prend pas un commentaire du cœur pour une définition', () => {
    assert.deepEqual(
      missingCoreSymbols('// au revive, le _mjs_updList suivant repartait de zéro\nvar x = 1', ['_mjs_updList']),
      ['_mjs_updList'],
    )
  })
})
