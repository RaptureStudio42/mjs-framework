// Régression — backtick IMBRIQUÉ dans une interpolation.
// L'ancien masquage des littéraux du lexer (`INERT_RE`, une seule regex) fermait
// la chaîne au PREMIER backtick rencontré : sur `` `a ${`b`} c` `` il fermait au
// 2e backtick au lieu du 4e, tout le masquage était décalé, et un `</script>`
// écrit DANS une chaîne (cas typique d'une page de doc qui MONTRE la balise)
// faisait partir l'extraction de sections en vrille — rattrapé in extremis par
// le garde-fou « reliquats » de transpiler/sections.ts, qui refusait de compiler.
//
// Depuis, `maskInert`/`maskInertSameLength` s'appuient sur un LECTEUR À NIVEAUX
// (src/lexer/index.ts) qui compte l'imbrication backtick / interpolation. Ce
// fichier fige les cas d'imbrication, ET le repli sur littéral non terminé (qui
// doit rester non masqué, sinon le garde-fou devient aveugle).

import assert from 'node:assert/strict'
import { maskInertSameLength } from '../src/lexer/index.js'
import { extractSections } from '../src/transpiler/sections.js'

// masqué ? — vrai si la sous-chaîne `needle` de `src` a été blanchie
function estMasque(src: string, needle: string): boolean {
  const at = src.indexOf(needle)
  assert.notEqual(at, -1, `motif absent de la source de test : ${needle}`)
  return maskInertSameLength(src).slice(at, at + needle.length).trim() === ''
}

describe('lexer — masquage des littéraux : backticks imbriqués', () => {
  it('la longueur et les sauts de ligne sont préservés (offsets alignés)', () => {
    const src    = 'a := `x ${`y`} z`\nb := 2\n'
    const masked = maskInertSameLength(src)
    assert.equal(masked.length, src.length)
    assert.equal((masked.match(/\n/g) ?? []).length, 2)
  })

  it('un backtick imbriqué ne ferme PAS la chaîne extérieure', () => {
    assert.equal(estMasque('a := `avant ${`dedans`} apres`\n', 'apres'), true)
  })

  it('deux niveaux d\'imbrication', () => {
    assert.equal(estMasque('a := `n1 ${`n2 ${`n3`} n2`} n1`\n', 'n1`'), true)
  })

  it('accolades imbriquees dans l\'interpolation', () => {
    assert.equal(estMasque('a := `x ${ f({ k: `y` }) } fin`\n', 'fin'), true)
  })

  it('chaine simple contenant un backtick, dans une interpolation', () => {
    assert.equal(estMasque('a := `x ${ q("un ` seul") } fin`\n', 'fin'), true)
  })

  it('backtick echappe : ne compte pas comme fermeture', () => {
    assert.equal(estMasque('a := `x \\` y` + apres\n', 'y`'), true)
    assert.equal(estMasque('a := `x \\` y` + apres\n', 'apres'), false)
  })

  it('code HORS chaine reste intact', () => {
    assert.equal(estMasque('a := `x` + visible\n', 'visible'), false)
  })

  it('chaine NON terminee : rien n\'est masque (le garde-fou doit rester lucide)', () => {
    assert.equal(estMasque('a := "pas fermee </script>\nb := 2\n', '</script>'), false)
  })

  it('interpolation NON refermee : la chaine entiere reste non masquee', () => {
    assert.equal(estMasque('a := `x ${ y\nb := reste\n', 'reste'), false)
  })

  it('commentaires et heredocs toujours masques', () => {
    assert.equal(estMasque('x := 1 # note ici\n', 'note ici'), true)
    assert.equal(estMasque('x := """bloc entier"""\n', 'bloc entier'), true)
    assert.equal(estMasque('x := 1 // ligne js\n', 'ligne js'), true)
    assert.equal(estMasque('x := 1 /* bloc js */\n', 'bloc js'), true)
  })

  it('un `#` suivi d\'un identifiant n\'est PAS un commentaire', () => {
    assert.equal(estMasque('a := couleur #ff0 fin\n', 'ff0'), false)
  })
})

describe('extractSections — la balise de fermeture citee dans un backtick imbrique', () => {
  it('ne casse plus l\'extraction (cas de la page de doc qui MONTRE </script>)', () => {
    const src = [
      '<script lang="js">',
      '  msg = `avant ${`</scr' + 'ipt>`} apres`',
      '</script>',
      '<div>contenu</div>',
    ].join('\n')
    const res = extractSections(src)                            //throwait avant : garde-fou reliquats
    assert.match(res.script.raw, /msg = /)
    assert.match(res.html, /<div>contenu<\/div>/)
  })

  it('la chaine NON terminee, elle, throw toujours (repli conserve)', () => {
    const src = [
      '<script lang="js">',
      '  msg = "jamais fermee </scr' + 'ipt>',
      '</script>',
      '<div>contenu</div>',
    ].join('\n')
    assert.throws(() => extractSections(src))
  })
})
