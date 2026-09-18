// µres PLEIN dès le 1er chargement HTML. Avant ce correctif, la branche HTML de render-server.ts
// ne résolvait JAMAIS les props d'un chargeur .server.mjs (seule la branche JSON le faisait) : un
// composant qui lit `µres.x` au montage voyait un sac vide tant que l'utilisateur n'avait pas
// navigué. Désormais la branche HTML appelle le MÊME `entry.propsFor` et sérialise le résultat
// dans une balise `<script type="application/json" id="__mjs_res">`, rattrapée ICI (jamais de 500
// pour un chargeur en échec sur une page HTML — contrairement à la branche JSON, cf. test 33 de
// serve-protocol-loaders-forms.test.ts, laissée inchangée).
//
// Deux harnais dans ce fichier :
//   - serveur : mjsTmp + startRenderServer + fetch, calqué sur render-nav-target-method.test.ts.
//   - client  : extraction de la SOURCE réelle de mjs_store_globals.ts (pas un mock), même
//     technique que tests/ujs-noujs-optout.test.ts — new Function() sur le bloc extrait.

import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mjsTmp, sweepRegistered } from './helpers/tmp.js'
import { startRenderServer } from '../src/server/render-server.js'

after(() => sweepRegistered())

// ═══ Serveur — render-server.ts, branche HTML ═══════════════════════════════════════════════

const FIXTURE = `export default {
  props: {
    '/': (params, req) -> { name: 'Ada', role: 'admin' }
    '/xss': (params, req) -> { bio: '</script><script>window.__pwned = true</script>' }
    '/boom': (params, req) ->
      throw new Error('chargeur cassé')
  }
}
`

// config PARTAGÉE : 4 routes CSR — '/' (props non vides), '/vide' (déclarée mais absente de la
// table `props` du chargeur), '/boom' (chargeur qui jette), '/xss' (valeur à échapper).
function setup() {
  const root = mjsTmp('nav-res-first-load')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(srcDir, 'home.mjs'), '<h1>Salut</h1>')
  writeFileSync(join(outDir, 'manifest.js'), 'µ.paths = {};\nµ.version = "abcd1234";\n')
  writeFileSync(join(root, 'serve.server.mjs'), FIXTURE)
  const config = {
    sourceDir: 'src', outputDir: 'out', manifestPath: 'out/manifest.js',
    render: {
      routes: {
        '/':     { component: 'mjs-home', mode: 'csr' as const },
        '/vide': { component: 'mjs-vide', mode: 'csr' as const },
        '/boom': { component: 'mjs-boom', mode: 'csr' as const },
        '/xss':  { component: 'mjs-xss',  mode: 'csr' as const },
      },
    },
  }
  return { root, config }
}

// isole le JSON brut (encore échappé) entre les bornes de la balise __mjs_res, ou null si absente
function extractResTag(html: string): string | null {
  const m = html.match(/<script type="application\/json" id="__mjs_res">([\s\S]*?)<\/script>/)
  return m ? m[1] : null
}

describe('render-server — µres au 1er chargement HTML', () => {
  it('1. route AVEC chargeur (props non vides) : la balise __mjs_res porte les bonnes valeurs', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/`)
      assert.equal(res.status, 200)
      const html = await res.text()
      const raw = extractResTag(html)
      assert.ok(raw, 'la balise __mjs_res doit être présente')
      assert.deepEqual(JSON.parse(raw!), { name: 'Ada', role: 'admin' })
    } finally { await running.close() }
  })

  it("2. route déclarée mais ABSENTE de la table `props` du chargeur : aucune balise __mjs_res", async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/vide`)
      assert.equal(res.status, 200)
      const html = await res.text()
      assert.equal(extractResTag(html), null, 'route sans entrée de chargeur → props {} → zéro octet ajouté')
      assert.match(html, /<mjs-vide><\/mjs-vide>/)
    } finally { await running.close() }
  })

  it("3. serveur SANS fichier d'entrée du tout : aucune balise __mjs_res, page servie normalement", async function () {
    this.timeout(15000)
    const root = mjsTmp('nav-res-first-load-noentry')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'home.mjs'), '<h1>Salut</h1>')
    const config = { sourceDir: 'src', outputDir: 'out', render: { routes: { '/': { component: 'mjs-home', mode: 'csr' as const } } } }
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/`)
      assert.equal(res.status, 200)
      const html = await res.text()
      assert.equal(extractResTag(html), null)
      assert.match(html, /<mjs-home><\/mjs-home>/)
    } finally { await running.close() }
  })

  it('4. chargeur qui JETTE : la page HTML est servie quand même (200), pas de balise, pas de 500', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/boom`)
      assert.equal(res.status, 200, "un chargeur en échec ne doit JAMAIS transformer un 200 HTML en 500")
      const html = await res.text()
      assert.equal(extractResTag(html), null)
      assert.match(html, /<mjs-boom><\/mjs-boom>/)
      assert.match(html, /<script type="module" src="\/__mjs\/bundle\.js">/)
    } finally { await running.close() }
  })

  it("5. échappement : une valeur de prop contenant littéralement '</script>' ne casse pas le document", async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/xss`)
      assert.equal(res.status, 200)
      const html = await res.text()
      const raw = extractResTag(html)
      assert.ok(raw, 'la balise __mjs_res doit être présente et correctement délimitée')
      assert.doesNotMatch(raw!, /</,
        "AUCUN '<' littéral ne doit survivre dans le JSON sérialisé (mêmes garanties que serializeGlobal/__mjs_store)")
      assert.deepEqual(JSON.parse(raw!), { bio: '</script><script>window.__pwned = true</script>' },
        "round-trip exact via JSON.parse, aucune perte d'info")
      // le VRAI <script> qui charge le bundle reste un terminateur reconnu, jamais avalé comme texte
      assert.match(html, /<script type="module" src="\/__mjs\/bundle\.js"><\/script>/)
    } finally { await running.close() }
  })
})

// ═══ Client — mjs_store_globals.ts, lecture de #__mjs_res au boot ═══════════════════════════
//
// Extraction de la SOURCE réelle (pas un mock) : sabote le fichier n'y ferait rougir aucun test
// si on ne testait qu'un double. Le bloc est un `try {...} catch (__re) {...}` top-level (pas une
// fonction nommée) : extraction par ancre littérale (try → catch (__re) { → 1re accolade fermante
// qui suit, le corps du catch n'ayant lui-même aucune accolade imbriquée).

const __dirname = dirname(fileURLToPath(import.meta.url))
const STORE_GLOBALS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_store_globals.ts'), 'utf-8')

function extractResBootBlock(): string {
  // ancre PRÉCISE (variable __mjsResEl, propre à CE bloc — le fichier porte un autre `try {`
  // pour la réhydratation du store, `__mjsStoreEl`, PLUS TÔT dans le fichier ; un ancrage nu sur
  // `try \{` matcherait ce premier try venu, puis dévorerait tout le fichier jusqu'au `catch
  // (__re)`, accolades non balancées à l'exécution) — puis extraction try→catch DEPUIS cette
  // position exacte (`^`, pas une recherche libre).
  const startRe = /try \{\s*\n\s*if \(typeof document !== 'undefined' && document\.getElementById\) \{\s*\n\s*var __mjsResEl/
  const start = STORE_GLOBALS_SRC.match(startRe)
  assert.ok(start, "bloc __mjs_res introuvable (structure de mjs_store_globals.ts a changé ?)")
  const rest = STORE_GLOBALS_SRC.slice(start!.index!)
  const full = rest.match(/^try \{[\s\S]*?catch \(__re\) \{[\s\S]*?\n\}/)
  assert.ok(full, "bloc __mjs_res : catch (__re) introuvable après le try (structure a changé ?)")
  return full![0]
}

function runResBoot(µ: any, document: any): void {
  new Function('µ', 'document', extractResBootBlock())(µ, document)
}

function fakeDoc(el: any): any {
  return { getElementById: (id: string) => (id === '__mjs_res' ? el : null) }
}

describe('mjs_store_globals (source réelle) — réhydratation de µres depuis #__mjs_res au boot', () => {
  it('balise présente, JSON valide : µ._mjs_resSet est appelé avec les props décodées', () => {
    const calls: any[] = []
    const warns: any[] = []
    const µ = { _mjs_resSet: (p: any) => calls.push(p), warn: (...a: any[]) => warns.push(a) }
    const el = { textContent: JSON.stringify({ name: 'Ada' }) }
    runResBoot(µ, fakeDoc(el))
    assert.deepEqual(calls, [{ name: 'Ada' }])
    assert.equal(warns.length, 0)
  })

  it("balise ABSENTE (getElementById renvoie null) : µ._mjs_resSet n'est PAS appelé, pas de warn", () => {
    const calls: any[] = []
    const warns: any[] = []
    const µ = { _mjs_resSet: (p: any) => calls.push(p), warn: (...a: any[]) => warns.push(a) }
    runResBoot(µ, fakeDoc(null))
    assert.equal(calls.length, 0)
    assert.equal(warns.length, 0)
  })

  it("JSON corrompu : µ._mjs_resSet n'est PAS appelé, un µ.warn signale l'échec, AUCUNE exception ne remonte", () => {
    const calls: any[] = []
    const warns: any[] = []
    const µ = { _mjs_resSet: (p: any) => calls.push(p), warn: (...a: any[]) => warns.push(a) }
    const el = { textContent: '{ pas du json valide' }
    assert.doesNotThrow(() => runResBoot(µ, fakeDoc(el)))
    assert.equal(calls.length, 0)
    assert.equal(warns.length, 1)
  })

  it('document indéfini (contexte non-navigateur) : silence total, pas de crash', () => {
    const calls: any[] = []
    const warns: any[] = []
    const µ = { _mjs_resSet: (p: any) => calls.push(p), warn: (...a: any[]) => warns.push(a) }
    assert.doesNotThrow(() => runResBoot(µ, undefined))
    assert.equal(calls.length, 0)
    assert.equal(warns.length, 0)
  })
})
