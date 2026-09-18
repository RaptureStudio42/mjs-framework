// Test de régression — en prod (`NODE_ENV=production`), `minifyJs` (appelé
// SANS CONDITION pour CHAQUE fichier compilé, y compris par le Bundler
// INTERNE que `createSSRRenderer` construit pour lui-même — indépendant de
// toute config utilisateur) MINIFIE aussi le bundle utilisé pour le rendu
// SSR. `stripEsm` (core) et `ssrScopeFile` (composants/modules) retiraient
// la syntaxe `import`/`export` via des regex ANCRÉES EN DÉBUT/FIN DE LIGNE —
// un import/export minifié n'est PLUS JAMAIS seul sur sa ligne (tout est
// compacté), ces regex ne matchaient PLUS RIEN, et `import`/`export`
// (syntaxe module, invalide en script classique) atteignaient
// `window.eval()` tels quels → TOUT rendu SSR échouait dès que le process
// hôte tourne avec `NODE_ENV=production` (déploiement standard), quelle que
// soit la config du renderer SSR lui-même.
//
// Fix en 3 volets distincts, chacun découvert en testant le VRAI pipeline
// bout-en-bout (pas juste stripEsm isolément) :
//   1. Ancrage par limite de MOT (`\b`) au lieu de limite de LIGNE.
//   2. `ssrScopeFile` doit réémettre un alias `const X = µ;` quand le mangler
//      renomme le binding LOCAL d'un import core supprimé (`import{µ as t}`).
//   3. `stripEsm` doit réémettre un alias `var µ = X;` quand le mangler
//      renomme la déclaration INTERNE de core et ne la ré-expose QUE via le
//      bloc `export{...}` supprimé (`export{i as µ}`).
// + 2 pièges de sur-matching corrigés en cours de route : `import(...)`
// (import DYNAMIQUE, une vraie fonctionnalité runtime, pas une déclaration à
// retirer) et une CHAÎNE contenant littéralement le mot "import" (message
// d'erreur réel du framework, `` `Failed to import ${r}` ``) — un pattern
// "générique" (n'importe quelle forme d'import, terminée au prochain `;`) ne
// peut PAS les distingure de manière fiable ; fix définitif = 4 regex
// SPÉCIFIQUES à la grammaire d'import ES (chacune exige la forme complète
// `... from '...'` ou une chaîne nue, qu'aucun texte libre ne produit par
// coïncidence).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToString, stripEsm } from '../src/server/renderToString.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

describe('stripEsm — une clé manifeste finissant en "import" ne corrompt plus le JSON', function () {
  it('« dir-import » dans µ.paths survit intact ET un vrai import de tête disparaît', function () {
    // manifeste RÉEL — clé de composant "dir-import"
    const manifestLine = `µ.paths = {"dir-import":"/assets/doc-dir-import-a1b2c3d4.js","autre":"/assets/autre-e5f6.js"};`
    const raw = `import 'foo.js';\n${manifestLine}\nwindow.µ = µ;`
    const out = stripEsm(raw)
    // on vise l'INSTRUCTION, pas le mot : `\bimport\b` matcherait aussi le « import » de
    // `"dir-import"`, la clé même que ce test demande de préserver
    assert.doesNotMatch(out, /import\s*['"]foo\.js['"]/, "l'import d'instruction en tête doit disparaître")
    assert.match(out, /"dir-import":"\/assets\/doc-dir-import-a1b2c3d4\.js"/, 'la clé JSON "dir-import" doit rester INTACTE (guillemets, ":", chemin)')
    // le résultat doit rester du JS évaluable — la ligne de manifeste doit parser en JSON valide
    const jsonText = out.match(/µ\.paths = (\{.*\});/)?.[1]
    assert.ok(jsonText, 'la ligne µ.paths doit toujours matcher la forme attendue')
    assert.doesNotThrow(() => JSON.parse(jsonText as string), 'le JSON du manifeste doit rester parsable après stripEsm')
  })
})

describe("SSR — stripEsm/ssrScopeFile survivent à un bundle MINIFIÉ (rendu en `env: 'prod'`)", function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it("composant + import cross-module (@import), build de prod : le rendu réussit ET le contenu est correct (pas juste \"ne plante pas\")", async function () {
    const root = mjsTmp('ssr-prod')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'tint.module.civet'), `export tint := -> 'ROUGE'\n`)
    writeFileSync(join(srcDir, 'page.mjs'), `@import tint 'tint.module.civet'\n\n<p class="r">{tint()}</p>\n`)

    const res = await renderToString({ sourceDir: srcDir, tag: 'mjs-page', env: 'prod' })

    assert.match(res.html, /ROUGE/,
      "AVANT le fix : l'éval du bundle minifié plantait avant même d'atteindre ce rendu (SyntaxError ou " +
      "ReferenceError sur µ) — aucun rendu SSR ne fonctionnait en prod, quel que soit le composant")
  })

  it("un message d'erreur RÉEL du framework contenant le mot \"import\" survit intact (pas de sur-matching sur du texte libre)", async function () {
    const root = mjsTmp('ssr-prod-string')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    // Le mot "import" DANS UNE CHAÎNE (pas une déclaration) — un pattern
    // "générique" (n'importe quelle forme, jusqu'au prochain ';') le
    // confondrait avec un import réel et supprimerait tout jusqu'au ';' suivant.
    writeFileSync(join(srcDir, 'comp.mjs'), `
<script lang="coffee">
msg = "Erreur : impossible d'importer ce module distant"
</script>
<p class="m">{msg}</p>
`)

    const res = await renderToString({ sourceDir: srcDir, tag: 'mjs-comp', env: 'prod' })
    assert.match(res.html, /impossible d.importer ce module distant/,
      "AVANT le fix : une chaîne contenant le mot \"import\" pouvait être tronquée/corrompue par le regex générique")
  })

  it('cas nominal (build de développement, pas de minification) : toujours correct (pas de régression du fix)', async function () {
    const root = mjsTmp('ssr-dev')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'tint.module.civet'), `export tint := -> 'BLEU'\n`)
    writeFileSync(join(srcDir, 'page.mjs'), `@import tint 'tint.module.civet'\n\n<p class="r">{tint()}</p>\n`)

    const res = await renderToString({ sourceDir: srcDir, tag: 'mjs-page' })
    assert.match(res.html, /BLEU/)
  })
})
