// Test de régression — SOCLE catalogue messages FR/EN. Couvre le contrat
// public de src/messages/ : t()/setMessagesLang()/getMessagesLang(), défaut fr, bascule en,
// et repli fr sur toute valeur de `lang` autre que 'en' (clé de config, contrat silencieux).

import assert from 'node:assert/strict'
import { t, setMessagesLang, getMessagesLang } from '../src/messages/index.js'
import { fr } from '../src/messages/fr.js'
import { en } from '../src/messages/en.js'

describe('messages — catalogue fr/en (clé lang)', function () {
  afterEach(() => {
    setMessagesLang('fr')
  })

  it('défaut fr', function () {
    assert.equal(getMessagesLang(), 'fr')
    assert.equal(t('cli.flag-valeur-manquante', { flag: '--port' }), '⚠️  --port ignoré : valeur manquante.')
  })

  it('lang en', function () {
    setMessagesLang('en')
    assert.equal(getMessagesLang(), 'en')
    assert.equal(t('cli.flag-valeur-manquante', { flag: '--port' }), '⚠️  --port ignored: missing value.')
  })

  it('valeur inconnue → fr', function () {
    setMessagesLang('de')
    assert.equal(getMessagesLang(), 'fr')
    setMessagesLang(42 as never)
    assert.equal(getMessagesLang(), 'fr')
    setMessagesLang(undefined)
    assert.equal(getMessagesLang(), 'fr')
  })

  it('parité structurelle fr/en : mêmes clés des deux côtés', function () {
    const frKeys = new Set(Object.keys(fr))
    const enKeys = new Set(Object.keys(en))
    const onlyFr = [...frKeys].filter(k => !enKeys.has(k))
    const onlyEn = [...enKeys].filter(k => !frKeys.has(k))
    assert.deepEqual(onlyFr, [], `clés présentes en fr, absentes en en : ${onlyFr.join(', ')}`)
    assert.deepEqual(onlyEn, [], `clés présentes en en, absentes en fr : ${onlyEn.join(', ')}`)
    assert.equal(frKeys.size, enKeys.size, `${frKeys.size} clés fr vs ${enKeys.size} clés en`)
  })
})
