// Préfixe public — `mjs serve` et `mjs dev` servent le dossier de sortie SOUS le préfixe que le
// projet publie dans ses URLs. Quand `urlPrefix` n'est pas déclaré, ce préfixe est DÉRIVÉ du
// dossier de sortie (`public/modularjs` → `/modularjs`), exactement comme le bundler le dérive pour
// composer les URLs qu'il écrit : une source unique des deux côtés, sinon le serveur cherche les
// fichiers sous un chemin que personne ne lui demande — et tout ce que la page référence rend 404.
//
// Sonde bout-en-bout : la page servie est relue, CHACUNE de ses URLs absolues est redemandée au
// même serveur, et doit répondre 200. Trois passes : sans `urlPrefix`, avec `''` (racine
// explicite), avec `'/modularjs'` (le même, déclaré).

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsTmp } from './helpers/tmp.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const COMPOSANT = [
  '<style>',
  ':host',
  '  display: block',
  '  color: crimson',
  '</style>',
  '<script>',
  '$titre = \'Accueil\'',
  '</script>',
  '',
  '<h1 class="t">{$titre}</h1>',
].join('\n') + '\n'

/** Projet fixture : sortie sous `public/modularjs`, mode strict (donc feuilles en `<link>`). */
function fixtureProject(prefix: string, urlPrefix?: string): string {
  const root = mjsTmp(prefix)
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'styles'), { recursive: true })
  writeFileSync(join(root, 'src', 'app-home.mjs'), COMPOSANT)
  const config: Record<string, unknown> = {
    sourceDir: 'src', outputDir: 'public/modularjs', stylesheetsDir: 'styles', csp: true, css: 'split',
    render: { default: 'ssr', engine: { request: 'happy-dom' }, routes: { '/': { component: 'mjs-app-home' } } },
  }
  if (urlPrefix !== undefined) config.urlPrefix = urlPrefix
  writeFileSync(join(root, 'mjs.config.json'), JSON.stringify(config, null, 2))
  return root
}

/** Un port libre, relâché juste avant d'être passé au sous-processus (`mjs dev` n'annonce que le
 *  port DEMANDÉ). */
async function portLibre(): Promise<number> {
  const sonde = createServer()
  await new Promise<void>(resolve => sonde.listen(0, '127.0.0.1', () => resolve()))
  const port = (sonde.address() as any).port
  await new Promise<void>(resolve => sonde.close(() => resolve()))
  return port
}

/** URLs absolues (`/…`) que la page référence, dédoublonnées. */
function urlsDeLaPage(html: string): string[] {
  return [...new Set([...html.matchAll(/(?:href|src)="(\/[^"]*)"/g)].map(m => m[1]))]
}

/**
 * Lance `mjs serve`/`mjs dev` sur le projet, demande `/`, et rend le couple (page, port). Le
 * sous-processus est toujours refermé.
 */
async function servirEtLire(commande: 'serve' | 'dev', root: string): Promise<{ html: string; port: number; verifier: (url: string) => Promise<number> }> {
  const port = commande === 'dev' ? await portLibre() : 0
  const enfant = spawn(join(repoRoot, 'node_modules', '.bin', 'tsx'), ['src/cli.ts', commande, '--root', root, '--port', String(port)], {
    cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let sortie = ''
  enfant.stdout.on('data', (d: Buffer) => { sortie += d.toString() })
  enfant.stderr.on('data', (d: Buffer) => { sortie += d.toString() })
  const fini = new Promise<void>(resolve => enfant.on('exit', () => resolve()))
  const pret = commande === 'dev' ? /Watching / : /127\.0\.0\.1:(\d+)/
  const debut = Date.now()
  while (Date.now() - debut < 90000 && !pret.test(sortie)) await new Promise(r => setTimeout(r, 200))
  assert.match(sortie, pret, `le serveur doit être prêt, obtenu :\n${sortie}`)
  const portReel = commande === 'dev' ? port : Number(/127\.0\.0\.1:(\d+)/.exec(sortie)![1])
  try {
    const rep = await fetch(`http://127.0.0.1:${portReel}/`)
    assert.equal(rep.status, 200, `la page doit répondre, journal :\n${sortie}`)
    const html = await rep.text()
    const statuts = new Map<string, number>()
    for (const url of urlsDeLaPage(html)) statuts.set(url, (await fetch(`http://127.0.0.1:${portReel}${url}`)).status)
    return { html, port: portReel, verifier: async (url: string) => statuts.get(url) ?? 0 }
  } finally {
    enfant.kill('SIGINT')
    await Promise.race([fini, new Promise<void>(r => setTimeout(r, 8000))])
    if (enfant.exitCode === null) { enfant.kill('SIGKILL'); await fini }
  }
}

async function toutesServies(commande: 'serve' | 'dev', root: string): Promise<void> {
  const { html, verifier } = await servirEtLire(commande, root)
  const urls = urlsDeLaPage(html)
  assert.ok(urls.some(u => /mjs_ssr_head-[a-f0-9]{8}\.css$/.test(u)), `la feuille du <head> doit être référencée, page :\n${html.slice(0, 600)}`)
  assert.ok(urls.some(u => /mjs_ssr_style_[a-z0-9-]+-[a-f0-9]{8}\.css$/.test(u)), `la feuille du composant rendu doit être référencée, page :\n${html.slice(0, 600)}`)
  const perdues: string[] = []
  for (const url of urls) { if (await verifier(url) !== 200) perdues.push(url) }
  assert.deepEqual(perdues, [], `toute URL que la page référence doit être servie (200), page :\n${html.slice(0, 900)}`)
}

describe('préfixe public — tout ce que la page référence est servi', function () {
  this.timeout(180000)

  for (const commande of ['serve', 'dev'] as const) {
    it(`\`mjs ${commande}\` sans \`urlPrefix\` : le préfixe est DÉRIVÉ du dossier de sortie`, async () => {
      await toutesServies(commande, fixtureProject(`prefixe-${commande}-derive`))
    })

    it(`\`mjs ${commande}\` avec \`urlPrefix: ''\` (racine explicite) : servi à la racine`, async () => {
      await toutesServies(commande, fixtureProject(`prefixe-${commande}-vide`, ''))
    })

    it(`\`mjs ${commande}\` avec \`urlPrefix: '/modularjs'\` déclaré : servi sous ce préfixe`, async () => {
      await toutesServies(commande, fixtureProject(`prefixe-${commande}-declare`, '/modularjs'))
    })
  }
})
