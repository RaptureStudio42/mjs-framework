// 4 mineurs sûrs, plus une normalisation CRLF, tous dans src/transpiler/index.ts. Méthode
// test-d'abord : chaque bloc ci-dessous documente le comportement ROUGE observé avant correctif,
// puis la sortie VERTE attendue après.
//
// replaceMagicAssets : `out.replace(from, to)` avec `to` STRING lit les motifs spéciaux
//       ($&/$1/$$/$`/$') de String.replace — un chemin web résolu qui en contient un coupait ou
//       dupliquait la sortie au lieu de s'insérer littéralement.
// applyI18nPrefixing : le marqueur `µ.t(` était cherché par indexOf sur le code BRUT — une
//       chaîne ou un commentaire qui MENTIONNE `µ.t('clé')` voyait sa « clé » préfixée par la
//       section comme s'il s'agissait d'un vrai appel.
// moduleVars (vars top-level du <script module>) collectées par un scan textuel ligne à
//       ligne, colonne 0 — un nom posé DANS un bloc `###…###`/`/* */`/chaîne multi-lignes passait
//       pour une vraie var module, empêchant l'auto-déclaration de son homonyme dans le <script>.
// collectTopLevelDeclarations ignorait `ExportNamedDeclaration` : un module qui EXPORTE une
//       var/const la perdait de la collecte (moduleTopVars), un handler inline qui l'écrivait la
//       redéclarait localement (ou, ici, se heurtait à lintHandlerSelfRefDeclaration).
// CRLF non normalisé en entrée de transpile() : le sucre mono-ligne (`k = (a, b) ->`) ne
//       s'appliquait plus du tout sur un fichier CRLF.

import assert from 'node:assert/strict'
import { transpile } from '../src/transpiler/index.ts'

describe('replaceMagicAssets : forme fonction, jamais de motif spécial de String.replace', function () {
  this.timeout(8000)

  it("resolveAsset renvoyant '/a/img-$&-$1.png' : le chemin apparaît LITTÉRALEMENT dans la sortie, transpile() ne jette pas", async function () {
    const src = [
      '<script>',
      "$logo = µasset('logo.png')",
      '</script>',
      '<p>{$logo}</p>',
    ].join('\n')
    const resolveAsset = async () => '/a/img-$&-$1.png'
    const { output } = await transpile(src, { moduleName: 'a3-7-t1-asset-dollar', resolveAsset })
    assert.ok(output.includes('/a/img-$&-$1.png'), 'le chemin résolu doit apparaître tel quel, sans réinjection du motif matché ni troncature')
  })
})

describe("applyI18nPrefixing : une chaîne/un commentaire qui MENTIONNE µ.t( n'est jamais un vrai appel", function () {
  this.timeout(8000)

  it("chaîne \"utilisez µ.t('clé') ici\" et commentaire // µ.t('c') intacts, vrai appel µt('ok') préfixé en µ.t('sec.ok')", async function () {
    const src = [
      "@i18n 'sec'",
      '<script lang="civet">',
      "aide := \"utilisez µ.t('clé') ici\"",
      "// µ.t('c')",
      "x := µt('ok')",
      '</script>',
      '<p>hi</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'a3-7-t5-i18n-mention-chaine' })
    assert.ok(output.includes("µ.t('clé')"), 'la chaîne doit rester intacte, jamais préfixée')
    assert.ok(!output.includes("µ.t('sec.clé')"), "la clé DANS la chaîne ne doit jamais être préfixée par la section")
    assert.ok(output.includes("µ.t('c')"), 'le commentaire doit rester intact, jamais préfixé')
    assert.ok(!output.includes("µ.t('sec.c')"), 'la clé DANS le commentaire ne doit jamais être préfixée par la section')
    assert.ok(output.includes("µ.t('sec.ok')"), 'le VRAI appel, lui, doit être préfixé par la section')
  })
})

describe("moduleVars lu sur l'AST du JS ÉMIS, plus sur un scan textuel colonne 0", function () {
  this.timeout(8000)

  it("un `foo = 1` posé DANS un bloc ###…### du <script module> ne bloque plus l'auto-déclaration de son homonyme dans le <script>", async function () {
    const src = [
      '<script module>',
      '###',
      'foo = 1',
      '###',
      '</script>',
      '<script>',
      'foo = 2',
      '</script>',
      '<p>{foo}</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'a3-7-t6-module-comment-block' })
    assert.match(output, /\blet foo\b/, 'foo doit être auto-déclaré dans le <script> (le module ne le déclare PAS réellement, tout entier commenté)')
  })

  it('non-régression — <script module> `compteur .= 0` + <script> `compteur = compteur + 1` : pas de re-déclaration locale', async function () {
    const src = [
      '<script module>',
      'compteur .= 0',
      '</script>',
      '<script>',
      'compteur = compteur + 1',
      '</script>',
      '<p>hi</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'a3-7-t6-nonreg-let-module-var' })
    assert.equal((output.match(/\blet compteur\b/g) ?? []).length, 1, 'une seule déclaration de compteur, posée dans le module')
    assert.ok(output.includes('compteur = compteur + 1'), 'le <script> réassigne la var du module telle quelle, sans la redéclarer')
  })

  it('non-régression — <script module> `export x := 1` + <script> `x = 2` : pas de re-déclaration locale', async function () {
    const src = [
      '<script module>',
      'export x := 1',
      '</script>',
      '<script>',
      'x = 2',
      '</script>',
      '<p>hi</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'a3-7-t6-nonreg-export-const' })
    assert.equal((output.match(/\b(?:let|const) x\b/g) ?? []).length, 1, 'une seule déclaration de x, posée dans le module (export const)')
    assert.ok(output.includes('x = 2'), 'le <script> réassigne x tel quel, sans le redéclarer')
  })
})

describe("collectTopLevelDeclarations voit aussi les déclarations EXPORTÉES du module", function () {
  this.timeout(8000)

  it("<script module> `export compteur .= 0` + handler @click={compteur = compteur + 1} : transpile() résout, le handler ne redéclare PAS compteur", async function () {
    const src = [
      '<script module>',
      'export compteur .= 0',
      '</script>',
      '<button @click={compteur = compteur + 1}>+</button>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'a3-7-t6b-handler-export-let' })
    const idx = output.indexOf('_mjs_inline')
    assert.ok(idx !== -1, '_mjs_inline doit être émis (le handler existe bien dans la sortie)')
    assert.doesNotMatch(output.slice(idx), /\blet compteur\b/, 'le handler ne pose pas de `let compteur` local : compteur vient du module, exporté ou pas')
  })

  it("idem export const — <script module> `export TOTAL := 10` : le handler ne se heurte plus à « jamais déclaré »", async function () {
    const src = [
      '<script module>',
      'export TOTAL := 10',
      '</script>',
      '<button @click={TOTAL = TOTAL + 1}>+</button>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'a3-7-t6b-handler-export-const' })
    const idx = output.indexOf('_mjs_inline')
    assert.ok(idx !== -1, '_mjs_inline doit être émis (le handler existe bien dans la sortie)')
    assert.doesNotMatch(output.slice(idx), /\b(?:let|const) TOTAL\b/, 'le handler ne pose pas de re-déclaration locale : TOTAL vient du module, exporté ou pas')
  })
})

describe('CRLF normalisé en tête de transpile()', function () {
  this.timeout(8000)

  it('le même composant en LF et en CRLF produit une sortie et une source map IDENTIQUES', async function () {
    const lf = [
      '<script>',
      'k = (a, b) ->',
      '  a + b',
      '$y = k(1, 2)',
      '</script>',
      '<p>{$y}</p>',
    ].join('\n')
    const crlf = lf.replace(/\n/g, '\r\n')
    const resLf = await transpile(lf, { moduleName: 'a3-7-d4-crlf' })
    const resCrlf = await transpile(crlf, { moduleName: 'a3-7-d4-crlf' })
    assert.equal(resCrlf.output, resLf.output, 'sortie strictement identique entre la version LF et la version CRLF')
    assert.equal(resCrlf.sourceMap, resLf.sourceMap, "source map identique aussi (startLine inchangé, un CR+LF compte pour UNE seule ligne)")
  })
})
