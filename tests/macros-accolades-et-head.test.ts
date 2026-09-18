// Macros globales — trois correctifs de macros.ts :
//   fin de balise consciente des accolades/guillemets (`findMacroTagEnd`).
//        AVANT : `<@nom([^>]*)>` s'arrêtait au premier `>`, même niché dans un
//        `{…}` (comparaison, `if…then…else`, chaîne) — panne MUETTE, résidu
//        texte dans le HTML rendu.
//   `quoteHeadLiteral` (<@head>) garde les sauts de ligne réels au lieu
//        de les écraser en espace — un commentaire `//` dans un <script> de
//        <@head> avalait la ligne suivante.
//   <@include> compilé sans baseDir : avertissement explicite au lieu
//        d'un strip silencieux.

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { processGlobalMacros, processIncludes, newIncludeAccumulator, findMacroTagEnd } from '../src/transpiler/macros.js'
import { transpile } from '../src/transpiler/index.js'
import { mjsTmp } from './helpers/tmp.js'

describe('macros — fin de balise consciente des accolades/guillemets', function () {
  it('findMacroTagEnd : un `>` niché dans une accolade ne ferme pas la balise', () => {
    const html = '<@window @scroll={$y > 100}/>'
    const end = findMacroTagEnd(html, '<@window'.length)
    assert.equal(end, html.length - 1, 'doit trouver le DERNIER `>` (celui qui ferme réellement la balise)')
    assert.equal(html[end], '>')
  })

  it('findMacroTagEnd : rend -1 si aucun `>` réel n\'est jamais atteint', () => {
    const end = findMacroTagEnd('<@window @scroll={$y', '<@window'.length)
    assert.equal(end, -1)
  })

  it('findMacroTagEnd : cas limite documenté — un `}` qui referme en réalité une CHAÎNE dans l\'accolade referme prématurément, mais le `>` final est quand même retrouvé', () => {
    // cf. commentaire de la fonction : DANS une accolade, seule la profondeur {/} est suivie,
    // jamais les guillemets — le `}` du littéral `'}'` referme prématurément l'accolade
    // extérieure ; le `'` isolé qui suit ne trouve PAS de guillemet partenaire plus loin dans le
    // html → n'est PAS traité comme une ouverture (règle « guillemet jamais refermé » ci-dessous)
    // → le `}` réel qui suit referme correctement, et le `>` final est retrouvé quand même.
    const html = `<@window @x={a = '}'}>ok`
    const end = findMacroTagEnd(html, '<@window'.length)
    assert.equal(end, html.length - 3, 'le `>` retrouvé doit être celui qui précède "ok", pas un `>` prématuré')
    assert.equal(html[end], '>')
  })

  it('findMacroTagEnd : un guillemet non refermé NULLE PART dans le html ne rend pas le scan aveugle (non-régression garde modificateur)', () => {
    // reproduit exactement le cas de tests/event-emit-gesture.test.ts (garde « modificateur non
    // géré ») : `data-x="non ferme` n'a AUCUN guillemet fermant plus loin dans tout le fichier —
    // il ne doit PAS être traité comme une ouverture, sous peine d'avaler tout le reste et de
    // rendre le scan aveugle au `>` réel (et donc à la violation qui le suit sur la même balise).
    const html = '<@window data-x="non ferme @resize.emit.sized={window.innerWidth}>\n<p>x</p>\n'
    const end = findMacroTagEnd(html, '<@window'.length)
    assert.equal(html[end], '>')
    assert.equal(html.slice(0, end + 1), '<@window data-x="non ferme @resize.emit.sized={window.innerWidth}>')
  })

  it('findMacroTagEnd : un `>` dans un attribut littéral CORRECTEMENT quoté (hors accolade) ne ferme pas la balise', () => {
    const html = '<@window title="a > b" @click={foo()}>ok'
    const end = findMacroTagEnd(html, '<@window'.length)
    assert.equal(html.slice('<@window'.length, end), ' title="a > b" @click={foo()}')
    assert.equal(html[end], '>')
  })

  it('(a) comparaison `>` dans <@window @scroll={…}> : la comparaison survit, aucun résidu dans le HTML', () => {
    const r = processGlobalMacros(`<@window @scroll={$y = window.scrollY > 100}/>\n<p>{$y}</p>`)
    assert.match(r.setup, /\$y = window\.scrollY > 100/, 'la comparaison complète doit apparaître dans le setup')
    assert.doesNotMatch(r.html, /100\}/, 'aucun résidu du corps du handler ne doit rester dans le HTML')
    assert.match(r.html, /<p>\{\$y\}<\/p>/, 'le reste du template doit rester intact')
  })

  it('(a-bis) même preuve via transpile() complet (reproduction du signalement initial)', async () => {
    const src = ['<script>', '  $y = 0', '</script>', '<@window @scroll={$y = window.scrollY > 100}/>', '<p>{$y}</p>'].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-m2-scroll' })
    assert.doesNotMatch(output, /100\}/, 'aucun résidu « 100} » ne doit atteindre le JS émis')
    assert.match(output, /window\.scrollY\s*>\s*100/, 'la comparaison doit survivre jusqu\'au JS émis')
  })

  it('(b) if/then/else (mots-clés + `>`) dans <@window @resize={…}>', () => {
    const r = processGlobalMacros(`<@window @resize={$w = if window.innerWidth > 800 then 'large' else 'petit'}/>\n<p>{$w}</p>`)
    assert.match(r.setup, /\$w = if window\.innerWidth > 800 then 'large' else 'petit'/)
    assert.doesNotMatch(r.html, /800/, 'aucun résidu du corps ne doit rester dans le HTML')
    assert.match(r.html, /<p>\{\$w\}<\/p>/)
  })

  it('(c) <@element $tag title={$n > 1}> : l\'attribut dynamique traverse ENTIER, aucun résidu tronqué', () => {
    const r = processGlobalMacros(`<@element $tag title={$n > 1}>x</@element>`)
    // hors périmètre macros.ts : ce que le compilateur d'attributs (generator/) fait ENSUITE de
    // `title={$n > 1}` sur le placeholder — ici on vérifie seulement que macros.ts ne tronque
    // plus la balise et ne laisse plus fuir de résidu texte. AVANT : `<div mjs-el="0"
    // title={$n> 1}>x</div>` (le `>` de la comparaison confondu avec le `>` de fin de balise,
    // espace avalé, balise coupée trop tôt) — la présence du `1}>x` seul ne suffit PAS à distinguer
    // les deux (il apparaît aussi dans le rendu CORRECT, cf. égalité stricte ci-dessous).
    assert.equal(r.html, '<div mjs-el="0" title={$n > 1}>x</div>')
  })

  it('(d) `>` dans une CHAÎNE À L\'INTÉRIEUR d\'une accolade (<@document @keydown={…}>)', () => {
    const r = processGlobalMacros(`<@document @keydown={if e.key is '>' then $x = 1}/>\n<p>ok</p>`)
    assert.match(r.setup, /if e\.key is '>' then \$x = 1/)
    assert.doesNotMatch(r.html, /then \$x/, 'aucun résidu du corps ne doit rester dans le HTML')
    assert.match(r.html, /<p>ok<\/p>/)
  })

  it('(e) <@failed err reset> : un `>` dans l\'accolade du CONTENU ne casse pas la balise ouvrante (non-régression, déjà correct avant ce correctif)', () => {
    const r = processGlobalMacros(`<@failed err reset><button @click={reset()}>Réessayer ({err.message.length > 3})</button></@failed>`)
    assert.doesNotMatch(r.html, /<@failed|<\/@failed>/)
    assert.match(r.setup, /Réessayer \(' \+ µ\._esc\(err\.message\.length > 3\) \+ '\)/)
    assert.match(r.setup, /addEventListener\('click', \(event\) => \(reset\(\)\)\)/)
  })

  // Non-régression byte-identique — mêmes extraits que tests/macros.test.ts (aucun `>` niché
  // dans une accolade) : le scan manuel doit rendre EXACTEMENT la même chose que l'ancien
  // `[^>]*`/`[^>]+?`. Comparaison sur pièce, pas de valeur en dur.
  it('non-régression : <@window> avec liaisons + écouteur, sortie inchangée', () => {
    const r = processGlobalMacros(`<@window scrollY=!{$y} innerWidth=!{$w} @keydown={onKey} />`)
    assert.match(r.setup, /\$y = window\.scrollY/)
    assert.match(r.setup, /\$w = window\.innerWidth/)
    assert.match(r.setup, /onKey\(e\)/)
    assert.match(r.teardown, /window\.removeEventListener\('scroll'/)
  })

  it('non-régression : <@head> avec contenu interpolé, sortie inchangée', () => {
    const r = processGlobalMacros(`<@head>\n  <link rel="stylesheet" href={themeCss[$selected]}>\n</@head>`)
    assert.match(r.setup, /µ\._setHead\(@, '<link rel="stylesheet" href="' \+ µ\._esc\(themeCss\[\$selected\]\) \+ '">'\)/)
  })

  it('non-régression : <@module $comp class="x"> statique, sortie inchangée', () => {
    const r = processGlobalMacros(`<@module $comp class="x">hi</@module>`)
    assert.match(r.html, /<div mjs-mod="0" class="x">/)
    assert.match(r.setup, /µ\._updModule\(@, '0', \(\$comp\)\)/)
  })
})

describe('<@head> — quoteHeadLiteral garde les sauts de ligne réels', function () {
  it('un commentaire `//` suivi d\'un VRAI saut de ligne n\'avale plus la ligne suivante', () => {
    const r = processGlobalMacros(`<@head><script>// commentaire\nwindow.foo = 1</script></@head>`)
    assert.match(r.setup, /commentaire\\nwindow\.foo/, 'séquence d\'échappement \\n entre "commentaire" et "window.foo"')
    const m = r.setup.match(/µ\._setHead\(@, (.+)\)$/)
    assert.ok(m, 'doit trouver l\'appel µ._setHead avec son littéral')
    const evaluated = eval(m![1]) // eslint-disable-line no-eval -- vérifie le VRAI saut de ligne après évaluation du littéral Civet/JS
    assert.ok(evaluated.includes('commentaire\nwindow.foo'), 'le littéral ÉVALUÉ doit contenir un vrai saut de ligne, pas un espace')
  })

  it('non-régression BYTE-IDENTIQUE : <@head><title>{$t}</title><link href={$u}></@head> produit EXACTEMENT la même expression', () => {
    const r = processGlobalMacros(`<@head><title>{$t}</title><link rel="stylesheet" href={$u}></@head>`)
    assert.equal(r.setup, '\nµeffect =>\n  µ._setHead(@, \'<title>\' + µ._esc($t) + \'</title><link rel="stylesheet" href="\' + µ._esc($u) + \'">\')')
  })
})

describe('<@include> sans baseDir — avertissement explicite au lieu d\'un strip silencieux', function () {
  it('processIncludes (unit) : sans baseDir, acc.warnings reçoit le message, le HTML reste nettoyé', () => {
    const acc = newIncludeAccumulator()
    const html = processIncludes('<@include foo>\n<p>x</p>', undefined, acc)
    assert.equal(html, '\n<p>x</p>')
    assert.equal(acc.warnings.length, 1)
    assert.match(acc.warnings[0], /foo/)
    assert.match(acc.warnings[0], /baseDir/)
  })

  it('transpile() bout en bout : sectionWarnings porte le message, le HTML compilé reste propre', async () => {
    const src = ['<script>$n = 1</script>', '<@include foo>', '<p>{$n}</p>'].join('\n')
    const { data, output } = await transpile(src, { moduleName: 'mjs-m3-sans-basedir' })
    assert.doesNotMatch(output, /<@include/, 'le HTML reste nettoyé, comme avant')
    assert.ok(data.sectionWarnings.some(w => w.includes('foo') && w.includes('baseDir')), `attendu un avertissement citant "foo" et "baseDir" dans sectionWarnings, reçu : ${JSON.stringify(data.sectionWarnings)}`)
  })
})

describe('macros — balise macro jamais refermée : erreur explicite au lieu du silence', function () {
  it('(1) <@window @click={f(…> jamais refermée (accolade ouverte) : 1 erreur, le reste du HTML survit intact', () => {
    const r = processGlobalMacros('<@window @click={f(<p>ok</p>')
    assert.equal(r.errors.length, 1, `attendu exactement 1 erreur, reçu : ${JSON.stringify(r.errors)}`)
    assert.match(r.errors[0], /window/)
    assert.match(r.errors[0], /@click=\{f\(/)
    assert.match(r.html, /<p>ok<\/p>/)
  })

  // (2) SUBSTITUÉ — `<@include foo titre="abc>` ne
  // reproduit pas, pour 2 raisons prouvées indépendamment de ce fichier : <@include> ne passe
  // JAMAIS par findMacroTagEnd (INCLUDE_RE, regex dédiée sans support d'attributs) ET même en
  // hypothèse contraire, cette chaîne précise ne rend PAS -1 (le `>` juste après « abc » est
  // retrouvé normalement — un guillemet SEUL jamais fermé n'empêche jamais de trouver le `>`
  // réel, cf. tolérance documentée sur findMacroTagEnd et son test dédié plus haut). Cas
  // substitué, fidèle à l'esprit « guillemet ouvert, balise jamais refermée » : la balise
  // s'arrête net (fin de composant) sans qu'aucun `>` n'existe plus loin.
  it('(2) <@window titre="abc (fin abrupte, aucun `>` plus loin) : 1 erreur', () => {
    const r = processGlobalMacros('<@window titre="abc')
    assert.equal(r.errors.length, 1, `attendu exactement 1 erreur, reçu : ${JSON.stringify(r.errors)}`)
    assert.match(r.errors[0], /window/)
  })

  it('(3) non-régression : <@window @click={a > b}/> (comparaison + balise bien fermée) → 0 erreur', () => {
    const r = processGlobalMacros('<@window @click={a > b}/>')
    assert.equal(r.errors.length, 0, `attendu 0 erreur, reçu : ${JSON.stringify(r.errors)}`)
  })

  it('(4) deux balises fautives distinctes → 2 erreurs distinctes, aucune duplication', () => {
    const r = processGlobalMacros('<@window @click={f(<@window @foo={g(')
    assert.equal(r.errors.length, 2, `attendu exactement 2 erreurs, reçu : ${JSON.stringify(r.errors)}`)
    assert.notEqual(r.errors[0], r.errors[1])
  })
})

describe('macros — <@head> non fermée comptée en double + extrait coupant un émoji', function () {
  // <@head> passe par DEUX chemins successifs : replacePairedTag (forme contenu) PUIS
  // la boucle TARGETS (forme écouteur, cf. commentaire § 1 de macros.ts). Quand
  // findMacroTagEnd rend -1 dans les DEUX passes (html inchangé entre les deux), la
  // MÊME occurrence était signalée deux fois — message identique, dupliqué dans le
  // throw final de bundler/index.ts.
  it('(1) <@head @click={f( jamais refermée : 1 erreur (pas 2, malgré les deux passes replacePairedTag + TARGETS)', () => {
    const r = processGlobalMacros('<@head @click={f(')
    assert.equal(r.errors.length, 1, `attendu exactement 1 erreur, reçu : ${JSON.stringify(r.errors)}`)
  })

  it('(2) <@head titre="abc (fin abrupte, aucun `>` plus loin) : 1 erreur (pas 2)', () => {
    const r = processGlobalMacros('<@head titre="abc')
    assert.equal(r.errors.length, 1, `attendu exactement 1 erreur, reçu : ${JSON.stringify(r.errors)}`)
  })

  it('(3) non-régression : <@window @click={f( (une seule passe TARGETS, jamais doublée) → 1 erreur', () => {
    const r = processGlobalMacros('<@window @click={f(')
    assert.equal(r.errors.length, 1, `attendu exactement 1 erreur, reçu : ${JSON.stringify(r.errors)}`)
  })

  it('(4) deux <@head> fautives DISTINCTES (extraits différents) → 2 erreurs (pas 4 : le dédoublonnage ne fusionne que le texte IDENTIQUE)', () => {
    const r = processGlobalMacros('<@head @click={f(<@head @foo={g(')
    assert.equal(r.errors.length, 2, `attendu exactement 2 erreurs, reçu : ${JSON.stringify(r.errors)}`)
    assert.notEqual(r.errors[0], r.errors[1])
  })

  it('(5) l\'extrait ne coupe jamais une paire de substituts UTF-16 : émoji entier dans le message, aucun substitut isolé', () => {
    // construit une balise fautive où le 60e caractère (point de code) tombe
    // pile sur le début de l'émoji — reproduit la coupure `html.slice(idx, idx+60)`
    // au milieu d'une paire de substituts.
    const prefix = '<@window @x={'
    const emoji = '😀'
    const pad = 'a'.repeat(59 - prefix.length)
    const html = prefix + pad + emoji + 'jamais ferme'
    const r = processGlobalMacros(html)
    assert.equal(r.errors.length, 1, `attendu exactement 1 erreur, reçu : ${JSON.stringify(r.errors)}`)
    const substitutIsole = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    assert.doesNotMatch(r.errors[0], substitutIsole, `substitut isolé détecté dans : ${r.errors[0]}`)
    assert.ok(r.errors[0].includes(emoji), `émoji entier attendu dans le message, reçu : ${r.errors[0]}`)
  })
})

// <@include> mal formé — AVANT : un <@include> qui ne
// correspond pas à la forme stricte <@include chemin> (attributs, chemin absent) ne matchait
// pas INCLUDE_RE et restait donc du texte INERTE dans la page, SANS UN MOT (silence total,
// aucune trace dans acc.errors/acc.warnings). `resolvePartial`/le slash final interdit restent
// inchangés : seule la forme vraiment étrangère à INCLUDE_RE déclenche la nouvelle erreur.
describe('<@include> mal formé → erreur de compilation explicite', function () {
  const dir = mjsTmp('a3m4-include-malforme')
  writeFileSync(join(dir, '_valide.mjs'), '<p>partiel</p>')

  it('(i1) <@include foo titre="a"> (attribut en trop, forme non reconnue) : 1 erreur citant "include" et "titre="', () => {
    const acc = newIncludeAccumulator()
    const html = processIncludes('<@include foo titre="a">\n<p>x</p>', dir, acc)
    assert.equal(acc.errors.length, 1, `attendu 1 erreur, reçu : ${JSON.stringify(acc.errors)}`)
    assert.match(acc.errors[0], /include/)
    assert.match(acc.errors[0], /titre=/)
    assert.match(html, /<p>x<\/p>/)
  })

  it('(i2) <@include> seul (chemin absent) : 1 erreur', () => {
    const acc = newIncludeAccumulator()
    processIncludes('<@include>\n<p>x</p>', dir, acc)
    assert.equal(acc.errors.length, 1, `attendu 1 erreur, reçu : ${JSON.stringify(acc.errors)}`)
    assert.match(acc.errors[0], /include/)
  })

  it('(i3) <@include ./valide> avec le partiel réellement présent : 0 erreur, inclusion faite (non-régression)', () => {
    const acc = newIncludeAccumulator()
    const html = processIncludes('<@include ./valide>', dir, acc)
    assert.equal(acc.errors.length, 0, `attendu 0 erreur, reçu : ${JSON.stringify(acc.errors)}`)
    assert.match(html, /<p>partiel<\/p>/)
  })

  it('(i4) <@include valide/> (barre finale) : l\'erreur EXISTANTE (slash final interdit), pas la nouvelle', () => {
    const acc = newIncludeAccumulator()
    processIncludes('<@include valide/>', dir, acc)
    assert.equal(acc.errors.length, 1, `attendu 1 erreur, reçu : ${JSON.stringify(acc.errors)}`)
    assert.match(acc.errors[0], /slash final interdit/)
    assert.doesNotMatch(acc.errors[0], /mal formé/)
  })

  it('(i5a) le MÊME <@include> malformé, rencontré à deux niveaux de récursion (partial inclus dans l\'hôte) : dédoublonné à 1 erreur', () => {
    // processIncludes se rappelle sur le html du partial (1er passage : le malformé y est
    // repéré), PUIS ce html est réinjecté tel quel dans l'hôte, où le <@include> englobant
    // rescanne le résultat assemblé (2e passage, MÊME extrait car aucun autre texte ne
    // l'entoure des deux côtés) — sans le dédoublonnage par texte EXACT, ce serait 2 erreurs
    // pour une seule balise fautive.
    const dirDup = mjsTmp('a3m4-include-malforme-dup')
    writeFileSync(join(dirDup, '_frag.mjs'), '<@include foo titre="a">')
    const acc = newIncludeAccumulator()
    processIncludes('<@include ./frag>', dirDup, acc)
    assert.equal(acc.errors.length, 1, `attendu 1 erreur dédoublonnée, reçu : ${JSON.stringify(acc.errors)}`)
  })

  it('(i5b) deux <@include> malformés DISTINCTS dans le même html → 2 erreurs, aucune fusion', () => {
    const acc = newIncludeAccumulator()
    processIncludes('<@include foo titre="a">\n<@include bar data-x="b">', dir, acc)
    assert.equal(acc.errors.length, 2, `attendu 2 erreurs, reçu : ${JSON.stringify(acc.errors)}`)
    assert.notEqual(acc.errors[0], acc.errors[1])
  })
})
