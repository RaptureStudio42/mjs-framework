// Test de régression :
// `µanim.create(name, config)` (runtime/animations/create.ts) écrivait
// `µ.anim[name] = factory` INCONDITIONNELLEMENT — sans vérifier si `name`
// désigne déjà une animation BUILT-IN du framework (fade/fly/scale/…) ou une
// AUTRE `µanim.create` précédemment enregistrée sous ce même nom. Le second
// appel écrase silencieusement le premier — un bug de "mauvaise animation qui
// joue" quasi impossible à tracer sans un signal explicite (ex. deux
// tutoriels/fichiers qui choisissent le même nom par coïncidence).
//
// Fix : avant d'écraser, vérifie si `µ.anim[name]` existe déjà et émet
// `µ.warn(...)` (toujours visible, jamais silencieux) si c'est le cas.
//
// Méthode : `create.ts` est un fichier runtime AUTONOME (une seule expression
// `(function(name, config) { ... })`, sans import/export — le bundler
// l'inclut tel quel via `µ.anim.<nom> = <ce fichier>` UNIQUEMENT s'il est
// référencé). On le charge et l'exécute DIRECTEMENT via `new Function`, avec
// un faux `µ` minimal — inutile de passer par tout le pipeline bundler/SSR
// pour tester cette seule fonction pure.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CREATE_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'animations', 'create.ts'), 'utf-8')

function loadCreateFactory(µ: any): (name: string, config: any) => any {
  // Le fichier est une expression `(function(name, config) {...});` — retire
  // le `;` final pour l'envelopper proprement dans un `return (...)`.
  const expr = CREATE_SRC.trim().replace(/;\s*$/, '')
  return new Function('µ', `return (${expr})`)(µ)
}

describe('µanim.create — collision de nom signalée', function () {
  it("1er enregistrement d'un nom : AUCUN warning", () => {
    const warnings: string[] = []
    const µ: any = { anim: {}, warn: (...args: any[]) => warnings.push(args.join(' ')) }
    const create = loadCreateFactory(µ)

    create('myFade', { duration: 200 })

    assert.equal(warnings.length, 0)
    assert.equal(typeof µ.anim.myFade, 'function')
  })

  it('2e enregistrement SOUS LE MÊME nom : un warning explicite (AVANT le fix : silence total)', () => {
    const warnings: string[] = []
    const µ: any = { anim: {}, warn: (...args: any[]) => warnings.push(args.join(' ')) }
    const create = loadCreateFactory(µ)

    create('myFade', { duration: 200 })
    create('myFade', { duration: 500 })

    assert.equal(warnings.length, 1,
      "AVANT le fix : la 2e animation écrasait la 1re SANS AUCUN signal — impossible à diagnostiquer")
    assert.match(warnings[0], /myFade/)
    assert.match(warnings[0], /remplace/)
  })

  it('collision avec un nom déjà présent AVANT même le premier µanim.create (ex. built-in du framework) : aussi signalée', () => {
    const warnings: string[] = []
    // Simule une animation BUILT-IN déjà enregistrée (fade/fly/scale/…) avant
    // que le code utilisateur n'appelle µanim.create.
    const µ: any = { anim: { fade: () => {} }, warn: (...args: any[]) => warnings.push(args.join(' ')) }
    const create = loadCreateFactory(µ)

    create('fade', { duration: 300 })

    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /fade/)
  })

  it('deux noms DIFFÉRENTS : aucun warning (pas de faux positif)', () => {
    const warnings: string[] = []
    const µ: any = { anim: {}, warn: (...args: any[]) => warnings.push(args.join(' ')) }
    const create = loadCreateFactory(µ)

    create('myFade', { duration: 200 })
    create('myOtherAnim', { duration: 100 })

    assert.equal(warnings.length, 0)
    assert.equal(typeof µ.anim.myFade, 'function')
    assert.equal(typeof µ.anim.myOtherAnim, 'function')
  })
})
