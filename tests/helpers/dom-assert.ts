// garde-fou de harnais : comparer un nœud DOM VIVANT à `null` avec node:assert
// (`assert.equal(el.querySelector('style'), null, msg)`) est une bombe à retardement. Tant que
// l'assertion passe, rien ne se voit ; le jour où elle ÉCHOUE — donc le jour où elle attrape une
// vraie régression — assert fabrique son message en inspectant la valeur reçue en profondeur
// illimitée, or le graphe d'un nœud happy-dom (ownerDocument → defaultView → toute la Window) est
// un réseau, pas un arbre : 14 Go en deux secondes, run tué par le noyau, machine à genoux.
// Ici le nœud n'est JAMAIS donné à assert : on lui passe un booléen, et le descripteur d'échec est
// fabriqué à la main — balise, id, classes, rien d'autre, aucun lien de parenté suivi.
// Le retour du motif est interdit par tests/harness-dom-null-assert.test.ts.

import assert from 'node:assert/strict'

const MAX_DESC = 120  //un descripteur reste court : jamais de sérialisation profonde

// descripteur SÛR d'une valeur : on ne lit que des champs plats, on ne traverse rien
export function describeNode(value: any): string {
  if(value === undefined) return 'undefined'
  if(value === null) return 'null'
  if(typeof value !== 'object') return String(value).slice(0, MAX_DESC)
  const tag = typeof value.nodeName === 'string' ? value.nodeName.toLowerCase() : ''
  if(!tag) return (value.constructor && value.constructor.name) || 'objet'
  const id  = typeof value.id === 'string' && value.id ? ' id="'+ value.id +'"' : ''
  const cls = typeof value.className === 'string' && value.className ? ' class="'+ value.className +'"' : ''
  return ('<'+ tag + id + cls +'>').slice(0, MAX_DESC)
}

// remplaçant strict de `assert.equal(<accès DOM>, null, msg)` : même fait vérifié (la valeur vaut
// exactement `null`), même message en tête de l'échec — sans l'inspection qui fait exploser la RAM
export function assertAbsent(value: any, msg: string = 'nœud attendu absent'): void {
  if(value === null) return
  assert.fail(msg +' — trouvé : '+ describeNode(value))
}
