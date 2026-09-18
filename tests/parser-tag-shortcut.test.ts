// Test neuf — parser/index.ts : raccourci UNIQUE `<@nom>`
// réécrit en `<mjs-nom>` (résolu par le bundler EN PROJET PUIS EN CŒUR),
// `<@mjs-nom>` (ancienne notation dédiée au cœur) est désormais une ERREUR DE
// MIGRATION, balises littérales `mjs-*`/`mjs-core-*` collectées SANS
// réécriture, les 12 réservées restent INTACTES. Ces tests portent
// UNIQUEMENT sur resolveTagName (parser/index.ts) — la RÉSOLUTION des
// références (inconnue/suggestion/catalogue cœur) est testée côté bundler
// (tests/bundler-tag-shortcut.test.ts), le parseur ne connaît qu'un fichier.

import assert from 'node:assert/strict'
import { parse } from '../src/parser/index.js'
import type { TagRef } from '../src/parser/index.js'

describe('parser — raccourci-dev <@nom> → <mjs-nom>', () => {
  it('self-close <@panier/> → node.name mjs-panier + tagRef raccourci-dev', () => {
    const refs: TagRef[] = []
    const root = parse('<@panier/>', refs)
    assert.equal(root.children[0].name, 'mjs-panier')
    assert.deepEqual(refs, [{ name: 'panier', kind: 'raccourci-dev' }])
  })

  it('forme ouvrante+fermante <@panier></@panier> → même réécriture', () => {
    const refs: TagRef[] = []
    const root = parse('<@panier></@panier>', refs)
    assert.equal(root.children[0].name, 'mjs-panier')
    assert.deepEqual(refs, [{ name: 'panier', kind: 'raccourci-dev' }])
  })

  it('multi-tiret <@rt-x/> → mjs-rt-x, tagRef name "rt-x"', () => {
    const refs: TagRef[] = []
    const root = parse('<@rt-x/>', refs)
    assert.equal(root.children[0].name, 'mjs-rt-x')
    assert.deepEqual(refs, [{ name: 'rt-x', kind: 'raccourci-dev' }])
  })

  it('sans tableau tagRefs (usage historique, 1 seul argument) : aucun crash', () => {
    assert.doesNotThrow(() => parse('<@panier/>'))
    const root = parse('<@panier/>')
    assert.equal(root.children[0].name, 'mjs-panier')
  })
})

describe('parser — <@mjs-nom> RETIRÉE → erreur de migration (raccourci-mjs-retire)', () => {
  it('<@mjs-tst/> → node.name mjs-tst (PLAT, l\'émission n\'a plus d\'importance) + tagRef raccourci-mjs-retire, name "tst" (SANS le préfixe mjs-)', () => {
    const refs: TagRef[] = []
    const root = parse('<@mjs-tst/>', refs)
    assert.equal(root.children[0].name, 'mjs-tst')
    assert.deepEqual(refs, [{ name: 'tst', kind: 'raccourci-mjs-retire' }])
  })

  it('<@mjs-rt-x/> (nom multi-tiret) → mjs-rt-x, tagRef name "rt-x"', () => {
    const refs: TagRef[] = []
    const root = parse('<@mjs-rt-x/>', refs)
    assert.equal(root.children[0].name, 'mjs-rt-x')
    assert.deepEqual(refs, [{ name: 'rt-x', kind: 'raccourci-mjs-retire' }])
  })
})

describe('parser — balises littérales mjs-*/mjs-core-* (écrites à la main, sans @)', () => {
  it('<mjs-panier></mjs-panier> → name INCHANGÉ + tagRef litteral-dev', () => {
    const refs: TagRef[] = []
    const root = parse('<mjs-panier></mjs-panier>', refs)
    assert.equal(root.children[0].name, 'mjs-panier')
    assert.deepEqual(refs, [{ name: 'panier', kind: 'litteral-dev' }])
  })

  it('<mjs-core-x></mjs-core-x> → name INCHANGÉ + tagRef litteral-coeur', () => {
    const refs: TagRef[] = []
    const root = parse('<mjs-core-x></mjs-core-x>', refs)
    assert.equal(root.children[0].name, 'mjs-core-x')
    assert.deepEqual(refs, [{ name: 'x', kind: 'litteral-coeur' }])
  })

  it('balise ordinaire (div, my-widget) : jamais de tagRef', () => {
    const refs: TagRef[] = []
    parse('<div><my-widget></my-widget></div>', refs)
    assert.deepEqual(refs, [])
  })
})

describe('parser — les 12 balises réservées restent INTACTES (jamais réécrites, jamais collectées)', () => {
  const RESERVED = ['include', 'slot', 'head', 'body', 'html', 'document', 'window', 'element', 'module', 'failed', 'view']

  for (const name of RESERVED) {
    it(`<@${name}></@${name}> : node.name préservé, aucun tagRef poussé`, () => {
      const refs: TagRef[] = []
      const root = parse(`<@${name}></@${name}>`, refs)
      // @view/@slot ont une réécriture PROPRE et historique (metamjs-view/slot) ;
      // les 9 autres (normalement consommées par macros.ts en amont) traversent
      // le parseur SANS filtre dédié — identité, comportement d'avant.
      if (name === 'view') {
        assert.equal(root.children[0].name, 'metamjs-view')
      } else if (name === 'slot') {
        assert.equal(root.children[0].name, 'slot')
      } else {
        assert.equal(root.children[0].name, `@${name}`)
      }
      assert.deepEqual(refs, [], `<@${name}> ne doit jamais produire de référence composant`)
    })
  }

  it('<@view id></@view> (usage réel documenté) : toujours metamjs-view, aucun tagRef', () => {
    const refs: TagRef[] = []
    const root = parse('<@view app-content></@view>', refs)
    assert.equal(root.children[0].name, 'metamjs-view')
    assert.deepEqual(refs, [])
  })

  it('<@slot title></@slot> (usage réel documenté) : toujours slot, aucun tagRef', () => {
    const refs: TagRef[] = []
    const root = parse('<@slot title></@slot>', refs)
    assert.equal(root.children[0].name, 'slot')
    assert.deepEqual(refs, [])
  })
})
