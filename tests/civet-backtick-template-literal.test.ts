// Template literal JS (backticks + `${...}`) dans un `<script lang="civet">`
// (ex. `message = \`Bonjour ${$nom}\``) : le motif COMPILE et FONCTIONNE, vrai
// pipeline à l'appui (transpileFile + rendu SSR réel). Le sigil `$nom` est
// réécrit `$.nom` À L'INTÉRIEUR de l'interpolation `${...}` comme partout
// ailleurs, sans aucun conflit avec le backtick. Le motif reste DÉCONSEILLÉ :
// la convention du projet est `"#{...}"`, dans l'esprit CoffeeScript. Ce
// fichier garde le cas en régression.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { transpileFile } from '../src/transpiler/index.js'
import { createSSRRenderer } from '../src/server/renderToString.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'

describe('Civet — template literal backtick + ${…} dans <script>', () => {
  after(async () => { await terminateSharedWorkerPool() })

  it('backtick SANS sigil (contrôle) : compile via transpileFile — Civet gère nativement `${…}`', async function () {
    this.timeout(8000)
    const root = mjsTmp('backtick-ctrl')
    const file = join(root, 'demo.mjs')
    writeFileSync(file, [
      '<script lang="civet">',
      'x := 1',
      'msg := `Bonjour ${x}`',
      '</script>',
      '<p>{msg}</p>',
    ].join('\n'))
    await assert.doesNotReject(() => transpileFile(file, { defaultScriptLang: 'civet' }))
  })

  it('motif EXACT de la doc (`$nom`/`$age`, sigils réactifs) : compile via transpileFile, sigil réécrit DANS le backtick', async function () {
    this.timeout(8000)
    const root = mjsTmp('backtick-doc')
    const file = join(root, 'demo.mjs')
    writeFileSync(file, [
      '<script lang="civet">',
      "$nom = 'monde'",
      '$age = 30',
      'message := `Bonjour ${$nom}, ${$age} ans`',
      '</script>',
      '<p>{message}</p>',
    ].join('\n'))
    const { output } = await transpileFile(file, { defaultScriptLang: 'civet' })
    assert.match(output, /`Bonjour \$\{\$\.nom\}, \$\{\$\.age\} ans`/,
      'AVANT ce test : PERSONNE ne vérifiait que ce motif compile réellement (la doc affirmait « Failed to parse »)')
  })

  it('bout-en-bout : le composant RENDU (SSR réel, pas juste compilé) affiche le texte interpolé correct', async function () {
    this.timeout(15000)
    const root = mjsTmp('backtick-ssr')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'backtick-demo.mjs'), [
      '<script lang="civet">',
      "$nom = 'monde'",
      '$age = 30',
      'message := `Bonjour ${$nom}, ${$age} ans`',
      '</script>',
      '<p>{message}</p>',
    ].join('\n'))
    const renderer = await createSSRRenderer({ sourceDir: srcDir, outputDir: join(root, 'out') })
    try {
      const { html } = await renderer.renderToString('mjs-backtick-demo', {})
      assert.match(html, /Bonjour monde, 30 ans/,
        'le motif ne doit pas juste COMPILER : il doit aussi FONCTIONNER (texte interpolé correct au rendu)')
    } finally {
      await renderer.close()
    }
  })
})
