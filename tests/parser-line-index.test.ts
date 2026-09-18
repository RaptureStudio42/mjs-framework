// `lineAt` (perf) : équivalence stricte entre l'index de sauts de ligne +
// recherche dichotomique (nouvelle implémentation, une fois par `Scanner`) et l'ANCIENNE formule
// `str.slice(0, pos).match(/\n/g)?.length ?? 0) + 1` (O(n) par appel, quadratique sur un HTML
// volumineux — recopiée ici comme ORACLE). Verrou de non-régression : ce test doit rester vert des
// deux côtés du refactor.

import assert from 'node:assert/strict'
import { parse, type Node } from '../src/parser/index.js'

// oracle — l'ancienne formule, telle quelle
function ancienneLineAt(str: string, pos: number): number {
  return (str.slice(0, pos).match(/\n/g)?.length ?? 0) + 1
}

// cherche le nœud `tag` portant `id="<id>"`, dans tout l'arbre (children + branches)
function trouveTag(root: Node, id: string): Node {
  const pile: Node[] = [...root.children]
  while (pile.length) {
    const n = pile.shift()!
    if (n.type === 'tag' && n.attrs.some(a => a.name === 'id' && a.val === id)) return n
    pile.push(...n.children)
    for (const b of n.branches) pile.push(...b.children)
  }
  throw new Error(`nœud id="${id}" introuvable`)
}

describe('parser — index des lignes de Scanner (perf lineAt)', () => {
  it('5 nœuds répartis sur un HTML multi-lignes, \\r\\n mêlés à \\n : ligne IDENTIQUE à l\'ancienne formule', () => {
    const lignes = [
      '<div id="n1">un</div>',
      '<div id="n2">deux</div>',
      '',
      '<div id="n3">trois</div>',
      '<div id="n4">quatre</div>',
      '<div id="n5">cinq</div>',
    ]
    // alterne les deux conventions de fin de ligne entre les segments
    const source = lignes[0] +'\r\n'+ lignes[1] +'\n'+ lignes[2] +'\r\n'+ lignes[3] +'\n'+ lignes[4] +'\r\n'+ lignes[5]
    const root = parse(source)

    for (const id of ['n1', 'n2', 'n3', 'n4', 'n5']) {
      const node    = trouveTag(root, id)
      const pos     = source.indexOf(`<div id="${id}"`)
      const attendu = ancienneLineAt(source, pos)
      assert.equal(node.line, attendu, `id=${id} — ligne attendue ${attendu}`)
    }
  })

  it('positions successives dans un même HTML (texte + expr + tag) restent cohérentes entre elles', () => {
    const source = '<p>ligne un</p>\n<p>{x}</p>\r\n<p>ligne trois</p>\n\n<p id="dernier">ligne cinq</p>'
    const root = parse(source)
    const dernier = trouveTag(root, 'dernier')
    assert.equal(dernier.line, ancienneLineAt(source, source.indexOf('<p id="dernier"')))
  })
})
