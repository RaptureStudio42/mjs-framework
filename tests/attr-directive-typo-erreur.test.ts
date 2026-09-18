// @xxx inconnu sur un élément = écouteur d'événement, jamais vérifié — remplace l'ancienne garde
// (casse exacte + Levenshtein ≤2, toutes deux
// BLOQUANTES). Le repli générique du dispatcher d'attributs (`@xxx` non catché →
// écouteur DOM, generator/attributes/index.ts, `eventListener()` → `registerEventRoute()`)
// n'est plus jugé du tout : « pour les @event on ne vérifie juste RIEN ».
// Peu importe la proximité avec une directive connue (`@confirn`/`@stlye`/`@titel`…) ou la
// casse d'une directive existante (`@Confirm`) : le nom devient l'événement écouté tel quel.
// Seules les DIRECTIVES DES BALISES DE SECTION (<style>/<script>/<theme>/<routes>) et les
// directives racine restent contrôlées (transpiler/sections.ts, transpiler/directives.ts).
//
// Harnais copié de tests/emit-raw-event-warning.test.ts (même famille de feature : diagnostic
// compile-time via transpile() direct, en process).

import assert from 'node:assert/strict'
import { transpile } from '../src/transpiler/index.js'

// capture l'erreur de compilation d'un transpile, ou sa sortie si aucune erreur
async function typoCheck(src: string, moduleName: string): Promise<{ err?: any; output?: string }> {
  try {
    const { output } = await transpile(src, { moduleName })
    return { output }
  } catch (err: any) {
    return { err }
  }
}

describe('@xxx inconnu sur un élément = écouteur d\'événement, jamais vérifié', function () {
  this.timeout(30000)

  it('@confirn="…" : compile sans erreur, la sortie écoute "confirn"', async () => {
    const { err, output } = await typoCheck('<button @confirn="oups">go</button>', 'typoconfirn')
    assert.equal(err, undefined, `aucune erreur attendue : ${err?.message}`)
    assert.match(output ?? '', /"confirn"/)
  })

  it('@stlye="…" : compile sans erreur, la sortie écoute "stlye"', async () => {
    const { err, output } = await typoCheck('<div @stlye="x">x</div>', 'typostlye')
    assert.equal(err, undefined, `aucune erreur attendue : ${err?.message}`)
    assert.match(output ?? '', /"stlye"/)
  })

  it('@titel="…" : compile sans erreur, la sortie écoute "titel"', async () => {
    const { err, output } = await typoCheck('<button @titel="hi">go</button>', 'typotitel')
    assert.equal(err, undefined, `aucune erreur attendue : ${err?.message}`)
    assert.match(output ?? '', /"titel"/)
  })

  it('@next="…" : compile sans erreur, la sortie écoute "next"', async () => {
    const { err, output } = await typoCheck('<div @next="x">x</div>', 'typonext')
    assert.equal(err, undefined, `aucune erreur attendue : ${err?.message}`)
    assert.match(output ?? '', /"next"/)
  })

  it('@Confirm="…" : compile sans erreur, quelle que soit la casse — la sortie écoute "Confirm"', async () => {
    const { err, output } = await typoCheck('<button @Confirm="x">go</button>', 'typoConfirmCasse')
    assert.equal(err, undefined, `aucune erreur attendue : ${err?.message}`)
    assert.match(output ?? '', /"Confirm"/)
  })

  it('@confirn NU (sans valeur) : compile sans erreur, la sortie écoute "confirn"', async () => {
    const { err, output } = await typoCheck('<button @confirn>go</button>', 'typoconfirnnu')
    assert.equal(err, undefined, `aucune erreur attendue : ${err?.message}`)
    assert.match(output ?? '', /"confirn"/)
  })

  it('@edit="…" : compile sans erreur, la sortie écoute "edit"', async () => {
    const { err, output } = await typoCheck('<div @edit="x">x</div>', 'typoedit')
    assert.equal(err, undefined, `aucune erreur attendue : ${err?.message}`)
    assert.match(output ?? '', /"edit"/)
  })

  it('@reload="…" : compile sans erreur, la sortie écoute "reload"', async () => {
    const { err, output } = await typoCheck('<div @reload="x">x</div>', 'typoreload')
    assert.equal(err, undefined, `aucune erreur attendue : ${err?.message}`)
    assert.match(output ?? '', /"reload"/)
  })

  it('@methdo="…" sur <a href> : compile sans erreur, la sortie écoute "methdo"', async () => {
    const { err, output } = await typoCheck('<a @methdo="doThing()" href="/x">go</a>', 'typomethdo')
    assert.equal(err, undefined, `aucune erreur attendue : ${err?.message}`)
    assert.match(output ?? '', /"methdo"/)
  })
})

describe('@xxx.modificateur inconnu : contrat DISTINCT, jamais retiré (eventListener(), pas une garde de nom)', () => {
  it('@Style.color="red" : erreur du MODIFICATEUR inconnu ".color" — rien à voir avec la garde de nom retirée (le nom "@Style" lui-même n\'est jamais jugé)', async () => {
    const { err } = await typoCheck('<div @Style.color="red">x</div>', 'typostylecolor')
    assert.ok(err, 'une erreur de compilation était attendue')
    assert.match(err.message, /\.color/)
    assert.match(err.message, /modificateur/)
  })
})
