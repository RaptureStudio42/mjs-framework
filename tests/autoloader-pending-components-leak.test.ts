// Régression : `Autoloader.load(tag)`
// purgeait `pendingComponents` sur SES DEUX CHEMINS D'ÉCHEC (tag absent du
// manifeste, import qui jette) mais JAMAIS sur le chemin de SUCCÈS. Un import
// qui RÉUSSIT mais dont le module ne fait PAS `customElements.define(tag)`
// (bug de config du composant, mauvais tag exporté) laissait le tag COINCÉ
// dans ce Set à VIE : `load(tag)` exige `!customElements.get(tag) &&
// !pendingComponents.has(tag)` — avec les deux BLOQUÉS respectivement à
// undefined et true pour toujours, cette condition ne redevient JAMAIS vraie
// → plus AUCUNE tentative de rechargement, SILENCIEUSEMENT (contrairement
// aux 2 autres échecs, qui logguent via µ.error).
//
// Fix : purge inconditionnelle de `pendingComponents` sur le chemin succès
// aussi, + un µ.error si `customElements.get(tag)` est TOUJOURS falsy après
// l'import (signale le module mal configuré au lieu de mourir en silence).

import { strict as assert } from 'node:assert'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { mjsTmp } from './helpers/tmp.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const AUTOLOADER_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_autoloader.ts'), 'utf-8')

describe("mjs_autoloader — load() purge pendingComponents même quand l'import réussit", function () {
  let dir: string
  let savedCustomElements: any

  before(function () {
    dir = mjsTmp('autoloader-test')
    // « bon » module : simule le code émis par le compilateur (customElements.define
    // au niveau racine, synchrone — cf. src/transpiler/template.ts:97).
    // CORRECTIF — le module appelait `__mjsTestRegistry.define(…)`,
    // or ce registre est une `Map` : `.define` n'existe pas → TypeError → l'import REJETAIT,
    // et le cas « import réussi » ci-dessous empruntait en réalité le chemin d'ÉCHEC. Il
    // restait vert par coïncidence (les deux chemins purgent `pendingComponents`). On passe
    // par le vrai stub `customElements`, exactement comme le fait un composant compilé.
    writeFileSync(join(dir, 'good.mjs'), `globalThis.customElements.define('mjs-good', class {});\n`)
    // « mauvais » module : importe SANS jamais enregistrer le tag attendu
    // (bug de config réaliste : mauvais nom de tag, oubli du define).
    writeFileSync(join(dir, 'bad.mjs'), `export const noop = true;\n`)
  })

  after(function () {
    rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(function () {
    savedCustomElements = (globalThis as any).customElements
    ;(globalThis as any).__mjsTestRegistry = new Map<string, any>()
    ;(globalThis as any).customElements = {
      get: (t: string) => (globalThis as any).__mjsTestRegistry.get(t),
      define: (t: string, c: any) => (globalThis as any).__mjsTestRegistry.set(t, c),
    }
  })
  afterEach(function () {
    (globalThis as any).customElements = savedCustomElements
    delete (globalThis as any).__mjsTestRegistry
  })

  function makeAutoloader(paths: Record<string, string>, spies: { log?: any[], error?: any[] } = {}) {
    const µ: any = {
      log: (...a: any[]) => spies.log?.push(a),
      warn() {},
      error: (...a: any[]) => spies.error?.push(a),
      paths,
    }
    new Function('µ', AUTOLOADER_SRC)(µ)
    return µ.Autoloader
  }

  it('import réussi ET customElements.define appelé : pendingComponents purgé (cas nominal)', async function () {
    const errorCalls: any[] = []
    const Autoloader = makeAutoloader({ good: join(dir, 'good.mjs') }, { error: errorCalls })
    await Autoloader.load('mjs-good')
    // GARDE DE VÉRACITÉ — sans ces deux assertions, ce cas passait aussi bien
    // par le chemin d'ÉCHEC : le tag enregistré prouve que le module s'est réellement
    // exécuté, et l'absence de µ.error écarte les DEUX chemins d'échec (import qui jette,
    // import réussi sans define — les seuls sites de µ.error de mjs_autoloader.ts).
    assert.ok((globalThis as any).customElements.get('mjs-good'), "le module doit avoir enregistré <mjs-good> — sinon ce cas emprunte le chemin d'ÉCHEC et ne teste pas ce qu'il annonce")
    assert.equal(errorCalls.length, 0, `chemin de SUCCÈS attendu : aucun µ.error, reçu ${JSON.stringify(errorCalls.map((a) => a[0]))}`)
    assert.equal(Autoloader.pendingComponents.has('mjs-good'), false)
  })

  it('import réussi mais SANS customElements.define : pendingComponents purgé quand même', async function () {
    const Autoloader = makeAutoloader({ bad: join(dir, 'bad.mjs') })
    await Autoloader.load('mjs-bad')
    assert.equal(Autoloader.pendingComponents.has('mjs-bad'), false, 'AVANT le fix : le tag restait coincé dans pendingComponents à vie')
  })

  it('avertit (µ.error) quand un import réussit sans jamais définir le tag attendu', async function () {
    const errorCalls: any[] = []
    const Autoloader = makeAutoloader({ bad: join(dir, 'bad.mjs') }, { error: errorCalls })
    await Autoloader.load('mjs-bad')
    assert.equal(errorCalls.length, 1, 'AVANT le fix : ce cas ne logguait RIEN (contrairement aux 2 autres échecs)')
    assert.match(errorCalls[0][0], /jamais été enregistré/)
  })

  it("un 2e load() du même tag jamais défini RETENTE (au lieu de se taire silencieusement à vie)", async function () {
    const logCalls: any[] = []
    const Autoloader = makeAutoloader({ bad: join(dir, 'bad.mjs') }, { log: logCalls })
    await Autoloader.load('mjs-bad')
    await Autoloader.load('mjs-bad')

    const downloadLogs = logCalls.filter((a) => String(a[0]).includes('Downloading'))
    assert.equal(downloadLogs.length, 2, "AVANT le fix : la 2e tentative était bloquée en silence (pendingComponents jamais purgé), un seul 'Downloading' log au lieu de deux")
  })
})
