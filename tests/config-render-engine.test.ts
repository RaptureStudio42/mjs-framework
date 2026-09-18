// mjs.config.json — bloc `render.engine` / `render.browserPool` / `render.forwardOrigin`
// + champs de route `settleMs`/`engine` (première brique du moteur de rendu serveur).
// SURFACE DE CONFIGURATION + validation stricte SEULEMENT — aucun défaut n'est
// appliqué ici (résolution au point de consommation) : ce test
// couvre juste que la forme est acceptée/rejetée comme spécifié, avec les mêmes
// messages `[mjs.config.json]` que le reste du config.

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { findConfig } from '../src/bundler/config.js'
import { computeForwardedOrigin } from '../src/server/render-request.js'

// espionne console.warn le temps d'un findConfig (motif
// tests/attr-directive-typo-erreur.test.ts), ne garde que les avertissements contenant "interne"
// (clé bundler.config.forward-origin-trusted-host-interne).
function findConfigCaptureWarnings(root: string): { found: ReturnType<typeof findConfig>; warnings: string[] } {
  const warnings: string[] = []
  const orig = console.warn
  console.warn = (...a: unknown[]) => { const s = String(a[0]); if (s.includes('interne')) warnings.push(s) }
  try {
    return { found: findConfig(root), warnings }
  } finally {
    console.warn = orig
  }
}

// écrit un mjs.config.json dans un dossier temp frais, retourne le dossier.
function writeConfig(config: Record<string, unknown>): string {
  const root = mjsTmp('cfg-render-engine')
  writeFileSync(join(root, 'mjs.config.json'), JSON.stringify(config))
  return root
}

describe('mjs.config.json — render.engine / render.browserPool / render.forwardOrigin', () => {
  it('(a) bloc render actuel (default/header/outDir/routes, sans les nouvelles clés) reste valide et inchangé', () => {
    const root = writeConfig({
      render: {
        default: 'prerender',
        header: 'X-MJS-Render',
        outDir: 'mjs_pages',
        routes: {
          '/':     { component: 'mjs-landing' },
          '/blog': { component: 'mjs-blog', mode: 'ssr:markers' },
        },
      },
    })
    const found = findConfig(root)
    assert.ok(found)
    assert.equal(found!.config.render!.default, 'prerender')
    assert.equal(found!.config.render!.routes!['/blog'].mode, 'ssr:markers')
    assert.equal(found!.config.render!.engine, undefined)
    assert.equal(found!.config.render!.browserPool, undefined)
    assert.equal(found!.config.render!.forwardOrigin, undefined)
  })

  it('(b) render.engine complet ({ prerender, request }) est accepté tel quel', () => {
    const root = writeConfig({
      render: { engine: { prerender: 'browser', request: 'happy-dom' } },
    })
    const found = findConfig(root)
    assert.ok(found)
    assert.equal(found!.config.render!.engine!.prerender, 'browser')
    assert.equal(found!.config.render!.engine!.request, 'happy-dom')
  })

  it("(c) render.engine.prerender: 'chrome' (valeur hors liste) → throw listant browser, happy-dom", () => {
    const root = writeConfig({ render: { engine: { prerender: 'chrome' } } })
    assert.throws(() => findConfig(root), /render\.engine\.prerender invalide[\s\S]*Valeurs valides : browser, happy-dom/)
  })

  it('(d) render.engine.autre (sous-clé inconnue) → throw listant prerender, request', () => {
    const root = writeConfig({ render: { engine: { autre: 'browser' } } })
    assert.throws(() => findConfig(root), /render\.engine\.autre : clé inconnue[\s\S]*Clés valides : prerender, request/)
  })

  it('(e) render.browserPool valide ({ size, keepAlive, maxAgeMs }) est accepté tel quel', () => {
    const root = writeConfig({
      render: { browserPool: { size: 4, keepAlive: false, maxAgeMs: 60000 } },
    })
    const found = findConfig(root)
    assert.ok(found)
    assert.equal(found!.config.render!.browserPool!.size, 4)
    assert.equal(found!.config.render!.browserPool!.keepAlive, false)
    assert.equal(found!.config.render!.browserPool!.maxAgeMs, 60000)
  })

  it('(f) render.browserPool.size: 0 (hors plage ≥ 1) → throw', () => {
    const root = writeConfig({ render: { browserPool: { size: 0 } } })
    assert.throws(() => findConfig(root), /render\.browserPool\.size doit être un entier ≥ 1/)
  })

  it('(g) render.browserPool.maxAgeMs: -1 (hors plage ≥ 0) → throw', () => {
    const root = writeConfig({ render: { browserPool: { maxAgeMs: -1 } } })
    assert.throws(() => findConfig(root), /render\.browserPool\.maxAgeMs doit être un entier ≥ 0/)
  })

  it("(h) render.browserPool.keepAlive: 'oui' (string, pas un booléen) → throw", () => {
    const root = writeConfig({ render: { browserPool: { keepAlive: 'oui' } } })
    assert.throws(() => findConfig(root), /render\.browserPool\.keepAlive doit être un booléen/)
  })

  // le plafond de rendu était DÉCLARÉ au type et CONSOMMÉ à l'exécution mais absent de
  // la liste blanche : l'écrire dans mjs.config.json faisait échouer le build sur
  // « clé inconnue » — le réglage n'était atteignable qu'en appelant le moteur par code
  it('render.browserPool.renderTimeoutMs est accepté par le validateur', () => {
    const root = writeConfig({ render: { browserPool: { size: 2, renderTimeoutMs: 30000 } } })
    const found = findConfig(root)
    assert.ok(found)
    assert.equal(found!.config.render!.browserPool!.renderTimeoutMs, 30000)
  })

  it('render.browserPool.renderTimeoutMs: 0 (hors plage ≥ 1) → throw', () => {
    const root = writeConfig({ render: { browserPool: { renderTimeoutMs: 0 } } })
    assert.throws(() => findConfig(root), /render\.browserPool\.renderTimeoutMs doit être un entier ≥ 1/)
  })

  it("render.browserPool.renderTimeoutMs: '15000' (chaîne) → throw", () => {
    const root = writeConfig({ render: { browserPool: { renderTimeoutMs: '15000' } } })
    assert.throws(() => findConfig(root), /render\.browserPool\.renderTimeoutMs doit être un entier ≥ 1/)
  })

  it("(i) render.forwardOrigin: 'true' (chaîne, PAS une URL d'origine valide — nouveau contrat SSRF) → throw", () => {
    const root = writeConfig({ render: { forwardOrigin: 'true' } })
    assert.throws(() => findConfig(root), /render\.forwardOrigin doit être une URL d'origine valide/)
  })

  it('render.forwardOrigin en booléen (true/false) reste accepté tel quel', () => {
    const root = writeConfig({ render: { forwardOrigin: true } })
    const found = findConfig(root)
    assert.ok(found)
    assert.equal(found!.config.render!.forwardOrigin, true)
  })

  it("render.forwardOrigin en origine FIXE ('https://back.exemple.com') est acceptée telle quelle", () => {
    const root = writeConfig({ render: { forwardOrigin: 'https://back.exemple.com' } })
    const found = findConfig(root)
    assert.ok(found)
    assert.equal(found!.config.render!.forwardOrigin, 'https://back.exemple.com')
  })

  it('render.forwardOrigin en { trustedHosts: [...] } est accepté tel quel', () => {
    const root = writeConfig({ render: { forwardOrigin: { trustedHosts: ['exemple.com', 'www.exemple.com'] } } })
    const found = findConfig(root)
    assert.ok(found)
    assert.deepEqual((found!.config.render!.forwardOrigin as any).trustedHosts, ['exemple.com', 'www.exemple.com'])
  })

  // un élément de `trustedHosts` avec port/crochets/chemin/espace/userinfo
  // ne matche JAMAIS l'hôte nu comparé par `computeForwardedOrigin` (forward-origin.ts, qui
  // compare `stripPort(host).toLowerCase()`, sans crochets ni chemin) : panne MUETTE, le
  // forwarding n'est jamais actif pour cet hôte, sans qu'aucune erreur ne le signale au build.
  it("render.forwardOrigin.trustedHosts[] : hôte avec port/crochets/chemin/espace/userinfo → throw (matcherait jamais l'hôte nu)", () => {
    for (const mauvais of ['exemple.com:8080', '[::1]', 'exemple.com/x', 'a@b', 'ex ample.com']) {
      const root = writeConfig({ render: { forwardOrigin: { trustedHosts: [mauvais] } } })
      assert.throws(() => findConfig(root), /render\.forwardOrigin\.trustedHosts\[\d+\][\s\S]*nom d'hôte nu/, `hôte accepté à tort : ${mauvais}`)
    }
  })

  it('render.forwardOrigin.trustedHosts[] : noms d\'hôte/IPv4/IPv6 nus, casse variable, restent acceptés tels quels', () => {
    const hotes = ['exemple.com', 'EXEMPLE.com', '127.0.0.1', '::1', '2001:db8::1']
    const root = writeConfig({ render: { forwardOrigin: { trustedHosts: hotes } } })
    const found = findConfig(root)
    assert.ok(found)
    assert.deepEqual((found!.config.render!.forwardOrigin as any).trustedHosts, hotes)
  })

  // `::ffff:1.2.3.4` (IPv4 mappée POINTÉE)
  // passait (i4c) au build mais ne matche JAMAIS `computeForwardedOrigin` (forward-origin.ts) :
  // sa comparaison finale passe par `new URL`, dont la normalisation WHATWG ne produit QUE la
  // forme hex compressée (`::ffff:102:304`) — jamais la forme pointée. Panne MUETTE : forwarding
  // jamais actif pour cet hôte, aucune erreur au build. Refusé depuis ce fix.
  it("render.forwardOrigin.trustedHosts[] : IPv4 mappée POINTÉE (::ffff:1.2.3.4) → throw, message donnant la forme hex", () => {
    const root = writeConfig({ render: { forwardOrigin: { trustedHosts: ['::ffff:1.2.3.4'] } } })
    assert.throws(() => findConfig(root), /render\.forwardOrigin\.trustedHosts\[0\][\s\S]*::ffff:102:304/)
  })

  it('render.forwardOrigin.trustedHosts[] : IPv4 mappée en forme HEX (::ffff:102:304) reste acceptée', () => {
    const root = writeConfig({ render: { forwardOrigin: { trustedHosts: ['::ffff:102:304'] } } })
    const found = findConfig(root)
    assert.ok(found)
    assert.deepEqual((found!.config.render!.forwardOrigin as any).trustedHosts, ['::ffff:102:304'])
  })

  // Casse (LOCALHOST) reste acceptée au build — INCHANGÉ, cf. (i4c). Le volet
  // « cohérence build/exécution » (computeForwardedOrigin(host:'localhost') doit rendre une
  // forwardedUrl) est OMIS ICI : `isBlockedForwardTarget` (forward-origin.ts l.97) bloque
  // EXPLICITEMENT 'localhost'/'*.localhost' (loopback, défense en profondeur) — vérifié en direct
  // (tsx), `computeForwardedOrigin({forwardOrigin:{trustedHosts:['LOCALHOST']}}, '/x',
  // {host:['localhost'], 'x-forwarded-proto':['https']})` rend `{}`, jamais une `forwardedUrl`. Comportement
  // laissé tel quel sur ce point précis — pas deviné de
  // host de remplacement.
  it('render.forwardOrigin.trustedHosts[] : casse (LOCALHOST) reste acceptée au build, inchangé', () => {
    const root = writeConfig({ render: { forwardOrigin: { trustedHosts: ['LOCALHOST'] } } })
    const found = findConfig(root)
    assert.ok(found)
    assert.deepEqual((found!.config.render!.forwardOrigin as any).trustedHosts, ['LOCALHOST'])
  })

  it("render.forwardOrigin.trustedHosts[] : point final (example.com.) accepté au build ET cohérent à l'exécution", () => {
    const root = writeConfig({ render: { forwardOrigin: { trustedHosts: ['example.com.'] } } })
    const found = findConfig(root)
    assert.ok(found)
    assert.deepEqual((found!.config.render!.forwardOrigin as any).trustedHosts, ['example.com.'])
    const out = computeForwardedOrigin({ forwardOrigin: { trustedHosts: ['example.com.'] } }, '/x', { host: ['example.com.'], 'x-forwarded-proto': ['https'] })
    assert.equal(out.forwardedUrl, 'https://example.com./x')
  })

  it('render.forwardOrigin.trustedHosts[] : IPv6 avec zone (fe80::1%eth0) reste refusée (non-régression)', () => {
    const root = writeConfig({ render: { forwardOrigin: { trustedHosts: ['fe80::1%eth0'] } } })
    assert.throws(() => findConfig(root), /render\.forwardOrigin\.trustedHosts\[0\]/)
  })

  // un `trustedHosts[i]` SYNTAXIQUEMENT valide
  // (passe `isValidTrustedHost`) mais NON CANONIQUE (au sens WHATWG, `new URL`) ne matche JAMAIS
  // un Host entrant réel : cf. le commentaire sur `canonicalTrustedHost` (bundler/config.ts).
  // (i4i)/(i4j)/(i4k)/(i4n) rejetés par le message NEUF (forme canonique proposée) ; (i4l) reste
  // rejeté par le message EXISTANT (`new URL` lève, forme irrécupérable, rien à proposer).
  it('render.forwardOrigin.trustedHosts[] : IPv4 avec zéros initiaux (01.02.03.04) → throw, message donnant la forme sans zéros', () => {
    const root = writeConfig({ render: { forwardOrigin: { trustedHosts: ['01.02.03.04'] } } })
    assert.throws(() => findConfig(root), /render\.forwardOrigin\.trustedHosts\[0\][\s\S]*1\.2\.3\.4/)
  })

  it('render.forwardOrigin.trustedHosts[] : IPv4 forme hexadécimale (0x7f.1) → throw, message donnant la forme pointée', () => {
    const root = writeConfig({ render: { forwardOrigin: { trustedHosts: ['0x7f.1'] } } })
    assert.throws(() => findConfig(root), /render\.forwardOrigin\.trustedHosts\[0\][\s\S]*127\.0\.0\.1/)
  })

  it('render.forwardOrigin.trustedHosts[] : IPv4 forme décimale entière (2130706433) → throw, message donnant la forme pointée', () => {
    const root = writeConfig({ render: { forwardOrigin: { trustedHosts: ['2130706433'] } } })
    assert.throws(() => findConfig(root), /render\.forwardOrigin\.trustedHosts\[0\][\s\S]*127\.0\.0\.1/)
  })

  it('render.forwardOrigin.trustedHosts[] : IPv4 aux octets hors bornes (123.456.789.0) → throw, message d\'invalidité (new URL lève, pas de forme canonique à proposer)', () => {
    const root = writeConfig({ render: { forwardOrigin: { trustedHosts: ['123.456.789.0'] } } })
    assert.throws(() => findConfig(root), /render\.forwardOrigin\.trustedHosts\[0\][\s\S]*nom d'hôte nu/)
  })

  it('render.forwardOrigin.trustedHosts[] : IPv6 déjà canonique à la casse près (2001:DB8::1) reste acceptée', () => {
    const root = writeConfig({ render: { forwardOrigin: { trustedHosts: ['2001:DB8::1'] } } })
    const found = findConfig(root)
    assert.ok(found)
    assert.deepEqual((found!.config.render!.forwardOrigin as any).trustedHosts, ['2001:DB8::1'])
  })

  it('render.forwardOrigin.trustedHosts[] : IPv6 développée (0:0:0:0:0:0:0:1) → throw, message donnant la forme compressée ::1', () => {
    const root = writeConfig({ render: { forwardOrigin: { trustedHosts: ['0:0:0:0:0:0:0:1'] } } })
    assert.throws(() => findConfig(root), /render\.forwardOrigin\.trustedHosts\[0\][\s\S]*::1/)
  })

  // (i4o) — ['example.com.'] est déjà couvert VERBATIM par (i4g) ci-dessus : canon('example.com.')
  // === 'example.com.' (new URL conserve le point final), donc build ET exécution restent cohérents
  // sans changement de comportement — pas de doublon ajouté ici.

  // un `trustedHosts[i]` ACCEPTÉ (regex + forme canonique)
  // peut désigner un hôte INTERNE (loopback, réseau privé, lien-local, métadonnées) TOUJOURS
  // bloqué à l'exécution par `isBlockedForwardTarget` (forward-origin.ts, défense en profondeur
  // SSRF) : sans avertissement au build, le dev croit avoir autorisé un hôte qui n'activera
  // JAMAIS rien — panne muette de configuration, cf. le commentaire de `validateForwardOrigin`.
  it("render.forwardOrigin.trustedHosts[] : hôte interne (localhost) accepté au build MAIS avertit (interne, bloqué à l'exécution)", () => {
    const root = writeConfig({ render: { forwardOrigin: { trustedHosts: ['localhost'] } } })
    const { found, warnings } = findConfigCaptureWarnings(root)
    assert.ok(found)
    assert.deepEqual((found!.config.render!.forwardOrigin as any).trustedHosts, ['localhost'])
    assert.equal(warnings.length, 1, `avertissements reçus : ${JSON.stringify(warnings)}`)
    assert.match(warnings[0], /interne/)
  })

  it('render.forwardOrigin.trustedHosts[] : autres formes internes (::1, 10.0.0.1, 169.254.169.254, fe80::1) avertissent chacune', () => {
    for (const hote of ['::1', '10.0.0.1', '169.254.169.254', 'fe80::1']) {
      const root = writeConfig({ render: { forwardOrigin: { trustedHosts: [hote] } } })
      const { found, warnings } = findConfigCaptureWarnings(root)
      assert.ok(found, `hôte accepté à tort refusé : ${hote}`)
      assert.equal(warnings.length, 1, `hôte ${hote} : ${warnings.length} avertissement(s) au lieu de 1`)
    }
  })

  it("render.forwardOrigin.trustedHosts[] : hôtes publics (example.com, IPv4 mappée publique ::ffff:102:304, 8.8.8.8) → 0 avertissement", () => {
    for (const hote of ['example.com', '::ffff:102:304', '8.8.8.8']) {
      const root = writeConfig({ render: { forwardOrigin: { trustedHosts: [hote] } } })
      const { found, warnings } = findConfigCaptureWarnings(root)
      assert.ok(found, `hôte ${hote}`)
      assert.equal(warnings.length, 0, `hôte ${hote} ne devait avertir de rien, reçu : ${JSON.stringify(warnings)}`)
    }
  })

  it("render.forwardOrigin.trustedHosts[] : un hôte interne n'échoue PAS le build (avertissement seul, jamais une exception)", () => {
    const root = writeConfig({ render: { forwardOrigin: { trustedHosts: ['localhost', '127.0.0.1'] } } })
    assert.doesNotThrow(() => findConfig(root))
  })

  it('render.forwardOrigin: { trustedHosts: [] } (tableau vide) → throw', () => {
    const root = writeConfig({ render: { forwardOrigin: { trustedHosts: [] } } })
    assert.throws(() => findConfig(root), /render\.forwardOrigin\.trustedHosts doit être un tableau non vide/)
  })

  it('render.forwardOrigin: { autre: 1 } (clé inconnue) → throw listant trustedHosts', () => {
    const root = writeConfig({ render: { forwardOrigin: { autre: 1 } } })
    assert.throws(() => findConfig(root), /render\.forwardOrigin\.autre : clé inconnue[\s\S]*Clé valide : trustedHosts/)
  })

  it('render.forwardOrigin: 42 (nombre, ni booléen/chaîne/objet) → throw', () => {
    const root = writeConfig({ render: { forwardOrigin: 42 } })
    assert.throws(() => findConfig(root), /render\.forwardOrigin doit être un booléen, une origine/)
  })

  it('(j) route avec settleMs + engine valides est acceptée tel quel', () => {
    const root = writeConfig({
      render: { routes: { '/blog': { component: 'mjs-blog', mode: 'ssr', settleMs: 200, engine: 'browser' } } },
    })
    const found = findConfig(root)
    assert.ok(found)
    assert.equal(found!.config.render!.routes!['/blog'].settleMs, 200)
    assert.equal(found!.config.render!.routes!['/blog'].engine, 'browser')
  })

  it('(k) route settleMs: 0 (doit être > 0) → throw', () => {
    const root = writeConfig({
      render: { routes: { '/blog': { component: 'mjs-blog', settleMs: 0 } } },
    })
    assert.throws(() => findConfig(root), /render\.routes\['\/blog'\]\.settleMs doit être un entier > 0/)
  })

  it("(l) route engine: 'chrome' (valeur hors liste) → throw", () => {
    const root = writeConfig({
      render: { routes: { '/blog': { component: 'mjs-blog', engine: 'chrome' } } },
    })
    assert.throws(() => findConfig(root), /render\.routes\['\/blog'\]\.engine invalide/)
  })

  it('(m) clé de route inconnue (typo) → throw listant component, mode, settleMs, engine', () => {
    const root = writeConfig({
      render: { routes: { '/blog': { component: 'mjs-blog', settleMz: 200 } } },
    })
    assert.throws(() => findConfig(root), /render\.routes\['\/blog'\]\.settleMz : clé inconnue[\s\S]*Clés valides : component, mode, settleMs, engine/)
  })
})
