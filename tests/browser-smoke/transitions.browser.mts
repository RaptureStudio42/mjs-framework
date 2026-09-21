// BANC navigateur RÉEL des transitions et animations (Chromium + Firefox, via playwright, PAS
// @playwright/test) — hors de `npm test` (extension `.mts`, cf. smoke.browser.mts), lancé par
// `npm run test:browser`. Motif (20/09/2026) : une démo de transitions de vue du site vitrine est
// restée MORTE en production sans qu'aucun test ne bronche — le build de prod n'expose plus
// `window.µ`, dont la démo dépendait. Aucun test du dépôt ne jouait une transition dans un vrai
// navigateur sur un build de PRODUCTION : happy-dom n'anime rien, et le seul smoke navigateur ne
// couvrait que les modules cœur en build de dev.
//
// Ce banc compile la fixture `fixture-transitions/` DEUX fois (`mjs build --dev`, puis `--prod`,
// minifié, noms raccourcis) et, pour chaque build et chaque moteur, joue TOUS les cas qui
// pourraient casser en silence :
//   - chaque animation intégrée (fade, fly, slide, scale, blur, elastic_*, typewriter, draw, iris,
//     volet, zoom, zoomOut, swipe, bars, blocks) en entrée ET en sortie ;
//   - les appariées dans un {key} (reveal, flip, cube, turn) ;
//   - `µanim.create` en forme css et en forme tick, `@in`/`@out` dissociés, `.shared`, `.global`
//     + `@childtransition="all"`, les 4 événements de transition, {key} + typewriter ;
//   - le cross-fade `µanim.crossfade` entre deux listes, `@flip`, `µinterpolate`, `µspring` ;
//   - la transition de PAGE `@viewTransition.cube` du routeur (`document.startViewTransition`
//     espionné avant tout script, comme dans script/landing_browser_smoke.mjs du site) ;
//   - et, sur la SORTIE compilée, la présence de chaque animation intégrée utilisée — la garde
//     muette du build (une anim non détectée = « personne n'en a besoin », cf. bundler/features.ts).
//
// Signal d'une transition : `getAnimations({ subtree: true })` sur le nœud (WAAPI — fade/fly/css…)
// ou, en mode tick (typewriter, typer), la longueur du texte qui progresse. Le premier rendu
// n'anime jamais (règle documentée, docs/10) : chaque cas démarre VISIBLE, le 1er clic joue la
// sortie, le 2e l'entrée.
//
// Shadow DOM fermé (mjs_element.ts) : accès par la propriété interne `_shadow`, comme partout
// dans tests/. Le serveur est un statique minimal maison (pas `mjs dev` : ici on veut aussi le
// build de prod, que le serveur dev ne produit pas).

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, copyFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, firefox } from 'playwright'

const __dirname      = dirname(fileURLToPath(import.meta.url))
const MODULARJS_ROOT = join(__dirname, '..', '..')
const FIXTURE_DIR    = join(__dirname, 'fixture-transitions')
const OUT_DIR        = join(FIXTURE_DIR, 'sortie')
const BIN_MJS        = join(MODULARJS_ROOT, 'bin', 'mjs')
const HOST           = 'mjs-anim-cases'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.map': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
}

// animations INTÉGRÉES que la fixture référence par `@transition.x`/`@in.x`/`@out.x` — chacune doit
// se retrouver dans la sortie compilée sous la forme `anim.x =` (nom PUBLIC, jamais raccourci)
const BUILTINS = ['fade', 'fly', 'slide', 'scale', 'blur', 'elastic_fly', 'elastic_scale', 'typewriter', 'draw', 'iris', 'volet', 'zoom', 'zoomOut', 'swipe', 'bars', 'blocks', 'reveal', 'flip', 'cube', 'turn', 'crossfade', 'create']

// cas {if} à un seul nœud racine : sortie puis entrée, signal WAAPI (`anim`) ou texte (`tick`) ;
// `outro: false` = nœud IMBRIQUÉ dans son bloc (le tracé SVG sous <svg>) : seule l'entrée est exigée
type ToggleCase = { id: string; signal: 'anim' | 'tick'; outro?: boolean }
const TOGGLES: ToggleCase[] = [
  { id: 'fade', signal: 'anim' }, { id: 'fly', signal: 'anim' }, { id: 'slide', signal: 'anim' },
  { id: 'scale', signal: 'anim' }, { id: 'blur', signal: 'anim' }, { id: 'elastic_fly', signal: 'anim' },
  { id: 'elastic_scale', signal: 'anim' }, { id: 'typewriter', signal: 'tick' }, { id: 'draw', signal: 'anim', outro: false },
  { id: 'iris', signal: 'anim' }, { id: 'volet', signal: 'anim' }, { id: 'zoom', signal: 'anim' },
  { id: 'zoomOut', signal: 'anim' }, { id: 'swipe', signal: 'anim' }, { id: 'bars', signal: 'anim' },
  { id: 'blocks', signal: 'anim' }, { id: 'spin', signal: 'anim' }, { id: 'typer', signal: 'tick' },
  { id: 'inout', signal: 'anim' }, { id: 'shared', signal: 'anim' }, { id: 'events', signal: 'anim' },
]
const DECKS = ['reveal', 'flip', 'cube', 'turn']

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = addr && typeof addr === 'object' ? addr.port : 0
      srv.close(() => resolvePort(port))
    })
  })
}

// serveur statique minimal sur FIXTURE_DIR — `/sortie/index.html`, `/sortie/bundle.js`, fichiers hachés
function serveFixture(port: number): Promise<any> {
  const server = createServer((req, res) => {
    const url  = new URL(req.url || '/', 'http://x')
    const rel  = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '')
    const file = join(FIXTURE_DIR, rel)
    if (!file.startsWith(FIXTURE_DIR) || !existsSync(file) || !statSync(file).isFile()) { res.statusCode = 404; res.end('absent'); return }
    res.setHeader('Content-Type', MIME[extname(file)] || 'application/octet-stream')
    res.setHeader('Cache-Control', 'no-store')
    createReadStream(file).pipe(res)
  })
  return new Promise((resolveSrv, reject) => {
    server.on('error', reject)
    server.listen(port, '127.0.0.1', () => resolveSrv(server))
  })
}

function buildFixture(mode: 'dev' | 'prod'): void {
  rmSync(OUT_DIR, { recursive: true, force: true })
  const r = spawnSync(process.execPath, [BIN_MJS, 'build', '--root', FIXTURE_DIR, mode === 'prod' ? '--prod' : '--dev'], { encoding: 'utf-8', timeout: 120000 })
  assert.equal(r.status, 0, `mjs build --${mode} en échec :\n${r.stdout}\n${r.stderr}`)
  assert.ok(existsSync(join(OUT_DIR, 'bundle.js')), `bundle.js absent après mjs build --${mode}`)
  mkdirSync(OUT_DIR, { recursive: true })
  copyFileSync(join(FIXTURE_DIR, 'index.html'), join(OUT_DIR, 'index.html'))
}

// tout le JS émis par le build, concaténé — pour prouver que chaque animation intégrée demandée y est
function emittedJs(): string {
  const parts: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.js')) parts.push(readFileSync(p, 'utf-8'))
    }
  }
  walk(OUT_DIR)
  return parts.join('\n')
}

describe('banc navigateur réel : transitions, animations et transitions de vue (dev + prod)', function () {
  this.timeout(600000)

  let server: any = null
  let port = 0

  before(async function () {
    port   = await freePort()
    server = await serveFixture(port)
  })

  after(async function () {
    if (server) await new Promise<void>((r) => server.close(() => r()))
    rmSync(OUT_DIR, { recursive: true, force: true })
  })

  for (const mode of ['dev', 'prod'] as const) {
    describe(`build ${mode}`, function () {
      before(function () { buildFixture(mode) })

      it(`la sortie compilée porte chacune des ${BUILTINS.length} animations intégrées utilisées`, function () {
        const js = emittedJs()
        const absentes = BUILTINS.filter((n) => !new RegExp(`\\.anim\\.${n}\\s*=`).test(js))
        assert.deepEqual(absentes, [], `animations demandées par la fixture mais ABSENTES du build ${mode} : ${absentes.join(', ')}`)
      })

      for (const engine of [chromium, firefox]) {
        describe(`moteur ${engine.name()}`, function () {
          let browser: any = null
          let page: any = null
          const consoleIssues: string[] = []

          // le repli shadow fermé et l'espion des transitions de vue, posés AVANT tout script de page
          const arm = async (p: any) => {
            await p.addInitScript(() => {
              const w = window as any
              w.__vt = 0
              w.__root = (el: any) => el._shadow || el.shadowRoot
              const nativeVt = (document as any).startViewTransition?.bind(document)
              w.__vtSupported = !!nativeVt
              if (nativeVt) (document as any).startViewTransition = (cb: any) => { w.__vt++; return nativeVt(cb) }
            })
          }

          before(async function () {
            browser = await engine.launch()
            page    = await browser.newPage()
            await arm(page)
            page.on('console', (m: any) => { if (m.type() === 'error') consoleIssues.push(`[${engine.name()}/${mode}] console.error: ${m.text()}`) })
            page.on('pageerror', (e: any) => { consoleIssues.push(`[${engine.name()}/${mode}] pageerror: ${e.message}`) })
            await page.goto(`http://127.0.0.1:${port}/sortie/index.html`, { waitUntil: 'load' })
            await page.waitForFunction((host: string) => {
              const el: any = document.querySelector(host)
              const sh = el && (el._shadow || el.shadowRoot)
              return !!(sh && sh.querySelector('#btn-fade') && sh.querySelector('[data-case="fade"]'))
            }, HOST, { timeout: 30000 })
          })

          after(async function () {
            if (browser) await browser.close()
          })

          // --- outils d'observation, tous exécutés DANS la page (shadow fermé) ---
          const clic = (sel: string) => page.evaluate(([host, sel]: string[]) => {
            const sh: any = (window as any).__root(document.querySelector(host))
            const el = sh.querySelector(sel)
            if (!el) throw new Error(`bouton absent : ${sel}`)
            el.click()
          }, [HOST, sel])
          const etat = (sel: string) => page.evaluate(([host, sel]: string[]) => {
            const sh: any = (window as any).__root(document.querySelector(host))
            const els: any[] = [...sh.querySelectorAll(sel)]
            return {
              n: els.length,
              animes: els.filter((e) => e.getAnimations({ subtree: true }).length > 0).length,
              textes: els.map((e) => e.textContent.trim()),
              transforms: els.map((e) => getComputedStyle(e).transform),
            }
          }, [HOST, sel])
          const texte = (sel: string) => page.evaluate(([host, sel]: string[]) => {
            const sh: any = (window as any).__root(document.querySelector(host))
            return sh.querySelector(sel)?.textContent.trim() ?? null
          }, [HOST, sel])
          const attendre = async (pred: () => Promise<boolean>, ms: number, quoi: string) => {
            const fin = Date.now() + ms
            while (Date.now() < fin) { if (await pred()) return; await page.waitForTimeout(40) }
            assert.fail(`délai dépassé (${ms} ms) : ${quoi}`)
          }
          const pause = (ms: number) => page.waitForTimeout(ms)

          for (const c of TOGGLES) {
            it(`${c.id} : sortie puis entrée animées`, async function () {
              const sel   = `[data-case="${c.id}"]`
              const avant = await etat(sel)
              assert.equal(avant.n, 1, `${c.id} : nœud initial absent`)
              const pleinTexte = avant.textes[0]
              await clic(`#btn-${c.id}`)
              await pause(60)
              const sortie = await etat(sel)
              if (c.outro !== false) {
                assert.equal(sortie.n, 1, `${c.id} : le nœud a disparu SANS jouer sa sortie`)
                if (c.signal === 'anim') assert.ok(sortie.animes >= 1, `${c.id} : aucune animation WAAPI pendant la sortie`)
                else assert.ok(sortie.textes[0].length < pleinTexte.length, `${c.id} : le texte ne raccourcit pas pendant la sortie`)
              }
              await attendre(async () => (await etat(sel)).n === 0, 2000, `${c.id} : le nœud devrait être retiré après sa sortie`)
              await clic(`#btn-${c.id}`)
              await pause(60)
              const entree = await etat(sel)
              assert.equal(entree.n, 1, `${c.id} : le nœud n'est pas revenu`)
              if (c.signal === 'anim') assert.ok(entree.animes >= 1, `${c.id} : aucune animation WAAPI pendant l'entrée`)
              else assert.ok(entree.textes[0].length < pleinTexte.length, `${c.id} : le texte ne se tape pas lettre à lettre à l'entrée`)
              await attendre(async () => { const e = await etat(sel); return e.n === 1 && e.animes === 0 && e.textes[0] === pleinTexte }, 2000, `${c.id} : l'entrée devrait se terminer sur le texte complet, sans animation résiduelle`)
            })
          }

          it('événements : outrostart → outroend, puis introstart → introend', async function () {
            await clic('#btn-events')
            await pause(60)
            assert.equal(await texte('#status'), 'outrostart')
            await attendre(async () => (await texte('#status')) === 'outroend', 2000, 'outroend attendu')
            await clic('#btn-events')
            await pause(60)
            assert.equal(await texte('#status'), 'introstart')
            await attendre(async () => (await texte('#status')) === 'introend', 2000, 'introend attendu')
          })

          it('.global + @childtransition="all" : les enfants jouent leur sortie quand le parent se ferme, et leur entrée quand il s\'ouvre', async function () {
            const sel = '[data-case="global"]'
            assert.equal((await etat(sel)).n, 3)
            await clic('#btn-global')
            await pause(60)
            const sortie = await etat(sel)
            assert.ok(sortie.n === 3 && sortie.animes >= 1, `enfants retirés d'un bloc sans jouer leur sortie (${JSON.stringify(sortie)})`)
            await attendre(async () => (await etat(sel)).n === 0, 2000, 'les 3 enfants devraient être retirés après leur sortie')
            await clic('#btn-global')
            await pause(60)
            const entree = await etat(sel)
            assert.ok(entree.n === 3 && entree.animes >= 1, `enfants revenus sans entrée animée (${JSON.stringify(entree)})`)
          })

          it('{key} : reveal, flip, cube, turn jouent la passation, puis un seul nœud reste', async function () {
            await clic('#btn-face')
            await pause(60)
            for (const d of DECKS) {
              const e = await etat(`[data-deck="${d}"] [data-case]`)
              assert.ok(e.animes >= 1, `${d} : aucune animation pendant la passation (${JSON.stringify(e)})`)
            }
            for (const d of DECKS) {
              await attendre(async () => { const e = await etat(`[data-deck="${d}"] [data-case]`); return e.n === 1 && e.animes === 0 && e.textes[0] === `${d} 1` }, 2500, `${d} : un seul nœud « ${d} 1 » attendu à la fin`)
            }
          })

          it('{key} + @in.typewriter : le nouveau message se tape lettre à lettre', async function () {
            await clic('#btn-keyed')
            await pause(60)
            const e = await etat('[data-deck="keyed"] [data-case="keyed"]')
            assert.ok(e.n >= 1 && e.textes.some((t: string) => t.length < 'message numero 1'.length), `texte tapé d'un bloc (${JSON.stringify(e)})`)
            await attendre(async () => { const e = await etat('[data-deck="keyed"] [data-case="keyed"]'); return e.n === 1 && e.textes[0] === 'message numero 1' }, 2500, 'message complet attendu')
          })

          it('cross-fade : la tâche terminée vole vers la seconde liste', async function () {
            await clic('#btn-finish')
            await pause(60)
            const recu = await etat('[data-list="done"] [data-case="done"]')
            assert.ok(recu.n === 1 && recu.animes >= 1 && recu.transforms[0] !== 'none', `réception sans vol (${JSON.stringify(recu)})`)
            await attendre(async () => { const a = await etat('[data-list="todo"] [data-case="todo"]'); const b = await etat('[data-list="done"] [data-case="done"]'); return a.n === 2 && b.n === 1 && a.animes === 0 && b.animes === 0 }, 2500, 'listes stabilisées à 2 + 1 attendues')
            assert.deepEqual((await etat('[data-list="done"] [data-case="done"]')).textes, ['un'])
          })

          it('@flip : le réordonnancement glisse les éléments', async function () {
            await clic('#btn-shuffle')
            await pause(60)
            const e = await etat('[data-list="order"] [data-case="order"]')
            assert.ok(e.n === 4 && e.animes >= 2, `réordonnancement sans glissement (${JSON.stringify(e)})`)
            await attendre(async () => { const e = await etat('[data-list="order"] [data-case="order"]'); return e.animes === 0 && e.textes.join('') === '4321' }, 2500, 'ordre inversé attendu sans animation résiduelle')
          })

          it('µinterpolate : la valeur avance en 400 ms vers la cible', async function () {
            assert.equal(await texte('#progress'), '0')
            await clic('#btn-progress')
            await pause(150)
            const milieu = Number(await texte('#progress'))
            assert.ok(milieu > 0 && milieu < 100, `valeur figée ou déjà arrivée à 150 ms : ${milieu}`)
            await attendre(async () => (await texte('#progress')) === '100', 2000, '100 attendu')
          })

          it('µspring : le ressort rejoint sa cible', async function () {
            assert.equal(await texte('#size'), '10')
            await clic('#btn-size')
            await pause(100)
            const milieu = Number(await texte('#size'))
            assert.ok(milieu !== 10, 'ressort immobile à 100 ms')
            await attendre(async () => Math.abs(Number(await texte('#size')) - 30) <= 1, 4000, '≈ 30 attendu')
          })

          it('@viewTransition.cube : la navigation permute la vue, enveloppée par startViewTransition quand le moteur le sait', async function () {
            const supporte = await page.evaluate(() => (window as any).__vtSupported)
            await clic('#lnk-b')
            await attendre(async () => page.evaluate((host: string) => !!(window as any).__root(document.querySelector(host)).querySelector('mjs-vt-page-b'), HOST), 3000, 'page B attendue dans la vue')
            const appels = await page.evaluate(() => (window as any).__vt)
            if (supporte) assert.ok(appels >= 1, `startViewTransition jamais appelé (${appels})`)
          })

          it('aucune erreur console ni pageerror pendant tout le banc', function () {
            assert.deepEqual(consoleIssues, [])
          })
        })
      }
    })
  }
})
