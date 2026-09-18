// Sucre « au geste, émets » — `@click.emit.NOM` (+ charge utile `={expr}`) —
// et garde anti-faute-de-frappe sur les modificateurs d'événement.
//
// Avant ce correctif, `@click.emit=increment` compilait EN SILENCE vers
// `(e, el) => { return increment }` — un ReferenceError au clic, sans un mot à
// la compilation ; et `@click.stopp` / `@click.prevnet` passaient en vert sans
// rien faire, la liste des suffixes étant consultée par INCLUSION.
//
// Ce fichier verrouille les deux moitiés : le code réellement émis + le
// comportement runtime (happy-dom, vrais clics), et les 4 formes refusées.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { mjsTmp } from './helpers/tmp.js'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { transpile } from '../src/transpiler/index.js'

const stripEsm = (s: string) => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

async function bundleComponent(name: string, src: string): Promise<{ coreCode: string; compCode: string }> {
  const root   = mjsTmp('emitgest')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, `${name}.mjs`), src)

  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'b.js') })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  const files    = readdirSync(outDir)
  const coreFile = files.find((f: string) => /^mjs_core-/.test(f))!
  const compFile = files.find((f: string) => new RegExp(`^${name}-`).test(f))!
  return {
    coreCode: stripEsm(readFileSync(join(outDir, coreFile), 'utf-8')),
    compCode: stripEsm(readFileSync(join(outDir, compFile), 'utf-8')),
  }
}

const out = async (src: string) => String(((await transpile(src, { moduleName: 'g' })) as any).output ?? '')

describe('@EVENEMENT.emit.NOM — code émis', function () {
  this.timeout(40000)

  it('sans charge utile : le handler ne fait que µemit du nom', async () => {
    assert.match(await out('<button @click.emit.increment>+</button>'), /_mjsThis\._mjs_emit\('increment'\)/)
  })

  it('avec charge utile : la valeur d\'attribut est l\'expression envoyée', async () => {
    assert.match(await out('<button @click.emit.select={42}>x</button>'), /_mjsThis\._mjs_emit\('select', 42\)/)
  })

  it('dans un {for} : la charge utile lit la row reconstruite', async () => {
    const js = await out('<script>\nrows = [{ id: 1 }]\n</script>\n<div>{for row in rows}<button @click.emit.select={row.id}>x</button>{end}</div>')
    assert.match(js, /_mjsThis\._mjs_emit\('select', row\.id\)/)
    assert.match(js, /__idx_0/, 'la reconstruction de la row du {for} est bien émise avec le handler')
  })

  it('modificateurs combinés : ils s\'appliquent AVANT l\'émission', async () => {
    const js = await out('<button @click.stop.prevent.emit.save>s</button>')
    const i  = js.indexOf("_mjs_emit('save')")
    assert.ok(i > 0)
    assert.ok(js.indexOf('e.preventDefault()') > 0 && js.indexOf('e.preventDefault()') < i, 'preventDefault avant l\'émission')
    assert.ok(js.indexOf('e.stopPropagation()') > 0 && js.indexOf('e.stopPropagation()') < i, 'stopPropagation avant l\'émission')
  })

  it('nom à tiret et nom namespacé sont acceptés', async () => {
    assert.match(await out('<button @click.emit.row-selected>x</button>'), /_mjs_emit\('row-selected'\)/)
    assert.match(await out('<button @click.emit.mjs:done>x</button>'),     /_mjs_emit\('mjs:done'\)/)
  })

  it('un événement de composant peut aussi porter le sucre (relais parent)', async () => {
    assert.match(await out('<mjs-child @picked.emit.chosen={e.data}></mjs-child>'), /_mjs_emit\('chosen', e\.data\)/)
  })
})

describe('@EVENEMENT.emit.NOM — formes refusées', function () {
  this.timeout(40000)

  it('`emit` sans nom : erreur de compilation', async () => {
    await assert.rejects(() => transpile('<button @click.emit>x</button>', { moduleName: 'g1' }),
      /forme d'émission sur le geste non reconnue/)
  })

  it('nom suivi d\'un modificateur (@click.emit.save.stop) : erreur — le nom se lit en DERNIER', async () => {
    await assert.rejects(() => transpile('<button @click.emit.save.stop>x</button>', { moduleName: 'g2' }),
      /forme d'émission sur le geste non reconnue/)
  })

  it('nom invalide (point interne) : erreur', async () => {
    await assert.rejects(() => transpile('<button @click.emit.user.created>x</button>', { moduleName: 'g3' }),
      /forme d'émission sur le geste non reconnue/)
  })
})

describe('modificateur d\'événement inconnu — garde bloquante', function () {
  this.timeout(40000)

  it('faute de frappe proche : erreur AVEC suggestion', async () => {
    await assert.rejects(() => transpile('<button @click.stopp={f()}>x</button>', { moduleName: 'm1' }),
      /n'est pas un modificateur d'événement[\s\S]*Tu voulais dire « \.stop » \?/)
  })

  it('faute de frappe sur `prevent` : erreur AVEC suggestion', async () => {
    await assert.rejects(() => transpile('<button @click.prevnet={f()}>x</button>', { moduleName: 'm2' }),
      /Tu voulais dire « \.prevent » \?/)
  })

  it('suffixe sans voisin proche : erreur SANS suggestion', async () => {
    await assert.rejects(() => transpile('<button @click.zorglub={f()}>x</button>', { moduleName: 'm3' }),
      /« \.zorglub » n'est pas un modificateur d'événement/)
  })

  it('les 5 modificateurs réels compilent toujours, seuls et combinés', async () => {
    const js = await out('<button @click.stop.prevent.self.once.propagate={f()}>x</button>')
    assert.match(js, /e\.preventDefault\(\)/)
    assert.match(js, /e\.stopPropagation\(\)/)
    for (const m of ['stop', 'prevent', 'self', 'once', 'propagate']) {
      await out(`<button @click.${m}={f()}>x</button>`)   // ne doit pas lever
    }
  })
})

describe('macros globales — un modificateur y est refusé, plus ignoré', function () {
  this.timeout(40000)

  // `<@window>`/`<@document>`/`<@body>`/`<@head>` posent leurs écouteurs EN DIRECT
  // (macros.ts, hors routeur délégué) : leur lecteur refuse par construction tout
  // `@evt.suffixe`, qui était donc IGNORÉ en silence. Tolérable tant que les
  // modificateurs n'existaient que sur les éléments — un piège depuis que
  // `@click.emit.NOM` est une écriture enseignée.
  const buildOne = async (src: string) => {
    const root   = mjsTmp('macromod')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'wmod.mjs'), src)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: join(root, 'out'), manifestPath: join(root, 'b.js') })
    return (await bundler.compile()).errors
  }

  it('`<@window @resize.emit.sized={…}>` fait ÉCHOUER le build (avant : vert et muet)', async () => {
    const errs = await buildOne('<@window @resize.emit.sized={window.innerWidth}>\n<p>x</p>\n')
    assert.equal(errs.length, 1, 'le build doit échouer')
    assert.match(errs.map((e: any) => e.message).join('\n'), /macro globale/)
  })

  it('`<@body @click.stop={…}>` échoue aussi — tout suffixe, pas seulement emit', async () => {
    const errs = await buildOne('<@body @click.stop={f()}>\n<p>x</p>\n')
    assert.equal(errs.length, 1)
  })

  it('la forme SANS suffixe reste intacte', async () => {
    const errs = await buildOne('<@window @resize={f()}>\n<p>x</p>\n')
    assert.equal(errs.length, 0, errs.map((e: any) => e.message).join('\n'))
  })

  // FAUX POSITIF de la 1re version de la garde — elle scannait la chaîne
  // d'attributs ENTIÈRE, corps des handlers compris : or `@truc` = `this.truc` en Civet,
  // donc un `@refs.list`/`@sizes.push` parfaitement légitime DANS un corps se lisait
  // comme le modificateur « .list »/« .push » et faisait échouer le build. La garde ne
  // lit plus que les NOMS d'attributs (valeurs masquées avant le scan).
  it('un `@prop.x` Civet dans le CORPS du handler ne déclenche PAS la garde', async () => {
    const errs = await buildOne('<@window @resize={@sizes.push window.innerWidth}>\n<p>x</p>\n')
    assert.equal(errs.length, 0, 'faux positif : `@sizes.push` est du Civet, pas un modificateur — ' + errs.map((e: any) => e.message).join('\n'))
  })

  it('un `@prop.x.y` en profondeur, et un `@x.y` dans une valeur en guillemets, passent aussi', async () => {
    const errs = await buildOne('<@window @scroll={@refs.list.scrollTop = 0} data-note="@a.b">\n<p>x</p>\n')
    assert.equal(errs.length, 0, errs.map((e: any) => e.message).join('\n'))
  })

  // BRÈCHE du masquage — la branche
  // `="…"` avançait jusqu'au guillemet FERMANT ; absent, elle avalait toute la fin de la balise,
  // donc un vrai `@evt.suffixe` situé plus loin échappait au scan : la garde redevenait muette,
  // exactement le silence qu'elle existe pour supprimer.
  it('guillemet NON FERMÉ ailleurs sur la balise : la violation qui suit est toujours vue', async () => {
    const errs = await buildOne('<@window data-x="non ferme @resize.emit.sized={window.innerWidth}>\n<p>x</p>\n')
    assert.ok(errs.length >= 1, 'un guillemet oublié ne doit pas rendre la garde aveugle')
    assert.match(errs.map((e: any) => e.message).join('\n'), /macro globale/)
  })

  it('le vrai piège reste refusé même à côté d\'un corps qui contient un `@prop.x`', async () => {
    const errs = await buildOne('<@window @resize.emit.sized={@sizes.push 1}>\n<p>x</p>\n')
    assert.equal(errs.length, 1, 'la garde doit toujours mordre sur le NOM')
    assert.match(errs.map((e: any) => e.message).join('\n'), /macro globale/)
  })
})

describe('@EVENEMENT.emit.NOM — runtime (happy-dom, vrais clics)', function () {
  this.timeout(40000)

  after(async () => { await terminateSharedWorkerPool() })

  it('le parent reçoit l\'événement nommé, avec et sans charge utile, y compris par row', async () => {
    const src = `
<script>
rows = [{ id: 7, label: 'A' }, { id: 9, label: 'B' }]
</script>
<button class="plain" @click.emit.increment>+</button>
<button class="paid" @click.emit.saved={ok: true}>save</button>
<div class="rows">{for row in rows}<button class="row" @click.emit.select={row.id}>{row.label}</button>{end}</div>
`
    const { coreCode, compCode } = await bundleComponent('gest', src)

    const win: any = new Window({ url: 'http://localhost/' })
    const document: any = win.document
    win.eval(`${coreCode}\nglobalThis.µ = µ;\n${compCode}`)
    document.body.innerHTML = '<mjs-gest></mjs-gest>'
    const el: any = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 80))

    const seen: any[] = []
    for (const type of ['increment', 'saved', 'select']) {
      el.addEventListener(type, (e: any) => seen.push([type, e.data]))
    }
    const click = async (sel: string, nth = 0) => {
      const nodes = el._shadow.querySelectorAll(sel)
      nodes[nth].dispatchEvent(new win.Event('click', { bubbles: true, cancelable: true, composed: true }))
      await new Promise(r => setTimeout(r, 30))
    }

    await click('.plain')
    assert.deepEqual(seen.at(-1), ['increment', null], 'sans charge utile : e.data vaut null')

    await click('.paid')
    // deepEqual est inutilisable ici : l'objet naît dans le realm happy-dom,
    // son prototype n'est pas celui de Node — on compare le contenu.
    assert.equal(seen.at(-1)[0], 'saved')
    assert.equal(seen.at(-1)[1].ok, true, 'charge utile objet transmise telle quelle')

    await click('.row', 1)
    assert.deepEqual(seen.at(-1), ['select', 9], 'dans un {for} : la charge utile est celle de LA row cliquée')

    await click('.row', 0)
    assert.deepEqual(seen.at(-1), ['select', 7])

    win.close?.()
  })
})
