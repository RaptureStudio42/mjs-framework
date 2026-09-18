// Verrou de non-régression : `µres` (sac de props serveur) en bloc
// structurel, MÊME esprit que tests/router-url-struct-lock.test.ts pour
// `µurl` : `µ.res` est un `µ.state({})` À PART (mjs_store_globals.ts), jamais
// dans `_mjs_renderStructVars` (le câblage compile-time des variables `$`) — toute
// lecture d'un de ses champs PENDANT un rendu enregistre une dépendance
// UNIVERSELLE (le filet de sécurité du Proxy), et `µ._mjs_resSet` (écriture PAR
// CLÉ, même canal que `µ.url`/`_mjs_updateUrlStore`) déclenche le re-rendu.
//
// Ce test prouve en plus le contrat d'amorçage : `µres.name` lu AVANT tout
// `µ._mjs_resSet` (premier rendu, sac vide) ne doit JAMAIS crasher — juste rendre
// vide (`val == null ? ''`, cf. mjs_element.ts) — et qu'une clé absente du
// NOUVEAU sac passé à `µ._mjs_resSet` est bien SUPPRIMÉE (redevient vide), pas
// seulement écrasée par `undefined`.
//
// Harnais calqué sur tests/router-url-struct-lock.test.ts (Bundler + happy-dom réel).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const stripEsm = (s: string) => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

describe('µres — sac de props serveur en bloc structurel : verrou de non-régression', () => {
  after(async () => { await terminateSharedWorkerPool() })

  it('rendu initial vide sans crash ; µ._mjs_resSet({name}) affiche ; µ._mjs_resSet({}) redevient vide (clé supprimée)', async function () {
    this.timeout(30000)

    const root = mjsTmp('res-struct-lock')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })

    writeFileSync(join(srcDir, 'res-struct.mjs'), `
<p class="name">{µres.name}</p>
`)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, `${stats.errors.map(e => e.message).join('\n')}`)

    const window = new Window({ url: 'http://localhost/' })
    const document: any = window.document

    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^res-struct-/.test(f))
    assert.ok(coreFile && compFile, 'core et res-struct doivent être compilés')

    const coreCode = stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))
    const compCode = stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))

    try {
      window.eval(`
        ${coreCode}
        globalThis.µ = µ;
        ${compCode}
      `)
    } catch (e: any) {
      throw new Error(`Eval bundle dans happy-dom : ${e.message}`)
    }

    const tag = 'mjs-res-struct'
    assert.ok(window.customElements.get(tag), `${tag} doit être enregistré`)

    document.body.innerHTML = `<${tag}></${tag}>`
    const el: any = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 50))

    // 1. Premier rendu, AUCUN µ._mjs_resSet encore appelé : µ.res existe déjà
    // (amorcé au boot, mjs_store_globals.ts) — lecture SANS crash, vide.
    assert.match(el._shadow?.querySelector('.name')?.textContent ?? 'ABSENT', /^$/,
      "amorçage : µres.name lu avant tout _mjs_resSet ne crashe pas, rend vide")

    // 2. µ._mjs_resSet({name:'Ada'}) — écriture PAR CLÉ (même canal que µ.url) :
    // le composant se re-rend, affiche la nouvelle valeur.
    window.eval(`µ._mjs_resSet({name: 'Ada'});`)
    await new Promise(r => setTimeout(r, 50))
    assert.equal(el._shadow?.querySelector('.name')?.textContent, 'Ada',
      "µ._mjs_resSet({name:'Ada'}) : le DOM affiche Ada")

    // 3. µ._mjs_resSet({}) — la clé 'name' du sac PRÉCÉDENT, absente du nouveau,
    // doit être SUPPRIMÉE (pas juste ignorée) : redevient vide.
    window.eval(`µ._mjs_resSet({});`)
    await new Promise(r => setTimeout(r, 50))
    assert.match(el._shadow?.querySelector('.name')?.textContent ?? 'ABSENT', /^$/,
      "µ._mjs_resSet({}) : la clé 'name' absente du nouveau sac est supprimée, redevient vide")

    window.close?.()
  })

  // Garde anti prototype-pollution de µ._mjs_resSet (miroir exact de µ._storeSet,
  // mjs_store_globals.ts:126-129) : `JSON.parse` crée `__proto__` comme propriété PROPRE du
  // JSON serveur — sans garde, `µ.res[k] = props[k]` traverserait le filet de sécurité et
  // écraserait le [[Prototype]] de `µ.res` (assignation `proxy['__proto__'] = v` standard,
  // contrairement à `JSON.parse` qui ne touche jamais le vrai prototype).
  it("µ._mjs_resSet garde anti prototype-pollution : __proto__ (via JSON.parse) n'écrase PAS µ.res, un warn est émis", async function () {
    this.timeout(30000)

    const root = mjsTmp('res-proto-lock')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'res-struct.mjs'), `
<p class="name">{µres.name}</p>
`)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, `${stats.errors.map(e => e.message).join('\n')}`)

    const window = new Window({ url: 'http://localhost/' })

    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    assert.ok(coreFile, 'core doit être compilé')
    const coreCode = stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))

    try {
      window.eval(`
        ${coreCode}
        globalThis.µ = µ;
      `)
    } catch (e: any) {
      throw new Error(`Eval bundle dans happy-dom : ${e.message}`)
    }

    const raw = window.eval(`
      globalThis.__warnCalls = [];
      µ.warn = function() { globalThis.__warnCalls.push(Array.prototype.slice.call(arguments)); };
      µ._mjs_resSet(JSON.parse('{"__proto__":{"pollue":1}}'));
      JSON.stringify({
        pollue: µ.res.pollue === undefined ? null : µ.res.pollue,
        protoInchange: Object.getPrototypeOf(µ.res) === Object.prototype,
        warnCount: globalThis.__warnCalls.length,
      });
    `)
    const result = JSON.parse(raw as string)

    assert.equal(result.pollue, null, 'µ.res.pollue doit rester undefined (la clé __proto__ ne doit JAMAIS être écrite)')
    assert.equal(result.protoInchange, true, 'le [[Prototype]] de µ.res doit rester Object.prototype (non pollué)')
    assert.equal(result.warnCount, 1, 'un µ.warn doit signaler la clé refusée (miroir µ._storeSet)')

    window.close?.()
  })
})
