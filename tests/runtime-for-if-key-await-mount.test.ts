// Montage RÉEL (happy-dom, via src/testing createHarness) des 4 blocs structurels détachés du
// cœur (mjs_for.ts/mjs_if.ts/mjs_key.ts/mjs_await.ts, cf. tests/bundler-detection-for-if-key-
// await.test.ts pour la sélection du bundle) : ce fichier vérifie le COMPORTEMENT, pas
// seulement la présence dans le bundle — une liste qui s'affiche et se met à jour, un `{if}`
// qui bascule, un `{key}` qui remonte (structure comprise, pas juste le texte), un `{await}`
// qui résout.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHarness } from '../src/testing/index.js'
import { mjsTmp } from './helpers/tmp.js'

const LIST = [
  '<script>',
  '$items ?= [1, 2, 3]',
  '</script>',
  '',
  '<ul>',
  '{for x in $items}<li>{x}</li>{end}',
  '</ul>',
  '<button class="add" @click={$items = $items.concat([99])}>+</button>',
].join('\n')

const COND = [
  '<script>',
  '$show ?= true',
  '</script>',
  '',
  '{if $show}<p class="yes">oui</p>{else}<p class="no">non</p>{end}',
  '<button class="toggle" @click={$show = !$show}>bascule</button>',
].join('\n')

// Le compteur vit sur `window` (global happy-dom, lu depuis le test via `app.window`) : une
// NOUVELLE instance construite (donc un VRAI remount, pas une simple mise à jour de texte)
// exécute à nouveau le corps du `<script>`, qui incrémente.
const KEYED_CHILD = [
  '<script>',
  'window.__mjsKeyRemountCount = (window.__mjsKeyRemountCount || 0) + 1',
  '</script>',
  '',
  '<span class="child">enfant</span>',
].join('\n')

const KEYED = [
  '<script>',
  '$k ?= 1',
  '</script>',
  '',
  '{key $k}<mjs-tst-fika-keyed-child></mjs-tst-fika-keyed-child>{end}',
  '<button class="bump" @click={$k = $k + 1}>bump</button>',
].join('\n')

const AWAITER = [
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
  '<button class="go" @click={$p = Promise.resolve(\'ok\')}>go</button>',
].join('\n')

function projetTemporaire(): string {
  const root = mjsTmp('mount-for-if-key-await')
  const srcDir = join(root, 'src')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'tst-fika-list.mjs'), LIST)
  writeFileSync(join(srcDir, 'tst-fika-cond.mjs'), COND)
  writeFileSync(join(srcDir, 'tst-fika-keyed-child.mjs'), KEYED_CHILD)
  writeFileSync(join(srcDir, 'tst-fika-keyed.mjs'), KEYED)
  writeFileSync(join(srcDir, 'tst-fika-awaiter.mjs'), AWAITER)
  writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ sourceDir: 'src', outputDir: 'out', manifestPath: 'out/bundle.js' }, null, 2))
  return root
}

describe('runtime — montage réel des 4 blocs structurels détachés', function () {
  this.timeout(60000)

  let app: any

  before(async () => {
    app = await createHarness({ root: projetTemporaire() })
  })

  after(async () => {
    if (app) await app.destroy()
  })

  it('{for} — la liste s\'affiche ET se met à jour (ajout d\'un item)', async () => {
    const c = await app.mount('tst-fika-list')
    assert.deepEqual(c.findAll('li').map((n: any) => n.textContent), ['1', '2', '3'])
    await c.click('.add')
    assert.deepEqual(c.findAll('li').map((n: any) => n.textContent), ['1', '2', '3', '99'])
    c.destroy()
  })

  it('{if} — bascule entre les deux branches', async () => {
    const c = await app.mount('tst-fika-cond')
    assert.ok(c.find('.yes'))
    assert.equal(c.find('.no'), null)
    await c.click('.toggle')
    assert.equal(c.find('.yes'), null)
    assert.ok(c.find('.no'))
    c.destroy()
  })

  it('{key} — un changement de clé REMONTE le contenu (nouvelle instance du composant enfant, pas une simple mise à jour)', async () => {
    (app.window as any).__mjsKeyRemountCount = 0
    const c = await app.mount('tst-fika-keyed')
    // Pas de valeur ABSOLUE attendue au montage initial (la 1ʳᵉ construction JAMAIS vue d'une
    // balise donnée, sur cette page, compte double — vérifié indépendant de `{key}`/`{if}`,
    // même chose avec un enfant monté SEUL) : l'invariant qui compte est la PROGRESSION —
    // chaque changement de clé doit construire une instance NEUVE, jamais réutiliser l'ancienne.
    const apresMontage = app.window.__mjsKeyRemountCount
    assert.ok(apresMontage >= 1, 'le montage initial doit construire le composant enfant au moins une fois')
    await c.click('.bump')
    const apres1erBump = app.window.__mjsKeyRemountCount
    assert.ok(apres1erBump > apresMontage,
      `le changement de clé doit RECONSTRUIRE le composant enfant (remount), pas juste le mettre à jour (avant=${apresMontage}, après=${apres1erBump})`)
    await c.click('.bump')
    assert.ok(app.window.__mjsKeyRemountCount > apres1erBump, 'un 2e changement de clé doit reconstruire de nouveau')
    c.destroy()
  })

  it('{await} — rien tant que la promesse est nulle, puis résout jusqu\'à la branche {success}', async () => {
    const c = await app.mount('tst-fika-awaiter')
    assert.equal(c.find('.pending'), null)
    assert.equal(c.find('.done'), null)
    await c.click('.go')
    assert.equal(c.find('.pending'), null, 'la promesse est déjà résolue au moment où le clic rend la main (nextTick vide la microtask queue)')
    assert.equal(c.text('.done'), 'ok')
    c.destroy()
  })
})
