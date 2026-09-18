// garde du HARNAIS, pas du produit : interdit le retour du motif qui a mis la machine
// à genoux — `assert.equal(<accès DOM>, null, …)`. Tant qu'une telle assertion passe, elle est
// inoffensive ; le jour où elle échoue — donc le jour où elle attrape enfin une régression — elle
// demande à node:assert de sérialiser tout le graphe happy-dom pour fabriquer son message : 14 Go
// en deux secondes, run tué par le noyau. Le remplaçant est `assertAbsent()`
// (tests/helpers/dom-assert.ts) : même fait vérifié, message court, aucune inspection profonde.
// Ce fichier est la mémoire du dépôt — un nouveau site du motif fait rougir la suite AVANT d'avoir
// eu l'occasion d'exploser. La détection lit les SOURCES (jamais d'exécution) et découpe les
// arguments en comptant parenthèses, chaînes, COMMENTAIRES et littéraux regex : un appel étalé sur
// plusieurs lignes est vu, un commentaire français au milieu de l'appel (avec son apostrophe et ses
// virgules) ne fausse rien, et le code sans point-virgule ne fabrique pas de faux couple avec
// l'assertion suivante. Les deux ORDRES d'arguments sont surveillés — `equal(nœud, null)` comme
// `equal(null, nœud)`, c'est la même bombe. Le premier test prouve que la garde attrape bien ce
// qu'elle prétend attraper : une garde jamais éprouvée ne garde rien.

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const TESTS_DIR = dirname(fileURLToPath(import.meta.url))
const EXEMPT = new Set(['harness-dom-null-assert.test.ts', 'dom-assert.ts'])  //la garde et son remplaçant se citent forcément
const SKIP_DIRS = new Set(['node_modules', 'fixtures', 'snapshots'])

// accès qui RENDENT un nœud DOM — les seuls dangereux (getAttribute rend une chaîne : sans risque)
const ACCESS = /(querySelector|getElementById|getElementsBy|firstChild|lastChild|firstElementChild|lastElementChild|next(?:Element)?Sibling|previous(?:Element)?Sibling|parentNode|parentElement|offsetParent|closest|activeElement|shadowRoot|assignedSlot|elementFromPoint)/
const OPENER = /[A-Za-z_$]*[Aa]ssert[A-Za-z_$]*\.(?:equal|strictEqual|deepEqual|deepStrictEqual)\(/g
const AVANT_REGEX = /[(,=:[!&|?{};+\-*%<>~^]/  //ce qui peut précéder un littéral regex — sinon `/` est une division

// fin d'un littéral regex ouvert en `i` (le `/` inclus), -1 s'il n'est jamais refermé
function skipRegex(src: string, i: number): number {
  let classe = false
  for(let j = i + 1; j < src.length; j++) {
    const c = src[j]
    if(c === '\\') { j++; continue }
    if(c === '\n') return -1
    if(c === '[') classe = true
    else if(c === ']') classe = false
    else if(c === '/' && !classe) return j
  }
  return -1
}

// dernier caractère significatif avant `i` : dit si un `/` ouvre une regex ou divise
function ouvreRegex(src: string, i: number): boolean {
  for(let j = i - 1; j >= 0; j--) {
    const c = src[j]
    if(c === ' ' || c === '\t' || c === '\n' || c === '\r') continue
    return AVANT_REGEX.test(c)
  }
  return true
}

// découpe les arguments d'un appel dont `start` est l'index JUSTE APRÈS la parenthèse ouvrante :
// suit la profondeur des (), [] et {}, saute chaînes, commentaires et regex, rend null si l'appel
// n'est pas refermé (source tronquée ou syntaxe inattendue) — jamais d'exception
function callArgs(src: string, start: number): string[] | null {
  const args: string[] = []
  let depth = 0, quote = '', from = start
  for(let i = start; i < src.length; i++) {
    const c = src[i], suivant = src[i + 1]
    if(quote) {
      if(c === '\\') i++
      else if(c === quote) quote = ''
      continue
    }
    if(c === '/' && suivant === '/') { const nl = src.indexOf('\n', i); if(nl === -1) return null; i = nl; continue }
    if(c === '/' && suivant === '*') { const fin = src.indexOf('*/', i + 2); if(fin === -1) return null; i = fin + 1; continue }
    if(c === '/' && ouvreRegex(src, i)) { const fin = skipRegex(src, i); if(fin === -1) return null; i = fin; continue }
    if(c === '\'' || c === '"' || c === '`') { quote = c; continue }
    if(c === '(' || c === '[' || c === '{') { depth++; continue }
    if(c === ')' && depth === 0) { args.push(src.slice(from, i)); return args }
    if(c === ')' || c === ']' || c === '}') { depth--; continue }
    if(c === ',' && depth === 0) { args.push(src.slice(from, i)); from = i + 1 }
  }
  return null
}

// numéros de ligne des sites du motif dans une source
export function scan(src: string): number[] {
  const out: number[] = []
  OPENER.lastIndex = 0
  let m: RegExpExecArray | null
  while((m = OPENER.exec(src)) !== null) {
    const args = callArgs(src, m.index + m[0].length)
    if(!args || args.length < 2) continue
    const nulEnSecond = args[1].trim() === 'null' && ACCESS.test(args[0])
    const nulEnPremier = args[0].trim() === 'null' && ACCESS.test(args[1])
    if(!nulEnSecond && !nulEnPremier) continue
    out.push(src.slice(0, m.index).split('\n').length)
  }
  return out
}

describe('harnais — aucune assertion ne compare un nœud DOM à null', function () {
  it('la garde attrape le motif, et lui seul', () => {
    assert.deepEqual(scan("assert.equal(el.querySelector('style'), null, 'aucun <style>')"), [1], 'le motif nu doit être vu')
    assert.deepEqual(scan("nodeAssert.equal(win.document.getElementById('x'), null)\n"), [1], 'sans message, et sous un autre nom, aussi')
    assert.deepEqual(scan("assert.equal(null, el.querySelector('style'), 'msg')"), [1], 'arguments INVERSÉS : la même bombe')
    assert.deepEqual(scan("const a = 1\nassert.equal(\n  box.closest('form'),\n  null\n)"), [2], 'un appel étalé sur plusieurs lignes doit être vu')
    assert.deepEqual(scan("assert.equal(\n  // n'oublie pas le cas limite, dit-il\n  box.nextElementSibling,\n  null\n)"), [1], 'un commentaire français au milieu de l\'appel ne doit rien fausser')
    assert.deepEqual(scan("assert.equal(/* on n'y touche pas, jamais */ box.assignedSlot, null)"), [1], 'commentaire de bloc idem')
    assert.deepEqual(scan("assert.equal(el.querySelector('x'), null, String(/l'ancre/))"), [1], 'un littéral regex dans le message ne doit rien fausser')
    assert.deepEqual(scan("assert.equal(box.querySelectorAll('b').length / 2, null)"), [1], 'une division ne doit pas être prise pour une regex')
    assert.deepEqual(scan("assert.equal(el.querySelectorAll('style').length, 0)"), [], 'compter les nœuds est le bon idiome')
    assert.deepEqual(scan("assert.notEqual(el.querySelector('style'), null)"), [], 'notEqual n\'échoue que sur null : sans danger')
    assert.deepEqual(scan("assertAbsent(el.querySelector('style'), 'aucun <style>')"), [], 'le remplaçant ne doit pas être signalé')
    assert.deepEqual(scan("assert.equal(el.getAttribute('data-x'), null)"), [], 'un attribut est une chaîne, jamais un graphe')
    assert.deepEqual(scan("assert.equal(box.querySelector('b').textContent, 'oui')\nassert.equal(retour, null)"), [], 'sans point-virgule, deux assertions voisines ne forment pas un faux couple')
  })

  it('aucun site du motif ne subsiste dans la suite', () => {
    const coupables: string[] = []
    for(const file of sourceFiles(TESTS_DIR)) {
      const relatif = relative(TESTS_DIR, file)
      for(const ligne of scan(readFileSync(file, 'utf-8'))) coupables.push(relatif +':'+ ligne)
    }
    assert.ok(coupables.length === 0, coupables.length +' assertion(s) comparent un nœud DOM à null — remplace par assertAbsent() de ./helpers/dom-assert.js (une seule d\'entre elles, en échouant, suffit à faire tomber la machine) :\n  '+ coupables.join('\n  '))
  })
})

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for(const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if(entry.isDirectory()) { if(!SKIP_DIRS.has(entry.name)) out.push(...sourceFiles(full)) }
    else if(/\.m?ts$/.test(entry.name) && !EXEMPT.has(entry.name)) out.push(full)
  }
  return out
}
