// resolveEngine (render-browser.ts) — logique PURE de résolution du moteur de
// rendu (priorité route > config > défaut), isolée de tout navigateur/Playwright
// réel via l'injection de `probeBrowserAvailable` — ce fichier tourne dans un
// simple `npm test`, sans Chromium ni xvfb (contrairement à render-browser.test.ts,
// l'intégration réelle).

import assert from 'node:assert/strict'
import { resolveEngine } from '../src/server/render-browser.js'

describe('resolveEngine — priorité route > config > défaut (logique pure, sans navigateur)', () => {
  it("axe 'request' : reste 'happy-dom' même si la sonde navigateur répond disponible (jamais de défaut implicite navigateur par requête)", async () => {
    const engine = await resolveEngine('request', {}, undefined, { probeBrowserAvailable: async () => true })
    assert.equal(engine, 'happy-dom')
  })

  it("axe 'prerender' : 'browser' si la sonde répond disponible", async () => {
    const engine = await resolveEngine('prerender', {}, undefined, { probeBrowserAvailable: async () => true })
    assert.equal(engine, 'browser')
  })

  it("axe 'prerender' : repli 'happy-dom' si la sonde répond indisponible", async () => {
    const engine = await resolveEngine('prerender', {}, undefined, { probeBrowserAvailable: async () => false })
    assert.equal(engine, 'happy-dom')
  })

  it("route.engine prime sur render.engine[kind] ET sur le défaut", async () => {
    const config = { render: { engine: { prerender: 'browser' as const } } }
    const engine = await resolveEngine('prerender', config, { engine: 'happy-dom' }, { probeBrowserAvailable: async () => true })
    assert.equal(engine, 'happy-dom', 'route.engine doit gagner même si config ET sonde pointent vers browser')
  })

  it("render.engine[kind] prime sur le défaut (et court-circuite la sonde — pas de résolution Playwright si explicitement configuré)", async () => {
    let probed = false
    const config = { render: { engine: { prerender: 'happy-dom' as const } } }
    const engine = await resolveEngine('prerender', config, undefined, {
      probeBrowserAvailable: async () => { probed = true; return true },
    })
    assert.equal(engine, 'happy-dom')
    assert.equal(probed, false, 'une valeur configurée explicitement ne doit JAMAIS déclencher la sonde de résolution Playwright')
  })

  it("render.engine.request explicite PEUT forcer 'browser' sur l'axe request (seul le défaut IMPLICITE est banni, pas le choix explicite)", async () => {
    const config = { render: { engine: { request: 'browser' as const } } }
    const engine = await resolveEngine('request', config, undefined, { probeBrowserAvailable: async () => false })
    assert.equal(engine, 'browser')
  })

  it("route.engine accepte aussi bien un objet { engine } minimal qu'un ResolvedPage complet (couplage structurel, pas nominal)", async () => {
    // ResolvedPage (render-routes.ts) porte bien plus que `engine` (component,
    // mode, params, settleMs…) — resolveEngine ne doit lire QUE le champ `engine`,
    // sans exiger le reste de la forme.
    const resolvedPageLike = { component: 'mjs-x', mode: 'ssr:replace' as const, params: {}, engine: 'browser' as const }
    const engine = await resolveEngine('prerender', {}, resolvedPageLike, { probeBrowserAvailable: async () => false })
    assert.equal(engine, 'browser')
  })

  it("le message informatif de repli ('installe playwright…') ne sort JAMAIS plus d'une fois par process", async () => {
    // Le dédoublonnage est un flag AU NIVEAU MODULE (même motif que `warnedFiles`,
    // languages/coffee.ts) — potentiellement déjà consommé par un test précédent
    // de CE fichier (ordre d'exécution). Assertion robuste à cet ordre : peu
    // importe le compte de DÉPART, 3 appels consécutifs dans CE test ne doivent
    // jamais ajouter plus d'1 nouveau message (jamais 2, jamais 3).
    const logs: string[] = []
    const probeUnavailable = async () => false
    for (let i = 0; i < 3; i++) {
      await resolveEngine('prerender', {}, undefined, { probeBrowserAvailable: probeUnavailable, log: (m) => logs.push(m) })
    }
    assert.ok(logs.length <= 1, `au plus 1 message sur 3 appels dans ce process, reçu : ${logs.length}`)
  })
})
