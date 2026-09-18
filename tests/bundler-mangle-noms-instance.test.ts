// production — noms courts des propriétés internes `_mjs_*` (esbuild `mangleProps`, cache partagé
// `<outputDir>/.mangle-cache.json`) contre les noms qu'une instance de composant porte PAR NOM :
// clés d'état reprises au montage (boucle `_mjs_var_bits` de connectedCallback), props posées par un
// parent sur un enfant pas encore défini, méthodes posées sur l'instance. esbuild ne réserve un nom
// de propriété que DANS la transformation qui le voit : le cœur, minifié après les composants,
// pouvait donner à `_mjs_dead` le nom d'un état `$g` — le composant affichait `false`.
//
// Montage dans un Chromium réel : la page charge `bundle.js` servi en HTTP, avec les modules hachés
// tels qu'écrits sur disque (happy-dom ne charge pas un découpage minifié, l'alias d'import du cœur
// y disparaît). Chromium absent : les montages sont sautés, les assertions sur le cache écrit et
// sur la construction restent.

import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, extname, normalize } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { collectInstanceNames, reserveMangleNames, RESERVED_NAME_MAX_LENGTH } from '../src/bundler/minify.js'

type JsMode = 'split' | 'bundle'
type Cache  = Record<string, string | false>

interface Projet { root: string; srcDir: string; outDir: string }

const LETTRES = 'abcdefghijklmnopqrstuvwxyz'.split('')

function projet(prefix: string): Projet {
  const root   = mjsTmp(prefix)
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  return { root, srcDir, outDir }
}

// un composant par lettre : l'état porte le nom de la lettre, le HTML l'affiche
function ecrireLettres(srcDir: string): void {
  for(const l of LETTRES) writeFileSync(join(srcDir, `v-${l}.mjs`), `<script>\n$${l} = 'ok'\n</script>\n<p>{$${l}}</p>\n`)
}

function nouveauBundler(p: Projet, js: JsMode): Bundler {
  return new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: join(p.outDir, 'bundle.js'), urlPrefix: '/out', env: 'prod', js })
}

async function construire(p: Projet, js: JsMode = 'split'): Promise<void> {
  const bundler = nouveauBundler(p, js)
  const stats   = await bundler.compile()
  await bundler.close()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
}

function lireCache(p: Projet): Cache {
  return JSON.parse(readFileSync(join(p.outDir, '.mangle-cache.json'), 'utf-8'))
}

// propriétés internes dont le nom court est un des noms donnés
function collisions(cache: Cache, noms: string[]): string[] {
  return Object.entries(cache).filter(([, court]) => typeof court === 'string' && noms.includes(court)).map(([prop, court]) => `${prop} → ${court}`).sort()
}

// chaque fichier de out/ (points compris) → son contenu, pour comparer deux constructions à l'octet
function instantane(outDir: string): Record<string, string> {
  const out: Record<string, string> = {}
  for(const f of readdirSync(outDir).sort()) {
    const chemin = join(outDir, f)
    if(statSync(chemin).isFile()) out[f] = readFileSync(chemin, 'latin1')
  }
  return out
}

// sert la page puis les fichiers de out/ tels qu'écrits ; `retards` retient les fichiers dont le nom
// commence par une clé (un enfant défini après le rendu de son parent)
async function servir(p: Projet, body: string, retards: Record<string, number> = {}): Promise<{ url: string; server: Server }> {
  const html   = `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}<script type="module" src="/out/bundle.js"></script></body></html>`
  const server = createServer((req, res) => {
    const chemin  = decodeURIComponent((req.url ?? '/').split('?')[0])
    const envoyer = () => {
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
    }
    const nom    = chemin.split('/').pop() ?? ''
    const retard = Object.entries(retards).find(([prefixe]) => nom.startsWith(prefixe))
    if(retard) setTimeout(envoyer, retard[1])
    else envoyer()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  return { url: `http://127.0.0.1:${(server.address() as any).port}/`, server }
}

// textes rendus (les <p> et <b> de chaque ombre, joints par |) de chaque composant de la page, ombres
// comprises — des chaînes seulement, jamais un nœud
async function monter(browser: any, p: Projet, body: string, balises: string[], retards: Record<string, number> = {}): Promise<{ rendus: Record<string, string>; erreurs: string[] }> {
  const { url, server }   = await servir(p, body, retards)
  const page              = await browser.newPage()
  const erreurs: string[] = []
  page.on('pageerror', (e: Error) => erreurs.push(e.message))
  page.on('console', (m: any) => { if(m.type() === 'error') erreurs.push(m.text()) })
  try {
    await page.goto(url, { waitUntil: 'load' })
    // attente bornée : un composant cassé n'a jamais d'ombre rendue, on relit quand même ce qui est là
    await page.waitForFunction((attendues: string[]) => {
      const vus       = new Set<string>()
      const parcourir = (racine: any) => {
        for(const el of Array.from(racine.querySelectorAll('*')) as any[]) {
          if(!el.tagName.startsWith('MJS-')) continue
          if(el._shadow && !el.hasAttribute('mjs-loading')) vus.add(el.tagName.toLowerCase())
          if(el._shadow) parcourir(el._shadow)
        }
      }
      parcourir(document)
      return attendues.every(b => vus.has(b))
    }, balises, { timeout: 10000 }).catch(() => {})
    await page.waitForTimeout(100)
    const rendus = await page.evaluate(() => {
      const out: Record<string, string> = {}
      const parcourir                   = (racine: any) => {
        for(const el of Array.from(racine.querySelectorAll('*')) as any[]) {
          if(!el.tagName.startsWith('MJS-')) continue
          out[el.tagName.toLowerCase()] = el._shadow ? Array.from(el._shadow.querySelectorAll('p, b')).map((n: any) => n.textContent).join('|') : '(sans ombre)'
          if(el._shadow) parcourir(el._shadow)
        }
      }
      parcourir(document)
      return out
    })
    return { rendus, erreurs }
  }
  finally {
    await page.close()
    await new Promise(resolve => server.close(() => resolve(null)))
  }
}

async function chromiumDisponible(): Promise<any> {
  try {
    const playwright = await import('playwright')
    if(!existsSync(playwright.chromium.executablePath())) return null
    return await playwright.chromium.launch()
  }
  catch {
    return null
  }
}

describe('production — noms courts des propriétés internes et noms portés par une instance', function () {
  this.timeout(180000)
  let browser: any = null

  before(async function () {
    this.timeout(30000)
    browser = await chromiumDisponible()
    if(!browser) console.log('  ℹ️  Chromium non installé : montages sautés, assertions de construction gardées. Activer : `npx playwright install chromium`')
  })

  after(async () => {
    if(browser) await browser.close()
    await terminateSharedWorkerPool()
  })

  for(const js of ['split', 'bundle'] as JsMode[]) {
    it(`js: '${js}' — les 26 composants $a…$z construits sans cache affichent tous ok`, async function () {
      const p = projet(`mangle-lettres-${js}`)
      ecrireLettres(p.srcDir)
      await construire(p, js)
      assert.deepEqual(collisions(lireCache(p), LETTRES), [], 'aucune propriété interne ne doit prendre le nom d\'un état')
      if(!browser) return
      const balises             = LETTRES.map(l => `mjs-v-${l}`)
      const { rendus, erreurs } = await monter(browser, p, balises.map(b => `<${b}></${b}>`).join(''), balises)
      const attendu             = Object.fromEntries(balises.map(b => [b, 'ok']))
      assert.deepEqual(rendus, attendu, `rendus faux — erreurs de page : ${erreurs.join(' / ') || 'aucune'}`)
    })
  }

  it('cache pollué d\'avance (_mjs_dead → g) : le composant $g affiche ok et le cache écrit ne mappe plus rien vers g', async function () {
    const p = projet('mangle-cache-pollue')
    mkdirSync(p.outDir, { recursive: true })
    writeFileSync(join(p.outDir, '.mangle-cache.json'), JSON.stringify({ _mjs_dead: 'g' }))
    writeFileSync(join(p.srcDir, 'v-g.mjs'), '<script>\n$g = \'ok\'\n</script>\n<p>{$g}</p>\n')
    await construire(p)
    const cache = lireCache(p)
    assert.deepEqual(collisions(cache, ['g']), [], 'la correspondance polluée doit être retirée du cache')
    assert.equal(cache.g, false, 'g doit être réservé dans le cache écrit')
    if(!browser) return
    const { rendus, erreurs } = await monter(browser, p, '<mjs-v-g></mjs-v-g>', ['mjs-v-g'])
    assert.deepEqual(rendus, { 'mjs-v-g': 'ok' }, `rendu faux — erreurs de page : ${erreurs.join(' / ') || 'aucune'}`)
  })

  it('props de noms courts posées par un parent sur un enfant défini après lui, et méthodes d\'instance de noms courts : valeurs intactes', async function () {
    const p = projet('mangle-props-methodes')
    writeFileSync(join(p.srcDir, 'parent.mjs'), `<script>\nv = 'ok'\n</script>\n<@enfant ${LETTRES.map(l => `${l}={v}`).join(' ')}>\n`)
    writeFileSync(join(p.srcDir, 'enfant.mjs'), `<p>${LETTRES.map(l => `{$${l}}`).join(',')}</p>\n`)
    writeFileSync(join(p.srcDir, 'methodes.mjs'), `<script>\n${LETTRES.map(l => `@${l} = -> '${l}'`).join('\n')}\nµmount ->\n  $monte = 'monte'\n</script>\n<p>${LETTRES.map(l => `{@${l}()}`).join('')}</p>\n<b>{$monte}</b>\n`)
    await construire(p)
    assert.deepEqual(collisions(lireCache(p), LETTRES), [], 'aucune propriété interne ne doit prendre le nom d\'une prop ou d\'une méthode')
    if(!browser) return
    // le module de l'enfant arrive 500 ms après le rendu du parent : les props sont posées sur un
    // élément pas encore mis à niveau, que le constructeur de l'enfant ne doit pas écraser
    const { rendus, erreurs } = await monter(browser, p, '<mjs-parent></mjs-parent><mjs-methodes></mjs-methodes>', ['mjs-parent', 'mjs-enfant', 'mjs-methodes'], { 'enfant-': 500 })
    assert.equal(rendus['mjs-enfant'], LETTRES.map(() => 'ok').join(','), `props de l'enfant faussées — erreurs de page : ${erreurs.join(' / ') || 'aucune'}`)
    assert.equal(rendus['mjs-methodes'], `${LETTRES.join('')}|monte`, `méthodes ou montage faussés — erreurs de page : ${erreurs.join(' / ') || 'aucune'}`)
    assert.deepEqual(erreurs, [], 'aucune erreur de page')
  })

  it('deux constructions successives du même projet : sorties identiques à l\'octet, cache compris', async function () {
    const p = projet('mangle-deux-constructions')
    ecrireLettres(p.srcDir)
    writeFileSync(join(p.srcDir, 'parent.mjs'), `<script>\nv = 'ok'\n@r = -> v\n</script>\n<@enfant g={v} s={@r()}>\n`)
    writeFileSync(join(p.srcDir, 'enfant.mjs'), '<p>{$g}{$s}</p>\n')
    await construire(p)
    const premiere = instantane(p.outDir)
    await construire(p)
    const seconde = instantane(p.outDir)
    assert.deepEqual(Object.keys(seconde), Object.keys(premiere), 'mêmes fichiers émis')
    for(const f of Object.keys(premiere)) assert.ok(seconde[f] === premiere[f], `${f} diffère d'une construction à l'autre`)
  })

  for(const js of ['split', 'bundle'] as JsMode[]) {
    it(`js: '${js}', même instance (surveillance) — un état ajouté qui prend le nom court d'une propriété interne re-minifie les unités déjà en cache`, async function () {
      const p = projet(`mangle-surveillance-${js}`)
      writeFileSync(join(p.srcDir, 'a-base.mjs'), '<script>\n$message = \'ok\'\n</script>\n<p>{$message}</p>\n')
      const bundler = nouveauBundler(p, js)
      try {
        const stats1 = await bundler.compile()
        assert.equal(stats1.errors.length, 0, stats1.errors.map((e: any) => e.message).join('\n'))
        // noms courts pris au 1er tour par une méthode que le code du composant appelle et par une
        // propriété propre posée au montage. Le nom court n'est PAS forcément d'une seule lettre :
        // le cœur porte plus de propriétés internes que l'alphabet n'a de lettres, le raccourcisseur
        // passe à deux caractères dès l'épuisement — et certains de ces noms commencent par `_`, qui
        // ne s'écrit pas derrière un `$`. Ce que le scénario exige, c'est un nom utilisable tel quel
        // comme nom d'état (`$<nom>`) : on prend, dans chaque famille, le premier qui l'est.
        const cache1     = lireCache(p)
        const utilisable = (n: unknown): n is string => typeof n === 'string' && /^[a-zA-Z][a-zA-Z0-9]*$/.test(n)
        const monte      = [cache1._mjs_mount, cache1._mjs_hook, cache1._mjs_updText].find(utilisable)
        const mort       = [cache1._mjs_dead, cache1._mjs_is_mounted, cache1._mjs_pending_full, cache1._mjs_effects].find(utilisable)
        assert.ok(utilisable(monte), `une méthode citée par le composant doit avoir pris un nom court utilisable comme nom d'état : ${JSON.stringify([cache1._mjs_mount, cache1._mjs_hook, cache1._mjs_updText])}`)
        assert.ok(utilisable(mort), `une propriété posée sur l'instance doit avoir pris un nom court utilisable comme nom d'état : ${JSON.stringify([cache1._mjs_dead, cache1._mjs_is_mounted, cache1._mjs_pending_full, cache1._mjs_effects])}`)
        assert.notEqual(monte, mort, 'les deux noms courts doivent être distincts pour que le scénario ait deux collisions')
        writeFileSync(join(p.srcDir, 'b-neuf.mjs'), `<script>\n$${monte} = 'ok'\n$${mort} = 'ok'\n</script>\n<p>{$${monte}}{$${mort}}</p>\n`)
        const recompiles: string[] = []
        const froid                = (bundler as any).compileMjsCold.bind(bundler)
        ;(bundler as any).compileMjsCold = (file: string, ...rest: any[]) => {
          recompiles.push(file.split('/').pop() as string)
          return froid(file, ...rest)
        }
        const stats2 = await bundler.compile()
        assert.equal(stats2.errors.length, 0, stats2.errors.map((e: any) => e.message).join('\n'))
        assert.deepEqual(collisions(lireCache(p), [monte, mort]), [], 'les noms de b-neuf ne doivent plus nommer aucune propriété interne')
        assert.ok(recompiles.includes('a-base.mjs'), `a-base.mjs, minifié avec des correspondances retirées, doit être re-minifié au même tour — recompilés : ${recompiles.join(', ')}`)
      }
      finally {
        await bundler.close()
      }
      if(!browser) return
      const { rendus, erreurs } = await monter(browser, p, '<mjs-a-base></mjs-a-base><mjs-b-neuf></mjs-b-neuf>', ['mjs-a-base', 'mjs-b-neuf'])
      assert.deepEqual(rendus, { 'mjs-a-base': 'ok', 'mjs-b-neuf': 'okok' }, `rendus faux — erreurs de page : ${erreurs.join(' / ') || 'aucune'}`)
    })
  }
})

describe('relevé des noms portés par une instance et réservation dans le cache de raccourcissement', function () {
  it('relève les noms courts écrits en accès pointé, en clé d\'objet, en littéral et en raccourci d\'objet', function () {
    const code = [
      'this.a = 1; x?.bb',
      'const o = { c: 1, "d": 2 }',
      'node._set(\'e\', v); node["f"] = v; `g`',
      'µ.merge(this, { h, i }); const p = { j() {} }; const { k = 1 } = p'
    ].join('\n')
    assert.deepEqual(collectInstanceNames(code), ['a', 'bb', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'])
  })

  it('ignore les noms plus longs que ceux du raccourcisseur, l\'étalement et les nombres', function () {
    const long = 'x'.repeat(RESERVED_NAME_MAX_LENGTH + 1)
    assert.deepEqual(collectInstanceNames(`this.ok = 1; this.${long} = 1; f(...xs); [...ys]; const n = 1.5; o = { ${long}: 2 }; '${long}'`), ['ok'])
  })

  it('retire toute correspondance vers un nom réservé, pose nom: false et rend les propriétés retirées', function () {
    const cache: Record<string, string | false> = { _mjs_dead: 'g', _mjs_dir: 't', _mjs_mount: 'r', h: false }
    const retirees                              = reserveMangleNames(cache, ['r', 'g', 'z'])
    assert.deepEqual(retirees, ['_mjs_dead', '_mjs_mount'])
    assert.deepEqual(cache, { _mjs_dir: 't', h: false, g: false, r: false, z: false })
  })

  it('une réservation déjà en place ne retire rien', function () {
    const cache: Record<string, string | false> = { _mjs_dead: 'q', g: false }
    assert.deepEqual(reserveMangleNames(cache, ['g']), [])
    assert.deepEqual(cache, { _mjs_dead: 'q', g: false })
  })
})
