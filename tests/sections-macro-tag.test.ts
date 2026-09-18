// sections — masquage <@head>/<@failed> aligné sur findMacroTagEnd. AVANT :
// `content.replace(/<@(head|failed)\b[^>]*>[\s\S]*?<\/@\1>/gi, …)`
// s'arrêtait, pour la portion « attrs », au PREMIER `>` textuel — sans effet observable tant
// que rien d'autre ne matche dans la zone laissée non masquée par erreur (masquer PUIS
// restaurer recolle alors le texte à l'identique, quelle que soit la coupure : `pre + match +
// post` reconstruit toujours EXACTEMENT `content`). Le défaut devient
// OBSERVABLE dès qu'un `<script>`/`<style>` niché dans le bloc mal coupé se retrouve HORS
// masque : il fuit dans `scan` et se fait voler comme section du composant, ou lève une balise
// orpheline si le composant a déjà la sienne — exactement le risque que ce masquage existe
// pour combattre (cf. commentaire d'origine dans sections.ts).
//
// (s1) NOTE — l'exemple `<@head @click={$y > 100}>…` (une simple
// comparaison) NE REPRODUIT PAS de défaut sur ce fichier précis : la recherche paresseuse
// `[\s\S]*?<\/@head>` retrouve quand même la VRAIE fermeture quel que soit l'endroit où
// `[^>]*` s'est arrêté (elle continue simplement de chercher plus loin) — vérifié par bascule
// TEMPORAIRE de la ligne de masquage vers l'ancienne regex (Edit, aucun commit, restauré
// aussitôt) : `extractSections` rend un HTML byte-identique avant/après sur cet exemple précis.
// Le défaut ne devient réel que si le texte compris entre le faux `>` et la vraie fermeture
// contient LUI-MÊME un `</@head>`/`</@failed>` littéral (chaîne ou tout autre texte) : la
// recherche paresseuse s'arrête alors PLUS TÔT que la vraie fermeture. Cas substitué ci-dessous
// (s1/s3), fidèle à l'esprit du spec (un `>` niché dans une accolade casse la balise), avec un
// <script> imbriqué qui rend le défaut OBSERVABLE (throw « balise orpheline » AVANT, confirmé
// par la même bascule temporaire).

import assert from 'node:assert/strict'
import { extractSections } from '../src/transpiler/sections.js'

describe('sections — masquage <@head>/<@failed> conscient des accolades', function () {
  it('(s1) `>` niché dans une accolade + texte « </@head> » littéral avant la vraie fermeture : bloc entier masqué, le <script> imbriqué n\'est pas volé', () => {
    const src = ['<script>real=1</script>', '<@head @x={a > \'</@head>\'}><script src="head.js"></script></@head>', '<p>x</p>'].join('\n')
    const r = extractSections(src)
    assert.equal(r.script.raw, 'real=1', 'le seul <script> du composant doit être celui du top-level, pas celui niché dans <@head>')
    assert.equal(r.html, '<@head @x={a > \'</@head>\'}><script src="head.js"></script></@head>\n<p>x</p>')
  })

  it('(s2) deux <@head> successifs : les deux sont masqués, aucun des deux <script> nichés n\'est volé', () => {
    const src = ['<script>real=1</script>', '<@head><script src="a.js"></script></@head>', '<@head><script src="b.js"></script></@head>', '<p>x</p>'].join('\n')
    const r = extractSections(src)
    assert.equal(r.script.raw, 'real=1')
    assert.equal(r.html, '<@head><script src="a.js"></script></@head>\n<@head><script src="b.js"></script></@head>\n<p>x</p>')
  })

  it('(s3) <@failed> : même piège (accolade + texte « </@failed> » littéral), même protection', () => {
    const src = ['<script>real=1</script>', '<@failed @x={a > \'</@failed>\'}><script src="f.js"></script></@failed>', '<p>x</p>'].join('\n')
    const r = extractSections(src)
    assert.equal(r.script.raw, 'real=1')
    assert.equal(r.html, '<@failed @x={a > \'</@failed>\'}><script src="f.js"></script></@failed>\n<p>x</p>')
  })

  it('(s4) <@head titre="a">…</@head> SANS accolade dans les attributs : byte-identique au comportement d\'avant (aucun `>` niché, aucune divergence possible)', () => {
    const src = '<script>$x = 1</script>\n<div>avant</div>\n<@head titre="a"><meta name="x"></@head>\n<div>apres</div>\n'
    const r = extractSections(src)
    assert.equal(r.html, '<div>avant</div>\n<@head titre="a"><meta name="x"></@head>\n<div>apres</div>')
  })

  it('(s5) <@headx> (nom plus long) : pas la macro <@head>, jamais masqué (frontière de nom)', () => {
    const src = '<@headx>bonjour</@headx>'
    const r = extractSections(src)
    assert.equal(r.html, '<@headx>bonjour</@headx>')
  })

  it('(s6) <@head jamais refermée (accolade ouverte sans fin) : texte intact, aucune exception', () => {
    const src = '<@head @x={foo'
    assert.doesNotThrow(() => extractSections(src))
    const r = extractSections(src)
    assert.equal(r.html, '<@head @x={foo')
  })
})
