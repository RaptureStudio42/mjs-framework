// Événements NAMESPACÉS (nom à DEUX-POINTS :
// `mjs:load`, `mjs:visit`, `mjs:before-visit`, `mjs:before-cache`, cf. µ._mjs_navEmit)
// sur les DEUX chemins du compilateur, qui n'ont rien en commun :
//   · macros globales — <@window>/<@document>/<@body>/<@html>/<@head>, passe à
//     base d'expressions régulières (src/transpiler/macros.ts, parseListeners) ;
//   · éléments ordinaires — table d'événements du générateur
//     (src/generator/attributes/index.ts, eventListener).
// Deux défauts distincts corrigés ici, tous deux SILENCIEUX avant :
//   1. le `:` manquait à la classe de caractères du lecteur de macros → le nom
//      était tronqué à `@mjs`, DEUX écouteurs fantômes étaient posés (dont un
//      fabriqué à partir du `@methode` du handler de l'utilisateur), aucun bon ;
//   2. la forme ABRÉGÉE (`@mjs:done` sans `={…}`) synthétisait un appel à la
//      méthode homonyme — que Civet compile en bare-hash `{mjs: done(e, el)}`,
//      un objet jeté, SANS la moindre erreur de compilation.

import assert from 'node:assert/strict'
import { processGlobalMacros } from '../src/transpiler/macros.js'
import { transpile } from '../src/transpiler/index.js'

describe('événement à deux-points — chemin des MACROS GLOBALES (macros.ts)', () => {
  it('<@document @mjs:load={…}> pose UN écouteur, sur le NOM COMPLET', () => {
    const r = processGlobalMacros(`<@document @mjs:load={@relancer()} />`)
    assert.match(r.setup, /document\.addEventListener\('mjs:load'/)
    assert.match(r.teardown, /document\.removeEventListener\('mjs:load'/)
    assert.equal(r.errors.length, 0)
  })

  it('… et AUCUN écouteur fantôme (`mjs` tronqué, `relancer` volé au handler)', () => {
    const r = processGlobalMacros(`<@document @mjs:load={@relancer()} />`)
    assert.doesNotMatch(r.setup, /addEventListener\('mjs'/)
    assert.doesNotMatch(r.setup, /addEventListener\('relancer'/)
    // un SEUL handler défini (@_gl_0), pas deux
    assert.equal((r.setup.match(/@_gl_\d+ = \(e, _\) =>/g) ?? []).length, 1)
    // le corps du handler est bien celui écrit, méthode du composant comprise
    assert.match(r.setup, /relancer\(\)/)
  })

  it('le handler reste intact sur <@window> aussi (même lecteur, autre cible)', () => {
    const r = processGlobalMacros(`<@window @mjs:before-visit={@garde(e)} />`)
    assert.match(r.setup, /window\.addEventListener\('mjs:before-visit'/)
    assert.match(r.setup, /garde\(e\)/)
    assert.equal(r.errors.length, 0)
  })

  it('les noms SANS deux-points ne bougent pas (non-régression)', () => {
    const r = processGlobalMacros(`<@window @scroll={@onScroll} />`)
    assert.match(r.setup, /window\.addEventListener\('scroll'/)
    assert.equal(r.errors.length, 0)
  })

  it('forme ABRÉGÉE `<@document @mjs:load />` : erreur accumulée, AUCUN écouteur posé', () => {
    const err = console.error
    console.error = () => {}
    let r
    try { r = processGlobalMacros(`<@document @mjs:load />`) } finally { console.error = err }
    assert.ok(r.errors.length > 0, 'errors ne doit pas être vide')
    assert.match(r.errors.join(' | '), /forme abrégée interdite/)
    assert.doesNotMatch(r.setup, /addEventListener/)
  })

  it('forme abrégée SANS deux-points toujours valide (`<@window @scroll />`)', () => {
    const r = processGlobalMacros(`<@window @scroll />`)
    assert.match(r.setup, /window\.addEventListener\('scroll'/)
    assert.match(r.setup, /scroll\(e\)/)
    assert.equal(r.errors.length, 0)
  })
})

describe('événement à deux-points — chemin des ÉLÉMENTS (generator)', () => {
  it('<form @mjs:done={…}> : table d\'événements sur le NOM COMPLET (non-régression)', async function () {
    this.timeout(8000)
    const src = ['<script>', 'fini = (e) -> µ.log e', '</script>', '<form @mjs:done={fini(e)}><button>ok</button></form>'].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-deux-points-ok' })
    assert.match(output, /"mjs:done"/)
    assert.match(output, /fini\(e\)/)
  })

  it('<form @mjs:done> (forme abrégée) : ERREUR de compile, jamais un bare-hash muet', async function () {
    this.timeout(8000)
    const src = ['<script>', 'x = 1', '</script>', '<form @mjs:done><button>ok</button></form>'].join('\n')
    await assert.rejects(() => transpile(src, { moduleName: 'mjs-deux-points-abrege' }), /forme abrégée interdite/)
  })

  it('forme abrégée SANS deux-points toujours valide (`<button @click>`)', async function () {
    this.timeout(8000)
    const src = ['<script>', 'click = (e, el) -> µ.log e', '</script>', '<button @click>ok</button>'].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-abrege-sans-deux-points' })
    assert.match(output, /click\(e, el\)/)
  })
})
