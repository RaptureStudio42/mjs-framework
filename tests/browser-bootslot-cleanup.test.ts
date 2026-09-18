// `bootSlot()` (render-browser.ts, appelée par `createSlot()`) ne referme pas le
// `context` Playwright déjà créé si une étape SUIVANTE (`addInitScript`/`route`/`newPage`) échoue :
// `createSlot()` n'entoure `await bootSlot()` que d'un `try/finally{ reserved-- }`, rien ne ferme
// le contexte d'un échec intermédiaire. Fonction interne non exportée :
// on force l'échec par un ESPION posé sur le PROTOTYPE PARTAGÉ `BrowserContext.addInitScript`
// (même singleton module `playwright` que celui résolu par render-browser.ts, prouvé par sonde
// avant écriture) — un seul essai réel, jamais un mock du module entier.
//
// Même garde de disponibilité que tests/render-browser.test.ts (skip propre si Chromium absent).
//
//   xvfb-run -a npx mocha tests/browser-bootslot-cleanup.test.ts --extension ts --require tsx/esm --exit

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { mjsTmp } from './helpers/tmp.js'
import { createBrowserRenderer } from '../src/server/render-browser.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'

async function isChromiumAvailable(): Promise<boolean> {
  try {
    return existsSync(chromium.executablePath())
  } catch {
    return false
  }
}

function project(): string {
  const root = mjsTmp('bootslot')
  mkdirSync(join(root, 'src'), { recursive: true })
  return root
}

describe('render-browser — bootSlot() referme le contexte si une étape suivante échoue', () => {
  let chromiumReady = false

  before(async function () {
    this.timeout(10000)
    chromiumReady = await isChromiumAvailable()
    if (!chromiumReady) {
      console.log('  ℹ️  Chromium non installé, test browser-bootslot-cleanup skippé. Activer : `npx playwright install chromium`')
    }
  })

  after(async () => { await terminateSharedWorkerPool() })

  it('addInitScript() en échec (stub) : le contexte fraîchement créé est refermé (context.close appelé), l\'erreur remonte telle quelle', async function () {
    if (!chromiumReady) { this.skip(); return }
    this.timeout(60000)
    const root = project()
    writeFileSync(join(root, 'src', 'simple.mjs'), '<p>simple</p>')

    // sonde jetable : uniquement pour récupérer le PROTOTYPE partagé (cf. en-tête de fichier).
    const probeBrowser = await chromium.launch({ headless: true })
    const probeCtx = await probeBrowser.newContext()
    const ContextProto = Object.getPrototypeOf(probeCtx)
    await probeCtx.close()
    await probeBrowser.close()

    const originalAddInitScript = ContextProto.addInitScript
    const originalClose = ContextProto.close
    const closedInstances = new Set<any>()
    let failingInstance: any = null

    ContextProto.close = function (...args: any[]) {
      closedInstances.add(this)
      return originalClose.apply(this, args)
    }
    // ne lève qu'UNE fois (le tout premier appel après le patch) : le seul `addInitScript()` posé
    // par bootSlot() pour ce renderer fraîchement créé — les appels ultérieurs (autres tests,
    // autres slots) repassent par l'original, jamais affectés.
    ContextProto.addInitScript = function (...args: any[]) {
      if (!failingInstance) {
        failingInstance = this
        throw new Error('échec simulé (addInitScript)')
      }
      return originalAddInitScript.apply(this, args)
    }

    try {
      const renderer = await createBrowserRenderer({ sourceDir: 'src', outputDir: 'out' }, { configDir: root })
      try {
        await assert.rejects(
          renderer.renderPage('mjs-simple', {}),
          /échec simulé \(addInitScript\)/,
          'l\'échec d\'addInitScript doit remonter tel quel (jamais avalé)',
        )
        assert.ok(failingInstance, 'addInitScript doit avoir été intercepté sur un contexte réel')
        assert.ok(closedInstances.has(failingInstance), 'le contexte dont une étape a échoué doit avoir été refermé (context.close() appelé)')
      } finally {
        await renderer.close()
      }
    } finally {
      ContextProto.addInitScript = originalAddInitScript
      ContextProto.close = originalClose
    }
  })
})
