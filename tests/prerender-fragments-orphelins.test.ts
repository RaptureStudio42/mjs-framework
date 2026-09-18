// Un fragment prérendu dont la ROUTE a disparu de la configuration reste un fichier COMPLET —
// servi tel quel par le back, avec le contenu et les liens de démarrage d'un build antérieur. Le
// prérendu retire donc, en fin de passe, les fragments QU'IL A ÉCRITS et qu'aucune page de la
// configuration courante n'attend, une ligne de journal par fichier.
//
// « Qu'il a écrits » se lit sur la PREMIÈRE LIGNE du fichier : la ligne-bandeau (marque
// `<!-- mjs:prerender`, ou l'ancien bandeau d'un build antérieur à cette marque). Tout autre `.html`
// est intouchable — coquille de l'application, page posée à la main, sortie d'un autre outil : rien
// n'oblige `render.outDir` à être un dossier réservé, il peut être partagé ou être la racine du
// projet. Le balayage est RÉCURSIF (le fragment d'une route imbriquée vit dans un sous-dossier), et
// un dossier vidé de ses fragments part avec eux. Une passe dont UNE page a échoué à se rendre ne
// retire rien : elle ne sait plus ce que le dossier devrait contenir (même garde que la purge des
// orphelins de `mjs build`).

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsTmp } from './helpers/tmp.js'
import { prerenderPages, prerenderBanner } from '../src/server/prerender.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'
import type { MjsConfig } from '../src/bundler/config.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

interface Projet { root: string; outDir: string }

// deux pages prérendables, `/` et `/blog` ; les fragments partent dans `<root>/mjs_pages`
function projet(prefix: string): Projet {
  const root   = mjsTmp(prefix)
  const srcDir = join(root, 'src')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'home.mjs'), '<h1 class="t">accueil</h1>\n')
  writeFileSync(join(srcDir, 'blog.mjs'), '<h2 class="b">blog</h2>\n')
  return { root, outDir: join(root, 'mjs_pages') }
}

function config(routes: Record<string, unknown>, extra: Record<string, unknown> = {}): MjsConfig {
  return {
    sourceDir: 'src',
    outputDir: 'out',
    manifestPath: 'out/bundle.js',
    render: { default: 'prerender', engine: { prerender: 'happy-dom' }, routes, ...extra },
  } as MjsConfig
}

const DEUX = { '/': { component: 'mjs-home' }, '/blog': { component: 'mjs-blog' } }
const UNE  = { '/': { component: 'mjs-home' } }

// fragment d'un build antérieur : première ligne = ligne-bandeau, le reste est du HTML complet
function fragmentEcrit(file: string, url: string, lang?: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${prerenderBanner(url, lang)}\n<h1>page d'un build antérieur</h1>\n`, 'utf-8')
}

async function prerendre(p: Projet, cfg: MjsConfig): Promise<string[]> {
  const journal: string[] = []
  await prerenderPages(cfg, p.root, m => journal.push(m))
  return journal
}

describe('prerender — fragments des routes retirées', function () {
  this.timeout(60000)

  after(async () => { await terminateSharedWorkerPool() })

  it('route retirée de la configuration : son fragment est supprimé, une ligne de journal le nomme', async () => {
    const p = projet('prerender-orphelin')
    await prerendre(p, config(DEUX))
    const blog    = join(p.outDir, 'blog.html')
    const index   = join(p.outDir, 'index.html')
    assert.ok(existsSync(blog), 'premier prérendu : le fragment du blog existe')
    const texte   = readFileSync(index, 'utf-8')
    const dateAv  = statSync(index, { bigint: true }).mtimeNs
    await new Promise(r => setTimeout(r, 50))

    const journal = await prerendre(p, config(UNE))
    assert.equal(existsSync(blog), false, 'le fragment de la route retirée ne doit plus être servi')
    assert.equal(journal.filter(l => l.includes('blog.html')).length, 1, `une ligne pour le fragment retiré, journal :\n${journal.join('\n')}`)
    // la page vivante ne paie rien : même contenu, et pas même une réécriture
    assert.ok(existsSync(index), 'le fragment de la route vivante reste')
    assert.equal(readFileSync(index, 'utf-8'), texte, 'fragment vivant identique au bit près')
    assert.equal(statSync(index, { bigint: true }).mtimeNs, dateAv, 'fragment vivant jamais réécrit')
  })

  it('dossier PARTAGÉ : un `.html` que le prérendu n\'a pas écrit survit, son fragment à bandeau part', async () => {
    const p = projet('prerender-orphelin-partage')
    const partage = join(p.root, 'public')
    mkdirSync(join(partage, 'assets'), { recursive: true })
    writeFileSync(join(partage, 'a-la-main.html'), '<h1>écrit à la main, pas par le prérendu</h1>\n')
    writeFileSync(join(partage, 'garde.txt'), 'pas du HTML\n')
    writeFileSync(join(partage, 'assets', 'b.html'), '<p>page d\'un autre outil</p>\n')
    fragmentEcrit(join(partage, 'vieux.html'), '/vieux')

    const journal = await prerendre({ ...p, outDir: partage }, config(UNE, { outDir: 'public' }))
    assert.ok(existsSync(join(partage, 'a-la-main.html')), 'un `.html` sans ligne-bandeau n\'est pas à nous')
    assert.ok(existsSync(join(partage, 'garde.txt')), 'un `.txt` n\'est pas un fragment')
    assert.ok(existsSync(join(partage, 'assets', 'b.html')), 'un `.html` sans ligne-bandeau, même dans un sous-dossier')
    assert.ok(existsSync(join(partage, 'index.html')), 'la page vivante est bien écrite dans le dossier partagé')
    assert.equal(existsSync(join(partage, 'vieux.html')), false, 'le fragment à bandeau sans route est retiré')
    assert.equal(journal.filter(l => l.includes('vieux.html')).length, 1, `une ligne pour le seul fichier retiré, journal :\n${journal.join('\n')}`)
  })

  it('`outDir` = racine du projet : la coquille `index.html` de l\'application survit', async () => {
    const p = projet('prerender-orphelin-racine')
    const coquille = join(p.root, 'index.html')
    writeFileSync(coquille, '<html><body>coquille de l\'application</body></html>\n')
    fragmentEcrit(join(p.root, 'vieux.html'), '/vieux')

    const journal = await prerendre({ ...p, outDir: p.root }, config({ '/accueil': { component: 'mjs-home' } }, { outDir: '.' }))
    assert.ok(existsSync(coquille), 'la coquille de l\'application n\'est pas au prérendu : jamais supprimée')
    assert.equal(readFileSync(coquille, 'utf-8'), '<html><body>coquille de l\'application</body></html>\n', 'la coquille de l\'application est intacte')
    assert.ok(existsSync(join(p.root, 'accueil.html')), 'le fragment de la route vivante est écrit à la racine')
    assert.equal(existsSync(join(p.root, 'vieux.html')), false, 'le fragment à bandeau sans route est retiré')
    assert.equal(journal.filter(l => l.includes('index.html')).length, 0, `la coquille n'est jamais nommée dans le journal :\n${journal.join('\n')}`)
  })

  it('fragment d\'un build ANTÉRIEUR à la marque : son ancien bandeau (français ou anglais) le fait reconnaître', async () => {
    const p = projet('prerender-orphelin-ancien')
    await prerendre(p, config(UNE))
    const ancienFr = join(p.outDir, 'ancien-fr.html')
    const ancienEn = join(p.outDir, 'ancien-en.html')
    writeFileSync(ancienFr, '<!-- Page prérendue par MJS (mjs build) pour \'/ancien-fr\' — ne pas éditer à la main. -->\n<h1>fr</h1>\n')
    writeFileSync(ancienEn, '<!-- Page pre-rendered by MJS (mjs build) for \'/ancien-en\' (language \'en\') — do not edit by hand. -->\n<h1>en</h1>\n')

    const journal = await prerendre(p, config(UNE))
    assert.equal(existsSync(ancienFr), false, 'l\'ancien bandeau français est reconnu')
    assert.equal(existsSync(ancienEn), false, 'l\'ancien bandeau anglais est reconnu')
    assert.equal(journal.filter(l => l.includes('🗑️')).length, 2, `une ligne par fragment retiré, journal :\n${journal.join('\n')}`)
  })

  it('route IMBRIQUÉE retirée : son fragment part du sous-dossier, et le sous-dossier vidé part avec lui', async () => {
    const p = projet('prerender-orphelin-imbrique')
    const routes = { '/': { component: 'mjs-home' }, '/a/b': { component: 'mjs-blog' } }
    await prerendre(p, config(routes))
    const imbrique = join(p.outDir, 'a', 'b.html')
    assert.ok(existsSync(imbrique), 'premier prérendu : le fragment imbriqué existe')

    const journal = await prerendre(p, config(UNE))
    assert.equal(existsSync(imbrique), false, 'le fragment de la route imbriquée retirée ne doit plus être servi')
    assert.equal(existsSync(join(p.outDir, 'a')), false, 'le sous-dossier vidé de ses fragments est retiré')
    assert.equal(journal.filter(l => l.includes('b.html')).length, 1, `une ligne pour le fragment retiré, journal :\n${journal.join('\n')}`)
    assert.equal(journal.filter(l => l.includes(join(p.outDir, 'a'))).length, 2, `le dossier retiré est nommé lui aussi, journal :\n${journal.join('\n')}`)
    assert.ok(existsSync(join(p.outDir, 'index.html')), 'le fragment de la route vivante reste')
  })

  it('langues : les fragments de la langue retirée partent, son dossier aussi ; un `.html` sans bandeau le retient', async () => {
    const p = projet('prerender-orphelin-locales')
    await prerendre(p, config(DEUX, { locales: ['fr', 'en'] }))
    for (const lang of ['fr', 'en']) assert.ok(existsSync(join(p.outDir, lang, 'blog.html')), `premier prérendu : ${lang}/blog.html existe`)
    // langue d'une configuration ANTÉRIEURE : ses fragments portent le bandeau, ils partent aussi
    fragmentEcrit(join(p.outDir, 'de', 'index.html'), '/', 'de')
    // un `.html` posé à la main dans un dossier de langue : il reste, et retient son dossier
    writeFileSync(join(p.outDir, 'en', 'note.html'), '<p>écrit à la main</p>\n')

    const journal = await prerendre(p, config(UNE, { locales: ['fr', 'it'] }))
    assert.ok(existsSync(join(p.outDir, 'fr', 'index.html')), 'la langue déclarée garde la page vivante')
    assert.ok(existsSync(join(p.outDir, 'it', 'index.html')), 'la langue ajoutée reçoit la sienne')
    assert.equal(existsSync(join(p.outDir, 'fr', 'blog.html')), false, 'fr/blog.html doit être supprimé')
    assert.equal(existsSync(join(p.outDir, 'en', 'index.html')), false, 'en/index.html n\'est plus attendu : supprimé')
    assert.equal(existsSync(join(p.outDir, 'en', 'blog.html')), false, 'en/blog.html n\'est plus attendu : supprimé')
    assert.ok(existsSync(join(p.outDir, 'en', 'note.html')), 'le `.html` sans bandeau reste')
    assert.ok(existsSync(join(p.outDir, 'en')), 'son dossier n\'est donc pas vide, et reste')
    assert.equal(existsSync(join(p.outDir, 'de')), false, 'le dossier de la langue retirée, vidé de ses fragments, est retiré')
    assert.equal(journal.filter(l => l.includes('🗑️')).length, 5, `quatre fragments et un dossier, journal :\n${journal.join('\n')}`)
  })

  it('jamais un fichier d\'une autre extension', async () => {
    const p = projet('prerender-orphelin-perimetre')
    await prerendre(p, config(UNE))
    writeFileSync(join(p.outDir, 'notes.txt'), 'hors périmètre\n')
    writeFileSync(join(p.outDir, 'plan.json'), '{}\n')

    await prerendre(p, config(UNE))
    assert.ok(existsSync(join(p.outDir, 'notes.txt')), 'un .txt n\'est pas un fragment')
    assert.ok(existsSync(join(p.outDir, 'plan.json')), 'un .json n\'est pas un fragment')
  })

  it('PLUS AUCUNE route prérendable (toutes en `csr`) : les fragments partent quand même', async () => {
    const p = projet('prerender-orphelin-csr')
    await prerendre(p, config(DEUX))
    const index = join(p.outDir, 'index.html')
    const blog  = join(p.outDir, 'blog.html')
    assert.ok(existsSync(index) && existsSync(blog), 'premier prérendu : les deux fragments existent')

    const journal = await prerendre(p, config({ '/': { component: 'mjs-home', mode: 'csr' }, '/blog': { component: 'mjs-blog', mode: 'csr' } }))
    assert.equal(existsSync(index), false, 'le fragment d\'une route passée en csr ne doit plus être servi')
    assert.equal(existsSync(blog), false, 'idem pour la seconde')
    assert.equal(journal.filter(l => l.includes('🗑️')).length, 2, `une ligne par fragment retiré, journal :\n${journal.join('\n')}`)
  })

  it('bloc `render` sans `routes` : les fragments d\'un build antérieur partent, le reste est intact', async () => {
    const p = projet('prerender-orphelin-sans-routes')
    await prerendre(p, config(DEUX))
    writeFileSync(join(p.outDir, 'a-la-main.html'), '<h1>posée à la main</h1>\n')

    const journal = await prerendre(p, { sourceDir: 'src', outputDir: 'out', manifestPath: 'out/bundle.js', render: { default: 'csr' } } as MjsConfig)
    assert.equal(existsSync(join(p.outDir, 'index.html')), false, 'plus aucune route : le fragment ne doit plus être servi')
    assert.equal(existsSync(join(p.outDir, 'blog.html')), false, 'idem pour le second')
    assert.ok(existsSync(join(p.outDir, 'a-la-main.html')), 'le `.html` sans bandeau reste')
    assert.equal(journal.filter(l => l.includes('🗑️')).length, 2, `une ligne par fragment retiré, journal :\n${journal.join('\n')}`)
  })

  it('page en échec de rendu : rien n\'est supprimé, le dossier garde ses fragments', async () => {
    const p = projet('prerender-orphelin-fatal')
    await prerendre(p, config(DEUX))
    const orphelin = join(p.outDir, 'ancien.html')
    fragmentEcrit(orphelin, '/ancien')

    // `/blog` pointe vers un composant qui n'existe pas : le rendu de cette page échoue (fatal)
    const journal = await prerendre(p, config({ '/': { component: 'mjs-home' }, '/blog': { component: 'mjs-nexistepas' } }))
    assert.ok(journal.some(l => l.includes('mjs-nexistepas')), `le journal doit signaler l'échec de rendu :\n${journal.join('\n')}`)
    assert.ok(existsSync(orphelin), 'une passe qui a échoué ne sait plus ce que le dossier devrait contenir : rien n\'est retiré')
  })

  it('`mjs build` : les routes retirées, imbriquées comprises, perdent leur fragment au build suivant', () => {
    const p = projet('prerender-orphelin-cli')
    const ecrire = (routes: Record<string, unknown>): void => {
      writeFileSync(join(p.root, 'mjs.config.json'), JSON.stringify({
        sourceDir: 'src', outputDir: 'out', manifestPath: 'out/bundle.js', urlPrefix: '/out',
        render: { default: 'prerender', engine: { prerender: 'happy-dom' }, startup: 'bundle', routes },
      }, null, 2))
    }
    const build = (): string => {
      const result = spawnSync('npx', ['tsx', 'src/cli.ts', 'build', '--prod', '--root', p.root], { cwd: repoRoot, encoding: 'utf-8' })
      assert.equal(result.status, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`)
      return result.stdout
    }
    ecrire({ ...DEUX, '/a/b': { component: 'mjs-blog' } })
    build()
    const blog     = join(p.outDir, 'blog.html')
    const imbrique = join(p.outDir, 'a', 'b.html')
    assert.ok(existsSync(blog), 'premier build : le fragment du blog existe')
    assert.ok(existsSync(imbrique), 'premier build : le fragment imbriqué existe')
    ecrire(UNE)
    const sortie = build()
    assert.equal(existsSync(blog), false, `le fragment de la route retirée doit être supprimé :\n${sortie}`)
    assert.equal(existsSync(imbrique), false, `le fragment de la route imbriquée retirée doit être supprimé :\n${sortie}`)
    assert.ok(sortie.split('\n').some(l => l.includes('blog.html')), `le build doit nommer le fragment retiré :\n${sortie}`)
    assert.ok(existsSync(join(p.outDir, 'index.html')), 'le fragment de la route vivante reste')
  })

  it('`mjs build` : la DERNIÈRE route passée en `csr` perd son fragment, jamais un lien mort derrière', () => {
    const p = projet('prerender-orphelin-cli-csr')
    const ecrire = (mode?: string): void => {
      writeFileSync(join(p.root, 'mjs.config.json'), JSON.stringify({
        sourceDir: 'src', outputDir: 'out', manifestPath: 'out/bundle.js', urlPrefix: '/out',
        render: { default: 'prerender', engine: { prerender: 'happy-dom' }, startup: 'bundle', routes: { '/': { component: 'mjs-home', ...(mode ? { mode } : {}) } } },
      }, null, 2))
    }
    const build = (): string => {
      const result = spawnSync('npx', ['tsx', 'src/cli.ts', 'build', '--prod', '--root', p.root], { cwd: repoRoot, encoding: 'utf-8' })
      assert.equal(result.status, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`)
      return result.stdout
    }
    ecrire()
    build()
    const index = join(p.outDir, 'index.html')
    assert.ok(existsSync(index), 'premier build : le fragment de l\'accueil existe')

    ecrire('csr')
    const sortie = build()
    assert.equal(existsSync(index), false, `le fragment de la seule route, passée en csr, doit être supprimé :\n${sortie}`)
    assert.ok(sortie.split('\n').some(l => l.includes('index.html')), `le build doit nommer le fragment retiré :\n${sortie}`)
    // le même build a purgé le fichier de page que ce fragment nommait : rien ne doit plus le citer
    assert.deepEqual(readdirSync(join(p.root, 'out')).filter(f => /^mjs_page-/.test(f)), [], 'aucun fichier de page ne survit à la bascule')
  })
})
