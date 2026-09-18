// l'erreur JSON.parse de mjs.config.json était la SEULE erreur du fichier
// hors catalogue (toujours en anglais brut, même quand `lang: 'fr'` est réglé par ailleurs) : sur
// 185 `throw new Error(...)` de config.ts, 184 passent par t('bundler.config....'), celle-ci non.

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { findConfig } from '../src/bundler/config.js'
import { setMessagesLang } from '../src/messages/index.js'

describe('config — findConfig() : erreur JSON.parse traduite par le catalogue', () => {
  afterEach(() => setMessagesLang('fr'))

  it("langue ambiante déjà 'fr' (posée par un chargement précédent) : le message sort en français, nomme le fichier et la position", () => {
    const root = mjsTmp('config-json-parse-error-fr')
    // virgule finale sans clé suivante : JSON syntaxiquement invalide
    writeFileSync(join(root, 'mjs.config.json'), '{\n  "sourceDir": "src",\n}\n')
    setMessagesLang('fr')
    assert.throws(() => findConfig(root), (e: any) => {
      assert.match(e.message, /\[mjs\.config\.json\]/)
      assert.match(e.message, /erreur de syntaxe JSON/, `AVANT le fix : message anglais brut non catalogué -> ${e.message}`)
      assert.ok(e.message.includes(join(root, 'mjs.config.json')), 'doit nommer le fichier')
      assert.match(e.message, /position \d+/, 'doit nommer la position (héritée du SyntaxError natif)')
      return true
    })
  })

  it("langue ambiante 'en' : le MÊME message sort en anglais (parité catalogue, pas un texte fixe)", () => {
    const root = mjsTmp('config-json-parse-error-en')
    writeFileSync(join(root, 'mjs.config.json'), '{\n  "sourceDir": "src",\n}\n')
    setMessagesLang('en')
    assert.throws(() => findConfig(root), /JSON syntax error/)
  })
})
