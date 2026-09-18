// render-browser — INTÉGRATION réelle du moteur navigateur (vrai Chromium, via
// Playwright). Complète render-engine-resolution.test.ts (logique pure, sans
// navigateur) : ici on lance un VRAI navigateur et on vérifie ce que happy-dom ne
// peut PAS prouver — µmount qui s'exécute pour de vrai, DSD natif, réutilisation du
// pool, respect de settleMs.
//
// Garde de disponibilité — même motif que tests/browser-playwright.test.ts (le
// seul autre test « à Chromium optionnel » de la suite) : si Chromium n'est pas
// installé (`npx playwright install chromium` jamais lancé), les tests se
// SKIPPENT proprement au lieu de planter. Contrairement à ce fichier-là (opt-in
// via MJS_PLAYWRIGHT=1 — un COMPLÉMENT de fidélité, hors suite par défaut), CE
// fichier valide le comportement central : il tourne SANS variable
// d'opt-in supplémentaire dès que Chromium est disponible.
//
//   xvfb-run -a npx mocha tests/render-browser.test.ts --extension ts --require tsx/esm --exit
//
// (headless:true — jamais besoin d'un `--headless` nu hors xvfb ; vérifié
// empiriquement dans ce dépôt, cf. browser-playwright.test.ts, avant d'écrire ce
// fichier : `chromium.launch({headless:true})` fonctionne SOUS xvfb-run sans
// réserve particulière.)

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { createBrowserRenderer } from '../src/server/render-browser.js'
import { createSSRRenderer } from '../src/server/renderToString.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'

// Même serveur d'écho que tests/render-forward-origin.test.ts (happy-dom) —
// répond à /api/qui avec le cookie brut reçu, sert de « vraie origine » pour le
// PROXY forwardOrigin du moteur navigateur (cf. render-browser.ts, routeHandler).
function startEchoServer(): Promise<{ origin: string; close: () => Promise<void> }> {
  return new Promise((resolveStart) => {
    const server = createServer((req, res) => {
      if (req.url === '/api/qui') {
        res.setHeader('content-type', 'text/plain')
        res.end(req.headers.cookie || 'ANONYME')
        return
      }
      res.statusCode = 404
      res.end('Not Found')
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any
      resolveStart({
        origin: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      })
    })
  })
}

async function isChromiumAvailable(): Promise<boolean> {
  try {
    const playwright = await import('playwright')
    return existsSync(playwright.chromium.executablePath())
  } catch {
    return false
  }
}

function project(): string {
  const root = mjsTmp('render-browser')
  mkdirSync(join(root, 'src'), { recursive: true })
  return root
}

describe('render-browser — moteur navigateur (Chromium réel, via Playwright)', () => {
  let chromiumReady = false

  before(async function () {
    this.timeout(10000)
    chromiumReady = await isChromiumAvailable()
    if (!chromiumReady) {
      console.log("  ℹ️  Chromium non installé, tests render-browser skippés. Activer : `npx playwright install chromium`")
    }
  })

  after(async () => { await terminateSharedWorkerPool() })

  it('@mount s\'exécute POUR DE VRAI (contrairement au SSR happy-dom, court-circuité par µ._isServer)', async function () {
    if (!chromiumReady) { this.skip(); return }
    this.timeout(60000)
    const root = project()
    writeFileSync(join(root, 'src', 'mount-test.mjs'), `
<script lang="coffee">
$status = 'avant montage'
µmount ->
  $status = 'monte cote client'
</script>
<p class="status">{$status}</p>
`)
    // Moteur navigateur : @mount doit avoir tourné, le HTML contient le texte posé
    // PAR le hook (pas celui de l'état initial).
    const browserRenderer = await createBrowserRenderer({ sourceDir: 'src', outputDir: 'out' }, { configDir: root })
    try {
      const res = await browserRenderer.renderPage('mjs-mount-test', {})
      assert.match(res.html, /monte cote client/, '@mount doit avoir mute $status avant la sérialisation')
      assert.doesNotMatch(res.html, /avant montage/, 'le texte pré-montage ne doit pas subsister dans le HTML sérialisé')
      assert.match(res.html, /<template shadowrootmode="open">/, 'DSD (Declarative Shadow DOM) attendu, comme le moteur happy-dom')
    } finally {
      await browserRenderer.close()
    }

    // Contraste : LE MÊME composant rendu par le moteur happy-dom (µ._isServer
    // court-circuite @mount, cf. mjs_element.ts) doit lui rester sur l'état
    // INITIAL — preuve que la différence observée ci-dessus vient bien du moteur,
    // pas d'un artefact du fixture.
    const happyRenderer = await createSSRRenderer({ sourceDir: join(root, 'src'), outputDir: join(root, 'out-happy') })
    try {
      const res = await happyRenderer.renderToString('mjs-mount-test')
      assert.match(res.html, /avant montage/, 'happy-dom : @mount ne tourne PAS, l\'état initial doit rester tel quel')
      assert.doesNotMatch(res.html, /monte cote client/, 'happy-dom : la mutation posée par @mount ne doit JAMAIS apparaître')
    } finally {
      await happyRenderer.close()
    }
  })

  it('µserver (µ.server) vaut true dans CE moteur aussi, MALGRÉ µ._isServer volontairement absent', async function () {
    if (!chromiumReady) { this.skip(); return }
    this.timeout(60000)
    const root = project()
    // {if µserver} doit sortir ICI comme au SSR happy-dom — même axe PUBLIC,
    // vrai sur LES DEUX moteurs — alors que @mount (test précédent) tourne, lui,
    // pour de vrai dans ce moteur (µ._isServer interne reste absent, cf. en-tête
    // de fichier render-browser.ts). Les deux flags divergent volontairement.
    writeFileSync(join(root, 'src', 'server-flag.mjs'), `
<script lang="coffee">
</script>
{if µserver}<p class="s">COTE-SERVEUR</p>{end}
{if not µserver}<p class="c">COTE-CLIENT</p>{end}
`)
    const browserRenderer = await createBrowserRenderer({ sourceDir: 'src', outputDir: 'out' }, { configDir: root })
    try {
      const res = await browserRenderer.renderPage('mjs-server-flag', {})
      assert.match(res.html, /COTE-SERVEUR/, 'µ.server doit être true dans le moteur navigateur aussi (axe PUBLIC uniforme)')
      assert.doesNotMatch(res.html, /COTE-CLIENT/, 'la branche "not µserver" ne doit jamais sortir, quel que soit le moteur')
    } finally {
      await browserRenderer.close()
    }
  })

  it('settleMs : un rendu trop court échoue à se stabiliser (warning), un délai suffisant capture le contenu résolu', async function () {
    if (!chromiumReady) { this.skip(); return }
    this.timeout(60000)
    const root = project()
    // La promesse résout à 300ms — laisse une marge nette entre un settleMs COURT
    // (50ms, insuffisant) et un settleMs LARGE (1500ms, largement suffisant).
    writeFileSync(join(root, 'src', 'delayed.mjs'), `
<script lang="coffee">
$p = new Promise((resolve) -> setTimeout((-> resolve("CHARGE")), 300))
</script>
{await $p}<span class="pending">chargement</span>{success val}<span class="done">{val}</span>{error err}<span class="err">erreur</span>{end}
`)
    const renderer = await createBrowserRenderer({ sourceDir: 'src', outputDir: 'out' }, { configDir: root })
    try {
      const short = await renderer.renderPage('mjs-delayed', { settleMs: 50 })
      assert.ok(
        short.warnings.some(w => /non stabilisé/.test(w)),
        'settleMs trop court (50ms < 300ms de résolution) doit produire un warning de non-stabilisation',
      )

      const long = await renderer.renderPage('mjs-delayed', { settleMs: 1500 })
      assert.doesNotMatch(long.warnings.join('\n'), /non stabilisé/, 'settleMs largement suffisant ne doit PAS avertir')
      assert.match(long.html, /CHARGE/, 'le contenu résolu doit être capturé une fois settleMs suffisant')
      assert.doesNotMatch(long.html, /chargement/, 'le pending state ne doit pas subsister une fois résolu')
    } finally {
      await renderer.close()
    }
  })

  it('pool réutilisé : un 2e rendu (page/contexte recyclés) est nettement plus rapide que le 1er (navigateur déjà lancé)', async function () {
    if (!chromiumReady) { this.skip(); return }
    this.timeout(60000)
    const root = project()
    writeFileSync(join(root, 'src', 'simple.mjs'), '<p>simple</p>')
    const renderer = await createBrowserRenderer({ sourceDir: 'src', outputDir: 'out' }, { configDir: root })
    try {
      const t0 = Date.now()
      await renderer.renderPage('mjs-simple', {})
      const firstMs = Date.now() - t0

      const t1 = Date.now()
      await renderer.renderPage('mjs-simple', {})
      const secondMs = Date.now() - t1

      assert.ok(
        secondMs < firstMs,
        `2e rendu (${secondMs}ms) doit être plus rapide que le 1er (${firstMs}ms) — preuve de réutilisation du navigateur/pool ` +
        `(le 1er inclut le lancement de Chromium, coûteux ; le 2e réutilise un contexte/page déjà prêts)`,
      )
    } finally {
      await renderer.close()
    }
  })

  it('deux rendus CONCURRENTS avec un pool de taille 1 ne se collisionnent JAMAIS (chacun son état, même en file)', async function () {
    if (!chromiumReady) { this.skip(); return }
    this.timeout(60000)
    const root = project()
    // NOTE méthodologique (essayé puis abandonné en écrivant ce test) — un témoin
    // par TIMING (délai artificiel + comparaison à un repère chronométré) semblait
    // pouvoir prouver qu'un pool de taille 1 sérialise vraiment 2 rendus
    // concurrents (file d'attente) plutôt que de dépasser silencieusement sa
    // taille. Abandonné : vérifié empiriquement peu fiable dans CET environnement
    // (xvfb) — le coût de CRÉATION d'un emplacement (contexte + page) s'est avéré
    // du même ordre de grandeur que le délai de rendu lui-même, rendant le rapport
    // 1×/2× attendu indiscernable du bruit de mesure (parfois même AVEC la
    // régression réintroduite délibérément pour vérifier le test). Le test
    // ci-dessous reste donc un test de CORRECTION FONCTIONNELLE (aucune collision
    // d'état entre 2 rendus concurrents, quel que soit le nombre RÉEL d'emplacements
    // sollicités) — pas une preuve du respect strict de `browserPool.size` sous
    // charge, garanti par relecture du code (`acquire()`/`reserved`, cf. son
    // commentaire dans render-browser.ts : réservation SYNCHRONE avant tout await).
    writeFileSync(join(root, 'src', 'echo.mjs'), `
<script lang="coffee">
</script>
<p class="v">{$label}</p>
`)
    const renderer = await createBrowserRenderer(
      { sourceDir: 'src', outputDir: 'out', render: { browserPool: { size: 1 } } },
      { configDir: root },
    )
    try {
      const [a, b] = await Promise.all([
        renderer.renderPage('mjs-echo', { props: { label: 'A' } }),
        renderer.renderPage('mjs-echo', { props: { label: 'B' } }),
      ])
      assert.match(a.html, /label="A"/)
      assert.match(b.html, /label="B"/)
      assert.match(a.html, />A</, 'le rendu A ne doit pas être pollué par le contenu de B (pas de collision d\'état)')
      assert.match(b.html, />B</, 'le rendu B ne doit pas être pollué par le contenu de A (pas de collision d\'état)')
    } finally {
      await renderer.close()
    }
  })

  it('render.forwardOrigin (proxy) : une cible réseau INTERNE (loopback) reste bloquée MÊME passée directement en forwardedUrl — défense en profondeur au point de consommation (SSRF)', async function () {
    if (!chromiumReady) { this.skip(); return }
    this.timeout(60000)
    const root = project()
    writeFileSync(join(root, 'src', 'qui.mjs'), `
<script lang="coffee">
$promise = fetch('/api/qui').then((r) -> r.text())
</script>
{await $promise}<span class="pending">chargement</span>{success txt}<span class="who">{txt}</span>{error err}<span class="err">{err.message}</span>{end}
`)
    const echo = await startEchoServer()
    try {
      const renderer = await createBrowserRenderer({ sourceDir: 'src', outputDir: 'out' }, { configDir: root })
      try {
        // AVANT le fix SSRF : `forwardedUrl` posé au loopback de
        // l'écho armait le proxy sans AUCUNE validation — le composant recevait
        // le cookie transmis. `isBlockedForwardTarget` (forward-origin.ts) est
        // maintenant appliquée ICI, au point de consommation de `renderPage`, PAS
        // seulement dans `computeForwardedOrigin` (render-request.ts) — même un
        // appelant DIRECT de cette API bas niveau (comme ce test) ne peut plus
        // faire router le proxy vers une IP interne. Le chemin non-asset reste
        // 404 (proxy désarmé), comme si `forwardedUrl` était absent.
        const res = await renderer.renderPage('mjs-qui', {
          forwardedUrl: echo.origin + '/',
          forwardedCookie: 'sid=secret-browser',
          settleMs: 5000,
        })
        assert.doesNotMatch(res.html, /secret-browser/, 'le cookie ne doit JAMAIS atteindre une cible réseau interne, même passée directement en forwardedUrl')
        assert.ok(res.warnings.some((w) => /cible réseau interne bloquée/.test(w)), 'un avertissement doit signaler le refus (warnings du résultat de rendu)')
      } finally {
        await renderer.close()
      }
    } finally {
      await echo.close()
    }
  })

  it("SANS forwardOrigin (forwardedUrl absent) : le chemin non-asset reste un 404 — comportement HISTORIQUE inchangé", async function () {
    if (!chromiumReady) { this.skip(); return }
    this.timeout(60000)
    const root = project()
    writeFileSync(join(root, 'src', 'qui404.mjs'), `
<script lang="coffee">
$promise = fetch('/api/qui').then((r) -> r.status)
</script>
{await $promise}<span class="pending">chargement</span>{success code}<span class="code">{code}</span>{error err}<span class="err">{err.message}</span>{end}
`)
    const renderer = await createBrowserRenderer({ sourceDir: 'src', outputDir: 'out' }, { configDir: root })
    try {
      const res = await renderer.renderPage('mjs-qui404', { settleMs: 3000 })
      assert.match(res.html, /class="code">404</, 'sans forwardOrigin, le chemin non-asset doit rester un 404 (pas de proxy)')
    } finally {
      await renderer.close()
    }
  })

  // AVANT le fix, `renderPage`
  // n'avait AUCUN plafond global : un `@mount` qui pend bloquait indéfiniment
  // le `finally{ release(slot) }` (poolSize défaut 2 → épuisable en 2
  // requêtes, déni de service du SSR). Repro RÉELLE (pas une simulation) —
  // un hook `µmount` avec une boucle SYNCHRONE de 4s : `connectedCallback`
  // l'appelle SANS `await` (mjs_element.ts, `this._mjs_hooks.mount.call
  // (this)`), donc elle bloque le THREAD JS de la page pendant toute sa
  // durée — exactement le `page.evaluate` de montage (non borné AVANT le
  // fix) que `renderTimeoutMs` doit maintenant couper.
  //
  // NOTE méthodologique (essayé puis abandonné) — l'AUTRE repro envisagée
  // (« fetch proxifié suspendu », `render.forwardOrigin` vers un
  // serveur qui ne répond jamais) est IRRÉALISABLE en test ici : toute cible
  // de test locale (loopback/réseau privé) est REFUSÉE par la défense SSRF
  // (`isBlockedForwardTarget`, cf. le test juste au-dessus) —
  // c'est le comportement VOULU, pas une lacune du test. Le câblage de
  // `renderSignal` sur le `fetch()` proxifié (render-browser.ts ~402) reste
  // donc vérifié par LECTURE + `tsc --noEmit` (même échéance, même variable
  // que le plafond global ci-dessous — cf. son commentaire), pas par un test
  // à Chromium réel qui exigerait une cible réseau publique.
  it("un @mount qui pend (boucle synchrone) ne fuit PAS le slot de pool : timeout global, slot repris, cas nominal inchangé", async function () {
    if (!chromiumReady) { this.skip(); return }
    this.timeout(60000)
    const root = project()
    writeFileSync(join(root, 'src', 'busy.mjs'), `
<script lang="coffee">
µmount ->
  target = Date.now() + 4000
  null while Date.now() < target
</script>
<p>mounted</p>
`)
    writeFileSync(join(root, 'src', 'fast.mjs'), '<p class="ok">rapide</p>')

    const renderTimeoutMs = 1200
    const renderer = await createBrowserRenderer(
      { sourceDir: 'src', outputDir: 'out', render: { browserPool: { size: 2, renderTimeoutMs } } },
      { configDir: root },
    )
    try {
      // Cas nominal AVANT tout hang — mesure de référence, doit rester rapide
      // (preuve que la course timeout/rendu n'introduit AUCUN ralentissement
      // du chemin commun).
      const t0 = Date.now()
      const baseline = await renderer.renderPage('mjs-fast', {})
      const baselineMs = Date.now() - t0
      assert.match(baseline.html, /rapide/)

      // 2 rendus qui pendent, poolSize=2 : consomment les DEUX slots. Chacun
      // doit rejeter AVANT `renderTimeoutMs` + marge généreuse (jamais
      // pendre jusqu'à la fin de la boucle de 4s côté page).
      for (let i = 1; i <= 2; i++) {
        const th0 = Date.now()
        await assert.rejects(
          renderer.renderPage('mjs-busy', { settleMs: 500 }),
          /abandonné après \d+ms \(timeout de rendu/,
          `hang #${i} : renderPage doit rejeter avec l'erreur de timeout dédiée`,
        )
        const elapsed = Date.now() - th0
        assert.ok(
          elapsed < renderTimeoutMs + 3000,
          `hang #${i} : rejeté en ${elapsed}ms, attendu bien avant renderTimeoutMs(${renderTimeoutMs}ms) + marge — jamais jusqu'à la fin de la boucle de 4s`,
        )
      }

      // Preuve directe qu'AUCUN slot n'a fui : une 3e requête (composant
      // rapide, sans rapport avec le hang) doit encore passer — poolSize=2
      // aurait épuisé le pool à vie SANS le correctif (finally{release}
      // jamais atteint sur les 2 rendus précédents).
      const t1 = Date.now()
      const after = await renderer.renderPage('mjs-fast', {})
      const afterMs = Date.now() - t1
      assert.match(after.html, /rapide/, 'le pool doit encore servir des rendus après 2 hangs consécutifs (aucun slot fuité)')
      assert.ok(
        afterMs < renderTimeoutMs,
        `rendu rapide APRÈS 2 hangs : ${afterMs}ms, doit rester net en dessous de renderTimeoutMs (${renderTimeoutMs}ms) — pool toujours opérationnel`,
      )
      assert.ok(
        baselineMs < renderTimeoutMs,
        `chemin nominal (référence AVANT tout hang) : ${baselineMs}ms, doit rester net en dessous de renderTimeoutMs — non ralenti par la course`,
      )
    } finally {
      await renderer.close()
    }
  })

  // Graine `#__mjs_i18n`. Ce moteur ne pose PAS `µ._isServer` (cf.
  // en-tête de fichier) : `_ensure()` y fetche pour de VRAI (routeHandler
  // proxifie vers `outputDir/i18n/…`, cf. render-browser.ts), `µ._i18nCache`
  // porte donc de vraies données résolues — source différente du moteur
  // happy-dom (`µ._i18nUsed`, cf. renderToString.ts), même balise en sortie.
  // `@i18nPlaceholder wait` : le 1er rendu ATTEND le fragment (mjs_i18n.ts),
  // donc le fetch a fini AVANT settleRender — pas de dépendance à un timing
  // de résolution asynchrone après stabilisation.
  // CORRECTIF — `sections` nichée PAR LANGUE (`{lang:{section:…}}`) : ici une seule
  // langue en jeu (fr, effective ET par défaut), donc `sections.fr.panier`. Le cas REPLI (langue
  // effective ≠ défaut) est un test À PART, juste en dessous : ce moteur (`_i18nCache`)
  // n'est PAS le moteur happy-dom (`_i18nUsed`) — une couverture côté happy-dom ne prouve RIEN ici,
  // les deux graines sont bâties par du code entièrement différent (cf. render-browser.ts/
  // renderToString.ts).
  it('graine `__mjs_i18n` : section RÉELLEMENT fetchée semée dans sharedScript, section jamais consultée absente', async function () {
    if (!chromiumReady) { this.skip(); return }
    this.timeout(60000)
    const root = project()
    mkdirSync(join(root, 'src', 'i18n', 'fr'), { recursive: true })
    writeFileSync(join(root, 'src', 'i18n', 'fr.yml'), 'titre: Bienvenue\n')
    writeFileSync(join(root, 'src', 'i18n', 'fr', 'panier.yml'), 'resume: Résumé du panier\n')
    writeFileSync(join(root, 'src', 'i18n', 'fr', 'inutile.yml'), 'cle: "jamais"\n')
    writeFileSync(join(root, 'src', 'i18nseed.mjs'), [
      "@i18n 'panier'",
      '@i18nPlaceholder wait',
      '<p class="resume">{µt(\'resume\')}</p>',
    ].join('\n'))

    const renderer = await createBrowserRenderer({ sourceDir: 'src', outputDir: 'out', i18n: { default: 'fr' } }, { configDir: root })
    try {
      const res = await renderer.renderPage('mjs-i18nseed', { settleMs: 5000 })
      assert.match(res.html, /Résumé du panier/, 'la section attendue (mode wait) est bien résolue avant la sérialisation')
      assert.match(res.sharedScript, /id="__mjs_i18n"/, 'la balise graine i18n est émise')
      assert.match(res.sharedScript, /Résumé du panier/, 'la section RÉELLEMENT fetchée (µ._i18nCache, entry.data) est semée')
      assert.doesNotMatch(res.sharedScript, /jamais/, 'la section jamais consultée (inutile) est absente de la graine')
      const m = res.sharedScript.match(/id="__mjs_i18n">([\s\S]*?)<\/script>/)
      assert.ok(m, `bloc __mjs_i18n introuvable. sharedScript:\n${res.sharedScript}`)
      const parsed = JSON.parse(m![1])
      assert.equal(parsed.sections.fr.panier.resume, 'Résumé du panier', 'sections nichée par langue (fr), pas au niveau plat')
    } finally {
      await renderer.close()
    }
  })

  // Le repli de `_ensure` (mjs_i18n.ts, § Repli de section) pose
  // DEUX entrées dans `µ._i18nCache` pour une MÊME donnée : `defLang/section` (le vrai fetch) ET
  // `lang/section` (alias, même `entry.data`). AVANT ce correctif, l'ancien code (`parts[0] ===
  // entryLang`, aucun filtre sur le manifeste) semait les DEUX — la graine étiquetait `en` comme
  // traduite (`sections.en.panier` présent) alors qu'AUCUN fichier `i18n/en/panier.*` n'existe :
  // le client réhydraté croit `en` déjà résolue et n'affiche jamais l'avertissement dev de repli.
  // Section `panier` EXCLUSIVEMENT en `fr` (aucun `i18n/en/` créé du tout), rendu en `en`.
  it('graine `__mjs_i18n` : section EXISTANT SEULEMENT en fr, rendu en `en` (repli) — jamais étiquetée `en` dans la graine', async function () {
    if (!chromiumReady) { this.skip(); return }
    this.timeout(60000)
    const root = project()
    mkdirSync(join(root, 'src', 'i18n', 'fr'), { recursive: true })
    writeFileSync(join(root, 'src', 'i18n', 'fr.yml'), 'titre: Bienvenue\n')
    writeFileSync(join(root, 'src', 'i18n', 'en.json'), '{"titre":"Welcome"}\n')
    writeFileSync(join(root, 'src', 'i18n', 'fr', 'panier.yml'), 'resume: Résumé du panier\n')
    writeFileSync(join(root, 'src', 'i18nseed2.mjs'), [
      "@i18n 'panier'",
      '@i18nPlaceholder wait',
      '<p class="resume">{µt(\'resume\')}</p>',
    ].join('\n'))

    const renderer = await createBrowserRenderer({ sourceDir: 'src', outputDir: 'out', i18n: { default: 'fr' } }, { configDir: root })
    try {
      const res = await renderer.renderPage('mjs-i18nseed2', { settleMs: 5000, store: { __mjsLang: 'en' } })
      assert.match(res.html, /Résumé du panier/, 'texte de repli (fr) rendu malgré la langue effective en')
      const m = res.sharedScript.match(/id="__mjs_i18n">([\s\S]*?)<\/script>/)
      assert.ok(m, `bloc __mjs_i18n introuvable. sharedScript:\n${res.sharedScript}`)
      const parsed = JSON.parse(m![1])
      assert.equal(parsed.sections.fr && parsed.sections.fr.panier && parsed.sections.fr.panier.resume, 'Résumé du panier', 'la section repliée est semée sous SA langue réelle (fr)')
      assert.ok(!parsed.sections.en || !parsed.sections.en.panier, 'AUCUNE entrée `en.panier` : aucun fichier i18n/en/panier.* n\'existe, jamais un alias de repli étiqueté en')
    } finally {
      await renderer.close()
    }
  })
})
