// {await} : une promesse REMPLACÉE pendant l'attente est ignorée quand elle se résout ou
// échoue après coup — comportement protégé dans `_mjs_updAwait` (mjs_await.ts) par DEUX mécanismes
// superposés : la garde `this._mjs_awaitMap.get(id) !== promise` (posée dans le `.then` ET le
// `.catch`, lignes 78/90/97) ET un état FRAIS par promesse (`state = {...}` recréé à chaque
// nouvelle promesse, jamais partagé). Sabotage sur banc d’essai (copie du runtime, garde seule
// retirée) : sans effet observable ici, la fraîcheur de l'état suffit à elle seule à protéger
// ce scénario ; en retirant les DEUX (garde + état partagé), le scénario « A échoue après que
// B a réussi » bascule bien sur la branche {error} — preuve que le test discrimine une vraie
// régression du mécanisme, même si la garde nommée n'en est qu'une des deux couches. Modèle de
// montage : createHarness, même patron que tests/runtime-for-if-key-await-mount.test.ts.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHarness } from '../src/testing/index.js'
import { mjsTmp } from './helpers/tmp.js'
import { assertAbsent } from './helpers/dom-assert.js'

function deferred(): { promise: Promise<any>; resolve: (v: any) => void; reject: (e: any) => void } {
  let resolve: (v: any) => void = () => {}
  let reject: (e: any) => void = () => {}
  const promise = new Promise<any>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

// deux boutons assignent chacun une promesse posée sur `window` par le test — même idée que
// le bouton unique de l'AWAITER voisin, dédoublé pour rejouer un REMPLACEMENT en cours d'attente
const RACER = [
  '<script>',
  '$p ?= null',
  '</script>',
  '',
  '{await $p}',
  '<p class="pending">chargement</p>',
  '{success v}',
  '<p class="done">{v}</p>',
  '{error err}',
  '<p class="fail">{err.message}</p>',
  '{end}',
  '<button class="a" @click={$p = window.__promA}>a</button>',
  '<button class="b" @click={$p = window.__promB}>b</button>',
].join('\n')

function projetTemporaire(): string {
  const root   = mjsTmp('await-promesse-remplacee')
  const srcDir = join(root, 'src')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'tst-arp-racer.mjs'), RACER)
  writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ sourceDir: 'src', outputDir: 'out', manifestPath: 'out/bundle.js' }, null, 2))
  return root
}

describe('{await} — une promesse remplacée pendant l\'attente est ignorée à son tour', function () {
  this.timeout(60000)

  let app: any

  before(async () => {
    app = await createHarness({ root: projetTemporaire() })
  })

  after(async () => {
    if (app) await app.destroy()
  })

  it('B (posée après A, résolue AVANT A) gagne ; la résolution tardive de A n\'écrase rien', async () => {
    const a = deferred()
    const b = deferred()
    app.window.__promA = a.promise
    app.window.__promB = b.promise
    const c = await app.mount('tst-arp-racer')
    await c.click('.a')
    await c.click('.b')
    b.resolve('B')
    await c.tick()
    assert.equal(c.text('.done'), 'B', 'B doit déjà être affiché (dernière promesse posée)')
    a.resolve('A')
    await c.tick()
    assert.equal(c.text('.done'), 'B', 'la résolution tardive de A ne doit rien changer')
    c.destroy()
  })

  it('A échoue APRÈS que B a déjà réussi : aucune branche {error} n\'apparaît', async () => {
    const a = deferred()
    const b = deferred()
    app.window.__promA = a.promise
    app.window.__promB = b.promise
    const c = await app.mount('tst-arp-racer')
    await c.click('.a')
    await c.click('.b')
    b.resolve('B')
    await c.tick()
    assert.equal(c.text('.done'), 'B')
    a.reject(new Error('boom'))
    await c.tick()
    assert.equal(c.text('.done'), 'B', 'toujours B : le rejet tardif de A ne bascule pas sur {error}')
    assertAbsent(c.find('.fail'), 'aucune branche {error} ne doit apparaître')
    c.destroy()
  })
})
