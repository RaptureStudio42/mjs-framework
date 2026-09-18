// Lint µeffect/µinspect hors top-level — les runes d'effet
// ne sont valides qu'au TOP-LEVEL du <script> d'un composant : imbriquées
// (handler, méthode, hook µmount, setTimeout…), le runtime les IGNORAIT en
// silence (µ.warn « doit être appelé à l'initialisation », mjs_runes.ts) —
// dans µmount, le sort dépendait même du CHEMIN de rendu (batch microtask vs
// fast-path sync). Désormais : erreur de COMPILATION explicite. Un
// <script module> s'exécute à l'import, sans composant actif → toute
// occurrence y est invalide, top-level compris.

import assert from 'node:assert/strict'
import { lintEffectTopLevel, transpile } from '../src/transpiler/index.js'

describe('lintEffectTopLevel — unitaire (scan source, chaînes/commentaires masqués)', () => {
  it('µeffect top-level (colonne 0) → valide', () => {
    assert.doesNotThrow(() => lintEffectTopLevel('$n = 0\nµeffect ->\n  µ.log $n'))
  })

  it('µeffect sur ligne indentée → throw avec le numéro de ligne', () => {
    assert.throws(() => lintEffectTopLevel('@go = ->\n  µeffect ->\n    $n++'), /« µeffect » imbriqué \(ligne 2 du <script>\)/)
  })

  it('µeffect en colonne 0 mais derrière un `->` sur la même ligne → throw', () => {
    assert.throws(() => lintEffectTopLevel('setTimeout -> µeffect -> $n++'), /imbriqué/)
  })

  it('µeffect derrière un `do` → throw ; `todo` ne compte pas comme `do`', () => {
    assert.throws(() => lintEffectTopLevel('do -> µeffect -> $n++'), /imbriqué/)
    assert.doesNotThrow(() => lintEffectTopLevel('todo = 1\nµeffect ->\n  µ.log todo'))
  })

  it('µ.effect (forme pointée) imbriqué → throw', () => {
    assert.throws(() => lintEffectTopLevel('µmount ->\n  µ.effect -> $n++'), /« µ\.effect » imbriqué/)
  })

  it('µinspect imbriqué → throw', () => {
    assert.throws(() => lintEffectTopLevel('@check = ->\n  µinspect $n'), /« µinspect » imbriqué/)
  })

  it('commentaire `# µeffect ->` et chaîne \'µeffect\' → PAS d\'erreur (masqués)', () => {
    assert.doesNotThrow(() => lintEffectTopLevel('@aide = ->\n  # µeffect -> exemple en commentaire\n  msg := \'contient µeffect et µinspect\''))
  })

  it('identifiant qui CONTIENT effect (µeffects, monµeffect) → jamais matché', () => {
    assert.doesNotThrow(() => lintEffectTopLevel('@go = ->\n  µeffects = 1\n  refl.inspect x'))
  })

  it('<script module> : µeffect même top-level → throw (import, sans composant actif)', () => {
    assert.throws(() => lintEffectTopLevel('µeffect ->\n  µ.log 1', true), /<script module> \(ligne 1\)[\s\S]*import/)
  })
})

describe('transpile — µeffect/µinspect hors top-level = erreur de compilation', function () {
  this.timeout(30000)

  it('µeffect top-level → compile sans erreur (non-régression)', async () => {
    const src = '<script>\n$n = 0\nµeffect ->\n  µ.log $n\n</script>\n<p>{$n}</p>'
    await assert.doesNotReject(transpile(src, { moduleName: 'fx-ok' }))
  })

  it('µeffect dans le corps d\'une méthode `@go = ->` → throw orientant', async () => {
    const src = '<script>\n$n = 0\n@go = ->\n  µeffect ->\n    $n++\n</script>\n<button @go>{$n}</button>'
    await assert.rejects(transpile(src, { moduleName: 'fx-methode' }), /imbriqué[\s\S]*TOP-LEVEL/)
  })

  it('µeffect dans un hook `µmount ->` → throw', async () => {
    const src = '<script>\n$n = 0\nµmount ->\n  µeffect ->\n    µ.log $n\n</script>\n<p>{$n}</p>'
    await assert.rejects(transpile(src, { moduleName: 'fx-mount' }), /imbriqué/)
  })

  it('µinspect imbriqué → throw ; µinspect top-level → OK', async () => {
    const bad = '<script>\n$n = 0\n@verif = ->\n  µinspect $n\n</script>\n<p>{$n}</p>'
    await assert.rejects(transpile(bad, { moduleName: 'insp-ko' }), /µinspect/)
    const ok = '<script>\n$n = 0\nµinspect $n\n</script>\n<p>{$n}</p>'
    await assert.doesNotReject(transpile(ok, { moduleName: 'insp-ok' }))
  })

  it('commentaire/chaîne mentionnant µeffect → compile (pas de faux positif)', async () => {
    const src = '<script>\n$n = 0\n@aide = ->\n  # µeffect -> ici en commentaire\n  µ.log \'doc µeffect en chaîne\'\n</script>\n<p>{$n}</p>'
    await assert.doesNotReject(transpile(src, { moduleName: 'fx-doc' }))
  })

  it('<script module> : µeffect top-level → throw (module = import, sans composant actif)', async () => {
    const src = '<script module>\nµeffect ->\n  µ.log 1\n</script>\n<script>\n$n = 0\n</script>\n<p>{$n}</p>'
    await assert.rejects(transpile(src, { moduleName: 'fx-module' }), /<script module>/)
  })

  it('sigil mjs : `mjs.effect` imbriqué → throw aussi (alias normalisé pour le scan)', async () => {
    const src = '<script>\n$n = 0\n@go = ->\n  mjs.effect ->\n    $n++\n</script>\n<p>{$n}</p>'
    await assert.rejects(transpile(src, { moduleName: 'fx-mjs', sigil: 'mjs' }), /imbriqué/)
  })
})
