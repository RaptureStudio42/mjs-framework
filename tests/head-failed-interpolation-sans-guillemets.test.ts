// Dans une balise de `<@head>`/`<@failed>`, une interpolation HORS guillemets est refusée à la
// compilation. Le contenu de ces deux blocs part en innerHTML (µ._setHead / repli d'error
// boundary) : `µ._esc` échappe `<>"'&`, jamais l'espace ni le `=`, donc une valeur nue
// (`href=https://x/{$slug}`) ou une expression posée à la place d'un attribut (`<meta {$x}>`)
// laissait une donnée d'ailleurs AJOUTER un attribut (`x onload=alert(1)`). L'erreur nomme la
// ligne du `.mjs` et la forme correcte ; elle s'accumule dans `errors` (jamais de throw), le
// bundler fait échouer la construction.
//
// `content={$x}` et `content={{$x}}` sont auto-quotés en amont (`="{…}"`) : hors sujet. Une valeur
// nue SANS interpolation (`title=l'erreur`) reste acceptée, comme le texte, les commentaires et les
// accolades d'un `<style>`.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { processGlobalMacros } from '../src/transpiler/macros.js'
import { transpile } from '../src/transpiler/index.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { createHarness } from '../src/testing/index.js'
import { mjsTmp } from './helpers/tmp.js'

// Donnée hostile de référence : elle porte un espace, un `=`, un guillemet et un `>` — de quoi
// ajouter un attribut ET fabriquer un élément dès que le compilateur la laisse hors guillemets.
const HOSTILE = 'x onload=alert(1) "><img class="evil" src=x>'

// miroir de µ._esc (src/runtime/mjs_esc.ts) : le runtime n'est pas chargé dans un test d'unité
const esc = (v: unknown): string => {
  const s = String(v)
  return /[&<>"']/.test(s) ? s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;') : s
}

// injecte — compile un bloc, ÉVALUE l'expression produite avec la donnée hostile, parse le HTML
// obtenu comme le ferait le navigateur : la preuve porte sur ce qui arrive vraiment dans la tête.
const injecte = (bloc: string, donnee: string = HOSTILE): { html: string; balises: string[]; attributs: string[]; evil: number } => {
  const r = processGlobalMacros(bloc)
  assert.equal(r.errors.length, 0, `forme légitime attendue, refus reçu : ${JSON.stringify(r.errors)}`)
  const expr = r.setup.match(/µ\._setHead\(@, ([\s\S]*)\)$/)?.[1] ?? r.setup.match(/_mjs_d\.innerHTML = ([\s\S]*?)\n/)?.[1]
  assert.ok(expr, `expression d'injection introuvable dans : ${r.setup}`)
  const html = new Function('µ', '$x', '$slug', '$h', `return (${expr})`)({ _esc: esc }, donnee, donnee, donnee) as string
  const window = new Window()
  const hote = window.document.createElement('div')
  hote.innerHTML = html
  const balises: string[] = []
  const attributs: string[] = []
  hote.querySelectorAll('*').forEach((el) => {
    balises.push(el.tagName.toLowerCase())
    for (const a of [...el.attributes]) attributs.push(a.name)
  })
  return { html, balises, attributs, evil: hote.querySelectorAll('.evil').length }
}

describe('<@head>/<@failed> — interpolation hors guillemets dans une balise : refusée', function () {
  it('<@head> valeur nue `href=https://x/{$slug}` : 1 erreur, ligne et forme correcte citées', () => {
    const r = processGlobalMacros('<@head><link rel="canonical" href=https://x/{$slug}></@head>')
    assert.equal(r.errors.length, 1, `attendu exactement 1 erreur, reçu : ${JSON.stringify(r.errors)}`)
    assert.match(r.errors[0], /<@head> ligne 1 :/)
    assert.match(r.errors[0], /« href=https:\/\/x\/\{\$slug\} »/)
    assert.match(r.errors[0], /Écrivez href="https:\/\/x\/\{\$slug\}"\./)
  })

  it('<@head> expression à la place d\'un attribut `<meta {$attrs}>` : 1 erreur, balise fautive citée', () => {
    const r = processGlobalMacros('<@head><meta {$attrs}></@head>')
    assert.equal(r.errors.length, 1, `attendu exactement 1 erreur, reçu : ${JSON.stringify(r.errors)}`)
    assert.match(r.errors[0], /<@head> ligne 1 :/)
    assert.match(r.errors[0], /« <meta \{\$attrs\}> »/)
    assert.match(r.errors[0], /ne peut pas tenir lieu d'attribut/)
  })

  it('<@failed> valeur nue `href=https://x/{$slug}` : 1 erreur, macro nommée « failed »', () => {
    const r = processGlobalMacros('<@failed err><link rel="canonical" href=https://x/{$slug}></@failed>')
    assert.equal(r.errors.length, 1, `attendu exactement 1 erreur, reçu : ${JSON.stringify(r.errors)}`)
    assert.match(r.errors[0], /<@failed> ligne 1 :/)
    assert.match(r.errors[0], /Écrivez href="https:\/\/x\/\{\$slug\}"\./)
  })

  it('<@failed> expression à la place d\'un attribut `<meta {$attrs}>` : 1 erreur', () => {
    const r = processGlobalMacros('<@failed err><meta {$attrs}></@failed>')
    assert.equal(r.errors.length, 1, `attendu exactement 1 erreur, reçu : ${JSON.stringify(r.errors)}`)
    assert.match(r.errors[0], /<@failed> ligne 1 :/)
    assert.match(r.errors[0], /« <meta \{\$attrs\}> »/)
  })

  it('`{{…}}` nu dans une balise : refusé comme `{…}` (valeur nue et position d\'attribut)', () => {
    const nue = processGlobalMacros('<@head><link rel="canonical" href=https://x/{{$slug}}></@head>')
    assert.equal(nue.errors.length, 1, `attendu exactement 1 erreur, reçu : ${JSON.stringify(nue.errors)}`)
    assert.match(nue.errors[0], /Écrivez href="https:\/\/x\/\{\{\$slug\}\}"\./)
    const attr = processGlobalMacros('<@head><meta {{$attrs}}></@head>')
    assert.equal(attr.errors.length, 1, `attendu exactement 1 erreur, reçu : ${JSON.stringify(attr.errors)}`)
    assert.match(attr.errors[0], /« <meta \{\{\$attrs\}\}> »/)
  })

  it('deux fautes dans un même bloc → 2 erreurs distinctes (une par interpolation)', () => {
    const r = processGlobalMacros('<@head><link rel="canonical" href=https://x/{$slug}>\n<meta {$attrs}></@head>')
    assert.equal(r.errors.length, 2, `attendu exactement 2 erreurs, reçu : ${JSON.stringify(r.errors)}`)
    assert.notEqual(r.errors[0], r.errors[1])
    assert.match(r.errors[0], /ligne 1 :/)
    assert.match(r.errors[1], /ligne 2 :/)
  })
})

// Le `"` d'une valeur NUE est un caractère LITTÉRAL (HTML5, unexpected-character-in-unquoted-
// attribute-value) : il n'ouvre aucune valeur quotée, et le `=` non plus. Lire « guillemet après un
// `=` » suffisait à croire la valeur protégée alors que le navigateur, lui, voit la valeur s'arrêter
// au premier espace — la donnée qui suit y ajoute des attributs.
describe('<@head> — états HTML5 dans la balise : le `"` d\'une valeur nue ne protège rien', function () {
  it('`a=b=" {$x}"` : refusé (l\'interpolation tombe en position d\'attribut, pas dans une valeur)', () => {
    const r = processGlobalMacros('<@head><meta name="d" a=b=" {$x}"></@head>')
    assert.equal(r.errors.length, 1, `attendu exactement 1 erreur, reçu : ${JSON.stringify(r.errors)}`)
    assert.match(r.errors[0], /<@head> ligne 1 :/)
    assert.match(r.errors[0], /« <meta name="d" a=b=" \{\$x\}"> »/)
  })

  it('`a=1=2="{$x}"` : refusé, et la correction proposée est du HTML VALIDE (guillemets de la valeur échappés)', () => {
    const r = processGlobalMacros('<@head><meta name="d" a=1=2="{$x}"></@head>')
    assert.equal(r.errors.length, 1, `attendu exactement 1 erreur, reçu : ${JSON.stringify(r.errors)}`)
    assert.match(r.errors[0], /« a=1=2="\{\$x\}" »/)
    assert.match(r.errors[0], /Écrivez a="1=2=&quot;\{\$x\}&quot;"\./)
  })

  it('`href=/x=" {$x}"` : refusé', () => {
    const r = processGlobalMacros('<@head><link href=/x=" {$x}"></@head>')
    assert.equal(r.errors.length, 1, `attendu exactement 1 erreur, reçu : ${JSON.stringify(r.errors)}`)
    assert.match(r.errors[0], /« <link href=\/x=" \{\$x\}"> »/)
  })

  it('preuve navigateur (happy-dom) : la forme nue ajoute des attributs, la valeur ENTIÈREMENT quotée n\'en ajoute aucun', () => {
    const window = new Window()
    const attributs = (html: string): string[] => {
      const hote = window.document.createElement('div')
      hote.innerHTML = html
      return [...hote.firstElementChild!.attributes].map(a => a.name)
    }
    // ce que la forme refusée produisait, avec une donnée échappée (aucun guillemet à échapper dedans)
    const nue = attributs('<meta name="d" a=b=" x onload=alert(1)">')
    assert.deepEqual(nue, ['name', 'a', 'x', 'onload'], `la forme nue doit fabriquer des attributs : ${nue.join(' ')}`)
    // la valeur entière entre guillemets : la donnée reste UNE valeur
    const quotee = attributs('<meta name="d" a="b= x onload=alert(1)">')
    assert.deepEqual(quotee, ['name', 'a'], `aucun attribut en plus attendu, reçu : ${quotee.join(' ')}`)
  })
})

// `<` suivi d'une interpolation : les chevrons viennent du gabarit, le nom de la balise (et tout ce
// qui suit) de la donnée — `µ._esc` ne peut rien y faire, l'élément est créé pour de vrai.
describe('<@head> — nom de balise interpolé : refusé', function () {
  it('`<{$tag}>` : 1 erreur, message « nom de balise »', () => {
    const r = processGlobalMacros('<@head><{$tag}></@head>')
    assert.equal(r.errors.length, 1, `attendu exactement 1 erreur, reçu : ${JSON.stringify(r.errors)}`)
    assert.match(r.errors[0], /<@head> ligne 1 :/)
    assert.match(r.errors[0], /« <\{\$tag\}> »/)
    assert.match(r.errors[0], /ne peut pas tenir lieu de nom de balise/)
  })

  it('`<{$tag} class="a">` : 1 erreur, la balise entière est citée', () => {
    const r = processGlobalMacros('<@head><{$tag} class="a"></@head>')
    assert.equal(r.errors.length, 1, `attendu exactement 1 erreur, reçu : ${JSON.stringify(r.errors)}`)
    assert.match(r.errors[0], /« <\{\$tag\} class="a"> »/)
    assert.match(r.errors[0], /nom de balise/)
  })

  it('`<{{$t}}>` : 1 erreur (le HTML brut ne rachète pas un nom de balise calculé)', () => {
    const r = processGlobalMacros('<@head><{{$t}}></@head>')
    assert.equal(r.errors.length, 1, `attendu exactement 1 erreur, reçu : ${JSON.stringify(r.errors)}`)
    assert.match(r.errors[0], /nom de balise/)
  })

  it('preuve navigateur (happy-dom) : `<` + donnée fabrique un élément complet', () => {
    const window = new Window()
    const hote = window.document.createElement('div')
    hote.innerHTML = '<' + 'img src=x onerror=alert(1)' + '>'
    assert.equal(hote.firstElementChild!.tagName.toLowerCase(), 'img')
    assert.ok(hote.firstElementChild!.hasAttribute('onerror'), 'la donnée a posé un attribut exécutable')
  })

  it('coût assumé : une comparaison collée au `<` en TEXTE (`{$a}<{$b}`) est refusée, et la citation s\'arrête à l\'expression', () => {
    const r = processGlobalMacros('<@head><title>{$a}<{$b}</title></@head>')
    assert.equal(r.errors.length, 1, `attendu exactement 1 erreur, reçu : ${JSON.stringify(r.errors)}`)
    assert.match(r.errors[0], /« <\{\$b\} »/, 'la citation ne doit pas avaler le `>` de la balise suivante')
    // écriture de remplacement : un espace (ou `&lt;`) et la comparaison redevient du texte
    const espace = processGlobalMacros('<@head><title>{$a} < {$b}</title></@head>')
    assert.equal(espace.errors.length, 0, `attendu 0 erreur, reçu : ${JSON.stringify(espace.errors)}`)
  })

  it('`</{$tag}>` et `<!{$x}>` restent refusés', () => {
    const fermante = processGlobalMacros('<@head></{$tag}></@head>')
    assert.equal(fermante.errors.length, 1, `attendu exactement 1 erreur, reçu : ${JSON.stringify(fermante.errors)}`)
    const bang = processGlobalMacros('<@head><!{$x}></@head>')
    assert.equal(bang.errors.length, 1, `attendu exactement 1 erreur, reçu : ${JSON.stringify(bang.errors)}`)
  })
})

describe('<@head> — le message cite ce que l\'auteur a écrit', function () {
  it('`content={$x}{$y}` : forme et correction reconstruites sur le texte d\'origine (pas sur la valeur déjà quotée par le compilateur)', () => {
    const r = processGlobalMacros('<@head><meta content={$x}{$y}></@head>')
    assert.equal(r.errors.length, 1, `attendu exactement 1 erreur, reçu : ${JSON.stringify(r.errors)}`)
    assert.match(r.errors[0], /« content=\{\$x\}\{\$y\} »/)
    assert.match(r.errors[0], /Écrivez content="\{\$x\}\{\$y\}"\./)
  })

  it('symbole `mjs` : le message rend le `mjs$`/`mjs.` tapé par l\'auteur, jamais la forme normalisée `µ`', () => {
    const r = processGlobalMacros('<@head><link href=/x/{µ$slug}></@head>', { firstLine: 1, sigil: 'mjs' })
    assert.equal(r.errors.length, 1, `attendu exactement 1 erreur, reçu : ${JSON.stringify(r.errors)}`)
    assert.match(r.errors[0], /« href=\/x\/\{mjs\$slug\} »/)
    assert.match(r.errors[0], /Écrivez href="\/x\/\{mjs\$slug\}"\./)
    assert.doesNotMatch(r.errors[0], /µ/, `aucun µ attendu dans le message : ${r.errors[0]}`)
  })

  it('symbole `µ` (défaut) : le message garde `µ`', () => {
    const r = processGlobalMacros('<@head><link href=/x/{µ$slug}></@head>')
    assert.match(r.errors[0], /« href=\/x\/\{µ\$slug\} »/)
  })

  it('bout en bout, projet en symbole `mjs` : le message cite `mjs.paths`', async () => {
    const src = [
      '<script>',
      '  $x = 1',
      '</script>',
      '<@head>',
      '  <link href=/x/{mjs.paths.a}>',
      '</@head>',
    ].join('\n')
    const { data } = await transpile(src, { moduleName: 'mjs-symbole-ascii', sigil: 'mjs' })
    assert.equal(data.macroErrors.length, 1, `attendu exactement 1 erreur, reçu : ${JSON.stringify(data.macroErrors)}`)
    assert.match(data.macroErrors[0], /« href=\/x\/\{mjs\.paths\.a\} »/)
    assert.match(data.macroErrors[0], /Écrivez href="\/x\/\{mjs\.paths\.a\}"\./)
  })
})

// Une interpolation DANS une valeur déjà entre guillemets n'a pas à être quotée une seconde fois :
// `µ._esc` y neutralise le guillemet, la valeur tient. Mettre des guillemets « au cas où » derrière
// le premier `=` rencontré (un paramètre d'URL, un `k=v` de configuration) FERMAIT la valeur au
// navigateur et rendait la donnée maîtresse de la balise. Le geste se décide donc par la position
// dans la balise, jamais par la présence d'un `=`.
describe('<@head>/<@failed> — interpolation dans une valeur DÉJÀ quotée : jamais de guillemet ajouté', function () {
  const formes: [string, string, string[]][] = [
    ['paramètre d\'URL', '<link rel="canonical" href="https://x/p?slug={$x}">', ['rel', 'href']],
    ['og:url avec ?id=', '<meta property="og:url" content="https://x/?id={$x}">', ['property', 'content']],
    ['deux paramètres', '<link href="/x?a=b&c={$x}">', ['href']],
    ['data-* de configuration', '<meta data-cfg="k={$x}">', ['data-cfg']],
    ['double égal', '<meta content="a=={$x}">', ['content']],
    ['valeur commençant par =', '<meta a="={$x}">', ['a']],
    ['deux égal successifs', '<meta content="a=b={$x}">', ['content']],
  ]

  for (const [nom, balise, attendus] of formes) {
    it(`<@head> ${nom} : 0 erreur, et la donnée hostile ne crée NI attribut NI élément`, () => {
      const r = injecte(`<@head>${balise}</@head>`)
      assert.deepEqual(r.attributs, attendus, `attributs inattendus dans ${r.html}`)
      assert.equal(r.balises.length, 1, `un seul élément attendu, reçu : ${r.balises.join(' ')} — ${r.html}`)
      assert.equal(r.evil, 0, `élément fabriqué par la donnée : ${r.html}`)
      assert.doesNotMatch(r.attributs.join(' '), /onload|onerror/)
    })
  }

  it('<@failed> paramètre d\'URL dans le repli : 0 erreur, aucun attribut venu de la donnée', () => {
    const r = injecte('<@failed err><a class="fb" href="/x?p={$x}">retour</a></@failed>')
    assert.deepEqual(r.attributs, ['class', 'href'], `attributs inattendus dans ${r.html}`)
    assert.equal(r.evil, 0, `élément fabriqué par la donnée : ${r.html}`)
  })

  it('même forme en Coffee : la construction passe et la valeur reste entière', async () => {
    const src = [
      '<script lang="coffee">',
      '  $x = \'a\'',
      '</script>',
      '<@head>',
      '  <link rel="canonical" href="https://x/p?slug={$x}">',
      '</@head>',
    ].join('\n')
    const { data, output } = await transpile(src, { moduleName: 'mjs-quotee-coffee' })
    assert.equal(data.macroErrors.length, 0, JSON.stringify(data.macroErrors))
    assert.match(output, /href="https:\/\/x\/p\?slug=/)
    assert.doesNotMatch(output, /p\?slug="/, 'aucun guillemet ne doit fermer la valeur avant la donnée')
  })

  it('même forme dans un projet en symbole `mjs` (html déjà normalisé en µ) : aucun guillemet ajouté', () => {
    const r = processGlobalMacros('<@head><link href="https://x/p?slug={µ$slug}"></@head>', { firstLine: 1, sigil: 'mjs' })
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors))
    assert.equal(r.setup, '\nµeffect =>\n  µ._setHead(@, \'<link href="https://x/p?slug=\' + µ._esc(µ$slug) + \'">\')')
  })

  it('texte `a={$x}` : aucun guillemet inventé, donnée échappée', () => {
    const r = processGlobalMacros('<@head><title>a={$x}</title></@head>')
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors))
    assert.equal(r.setup, '\nµeffect =>\n  µ._setHead(@, \'<title>a=\' + µ._esc($x) + \'</title>\')')
  })

  it('texte `a={{$h}}` : HTML brut honoré (le `=` qui précède ne change rien)', () => {
    const r = processGlobalMacros('<@head><title>a={{$h}}</title></@head>')
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors))
    assert.equal(r.setup, '\nµeffect =>\n  µ._setHead(@, \'<title>a=\' + String($h) + \'</title>\')')
  })

  it('`content={$x}` (valeur nue réduite à l\'interpolation) : toujours mise entre guillemets par le compilateur', () => {
    const r = processGlobalMacros('<@head><meta content={$x}></@head>')
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors))
    assert.equal(r.setup, '\nµeffect =>\n  µ._setHead(@, \'<meta content="\' + µ._esc($x) + \'">\')')
    const rendu = injecte('<@head><meta content={$x}></@head>')
    assert.deepEqual(rendu.attributs, ['content'], `attributs inattendus dans ${rendu.html}`)
    assert.equal(rendu.evil, 0)
  })
})

// Un `=` sans nom d'attribut devant lui n'ouvre AUCUNE valeur : le navigateur (état
// before-attribute-name) en fait le premier caractère d'un NOM d'attribut, et le guillemet qu'on
// aurait posé « autour de la valeur » devient un caractère de ce nom — la donnée reprend la main et
// pose ses propres attributs. Collé au nom de balise (`<meta={$x}>`), le `=` appartient au nom de
// l'élément.
describe('<@head>/<@failed> — `=` sans nom d\'attribut : aucune valeur, donc refus', function () {
  const formes: [string, string, 'head' | 'failed', RegExp][] = [
    ['`= {$x}` après une valeur quotée', '<meta name="d" = {$x}>', 'head', /tenir lieu d'attribut/],
    ['`={$x}` après une valeur quotée', '<meta name="d" ={$x}>', 'head', /tenir lieu d'attribut/],
    ['`={$x}` après le nom de balise', '<meta ={$x}>', 'head', /tenir lieu d'attribut/],
    ['`={$x}` collé au nom de balise', '<meta={$x}>', 'head', /nom de balise/],
    ['`={$x}` après une barre de fermeture', '<meta a="b"/={$x}>', 'head', /tenir lieu d'attribut/],
    ['`={$x}` après deux attributs', '<meta name="d" a="b" ={$x}>', 'head', /tenir lieu d'attribut/],
    ['`={$x}` suivi d\'un attribut', '<meta name="d" ={$x} b="c">', 'head', /tenir lieu d'attribut/],
    ['`={$x}` entre deux attributs', '<link rel="x" ={$x} href="/y">', 'head', /tenir lieu d'attribut/],
    ['`={$x}` collé au nom de balise (link)', '<link={$x}>', 'head', /nom de balise/],
    ['`={$x}` dans le repli d\'une frontière', '<a class="fb" ={$x}>r</a>', 'failed', /tenir lieu d'attribut/],
  ]

  for (const [nom, balise, macro, attendu] of formes) {
    it(`${nom} : refusé`, () => {
      const bloc = macro === 'head' ? `<@head>${balise}</@head>` : `<@failed err reset>${balise}</@failed>`
      const r = processGlobalMacros(bloc)
      assert.equal(r.errors.length, 1, `attendu exactement 1 erreur, reçu : ${JSON.stringify(r.errors)}`)
      assert.match(r.errors[0], attendu)
    })
  }

  it('preuve navigateur : la sortie de ces formes donnait le contrôle de la balise à la donnée', () => {
    const window = new Window()
    const attributs = (html: string): string[] => {
      const hote = window.document.createElement('div')
      hote.innerHTML = html
      return [...hote.firstElementChild!.attributes].map(a => a.name)
    }
    // sortie EXACTE que produisait `<meta name="d" ={$x}>`, donnée échappée injectée
    const fautif = attributs(`<meta name="d" ="${esc(HOSTILE)}">`)
    assert.ok(fautif.includes('onload'), `un attribut exécutable était attendu dans la preuve du trou : ${fautif.join(' ')}`)
    // l'écriture correcte : la donnée reste UNE valeur
    const correct = attributs(`<meta name="d" content="${esc(HOSTILE)}">`)
    assert.deepEqual(correct, ['name', 'content'], `aucun attribut en plus attendu, reçu : ${correct.join(' ')}`)
  })

  it('un nom d\'attribut clos par un blanc HTML garde son `=` ouvreur de valeur (`a = "x"`, `a ={$x}`)', () => {
    const quotee = injecte('<@head><meta a = "{$x}"></@head>')
    assert.deepEqual(quotee.attributs, ['a'], `attributs inattendus dans ${quotee.html}`)
    const nue = injecte('<@head><meta a = {$x}></@head>')
    assert.deepEqual(nue.attributs, ['a'], `attributs inattendus dans ${nue.html}`)
    assert.equal(nue.evil, 0)
  })
})

// Un commentaire se ferme sur `-->`, sur `--!>`, et tout de suite sur `<!-->` / `<!--->` (HTML5).
// Ne connaître que `-->` faisait passer pour du commentaire tout le reste du bloc — balises fautives
// comprises.
describe('<@head> — fins de commentaire HTML5 : ce qui suit reste contrôlé', function () {
  const fins: [string, string][] = [
    ['`--!>`', '<!-- a --!><meta {$x}>'],
    ['`<!-->` abrupt', '<!--><meta {$x}>'],
    ['`<!--->` abrupt', '<!---><meta {$x}>'],
    ['`-->` normal', '<!-- a --><meta {$x}>'],
    ['`<!--- -->`', '<!--- --><meta {$x}>'],
  ]

  for (const [nom, contenu] of fins) {
    it(`commentaire fermé par ${nom} puis balise fautive : 1 erreur`, () => {
      const r = processGlobalMacros(`<@head>${contenu}</@head>`)
      assert.equal(r.errors.length, 1, `attendu exactement 1 erreur, reçu : ${JSON.stringify(r.errors)}`)
      assert.match(r.errors[0], /« <meta \{\$x\}> »/)
    })
  }

  it('commentaire `--!>` puis balise SAINE : 0 erreur, et la donnée hostile reste une valeur', () => {
    const r = injecte('<@head><!-- a --!><meta name="f2" content="{$x}"></@head>')
    assert.deepEqual(r.attributs, ['name', 'content'], `attributs inattendus dans ${r.html}`)
    assert.equal(r.evil, 0, `élément fabriqué par la donnée : ${r.html}`)
  })
})

// Le tokeniseur HTML5 n'admet comme blanc que l'espace, la tabulation, LF, FF et CR. Prendre NBSP,
// BOM ou U+2028 pour du blanc faisait lire au compilateur une valeur quotée là où le navigateur
// commence une valeur NUE.
describe('<@head> — blanc au sens HTML5 seulement', function () {
  const faux: [string, string][] = [
    ['espace insécable', '<meta name="d" a= "{$x}">'],
    ['BOM', '<meta name="d" a=﻿"{$x}">'],
    ['séparateur de ligne U+2028', '<meta name="d" a= "{$x}">'],
    ['espace insécable, guillemets simples', '<meta a= \'{$x}\'>'],
  ]

  for (const [nom, balise] of faux) {
    it(`${nom} après le \`=\` : refusé (le navigateur y lit une valeur nue)`, () => {
      const r = processGlobalMacros(`<@head>${balise}</@head>`)
      assert.equal(r.errors.length, 1, `attendu exactement 1 erreur, reçu : ${JSON.stringify(r.errors)}`)
    })
  }

  const vrais: [string, string][] = [
    ['espace', '<meta a= "{$x}">'],
    ['tabulation', '<meta a=\t"{$x}">'],
    ['saut de ligne', '<meta a=\n"{$x}">'],
    ['saut de page', '<meta a=\f"{$x}">'],
    ['retour chariot', '<meta a=\r"{$x}">'],
  ]

  for (const [nom, balise] of vrais) {
    it(`${nom} entre le \`=\` et le guillemet : accepté, valeur quotée`, () => {
      const r = injecte(`<@head>${balise}</@head>`)
      assert.deepEqual(r.attributs, ['a'], `attributs inattendus dans ${r.html}`)
      assert.equal(r.evil, 0)
    })
  }

  it('`content= {$x}` (blanc puis interpolation nue) : le compilateur quote la valeur, la donnée reste dedans', () => {
    const r = injecte('<@head><meta content= {$x}></@head>')
    assert.deepEqual(r.attributs, ['content'], `attributs inattendus dans ${r.html}`)
    assert.equal(r.evil, 0, `élément fabriqué par la donnée : ${r.html}`)
  })
})

describe('<@head>/<@failed> — le corpus des écritures courantes passe', function () {
  const legitimes: [string, string][] = [
    ['attributs booléens + data + aria', '<@head><meta data-a aria-hidden="true" content="{$x}"></@head>'],
    ['imagesrcset', '<@head><link rel="preload" as="image" imagesrcset="a.png 1x, b.png 2x" href="{$x}"></@head>'],
    ['viewport', '<@head><meta name="viewport" content="width=device-width, initial-scale=1"></@head>'],
    ['og:title', '<@head><meta property="og:title" content="{$t}"></@head>'],
    ['base', '<@head><base href="/"></@head>'],
    ['noscript', '<@head><noscript><link href="/x"></noscript></@head>'],
    ['template', '<@head><template><link href="/x"></template></@head>'],
    ['svg viewBox + path', '<@head><svg viewBox="0 0 10 10"><path d="M0 0 L10 10"/></svg></@head>'],
    ['json-ld', '<@head><script type="application/ld+json">{"a":"b"}</script></@head>'],
    ['@media dans un <style>', '<@head><style>@media (min-width: 600px){a{color:red}}</style></@head>'],
    ['url a=b&c=d statique', '<@head><link href="/x?a=b&c=d" title="{$x}"></@head>'],
    ['valeur nue sans interpolation', '<@head><meta title=l\'erreur content="{$x}"></@head>'],
    ['srcset + alt interpolé', '<@head><img srcset="a.png 1x, b.png 2x" alt="{$x}"></@head>'],
    ['expression avec > dans une valeur quotée', '<@head><meta content="{$a > \'b\'}"></@head>'],
    ['expression avec un = dans un appel', '<@head><meta content="{f(\'a=b\')}"></@head>'],
    ['titre interpolé', '<@head><title>{$x} — site</title></@head>'],
    ['repli : gestionnaire à accolades', '<@failed err reset><button @click={reset({hard: true})}>r</button></@failed>'],
    ['repli : retry + texte interpolé', '<@failed err reset retry="2"><p>{err.message}</p></@failed>'],
  ]

  for (const [nom, bloc] of legitimes) {
    it(`${nom} : 0 erreur`, () => {
      const r = processGlobalMacros(bloc)
      assert.equal(r.errors.length, 0, `attendu 0 erreur, reçu : ${JSON.stringify(r.errors)}`)
    })
  }
})

describe('<@head>/<@failed> — écritures légitimes : 0 erreur, sortie inchangée', function () {
  // Valeurs de référence relevées sur le compilateur AVANT le refus (aucune ne doit bouger).
  const cas: [string, string, string][] = [
    ['valeur quotée', '<@head><link rel="canonical" href="https://x/{$slug}"></@head>',
      '\nµeffect =>\n  µ._setHead(@, \'<link rel="canonical" href="https://x/\' + µ._esc($slug) + \'">\')'],
    ['content={$x} auto-quoté', '<@head><meta name="d" content={$x}></@head>',
      '\nµeffect =>\n  µ._setHead(@, \'<meta name="d" content="\' + µ._esc($x) + \'">\')'],
    ['content={{$x}} auto-quoté', '<@head><meta name="d" content={{$x}}></@head>',
      '\nµeffect =>\n  µ._setHead(@, \'<meta name="d" content="\' + µ._esc($x) + \'">\')'],
    ['texte : {$x} échappé, {{$h}} brut', '<@head><title>{$x} — {{$h}}</title></@head>',
      '\nµeffect =>\n  µ._setHead(@, \'<title>\' + µ._esc($x) + \' — \' + String($h) + \'</title>\')'],
    ['commentaire HTML', '<@head><!-- {$x} --><meta name="d" content="ok"></@head>',
      '\nµeffect =>\n  µ._setHead(@, \'<!-- \' + µ._esc($x) + \' --><meta name="d" content="ok">\')'],
    ['<style> et ses accolades', '<@head><style>@font-face { font-family: \'a\' }</style></@head>',
      '\nµeffect =>\n  µ._setHead(@, \'<style>@font-face { font-family: \\\'a\\\' }</style>\')'],
    ['apostrophe de commentaire puis valeur quotée', '<@head><!-- it\'s --><meta content="{$x}"></@head>',
      '\nµeffect =>\n  µ._setHead(@, \'<!-- it\\\'s --><meta content="\' + µ._esc($x) + \'">\')'],
    ['valeur nue SANS interpolation', '<@head><meta title=l\'erreur content="{$x}"></@head>',
      '\nµeffect =>\n  µ._setHead(@, \'<meta title=l\\\'erreur content="\' + µ._esc($x) + \'">\')'],
    ['valeur nue avec `=` dedans, SANS interpolation', '<@head><meta a=b=c content="{$x}"></@head>',
      '\nµeffect =>\n  µ._setHead(@, \'<meta a=b=c content="\' + µ._esc($x) + \'">\')'],
    ['`=` et espace DANS une valeur quotée', '<@head><meta content="a=b {$x}"></@head>',
      '\nµeffect =>\n  µ._setHead(@, \'<meta content="a=b \' + µ._esc($x) + \'">\')'],
    ['valeur entre guillemets SIMPLES', '<@head><meta content=\'{$x}\'></@head>',
      '\nµeffect =>\n  µ._setHead(@, \'<meta content=\\\'\' + µ._esc($x) + \'\\\'>\')'],
    ['`attr={$x}` dans une balise auto-fermée', '<@head><link href={$x}/></@head>',
      '\nµeffect =>\n  µ._setHead(@, \'<link href="\' + µ._esc($x) + \'"/>\')'],
    ['`attr={$x}` suivi de texte statique', '<@head><meta content={$x}abc></@head>',
      '\nµeffect =>\n  µ._setHead(@, \'<meta content="\' + µ._esc($x) + \'"abc>\')'],
  ]

  for (const [nom, html, attendu] of cas) {
    it(`<@head> ${nom}`, () => {
      const r = processGlobalMacros(html)
      assert.equal(r.errors.length, 0, `attendu 0 erreur, reçu : ${JSON.stringify(r.errors)}`)
      assert.equal(r.setup, attendu)
    })
  }

  it('<@failed> texte interpolé + valeur nue sans interpolation : 0 erreur, sortie inchangée', () => {
    const r = processGlobalMacros('<@failed err><span title=l\'erreur>{err.message}</span></@failed>')
    assert.equal(r.errors.length, 0, `attendu 0 erreur, reçu : ${JSON.stringify(r.errors)}`)
    assert.match(r.setup, /_mjs_d\.innerHTML = '<span title=l\\'erreur>' \+ µ\._esc\(err\.message\) \+ '<\/span>'/)
  })
})

describe('<@head> — la ligne citée est celle du .mjs', function () {
  it('bloc ouvert ligne 7, interpolation fautive ligne 9 → « ligne 9 »', async () => {
    const src = [
      '<script>',                                            // 1
      '  $slug = \'a\'',                                     // 2
      '</script>',                                           // 3
      '',                                                    // 4
      '<p>{$slug}</p>',                                      // 5
      '',                                                    // 6
      '<@head>',                                             // 7
      '  <meta name="ok" content="{$slug}">',                // 8
      '  <link rel="canonical" href=https://x/{$slug}>',     // 9
      '</@head>',                                            // 10
    ].join('\n')
    const { data } = await transpile(src, { moduleName: 'mjs-tete-ligne-neuf' })
    assert.equal(data.macroErrors.length, 1, `attendu exactement 1 erreur, reçu : ${JSON.stringify(data.macroErrors)}`)
    assert.match(data.macroErrors[0], /<@head> ligne 9 :/)
    assert.match(data.macroErrors[0], /Écrivez href="https:\/\/x\/\{\$slug\}"\./)
  })

  it('<@failed> ouvert ligne 6, interpolation fautive ligne 7 → « ligne 7 »', async () => {
    const src = [
      '<script>',                                      // 1
      '  $slug = \'a\'',                               // 2
      '  boom = -> throw new Error(\'raté\')',         // 3
      '</script>',                                     // 4
      '',                                              // 5
      '<@failed err>',                                 // 6
      '  <meta {$slug}>',                              // 7
      '</@failed>',                                    // 8
      '<p>{boom()}</p>',                               // 9
    ].join('\n')
    const { data } = await transpile(src, { moduleName: 'mjs-repli-ligne-sept' })
    assert.equal(data.macroErrors.length, 1, `attendu exactement 1 erreur, reçu : ${JSON.stringify(data.macroErrors)}`)
    assert.match(data.macroErrors[0], /<@failed> ligne 7 :/)
  })
})

// Preuve avec le RUNTIME RÉEL : composants compilés par le bundler, montés, tête vivante et repli
// inspectés après injection de la donnée hostile.
describe('<@head>/<@failed> — tête vivante et repli avec le runtime réel', function () {
  this.timeout(120000)
  let app: Awaited<ReturnType<typeof createHarness>> | null = null

  const TETE_URL = [
    '<script>',
    '$slug = window.__hostile',
    '</script>',
    '',
    '<@head>',
    '  <link rel="canonical" href="https://x/p?slug={$slug}">',
    '</@head>',
    '<p class="ok">t1</p>',
  ].join('\n')

  const TETE_COMMENTAIRE = [
    '<script>',
    '$x = window.__hostile',
    '</script>',
    '',
    '<@head>',
    '  <!-- a --!><meta name="t2" content="{$x}">',
    '</@head>',
    '<p class="ok">t2</p>',
  ].join('\n')

  const TETE_BLANC = [
    '<script>',
    '$x = window.__hostile',
    '</script>',
    '',
    '<@head>',
    '  <meta name="t3" data-v= "{$x}">',
    '</@head>',
    '<p class="ok">t3</p>',
  ].join('\n')

  const REPLI_URL = [
    '<script>',
    '  $x = window.__hostile',
    '  boom = -> throw new Error(\'raté\')',
    '</script>',
    '',
    '<@failed err>',
    '  <a class="fb" href="/x?p={$x}">retour</a>',
    '</@failed>',
    '<p class="ok">{boom()}</p>',
  ].join('\n')

  // écriture CORRECTE des deux formes que le `=` sans nom d'attribut rendait dangereuses
  const TETE_NOMMEE = [
    '<script>',
    '$x = window.__hostile',
    '</script>',
    '',
    '<@head>',
    '  <meta name="d" content="{$x}">',
    '</@head>',
    '<p class="ok">t4</p>',
  ].join('\n')

  const REPLI_NOMME = [
    '<script>',
    '  $x = window.__hostile',
    '  boom = -> throw new Error(\'raté\')',
    '</script>',
    '',
    '<@failed err>',
    '  <a class="fb" title="{$x}">retour</a>',
    '</@failed>',
    '<p class="ok">{boom()}</p>',
  ].join('\n')

  before(async () => {
    const root = mjsTmp('tete-vivante-hostile')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'tv-url.mjs'), TETE_URL)
    writeFileSync(join(srcDir, 'tv-commentaire.mjs'), TETE_COMMENTAIRE)
    writeFileSync(join(srcDir, 'tv-blanc.mjs'), TETE_BLANC)
    writeFileSync(join(srcDir, 'tv-repli.mjs'), REPLI_URL)
    writeFileSync(join(srcDir, 'tv-nommee.mjs'), TETE_NOMMEE)
    writeFileSync(join(srcDir, 'tv-repli-nomme.mjs'), REPLI_NOMME)
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ sourceDir: 'src', outputDir: 'out', manifestPath: 'out/bundle.js' }, null, 2))
    app = await createHarness({ root })
    ;(app!.window as unknown as Record<string, string>).__hostile = HOSTILE
  })

  after(async () => {
    if (app) await app.destroy()
  })

  for (const [nom, module] of [['valeur quotée à paramètre d\'URL', 'tv-url'], ['commentaire fermé par --!>', 'tv-commentaire'], ['blanc entre le = et le guillemet', 'tv-blanc']] as [string, string][]) {
    it(`tête vivante — ${nom} : aucun attribut ni élément venu de la donnée`, async () => {
      const c = await app!.mount(module)
      await c.tick()
      const tete = app!.window.document.head
      const attributs: string[] = []
      tete.querySelectorAll('*').forEach((el: Element) => { for (const a of [...el.attributes]) attributs.push(a.name) })
      assert.doesNotMatch(attributs.join(' '), /onload|onerror/, `attribut exécutable dans la tête : ${tete.innerHTML}`)
      assert.equal(tete.querySelectorAll('.evil').length, 0, `élément fabriqué par la donnée : ${tete.innerHTML}`)
      c.destroy()
    })
  }

  it('tête vivante — attribut NOMMÉ et quoté (écriture correcte du `=` sans nom) : exactement name + content', async () => {
    const c = await app!.mount('tv-nommee')
    await c.tick()
    const meta = app!.window.document.head.querySelector('meta[name="d"]')
    assert.ok(meta, `<meta name="d"> attendu dans la tête : ${app!.window.document.head.innerHTML}`)
    assert.deepEqual([...meta!.attributes].map((a: Attr) => a.name), ['name', 'content'], `attributs inattendus : ${app!.window.document.head.innerHTML}`)
    assert.equal(app!.window.document.head.querySelectorAll('.evil').length, 0)
    c.destroy()
  })

  it('repli d\'une frontière — attribut NOMMÉ et quoté : exactement class + title', async () => {
    const c = await app!.mount('tv-repli-nomme')
    await c.tick()
    const lien = c.find('a')
    assert.deepEqual(lien ? [...lien.attributes].map((a: Attr) => a.name) : [], ['class', 'title'], `attributs inattendus dans le repli : ${c.html()}`)
    assert.equal(c.find('.evil'), null, `élément fabriqué par la donnée : ${c.html()}`)
    c.destroy()
  })

  it('repli d\'une frontière — valeur quotée à paramètre d\'URL : aucun attribut ni élément venu de la donnée', async () => {
    const c = await app!.mount('tv-repli')
    await c.tick()
    const lien = c.find('a')
    const attributs = lien ? [...lien.attributes].map((a: Attr) => a.name) : []
    assert.deepEqual(attributs, ['class', 'href'], `attributs inattendus dans le repli : ${c.html()}`)
    assert.equal(c.find('.evil'), null, `élément fabriqué par la donnée : ${c.html()}`)
    c.destroy()
  })
})

describe('<@head> — construction bout en bout', function () {
  this.timeout(30000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  const projet = (contenu: string) => {
    const root = mjsTmp('head-interpolation-nue')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'tete.mjs'), contenu)
    return { srcDir, outDir: join(root, 'out'), manifest: join(root, 'bundle.js') }
  }

  const SANS_GUILLEMETS = [
    '<script>',
    '  $slug = \'a\'',
    '</script>',
    '',
    '<@head>',
    '  <link rel="canonical" href=https://x/{$slug}>',
    '</@head>',
    '<p>{$slug}</p>',
  ].join('\n')

  const AVEC_GUILLEMETS = SANS_GUILLEMETS.replace('href=https://x/{$slug}', 'href="https://x/{$slug}"')

  it('interpolation nue dans une balise : la construction ÉCHOUE, le message porte la ligne et la forme correcte', async () => {
    const { srcDir, outDir, manifest } = projet(SANS_GUILLEMETS)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()
    const messages = stats.errors.map(e => e.message).join('\n')
    assert.ok(stats.errors.length > 0, 'la construction doit échouer')
    assert.match(messages, /<@head> ligne 6 :/)
    assert.match(messages, /Écrivez href="https:\/\/x\/\{\$slug\}"\./)
    await bundler.close()
  })

  it('la même avec guillemets : construction VERTE', async () => {
    const { srcDir, outDir, manifest } = projet(AVEC_GUILLEMETS)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    await bundler.close()
  })
})
