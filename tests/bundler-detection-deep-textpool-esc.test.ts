// Trois familles de fonctions de mjs_init.ts, rattachées D'OFFICE au cœur jusqu'ici, chacune
// appelée par un code que le compilateur émet LITTÉRALEMENT — donc détectable sans faux négatif :
//
//   · `deep`     — `µ._mjs_deepSet`/`µ._mjs_deepCall`/`µ._mjs_deepDelete`/`µ._mjs_makeDeepProxy` (mjs_deep.ts),
//                  émis par le suiveur de chemins pour `$o.x = v`, `$liste.push(v)`,
//                  `delete $o.x` et les points de fuite (`µproxy`) ;
//   · `textpool` — `µ._mjs_getTextNode` et la libération qui va avec (mjs_textpool.ts), émis par le
//                  mode IMPÉRATIF du générateur pour ses placeholders de texte ;
//   · `esc`      — `µ._esc` (mjs_esc.ts), émis pour chaque interpolation d'un `<@head>` ou d'un
//                  `<@failed>` (les deux partent en innerHTML). Joint D'OFFICE hors production :
//                  le panneau de développement s'en sert pour son propre affichage.
//
// Un projet qui n'émet aucun de ces appels n'a jamais eu besoin de ces fonctions.

import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, extname, normalize } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { findConfig, resolveBundlerOpts } from '../src/bundler/config.js'
import { mjsTmp } from './helpers/tmp.js'

// définitions telles qu'écrites dans chaque module (build de développement : rien n'est minifié)
const MARQUE_DEEP     = 'µ._mjs_deepSet = function'
const MARQUE_TEXTPOOL = 'µ._mjs_getTextNode = function'
const MARQUE_ESC      = 'µ._esc = function'

interface Projet { root: string; outDir: string }

// Les cas `esc` passent `runtime: []` (cœur nu) : le panneau de développement, qui appelle
// `µ._esc` lui-même, n'est inséré que dans un build de dev NON nu — sans ce cadrage, il joindrait
// le module à lui seul et masquerait le signal testé ici.
async function construire(cfgExtra: any, sources: Record<string, string>, prefix = 'detect-init'): Promise<Projet> {
  const root   = mjsTmp(prefix)
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  for (const [name, content] of Object.entries(sources)) writeFileSync(join(srcDir, name), content)
  writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
    sourceDir: 'src', outputDir: 'out', manifestPath: 'out/bundle.js', urlPrefix: '/out', defaultScriptLang: 'civet', lint: { a11y: false }, ...cfgExtra
  }))
  const found = findConfig(root)
  assert.ok(found, 'mjs.config.json doit être trouvé')
  const opts    = resolveBundlerOpts(found!.config, found!.configDir)
  const bundler = new Bundler(opts as any)
  const stats   = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
  return { root, outDir }
}

function contenuCoeur(outDir: string): string {
  const coeur = readdirSync(outDir).find((f) => /^mjs_core-/.test(f))
  assert.ok(coeur, 'mjs_core-*.js doit exister')
  return readFileSync(join(outDir, coeur!), 'utf-8')
}

// sources d'appui — le composant NU n'émet aucun des trois appels
const NU        = { 'hop.mjs': '<script>\n$t = \'ok\'\n</script>\n<p>{$t}</p>\n' }
const ECRIT     = { 'hop.mjs': '<script>\n$o = { n: 1 }\nmaj = -> $o.n = 2\n</script>\n<p @click={maj()}>{$o.n}</p>\n' }
const POUSSE    = { 'hop.mjs': '<script>\n$xs = [1]\nadd = -> $xs.push(2)\n</script>\n<p @click={add()}>{$xs.length}</p>\n' }
const SUPPRIME  = { 'hop.mjs': '<script>\n$o = { n: 1 }\ndel = -> delete $o.n\n</script>\n<p @click={del()}>{$o.n}</p>\n' }
// {for} DANS une branche {await} : seule forme qui passe par le mode impératif du générateur,
// celui qui puise ses placeholders de texte dans le pool
const IMPERATIF = { 'hop.mjs': '<script>\n$p = Promise.resolve(1)\n$xs = [1]\n</script>\n<div>{await $p}<ul>{for x in $xs}<li>{x}</li>{end}</ul>{end}</div>\n' }
const TETE      = { 'hop.mjs': '<script>\n$t = \'ok\'\n</script>\n<@head><title>{$t}</title></@head>\n<p>{$t}</p>\n' }
const TETE_FIXE = { 'hop.mjs': '<script>\n$t = \'ok\'\n</script>\n<@head><title>fixe</title></@head>\n<p>{$t}</p>\n' }
const ECHEC     = { 'hop.mjs': '<script>\n$t = \'ok\'\n</script>\n<@failed err><p>oups {err}</p></@failed>\n<p>{$t}</p>\n' }

describe('mjs_deep.ts — mutations profondes détectées, build RÉEL', function () {
  this.timeout(120000)
  after(async () => { await terminateSharedWorkerPool() })

  it('composant sans mutation profonde : ABSENT', async function () {
    const coeur = contenuCoeur((await construire({}, NU)).outDir)
    assert.equal(coeur.includes(MARQUE_DEEP), false)
    assert.equal(coeur.includes('_mjs_makeDeepProxy'), false, 'aucune trace du module dans le cœur')
  })

  it('écriture `$o.n = 2` : PRÉSENT', async function () {
    assert.ok(contenuCoeur((await construire({}, ECRIT)).outDir).includes(MARQUE_DEEP))
  })

  it('méthode mutative `$xs.push(2)` : PRÉSENT', async function () {
    assert.ok(contenuCoeur((await construire({}, POUSSE)).outDir).includes(MARQUE_DEEP))
  })

  it('`delete $o.n` : PRÉSENT', async function () {
    assert.ok(contenuCoeur((await construire({}, SUPPRIME)).outDir).includes(MARQUE_DEEP))
  })

  it("runtime: ['deep'] sans usage : présent quand même (explicite gagne)", async function () {
    assert.ok(contenuCoeur((await construire({ runtime: ['deep'] }, NU)).outDir).includes(MARQUE_DEEP))
  })
})

describe('mjs_textpool.ts — pool de nœuds texte détecté, build RÉEL', function () {
  this.timeout(120000)
  after(async () => { await terminateSharedWorkerPool() })

  it('composant sans placeholder impératif : ABSENT', async function () {
    const coeur = contenuCoeur((await construire({}, NU)).outDir)
    assert.equal(coeur.includes(MARQUE_TEXTPOOL), false)
    assert.equal(coeur.includes('_mjs_recycleTextLeaves = '), false, 'la libération part avec le pool')
  })

  it('{for} dans une branche {await} (mode impératif) : PRÉSENT', async function () {
    const coeur = contenuCoeur((await construire({}, IMPERATIF)).outDir)
    assert.ok(coeur.includes(MARQUE_TEXTPOOL))
    assert.ok(coeur.includes('_mjs_recycleTextLeaves = '), 'la libération vient avec le pool')
  })

  it("runtime: ['textpool'] sans usage : présent quand même (explicite gagne)", async function () {
    assert.ok(contenuCoeur((await construire({ runtime: ['textpool'] }, NU)).outDir).includes(MARQUE_TEXTPOOL))
  })
})

describe('mjs_esc.ts — échappement HTML détecté, build RÉEL', function () {
  this.timeout(120000)
  after(async () => { await terminateSharedWorkerPool() })

  it('aucun <@head> ni <@failed> (cœur nu) : ABSENT', async function () {
    assert.equal(contenuCoeur((await construire({ runtime: [] }, NU, 'esc-nu')).outDir).includes(MARQUE_ESC), false)
  })

  it('<@head> SANS interpolation (cœur nu) : ABSENT — aucun appel émis', async function () {
    assert.equal(contenuCoeur((await construire({ runtime: [] }, TETE_FIXE, 'esc-tete-fixe')).outDir).includes(MARQUE_ESC), false)
  })

  it('<@head> avec interpolation : PRÉSENT', async function () {
    assert.ok(contenuCoeur((await construire({ runtime: [] }, TETE, 'esc-tete')).outDir).includes(MARQUE_ESC))
  })

  it('<@failed> avec interpolation : PRÉSENT', async function () {
    assert.ok(contenuCoeur((await construire({ runtime: [] }, ECHEC, 'esc-echec')).outDir).includes(MARQUE_ESC))
  })

  it('build de DÉVELOPPEMENT (panneau de développement embarqué) : PRÉSENT sans aucun usage', async function () {
    assert.ok(contenuCoeur((await construire({ runtime: ['ajax'] }, NU)).outDir).includes(MARQUE_ESC))
  })

  it("runtime: ['esc'] sans usage : présent quand même (explicite gagne)", async function () {
    assert.ok(contenuCoeur((await construire({ runtime: ['esc'] }, NU, 'esc-force')).outDir).includes(MARQUE_ESC))
  })
})

// ---------------------------------------------------------------------------
// Montage réel : un cœur SANS ces trois modules reste correct (les appels qu'il garde sont
// gardés), et un cœur QUI les embarque se comporte comme avant.
// ---------------------------------------------------------------------------

async function servir(p: Projet, body: string): Promise<{ url: string; server: Server }> {
  const html   = `<!doctype html><html><head><meta charset="utf-8"><title>page</title></head><body>${body}<script type="module" src="/out/bundle.js"></script></body></html>`
  const server = createServer((req, res) => {
    const chemin = decodeURIComponent((req.url ?? '/').split('?')[0])
    if(chemin === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }
    const fichier = join(p.root, normalize(chemin))
    if(!fichier.startsWith(p.outDir) || !existsSync(fichier) || !statSync(fichier).isFile()) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': extname(fichier) === '.js' ? 'text/javascript; charset=utf-8' : 'application/octet-stream' })
    res.end(readFileSync(fichier))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  return { url: `http://127.0.0.1:${(server.address() as any).port}/`, server }
}

async function chromiumDisponible(): Promise<any> {
  try {
    const playwright = await import('playwright')
    if(!existsSync(playwright.chromium.executablePath())) return null
    return await playwright.chromium.launch({ chromiumSandbox: false })
  }
  catch {
    return null
  }
}

describe('cœur sans (puis avec) deep/textpool/esc — montage dans Chromium', function () {
  this.timeout(180000)
  let browser: any = null

  before(async function () {
    this.timeout(60000)
    browser = await chromiumDisponible()
    if(!browser) console.log('  ℹ️  Chromium non installé : montages sautés.')
  })

  after(async () => {
    if(browser) await browser.close()
    await terminateSharedWorkerPool()
  })

  it('SANS les trois : une branche {if} qui se referme détruit ses nœuds sans erreur', async function () {
    const p = await construire({}, {
      'bas.mjs': '<script>\n$v = true\n$t = \'ok\'\nbascule = -> $v = not $v\n</script>\n<div><button class="b" @click={bascule()}>b</button>{if $v}<p class="cible">{$t}</p>{end}</div>\n'
    }, 'sans-trois')
    const coeur = contenuCoeur(p.outDir)
    assert.equal(coeur.includes(MARQUE_TEXTPOOL), false, 'ce cœur ne doit pas porter le pool')
    assert.equal(coeur.includes(MARQUE_DEEP), false, 'ce cœur ne doit pas porter les mutations profondes')
    if(!browser) return
    const { url, server }    = await servir(p, '<mjs-bas></mjs-bas>')
    const page               = await browser.newPage()
    const messages: string[] = []
    page.on('pageerror', (e: Error) => messages.push('pageerror: ' + e.message))
    page.on('console', (m: any) => { if(m.type() === 'error') messages.push('error: ' + m.text()) })
    try {
      await page.goto(url, { waitUntil: 'load' })
      await page.waitForTimeout(200)
      const etats: string[] = []
      for(const _ of [0, 1, 2]) {
        etats.push(await page.evaluate(() => {
          const el = document.querySelector('mjs-bas') as any
          return el && el._shadow ? String(el._shadow.querySelectorAll('.cible').length) + ':' + (el._shadow.querySelector('.cible')?.textContent ?? '') : '(sans ombre)'
        }))
        await page.evaluate(() => { (document.querySelector('mjs-bas') as any)._shadow.querySelector('.b').click() })
        await page.waitForTimeout(80)
      }
      assert.deepEqual(etats, ['1:ok', '0:', '1:ok'], `bascule cassée — console : ${messages.join(' / ') || 'vide'}`)
      assert.deepEqual(messages, [], 'aucune erreur de page attendue')
    }
    finally {
      await page.close()
      await new Promise(resolve => server.close(() => resolve(null)))
    }
  })

  it('AVEC les trois : mutation profonde, titre échappé et liste impérative se comportent comme avant', async function () {
    const p = await construire({}, {
      'tri.mjs': [
        '<script>',
        '$o = { n: 1 }',
        '$p = Promise.resolve(1)',
        '$xs = [7]',
        'maj = -> $o.n = $o.n + 1',
        '</script>',
        '<@head><title>{"t<&>" + $o.n}</title></@head>',
        '<div><button class="b" @click={maj()}>b</button><span class="n">{$o.n}</span>{await $p}<i>attente</i>{success v}<ul>{for x in $xs}<li class="x">{x}{v}</li>{end}</ul>{end}</div>'
      ].join('\n') + '\n'
    }, 'avec-trois')
    const coeur = contenuCoeur(p.outDir)
    assert.ok(coeur.includes(MARQUE_DEEP) && coeur.includes(MARQUE_TEXTPOOL) && coeur.includes(MARQUE_ESC), 'les trois modules doivent être joints')
    if(!browser) return
    const { url, server }    = await servir(p, '<mjs-tri></mjs-tri>')
    const page               = await browser.newPage()
    const messages: string[] = []
    page.on('pageerror', (e: Error) => messages.push('pageerror: ' + e.message))
    page.on('console', (m: any) => { if(m.type() === 'error') messages.push('error: ' + m.text()) })
    try {
      await page.goto(url, { waitUntil: 'load' })
      // la branche {await} se résout en microtâche APRÈS le premier rendu : on attend son
      // contenu (attente BORNÉE — un échec laisse quand même lire ce qui est là)
      await page.waitForFunction(() => {
        const el = document.querySelector('mjs-tri') as any
        return !!(el && el._shadow && el._shadow.querySelector('.x'))
      }, null, { timeout: 5000 }).catch(() => {})
      await page.waitForTimeout(100)
      const avant = await page.evaluate(() => {
        const el = document.querySelector('mjs-tri') as any
        return { n: el?._shadow?.querySelector('.n')?.textContent ?? '', item: el?._shadow?.querySelector('.x')?.textContent ?? '', titre: document.title }
      })
      assert.deepEqual(avant, { n: '1', item: '71', titre: 't<&>1' }, `rendu initial faux — console : ${messages.join(' / ') || 'vide'}`)
      await page.evaluate(() => { (document.querySelector('mjs-tri') as any)._shadow.querySelector('.b').click() })
      await page.waitForTimeout(120)
      const apres = await page.evaluate(() => {
        const el = document.querySelector('mjs-tri') as any
        return { n: el?._shadow?.querySelector('.n')?.textContent ?? '', titre: document.title }
      })
      assert.deepEqual(apres, { n: '2', titre: 't<&>2' }, `mutation profonde non propagée — console : ${messages.join(' / ') || 'vide'}`)
      assert.deepEqual(messages, [], 'aucune erreur de page attendue')
    }
    finally {
      await page.close()
      await new Promise(resolve => server.close(() => resolve(null)))
    }
  })
})
