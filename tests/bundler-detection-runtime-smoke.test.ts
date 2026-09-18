// Détection au build × code RÉELLEMENT émis. Certaines syntaxes font écrire au compilateur un
// appel runtime dont le nom n'apparaît jamais dans le source du projet : `<@window @keydown>`
// et `<@body @class{…}>` s'attachent au réveil par `@_mjs_hook 'awake'` (mjs_lifecycle.ts),
// la rune nue `µfailed` câble un `reset` qui appelle `µ._mjs_resetComponent` (mjs_failed.ts), les
// runes `µ.setContext`/`µ.getContext` visent `_mjs_setContext`/`_mjs_getContext`
// (mjs_context.ts), et un `layout="…"` écrit dans la page hôte réclame un variant déclaré par
// `<style name="…">` (mjs_layout_variant.ts). Chaque cas est compilé par le vrai Bundler avec
// `runtime: []` (aucun optionnel, donc aucun forçage par un module voisin), puis monté dans
// happy-dom : un module détecté oublié se voit ici au COMPORTEMENT, pas seulement à l'octet.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { findConfig, resolveBundlerOpts } from '../src/bundler/config.js'
import { mjsTmp } from './helpers/tmp.js'
import { assertAbsent } from './helpers/dom-assert.js'

const stripEsm = (s: string): string => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms))

// compile `files` (nom → source) avec runtime: [], charge le cœur puis TOUS les composants dans une
// Window neuve ; `fetch` sert les fichiers écrits par le build (variants), 404 sinon
async function loadProject(prefix: string, files: Record<string, string>) {
  const root   = mjsTmp(prefix)
  const srcDir = join(root, 'app/modularjs')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  for (const [name, content] of Object.entries(files)) writeFileSync(join(srcDir, name), content)
  writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ sourceDir: 'app/modularjs', outputDir: 'out', manifestPath: 'bundle.js', runtime: [] }))
  const found   = findConfig(root)
  assert.ok(found, 'mjs.config.json doit être trouvé')
  const bundler = new Bundler(resolveBundlerOpts(found!.config, found!.configDir) as any)
  const stats   = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  const win: any = new Window({ url: 'http://localhost/' })
  win.fetch = async (url: string) => {
    const file = join(outDir, basename(String(url).split('?')[0]))
    return existsSync(file) ? { ok: true, status: 200, text: async () => readFileSync(file, 'utf-8') } : { ok: false, status: 404, text: async () => '' }
  }
  const out      = readdirSync(outDir)
  const coreFile = out.find((f) => /^mjs_core-/.test(f))
  assert.ok(coreFile, `sortie du build inattendue : ${out.join(', ')}`)
  // un partiel (`_nom.mjs`) est inliné par `<@include>`, jamais compilé en composant
  const comps = Object.keys(files).filter((name) => !name.startsWith('_')).map((name) => {
    const comp = out.find((f) => f.startsWith(basename(name, '.mjs') + '-') && f.endsWith('.js'))
    assert.ok(comp, `composant ${name} introuvable dans : ${out.join(', ')}`)
    return stripEsm(readFileSync(join(outDir, comp!), 'utf-8'))
  })
  win.eval([stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8')), 'globalThis.µ = µ;', ...comps].join('\n'))
  return { win, document: win.document }
}

describe('détection au build — le code émis par le compilateur trouve son module au runtime', function () {
  this.timeout(60000)
  after(async () => { await terminateSharedWorkerPool() })

  it('<@window @keydown> sans aucune rune : l\'écouteur s\'attache au montage et se détache au départ', async function () {
    const { win, document } = await loadProject('smoke-window', {
      'clavier.mjs': [
        '<script lang="coffee">',
        '$key = undefined',
        'onkeydown = (event)->',
        '  window.__smokeKeys.push(event.key)',
        '  $key = event.key',
        '</script>',
        '<@window @keydown={onkeydown}>',
        '<p class="k">{$key}</p>',
      ].join('\n'),
    })
    win.__smokeKeys = []
    document.body.innerHTML = '<mjs-clavier></mjs-clavier>'
    const el: any = document.body.firstElementChild
    await tick()
    assert.equal(el.classList.contains('mjs-error'), false, 'le composant ne doit pas planter à la construction')
    win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'a' }))
    await tick()
    assert.deepEqual(win.__smokeKeys, ['a'], 'l\'écouteur posé sur window reçoit la touche')
    assert.equal(el._shadow.querySelector('.k').textContent, 'a')
    el.remove()
    await tick()
    win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'b' }))
    await tick()
    assert.deepEqual(win.__smokeKeys, ['a'], 'l\'écouteur est retiré quand le composant s\'endort')
    win.close?.()
  })

  it('<@body @class{…}> sans aucune rune : la classe est posée au montage et retirée au départ', async function () {
    const { win, document } = await loadProject('smoke-body', {
      'modale.mjs': ['<script lang="coffee">', '$open = true', '</script>', '<@body @class{$open}="no-scroll">', '<p>x</p>'].join('\n'),
    })
    document.body.innerHTML = '<mjs-modale></mjs-modale>'
    const el: any = document.body.firstElementChild
    await tick()
    assert.equal(el.classList.contains('mjs-error'), false, 'le composant ne doit pas planter à la construction')
    assert.equal(document.body.classList.contains('no-scroll'), true, 'classe posée sur body')
    el.remove()
    await tick()
    assert.equal(document.body.classList.contains('no-scroll'), false, 'classe retirée quand le composant s\'endort')
    win.close?.()
  })

  it('µfailed en rune nue : le bouton mjs-reset remonte le composant (µ._mjs_resetComponent présent)', async function () {
    const { win, document } = await loadProject('smoke-failed', {
      'fragile.mjs': [
        '<script>',
        'window.__mount = (window.__mount or 0) + 1',
        'boom = -> if window.__mount == 1 then throw new Error(\'boum\') else \'ok\'',
        'µfailed (err, reset)->',
        '  "<p class=\\"oups\\">Oups</p><button mjs-reset>Réessayer</button>"',
        '</script>',
        '<p class="ok">{boom()}</p>',
      ].join('\n'),
    })
    document.body.innerHTML = '<mjs-fragile></mjs-fragile>'
    await tick()
    const el: any = document.body.querySelector('mjs-fragile')
    const bouton  = el._shadow.querySelector('button[mjs-reset]')
    assert.ok(bouton, 'le repli s\'affiche au premier plantage du rendu')
    bouton.click()
    await tick(160)
    const neuf: any = document.body.querySelector('mjs-fragile')
    assert.equal(win.__mount, 2, 'le composant a été remonté une fois')
    assertAbsent(neuf._shadow.querySelector('.oups'), 'le repli est parti')
    assert.equal(neuf._shadow.querySelector('.ok')?.textContent, 'ok', 'la seconde tentative réussit')
    win.close?.()
  })

  it('runes µ.setContext / µ.getContext sans aucun § : l\'enfant lit la valeur de l\'ancêtre', async function () {
    const { win, document } = await loadProject('smoke-context', {
      'ancetre.mjs': ['<script lang="coffee">', 'µ.setContext(\'theme\', \'sombre\')', '</script>', '<@enfant>'].join('\n'),
      'enfant.mjs': ['<script lang="coffee">', '$t = µ.getContext(\'theme\')', '</script>', '<p class="t">{$t}</p>'].join('\n'),
    })
    document.body.innerHTML = '<mjs-ancetre></mjs-ancetre>'
    await tick(160)
    const ancetre: any = document.body.firstElementChild
    assert.equal(ancetre.classList.contains('mjs-error'), false, 'l\'ancêtre ne doit pas planter')
    const enfant: any = ancetre._shadow.querySelector('mjs-enfant')
    assert.ok(enfant, 'l\'enfant est monté')
    assert.equal(enfant.classList.contains('mjs-error'), false, 'l\'enfant ne doit pas planter')
    assert.equal(enfant._shadow.querySelector('.t')?.textContent, 'sombre')
    win.close?.()
  })

  it('rune µgetContext sans point, SEULE du build (ni setContext ni §) : pas de plantage, le repli s\'affiche', async function () {
    const { win, document } = await loadProject('smoke-getcontext', {
      'lecteur.mjs': ['<script lang="coffee">', '$t = µgetContext(\'theme\') or \'clair\'', '</script>', '<p class="t">{$t}</p>'].join('\n'),
    })
    document.body.innerHTML = '<mjs-lecteur></mjs-lecteur>'
    await tick(160)
    const el: any = document.body.firstElementChild
    assert.equal(el.classList.contains('mjs-error'), false, 'le composant ne doit pas planter à la construction')
    assert.equal(el._shadow.querySelector('.t')?.textContent, 'clair', 'aucun ancêtre ne pose la clé : le repli est lu')
    win.close?.()
  })

  it('variant déclaré par <style name> et demandé par la PAGE hôte (layout="…" hors des sources) : appliqué', async function () {
    const { win, document } = await loadProject('smoke-variant', {
      'carte.mjs': ['<p class="t">x</p>', '<style>', '.t', '  color: red', '</style>', '<style name="banner">', '.t', '  color: green', '</style>'].join('\n'),
    })
    win.customElements.get('mjs-carte').mjsLight = true
    document.body.innerHTML = '<mjs-carte mjs-light layout="banner"></mjs-carte>'
    await tick(160)
    const styleEl = document.head.querySelector('style[data-mjs-light-layout="mjs-carte"]')
    assert.ok(styleEl, 'le <style> du variant doit être posé')
    assert.match(styleEl.textContent, /green/, 'c\'est bien le CSS du variant banner')
    win.close?.()
  })

  it('<@failed> posé sur l\'ancêtre SEUL : le crash d\'un enfant sans repli remonte et le repli de l\'ancêtre s\'affiche', async function () {
    const { win, document } = await loadProject('smoke-failed-propagation', {
      'enfant-fragile.mjs': ['<script>', 'boom = -> throw new Error(\'boum enfant\')', '</script>', '<p class="e">{boom()}</p>'].join('\n'),
      'abri.mjs': ['<@enfant-fragile>', '<@failed err reset>', '<p class="repli">Repli : {err.message}</p>', '</@failed>'].join('\n'),
    })
    document.body.innerHTML = '<mjs-abri></mjs-abri>'
    await tick(160)
    const abri: any = document.body.firstElementChild
    assert.match(abri._shadow.querySelector('.repli')?.textContent ?? '', /boum enfant/, 'le repli de l\'ancêtre affiche l\'erreur de l\'enfant')
    assert.equal(abri._shadow.querySelectorAll('.mjs-fatal-error').length, 0, 'aucun panneau fatal : l\'erreur est absorbée')
    assert.equal(win.µ._fatalErrors || 0, 0)
    win.close?.()
  })

  it('<@failed> dont le repli jette à son tour : le panneau fatal prend le relais', async function () {
    const { win, document } = await loadProject('smoke-failed-fallback-throws', {
      'double-crash.mjs': ['<script>', 'boom = -> throw new Error(\'boum\')', '</script>', '<p class="ok">{boom()}</p>', '<@failed err reset>', '<p class="repli">{err.nope.deep}</p>', '</@failed>'].join('\n'),
    })
    document.body.innerHTML = '<mjs-double-crash></mjs-double-crash>'
    await tick(160)
    const el: any = document.body.firstElementChild
    assert.equal(el._shadow.querySelectorAll('.mjs-fatal-error').length, 1, 'le panneau fatal s\'affiche')
    assert.equal(el._shadow.querySelectorAll('.repli').length, 0, 'aucun reste du repli en erreur')
    assert.equal(win.µ._fatalErrors, 1)
    win.close?.()
  })

  it('{{…}} à la racine, dans {if}, {key}, {for}, <@slot> et un partiel <@include> (plus un {await} voisin) : HTML rendu puis mis à jour', async function () {
    const { win, document } = await loadProject('smoke-html', {
      'brut.mjs': [
        '<script>',
        '$h = \'<b class="gras">x</b>\'',
        '$ok = true',
        '$k = 1',
        '$items = [1, 2]',
        '$p = Promise.resolve(\'<b class="gras">a</b>\')',
        '</script>',
        '<p class="racine">{{$h}}</p>',
        '{if $ok}<p class="si">{{$h}}</p>{end}',
        '{key $k}<p class="cle">{{$h}}</p>{end}',
        '{for it in $items}<p class="pour">{{$h}}</p>{end}',
        '{await $p}<p>...</p>{success v}<p class="attente">{{v}}</p>{end}',
        '<div class="fente"><@slot>{{$h}}</@slot></div>',
        '<@include bloc>'
      ].join('\n'),
      '_bloc.mjs': '<div class="inclus">{{$h}}</div>\n'
    })
    document.body.innerHTML = '<mjs-brut></mjs-brut>'
    await tick(160)
    const el: any = document.body.firstElementChild
    assert.equal(el.classList.contains('mjs-error'), false, 'le composant ne doit pas planter')
    const count = (sel: string) => el._shadow.querySelectorAll(sel).length
    for (const bloc of ['.racine', '.si', '.cle', '.fente', '.inclus']) {
      assert.equal(count(bloc +' b.gras'), 1, `${bloc} : le HTML brut doit être rendu`)
    }
    assert.equal(count('.pour b.gras'), 2, '{for} : une fois par ligne')
    // {await} n'appelle jamais `_mjs_updHtml` (la branche construit son nœud elle-même) : seul le rendu de la branche est vérifié
    assert.match(el._shadow.querySelector('.attente')?.textContent ?? '', /a/, '{await} : la branche {success} est rendue')
    el._set('h', '<i class="penche">y</i>')
    await tick()
    for (const bloc of ['.racine', '.si', '.cle', '.fente', '.inclus']) {
      assert.equal(count(bloc +' i.penche'), 1, `${bloc} : la mise à jour doit remplacer le HTML`)
      assert.equal(count(bloc +' b.gras'), 0, `${bloc} : l'ancien HTML doit partir`)
    }
    assert.equal(count('.pour i.penche'), 2)
    win.close?.()
  })

  it('crash dans un projet SANS aucune frontière (mjs_failed.ts absent du cœur) : panneau fatal du cœur', async function () {
    const { win, document } = await loadProject('smoke-failed-absent', {
      'seul.mjs': ['<script>', 'boom = -> throw new Error(\'boum seul\')', '</script>', '<p class="ok">{boom()}</p>'].join('\n'),
    })
    assert.equal(typeof win.µ._mjs_resetComponent, 'undefined', 'le projet n\'écrit aucun repli : la brique n\'est pas jointe')
    document.body.innerHTML = '<mjs-seul></mjs-seul>'
    await tick(160)
    const el: any = document.body.firstElementChild
    assert.equal(el.classList.contains('mjs-error'), true)
    assert.match(el._shadow.querySelector('.mjs-fatal-error')?.textContent ?? '', /boum seul/)
    assert.equal(win.µ._fatalErrors, 1)
    win.close?.()
  })
})
