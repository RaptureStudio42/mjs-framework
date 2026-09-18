// UN HANDLER PEUT ENFIN ÉCRIRE DANS UNE VARIABLE ORDINAIRE DU `<script>`.
//
// Le batch `_mjs_inline` est compilé À PART du `<script>` composant : sa passe
// d'auto-déclaration ne connaissait AUCUN des noms déclarés à côté, alors qu'elle vit dans
// le MÊME corps de fonction (le handler les voit par closure). Elle posait donc un `let`
// local sur chaque écriture — deux pannes, aucune signalée :
//   · `@click={n = 'b'}` écrivait dans une copie jetable : l'écriture était PERDUE, sans un mot ;
//   · `@click={n = n + 1}` levait « Cannot access 'n' before initialization » au premier clic
//     (l'initialiseur du `let` lit la variable encore dans sa zone morte).
// C'est ce qui rendait `µtoggle(n, 'a', 'b')` inutilisable sur une variable nue.
//
// Le remède : passer au batch les vars top-level du `<script module>` ET du `<script>`,
// MOINS les noms que le template introduit lui-même dans le handler (variable et index de
// chaque `{for}`, que le squelette de reconstruction réassigne en tête) — sans ce filtre,
// un `<script>` portant un homonyme de la variable de boucle se ferait écraser à chaque clic.
// Le dernier cas (`nom` jamais déclaré NULLE PART) reste une faute, mais elle est désormais
// refusée AU BUILD au lieu d'attendre le premier clic.

import assert from 'node:assert/strict'
import { transpile } from '../src/transpiler/index.js'

/** le corps du batch `_mjs_inline` seul — jamais le `<script>` qui le précède */
async function batchInline(src: string): Promise<string> {
  const { output } = await transpile(src, { moduleName: 'card' })
  const debut = output.indexOf('_mjs_inline = [')
  assert.ok(debut > 0, 'aucun batch _mjs_inline dans la sortie')
  const fin = output.indexOf('\n]', debut)   // le crochet fermant du BATCH, seul en tête de ligne
  return output.slice(debut, fin > 0 ? fin : undefined)
}

describe('handlers — les variables ordinaires du <script>', function () {
  it('une écriture nue vise la var du <script>, elle n\'en déclare plus une copie locale', async function () {
    const batch = await batchInline("<script>\n  n = 'a'\n</script>\n<button @click={n = 'b'}>x</button>\n")
    assert.match(batch, /return n = 'b'/)
    assert.doesNotMatch(batch, /let n\b/, "AVANT : `let n = 'b'` — l'écriture partait dans une copie jetée à la sortie du handler")
  })

  it('une lecture-écriture ne lève plus au premier clic', async function () {
    const batch = await batchInline("<script>\n  compteur = 0\n</script>\n<button @click={compteur = compteur + 1}>x</button>\n")
    assert.match(batch, /return compteur = compteur \+ 1/)
    assert.doesNotMatch(batch, /let compteur\b/, "AVANT : `let compteur = compteur + 1` — zone morte, « Cannot access before initialization »")
  })

  it('la variable de boucle reste LOCALE, même si le <script> porte un homonyme', async function () {
    const batch = await batchInline("<script>\n  item = 'du script'\n  $list = [1, 2]\n</script>\n{for item in $list}\n  <button @click={console.log(item)}>x</button>\n{end}\n")
    assert.match(batch, /let item = __arr_0\[__idx_0\]/, 'le squelette DOIT garder sa propre déclaration')
    assert.match(batch, /let index = __idx_0/)
  })

  it('une locale de travail du handler reste une locale', async function () {
    const batch = await batchInline('<button @click={tmp = 3; console.log(tmp)}>x</button>\n')
    assert.match(batch, /let tmp = 3/, 'un nom qui ne se relit pas dans sa propre valeur est une locale parfaitement saine')
  })

  it('un nom que RIEN ne déclare et qui se relit : refusé au build', async function () {
    await assert.rejects(
      () => transpile("<button @click={n = (n === 'a' ? 'b' : 'a')}>x</button>\n", { moduleName: 'card' }),
      /se relit dans sa propre déclaration/,
    )
  })

  it('le message nomme la variable et les deux issues', async function () {
    await assert.rejects(
      () => transpile("<button @click={sens = (sens === 'asc' ? 'desc' : 'asc')}>x</button>\n", { moduleName: 'card' }),
      (e: Error) => {
        assert.match(e.message, /« sens »/)
        assert.match(e.message, /sens = …/,   'doit proposer la déclaration dans le <script>')
        assert.match(e.message, /« \$sens »/, 'doit proposer le symbole $ pour un état réactif')
        return true
      },
    )
  })

  it('une var du <script module> reste écrivable elle aussi', async function () {
    const batch = await batchInline("<script module>\n  partage = 0\n</script>\n<script>\n  local = 1\n</script>\n<button @click={partage = 7}>x</button>\n")
    assert.match(batch, /return partage = 7/)
    assert.doesNotMatch(batch, /let partage\b/)
  })

  // ─── limites de la première implémentation ────────────
  // La première écriture collectait les noms du `<script>` par une lecture LIGNE À LIGNE du
  // texte source. Trois trous, tous muets jusqu'au premier clic — fermés en lisant l'AST du
  // JS COMPILÉ (ce sont exactement les noms qui existeront dans le corps de fonction), et en
  // enregistrant TOUS les noms que le template introduit, pas seulement ceux d'un `{for}`.
  describe('les noms collectés — l\'AST du JS émis, jamais le texte', function () {
    it('un nom écrit dans un commentaire du <script> n\'est PAS un nom du script', async function () {
      const batch = await batchInline("<script>\n###\ndocVar = 'exemple dans un commentaire'\n###\nn = 1\n</script>\n<button @click={docVar = 'x'}>x</button>\n")
      assert.match(batch, /let docVar/, "AVANT : `docVar` était pris pour une var du script → `ReferenceError` au premier clic")
    })

    it('… ni un nom écrit dans une chaîne multi-ligne', async function () {
      const batch = await batchInline("<script>\n  txt = `\nlabel = 'texte, pas du code'\n`\n</script>\n<button @click={label = 'x'}>x</button>\n")
      assert.match(batch, /let label/)
    })

    it('le nom d\'un {const} reste LOCAL au handler, même si le <script> a un homonyme', async function () {
      const batch = await batchInline("<script>\n  label = 'du script'\n  $items = [{ nom: 'premier' }]\n</script>\n{for i, item in $items}\n  {const label = item.nom}\n  <button @click={label = 'ECRASE'}>{label}</button>\n{end}\n")
      assert.match(batch, /let label/, 'AVANT : le clic écrivait dans le `label` du <script> — muet, aucune erreur')
    })

    it('… de même pour l\'argument d\'un {success} / {error}', async function () {
      const succes = await batchInline("<script>\n  data = 'du script'\n  $p = Promise.resolve(1)\n</script>\n{await $p}\n  <p>…</p>\n{success data}\n  <button @click={data = 'x'}>y</button>\n{end}\n")
      assert.match(succes, /let data/)
      const erreur = await batchInline("<script>\n  err = 'du script'\n  $p = Promise.resolve(1)\n</script>\n{await $p}\n  <p>…</p>\n{error err}\n  <button @click={err = 'x'}>y</button>\n{end}\n")
      assert.match(erreur, /let err/)
    })

    it('une CONSTANTE du <script> réaffectée dans un handler est refusée au build', async function () {
      // `compteur := 0` compile en `const compteur` : l'écriture lèverait « Assignment to
      // constant variable » au premier clic. Autant le dire, en nommant l'opérateur à changer.
      await assert.rejects(
        () => transpile("<script>\n  compteur := 0\n</script>\n<button @click={compteur = compteur + 1}>x</button>\n", { moduleName: 'card' }),
        /déclaré CONSTANT/,
      )
    })

    it('un helper récursif local n\'est PAS pris pour une zone morte', async function () {
      // la relecture vit dans un CORPS DE FONCTION, jouée à l'appel : aucune TDZ possible
      const batch = await batchInline('<button @click={fact = (n) => n <= 1 ? 1 : n * fact(n - 1); console.log(fact(5))}>x</button>\n')
      assert.match(batch, /let fact/)
    })
  })

  // ─── le repli historique `templateLang: "js"` (handlers compilés en Coffee) ──
  // Coffee auto-déclare NATIVEMENT et n'a pas de `predeclared` : il pose un `var n;` en tête
  // du handler. On le laisse compiler, puis on retire la déclaration de trop sur l'AST de sa
  // sortie — même résultat que Civet, par l'autre bout.
  describe('le chemin Coffee (templateLang: "js")', function () {
    const batchCoffee = async (src: string): Promise<string> => {
      const { output } = await transpile(src, { moduleName: 'card', templateLang: 'js' })
      const debut = output.indexOf('_mjs_inline = [')
      return output.slice(debut, output.indexOf('\n]', debut))
    }

    it('une écriture nue vise la var du <script>', async function () {
      const batch = await batchCoffee("<script>\n  n = 'a'\n</script>\n<button @click={n = 'b'}>x</button>\n")
      assert.match(batch, /return n = 'b'/)
      assert.doesNotMatch(batch, /var n[,;]/, "AVANT : `var n;` local — écriture perdue, sans un mot")
    })

    it('une locale de travail garde son `var`', async function () {
      const batch = await batchCoffee('<button @click={tmp = 3; console.log(tmp)}>x</button>\n')
      assert.match(batch, /var tmp/)
    })

    it('la variable de boucle garde le sien', async function () {
      const batch = await batchCoffee("<script>\n  item = 'du script'\n  $list = [1, 2]\n</script>\n{for item in $list}\n  <button @click={console.log(item)}>x</button>\n{end}\n")
      assert.match(batch, /var [^;]*\bitem\b/)
    })
  })
})
