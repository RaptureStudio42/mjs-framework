// Des noms bits() en double étaient acceptés côté client (mjs_schema.ts::_mjschemaValiderType,
// AUCUNE vérif de doublon) mais rejetés côté serveur (schema/core.ts::validerType, ligne 113,
// `new Set(type.noms).size !== type.noms.length` → throw) — l'en-tête de mjs_schema.ts affirme
// pourtant « tout le reste... identique » au serveur. Le throw serveur lui-même (schema.bits-noms-
// double) n'était par ailleurs exercé par AUCUN test, ni côté serveur ni côté client — ce fichier
// couvre les DEUX, sans toucher à schema/core.ts (déjà correct).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { creerRegistre, defSchema, bits } from '../src/schema/core.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const clientSrc = readFileSync(join(__dirname, '../src/runtime/mjs_schema.ts'), 'utf8')

function makeMuClient(): any {
  const µ: any = { warn: () => {}, error: () => {} }
  new Function('µ', clientSrc)(µ)
  return µ
}

// ============================================================================================
// serveur (schema/core.ts) — déjà correct, jamais exercé par un test avant
// ============================================================================================

describe('schema/core — bits() noms en double (côté serveur — comportement déjà correct, non testé avant)', () => {
  it("defSchema(bits(['a','b','a'])) lève 'noms en double'", () => {
    const reg = creerRegistre()
    assert.throws(
      () => defSchema(reg, 'joueur', { flags: bits(['vivant', 'vip', 'vivant']) }),
      /noms en double/,
    )
  })
})

// ============================================================================================
// client (mjs_schema.ts) — AVANT le fix : acceptait silencieusement (parité rompue)
// ============================================================================================

describe('mjs_schema (client) — bits() noms en double', () => {
  it("µ.schema('joueur', {flags: µ.bits(['vivant','vip','vivant'])}) lève désormais, comme le serveur", () => {
    const µ = makeMuClient()
    assert.throws(
      () => µ.schema('joueur', { flags: µ.bits(['vivant', 'vip', 'vivant']) }),
      /noms en double/,
      "AVANT le fix : acceptait silencieusement, id attribué au schéma malgré le doublon",
    )
  })

  it('aucun id attribué au registre client après le refus (pas de schéma fantôme)', () => {
    const µ = makeMuClient()
    assert.throws(() => µ.schema('joueur', { flags: µ.bits(['vivant', 'vip', 'vivant']) }))
    assert.equal(µ._mjs_mjschemaRegistre.parNom.has('joueur'), false, "un schéma rejeté ne doit JAMAIS entrer dans le registre")
  })

  it('bits() sans doublon reste accepté (non-régression)', () => {
    const µ = makeMuClient()
    const def = µ.schema('joueur', { flags: µ.bits(['vivant', 'vip']) })
    assert.equal(def.id, 0)
    assert.equal(µ._mjs_mjschemaRegistre.parNom.has('joueur'), true)
  })
})

// ============================================================================================
// symétrie du MESSAGE (structure « bits() — noms en double », les deux catalogues)
// ============================================================================================

describe('schema — parité du message « bits() — noms en double » client/serveur', () => {
  it('le message client contient le MÊME cœur de phrase que le message serveur catalogué', async () => {
    const { t, setMessagesLang } = await import(pathToFileURL(join(__dirname, '../src/messages/index.js')).href) as any
    setMessagesLang('fr')   // LANG est un état GLOBAL du module — un autre fichier de test peut l'avoir laissé en 'en'
    const texteServeur = t('schema.bits-noms-double', { schema: 'joueur', champ: 'flags' })
    assert.match(texteServeur, /bits\(\) — noms en double/)

    const µ = makeMuClient()
    try { µ.schema('joueur', { flags: µ.bits(['a', 'b', 'a']) }); assert.fail('devait lever') }
    catch (e: any) { assert.match(e.message, /bits\(\) — noms en double/) }
  })
})
