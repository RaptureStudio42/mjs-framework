// compile : directive @title (infobulle universelle, mjs_title.ts + preprocessHtml).
// Volet COMPILE seulement (preprocessHtml, transpiler/index.ts) — le volet runtime est couvert
// par tests/runtime-title.test.ts. Même style que tests/transpiler-callback-confirm.test.ts :
// transpile() appelé directement, pas le Bundler complet (aucune de ces formes ne touche au
// système de fichiers/imports).

import assert from 'node:assert/strict'
import { transpile } from '../src/transpiler/index.js'

describe('transpiler — @title forme CHAÎNE', () => {
  // NB quotes : le générateur ré-émet les attributs statiques du template en guillemets
  // SIMPLES (le fragment HTML est lui-même embarqué dans une chaîne JS À DOUBLES guillemets,
  // cf. µ._mjs_cloneTpl("...")) — mes assertions acceptent donc les deux, comme
  // tests/transpiler-callback-confirm.test.ts (`mjs-confirm=['"]...['"]`).
  it('@title="texte" (guillemets doubles) → mjs-title=texte', async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<button @title="Enregistrer le brouillon">Sauver</button>`
    const { output } = await transpile(src, { moduleName: 'ti1' })
    assert.match(output, /mjs-title=['"]Enregistrer le brouillon['"]/)
  })

  it("@title='texte' (guillemets simples) → même résultat", async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<button @title='Enregistrer le brouillon'>Sauver</button>`
    const { output } = await transpile(src, { moduleName: 'ti2' })
    assert.match(output, /mjs-title=['"]Enregistrer le brouillon['"]/)
  })

  it('accolade LITTÉRALE dans le texte survit (escapeVtAttrValue) — round-trip décodable', async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<button @title="Solde {global}">Aide</button>`
    const { output } = await transpile(src, { moduleName: 'ti3' })
    const m = output.match(/mjs-title=(["'])((?:(?!\1)[\s\S])*)\1/)
    assert.ok(m, 'attribut mjs-title introuvable')
    assert.doesNotMatch(m![2], /[{}]/, 'aucune accolade LITTÉRALE dans l\'attribut émis')
    const decoded = m![2].replace(/&quot;/g, '"').replace(/&#123;/g, '{').replace(/&#125;/g, '}')
    assert.equal(decoded, 'Solde {global}')
  })

  it('title="" NATIF (sans @) reste totalement inchangé à côté de @title', async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<a @title="Astuce" title="natif inchangé" href="/x">lien</a>`
    const { output } = await transpile(src, { moduleName: 'ti4' })
    assert.match(output, /mjs-title=['"]Astuce['"]/)
    assert.match(output, /(?<!mjs-)title=['"]natif inchangé['"]/)
  })
})

// @title={{ expr }} : forme HTML BRUT, symétrique de
// {{ }}/{ } en interpolation de texte (docs/07-bindings.md). Disambiguation par les DEUX
// PREMIERS caractères après `@title=` : `{{` accolées (SANS espace) = HTML, `{ {` (un espace)
// reste la forme simple ci-dessous (objet littéral en EXPRESSION, cas rare mais licite — c'est
// LE test qui prouve la règle de l'espace).
describe('transpiler — @title forme HTML ({{ }})', () => {
  it("@title={{ '<b>gras</b>' }} → attribut mjs-title-html produit (slot vide + _mjs_updAttr réactif), mjs-title simple ABSENT", async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<button @title={{ '<b>gras</b>' }}>Aide</button>`
    const { output } = await transpile(src, { moduleName: 'th1' })
    assert.match(output, /mjs-title-html=''/)
    assert.doesNotMatch(output, /mjs-title=/)
    assert.match(output, /_mjs_updAttr\('[^']+',\s*'mjs-title-html',/)
  })

  it('@title={{ $a + $b }} (expression combinée, exemple canonique) → mjs-title-html réactif, expression reçue INTACTE', async () => {
    const src = `<script lang="coffee">\n$a = 'Solde : '\n$b = 42\n</script>\n<div @title={{ $a + $b }}>Survole-moi</div>`
    const { output } = await transpile(src, { moduleName: 'th1b' })
    assert.match(output, /mjs-title-html=''/)
    assert.match(output, /_mjs_updAttr\('[^']+',\s*'mjs-title-html',\s*\$\.a\s*\+\s*\$\.b\)/)
  })

  it('@title={{ $html }} suit la variable $ : attribut mjs-title-html câblé RÉACTIF (_mjs_updAttr, valeur = $.html)', async () => {
    const src = `<script lang="coffee">\n$html = '<b>x</b>'\n</script>\n<div @title={{ $html }}>Survole-moi</div>`
    const { output } = await transpile(src, { moduleName: 'th2' })
    assert.match(output, /mjs-title-html=''/)
    assert.match(output, /_mjs_updAttr\('[^']+',\s*'mjs-title-html',\s*\$\.html\)/)
  })

  it("@title={ { text: 'x' } } (UN espace entre les deux accolades) → forme SIMPLE, objet littéral en EXPRESSION réactive, mjs-title-html ABSENT (règle de l'espace)", async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<div @title={ { text: 'x' } }>y</div>`
    const { output } = await transpile(src, { moduleName: 'th3' })
    assert.doesNotMatch(output, /mjs-title-html/, 'la forme espacée ne doit JAMAIS déclencher la forme HTML')
    assert.doesNotMatch(output, /mjs-title-conf/, 'un objet littéral en EXPRESSION ne passe pas par le parsing strict des options')
    assert.match(output, /mjs-title=''/, 'slot vide : passe-plat réactif générique, pas une chaîne figée')
    assert.match(output, /_mjs_updAttr\('[^']+',\s*'mjs-title',/, 'attribut mjs-title câblé réactif (même mécanisme que title={$expr})')
  })

  it("@title={ text: 'x' } (objet d'options STATIQUE, INCHANGÉ) → mjs-title/mjs-title-conf, mjs-title-html ABSENT", async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<a @title={ text: 'x' }>x</a>`
    const { output } = await transpile(src, { moduleName: 'th4' })
    assert.doesNotMatch(output, /mjs-title-html/)
    assert.match(output, /mjs-title=['"]x['"]/)
  })

  it('@title="chaîne" (INCHANGÉ) → mjs-title-html ABSENT', async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<button @title="Astuce">Sauver</button>`
    const { output } = await transpile(src, { moduleName: 'th5' })
    assert.doesNotMatch(output, /mjs-title-html/)
    assert.match(output, /mjs-title=['"]Astuce['"]/)
  })

  it('@title={$expr} (accolade SIMPLE, INCHANGÉ) → mjs-title-html ABSENT, passe-plat mjs-title habituel', async () => {
    const src = `<script lang="coffee">\n$msg = 'x'\n</script>\n<div @title={$msg}>y</div>`
    const { output } = await transpile(src, { moduleName: 'th6' })
    assert.doesNotMatch(output, /mjs-title-html/)
    assert.match(output, /mjs-title=''/)
  })

  it('{{ ouvert sans }} fermant (fin de fichier) → ERREUR de compile explicite, jamais un corps tronqué', async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<button @title={{ 'abc'</button>`
    await assert.rejects(
      () => transpile(src, { moduleName: 'th7' }),
      /n'est jamais refermée/,
    )
  })

  it('{{ ouvert avec UNE SEULE accolade fermante (pas la double attendue) → ERREUR de compile explicite', async () => {
    const src = `<script lang="coffee">\n$n = 2\n</script>\n<button @title={{ $n }>Aide</button>`
    await assert.rejects(
      () => transpile(src, { moduleName: 'th8' }),
      /n'est jamais refermée/,
    )
  })

  // DÉFAUT 3 — TROIS accolades ouvrantes accolées
  // (`{{{`) compilaient SANS ERREUR : extractBraceBody appariait la première fermante venue, la
  // troisième accolade filait dans le CORPS comme un objet littéral (`mjs-title-html={{ expr }}`)
  // → au runtime, String({...}) affiche "[object Object]" au survol. Ni la forme texte (une
  // accolade), ni la forme HTML (deux) : refusé.
  it('@title={{{ expr }}} (TROIS accolades accolées) → ERREUR de compile explicite, jamais un objet affiché "[object Object]"', async () => {
    const src = `<script lang="coffee">\n$titre = 'x'\n</script>\n<button @title={{{ $titre }}}>Aide</button>`
    await assert.rejects(
      () => transpile(src, { moduleName: 'th9' }),
      /trois accolades/,
    )
  })

  it('@title={{{{ expr }}}} (QUATRE accolades) → même refus que le triple (la 3e accolade suffit à le détecter)', async () => {
    const src = `<script lang="coffee">\n$titre = 'x'\n</script>\n<button @title={{{{ $titre }}}}>Aide</button>`
    await assert.rejects(
      () => transpile(src, { moduleName: 'th10' }),
      /trois accolades/,
    )
  })
})

describe('transpiler — @title forme OBJET', () => {
  it('objet COMPLET {text,delay,side,dur,transition} → mjs-title + mjs-title-conf JSON exact', async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<a @title={ text: 'Astuce', delay: 200, side: 'bottom', dur: 100, transition: 'slide' }>x</a>`
    const { output } = await transpile(src, { moduleName: 'ti5' })
    const mText = output.match(/mjs-title=(["'])((?:(?!\1)[\s\S])*)\1/)
    assert.ok(mText, 'mjs-title introuvable')
    assert.equal(mText![2], 'Astuce')
    const mConf = output.match(/mjs-title-conf=(["'])((?:(?!\1)[\s\S])*)\1/)
    assert.ok(mConf, 'mjs-title-conf introuvable')
    const decoded = mConf![2].replace(/&quot;/g, '"').replace(/&#123;/g, '{').replace(/&#125;/g, '}')
    assert.deepEqual(JSON.parse(decoded), { delay: 200, side: 'bottom', dur: 100, transition: 'slide' })
  })

  it('objet PARTIEL (text + une seule autre clé) → JSON ne porte que la clé fournie', async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<a @title={ text: 'Astuce', side: 'bottom' }>x</a>`
    const { output } = await transpile(src, { moduleName: 'ti6' })
    const mConf = output.match(/mjs-title-conf=(["'])((?:(?!\1)[\s\S])*)\1/)
    assert.ok(mConf, 'mjs-title-conf introuvable')
    const decoded = mConf![2].replace(/&quot;/g, '"').replace(/&#123;/g, '{').replace(/&#125;/g, '}')
    assert.deepEqual(JSON.parse(decoded), { side: 'bottom' })
  })

  it('objet avec SEULEMENT text → mjs-title-conf ABSENT (rien d\'autre à porter)', async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<a @title={ text: 'Astuce' }>x</a>`
    const { output } = await transpile(src, { moduleName: 'ti7' })
    assert.match(output, /mjs-title=['"]Astuce['"]/)
    assert.doesNotMatch(output, /mjs-title-conf/)
  })

  it('guillemets doubles ACCEPTÉES pour les valeurs (pas seulement simples)', async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<a @title={ text: "Astuce", side: "top" }>x</a>`
    const { output } = await transpile(src, { moduleName: 'ti8' })
    assert.match(output, /mjs-title=['"]Astuce['"]/)
  })

  it('text ABSENT → ERREUR de compile explicite', async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<a @title={ delay: 300 }>x</a>`
    await assert.rejects(
      () => transpile(src, { moduleName: 'ti9' }),
      /@title=\{.*forme objet invalide.*text \(obligatoire\)/s,
    )
  })

  it('objet : accolade LITTÉRALE dans text → mjs-title survit, texte intact', async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<a @title={ text: 'Solde {global}' }>x</a>`
    const { output } = await transpile(src, { moduleName: 'ti9b' })
    const m = output.match(/mjs-title=(["'])((?:(?!\1)[\s\S])*)\1/)
    assert.ok(m, 'attribut mjs-title introuvable (accolade dans la chaîne a fait échouer l\'extraction)')
    assert.doesNotMatch(m![2], /[{}]/, 'aucune accolade LITTÉRALE dans l\'attribut émis')
    const decoded = m![2].replace(/&quot;/g, '"').replace(/&#123;/g, '{').replace(/&#125;/g, '}')
    assert.equal(decoded, 'Solde {global}')
  })

  it('objet : accolades IMBRIQUÉES dans text ({a{b}c}) → extraction équilibrée, texte intact', async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<a @title={ text: '{a{b}c}', side: 'bottom' }>x</a>`
    const { output } = await transpile(src, { moduleName: 'ti9c' })
    const mText = output.match(/mjs-title=(["'])((?:(?!\1)[\s\S])*)\1/)
    assert.ok(mText, 'mjs-title introuvable')
    const decodedText = mText![2].replace(/&quot;/g, '"').replace(/&#123;/g, '{').replace(/&#125;/g, '}')
    assert.equal(decodedText, '{a{b}c}')
    const mConf = output.match(/mjs-title-conf=(["'])((?:(?!\1)[\s\S])*)\1/)
    assert.ok(mConf, 'mjs-title-conf introuvable')
    const decoded = mConf![2].replace(/&quot;/g, '"').replace(/&#123;/g, '{').replace(/&#125;/g, '}')
    assert.deepEqual(JSON.parse(decoded), { side: 'bottom' })
  })

  it('clé HORS text/delay/side/dur/transition → ERREUR de compile explicite', async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<a @title={ text: 'x', danger: 'y' }>x</a>`
    await assert.rejects(
      () => transpile(src, { moduleName: 'ti10' }),
      /forme objet invalide/,
    )
  })

  it("side HORS énumération ('left') → ERREUR de compile explicite", async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<a @title={ text: 'x', side: 'left' }>x</a>`
    await assert.rejects(
      () => transpile(src, { moduleName: 'ti11' }),
      /forme objet invalide/,
    )
  })

  it("transition HORS énumération ('bounce') → ERREUR de compile explicite", async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<a @title={ text: 'x', transition: 'bounce' }>x</a>`
    await assert.rejects(
      () => transpile(src, { moduleName: 'ti12' }),
      /forme objet invalide/,
    )
  })

  it('delay NON NUMÉRIQUE (chaîne) → ERREUR de compile explicite', async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<a @title={ text: 'x', delay: 'vite' }>x</a>`
    await assert.rejects(
      () => transpile(src, { moduleName: 'ti13' }),
      /forme objet invalide/,
    )
  })

  it('valeur VARIABLE pour text (pas une chaîne littérale) → ERREUR, aucune expression tolérée', async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<a @title={ text: messageVar }>x</a>`
    await assert.rejects(
      () => transpile(src, { moduleName: 'ti14' }),
      /forme objet invalide/,
    )
  })
})

describe('transpiler — @title forme EXPRESSION (passe-plat réactif)', () => {
  // NB : `output` est le JS final, pas le HTML prétraité — le pipeline générique consomme
  // `mjs-title={expr}` et le remplace par un slot vide dans le template statique + un appel
  // `_mjs_updAttr` réactif séparé (même chemin que l'attribut natif `title={$expr}`, cf.
  // tests/parser.test.ts « dynamic {expr} ») : c'est CE couple qui prouve le passe-plat, pas une
  // recherche du texte `{$msg}` verbatim dans la sortie.
  it("@title={$msg} (pas de « clé: » en tête) → slot vide dans le template statique (PAS de texte figé, PAS de JSON)", async () => {
    const src = `<script lang="coffee">\n$msg = 'Bonjour'\n</script>\n<div @title={$msg}>Survole-moi</div>`
    const { output } = await transpile(src, { moduleName: 'ti15' })
    assert.match(output, /mjs-title=''/)
    assert.doesNotMatch(output, /mjs-title-conf/)
  })

  it("@title={$msg} suit la variable $ : l'attribut est câblé RÉACTIF (_mjs_updAttr sur 'mjs-title', valeur = \$.msg)", async () => {
    const src = `<script lang="coffee">\n$msg = 'Bonjour'\n</script>\n<div @title={$msg}>Survole-moi</div>`
    const { output } = await transpile(src, { moduleName: 'ti16' })
    assert.match(output, /_mjs_updAttr\('[^']+',\s*'mjs-title',\s*\$\.msg\)/)
  })

  it('@title={cond ? a : b} (ternaire, PAS un objet malgré le ":") → passe-plat réactif, aucune erreur', async () => {
    const src = `<script lang="coffee">\n$cond = true\n$a = 'x'\n$b = 'y'\n</script>\n<div @title={$cond ? $a : $b}>x</div>`
    const { output } = await transpile(src, { moduleName: 'ti17' })
    assert.match(output, /mjs-title=''/)
    assert.match(output, /_mjs_updAttr\('[^']+',\s*'mjs-title',\s*\$\.cond \? \$\.a : \$\.b\)/)
  })
})

describe('transpiler — @title apostrophe échappée', () => {
  it("forme OBJET, cas EXACT du verdict : @title={ text: 'j\\'accepte', delay: 100 } → mjs-title exact + mjs-title-conf JSON", async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<a @title={ text: 'j\\'accepte', delay: 100 }>x</a>`
    const { output } = await transpile(src, { moduleName: 'ti18' })
    const mText = output.match(/mjs-title=(["'])((?:(?!\1)[\s\S])*)\1/)
    assert.ok(mText, 'mjs-title introuvable (apostrophe échappée a fait échouer l\'extraction)')
    const decodedText = mText![2].replace(/&quot;/g, '"').replace(/&#123;/g, '{').replace(/&#125;/g, '}').replace(/&#39;/g, "'")
    assert.equal(decodedText, "j'accepte")
    const mConf = output.match(/mjs-title-conf=(["'])((?:(?!\1)[\s\S])*)\1/)
    assert.ok(mConf, 'mjs-title-conf introuvable')
    const decodedConf = mConf![2].replace(/&quot;/g, '"').replace(/&#123;/g, '{').replace(/&#125;/g, '}')
    assert.deepEqual(JSON.parse(decodedConf), { delay: 100 })
  })

  it('forme OBJET, guillemets doubles échappés dans text : @title={ text: "dit \\"salut\\"" } → décodé exact', async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<a @title={ text: "dit \\"salut\\"" }>x</a>`
    const { output } = await transpile(src, { moduleName: 'ti19' })
    const m = output.match(/mjs-title=(["'])((?:(?!\1)[\s\S])*)\1/)
    assert.ok(m, 'attribut mjs-title introuvable')
    const decoded = m![2].replace(/&quot;/g, '"').replace(/&#123;/g, '{').replace(/&#125;/g, '}')
    assert.equal(decoded, 'dit "salut"')
  })

  it("forme CHAÎNE avec apostrophe échappée : @title='J\\'accepte' → attribut PROPRE (pas de corruption), gabarit isométrique", async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<button @title='J\\'accepte'>go</button>`
    const { output } = await transpile(src, { moduleName: 'ti20' })
    const m = output.match(/mjs-title=(["'])((?:(?!\1)[\s\S])*)\1/)
    assert.ok(m, 'attribut mjs-title introuvable')
    const decoded = m![2].replace(/&quot;/g, '"').replace(/&#123;/g, '{').replace(/&#125;/g, '}').replace(/&#39;/g, "'")
    assert.equal(decoded, "J'accepte")
    assert.equal((output.match(/<\/button>/g) || []).length, 1, 'le gabarit doit rester équilibré, une seule fermeture </button>')
  })

  it('forme CHAÎNE avec guillemets doubles échappés : @title="Elle dit \\"stop\\"" → décodé exact', async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<button @title="Elle dit \\"stop\\"">go</button>`
    const { output } = await transpile(src, { moduleName: 'ti21' })
    const m = output.match(/mjs-title=(["'])((?:(?!\1)[\s\S])*)\1/)
    assert.ok(m, 'attribut mjs-title introuvable')
    const decoded = m![2].replace(/&quot;/g, '"').replace(/&#123;/g, '{').replace(/&#125;/g, '}')
    assert.equal(decoded, 'Elle dit "stop"')
  })

  it("forme CHAÎNE JAMAIS refermée (@title='abc sans guillemet final) → ERREUR de compile explicite, jamais de HTML corrompu", async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<button @title='abc</button>`
    await assert.rejects(
      () => transpile(src, { moduleName: 'ti22' }),
      /@title=\{.*forme objet invalide/s,
    )
  })
})

describe('extractBraceBody — accolade littérale dans un backtick ou un commentaire', () => {
  // le scanner ne gelait le comptage d'accolades que dans `'…'`/`"…"` : une
  // accolade NON appariée dans un backtick ou un commentaire `/* */` de la forme passe-plat
  // (`@title={…}`) faisait perdre l'attribut `mjs-title` EN SILENCE et câblait en prime un
  // écouteur DOM fantôme sur l'événement 'title' (`_mjs_bindEvents({"title":…})`) — confirmé par
  // exécution avant correctif : `mjs-title` absent, `_mjs_bindEvents({"title":{"e1":0}})` présent.
  it('backtick contenant une accolade non appariée (`solde {x`) → mjs-title survit, aucun écouteur fantôme', async () => {
    const src = "<script lang=\"coffee\">\n$x = 0\n</script>\n<button @title={ `solde {x` }>Aide</button>"
    const { output } = await transpile(src, { moduleName: 'tb1' })
    assert.match(output, /mjs-title=/, "AVANT : le backtick non géré cassait le comptage d'accolades, mjs-title disparaissait")
    assert.doesNotMatch(output, /_mjs_bindEvents\(\{"title"/, 'AVANT : écouteur DOM fantôme câblé sur l\'événement "title"')
  })

  it('commentaire de BLOC contenant une accolade (/* { */) → idem', async () => {
    const src = "<script lang=\"coffee\">\n$x = 0\n</script>\n<button @title={ /* { */ 'txt' }>Aide</button>"
    const { output } = await transpile(src, { moduleName: 'tb2' })
    assert.match(output, /mjs-title=/)
    assert.doesNotMatch(output, /_mjs_bindEvents\(\{"title"/)
  })

  it('commentaire de LIGNE (//) dans un corps multi-lignes → idem', async () => {
    const src = "<script lang=\"coffee\">\n$x = 0\n</script>\n<button @title={\n  // {\n  'txt'\n}>Aide</button>"
    const { output } = await transpile(src, { moduleName: 'tb3' })
    assert.match(output, /mjs-title=/)
    assert.doesNotMatch(output, /_mjs_bindEvents\(\{"title"/)
  })

  it("backtick avec `\\${…}` imbriqué contenant une accolade en chaîne → idem", async () => {
    const src = "<script lang=\"coffee\">\n$x = 0\n</script>\n<button @title={ `a${ '}' }b` }>Aide</button>"
    const { output } = await transpile(src, { moduleName: 'tb4' })
    assert.match(output, /mjs-title=/)
    assert.doesNotMatch(output, /_mjs_bindEvents\(\{"title"/)
  })
})

// `extractBraceBody` ne connaissait NI les regex NI leur ambiguïté avec un
// commentaire de bloc : un `/` qui FERME une regex, immédiatement suivi d'un `*` (ex. multiplication
// juste après un test regex, `/a*/*$n`), était pris pour l'OUVERTURE d'un `/* … */` — la « fin » du
// faux commentaire n'existant nulle part, tout le reste du fichier était avalé (`end: -1`), le
// marqueur `@title={` restait INTACT dans le HTML, et retombait sur le pipeline générique
// d'attributs : @title interprété comme un ÉCOUTEUR d'événement DOM 'title' — confirmé par exécution
// avant correctif : `mjs-title` ABSENT de `_mjs_cloneTpl`, `_mjs_bindEvents({"title":{"e1":0}})` présent, le
// corps de la directive rejoué comme handler (`this._mjs_inline = [(e, el) => { return /a*/*$.n }]`).
// Remède : `extractBraceBody` délègue à `extractBalanced` (src/parser/index.ts), déjà regex-aware.
describe('extractBraceBody — regex littérale (délégation à extractBalanced)', () => {
  it("@title={ /a*/*$n } (regex finissant par `*`, immédiatement suivi de `*$n`, PIÈGE `/*`) → mjs-title survit, expression complète, aucun écouteur fantôme", async () => {
    const src = `<script lang="coffee">\n$n = 2\n</script>\n<button @title={ /a*/*$n }>Aide</button>`
    const { output } = await transpile(src, { moduleName: 'tb5' })
    assert.match(output, /mjs-title=''/, 'AVANT : le piège /* avalait tout le fichier, mjs-title disparaissait')
    assert.match(output, /_mjs_updAttr\('[^']+',\s*'mjs-title',\s*\/a\*\/\s*\*\s*\$\.n\)/, 'expression reçue INTACTE (regex + multiplication), pas tronquée')
    assert.doesNotMatch(output, /_mjs_bindEvents\(\{"title"/, 'même symptôme que B1 : écouteur DOM fantôme sur l\'événement "title"')
  })

  it("@title={ /}/.test($s) ? 'a' : 'b' } (regex portant un `}` littéral) → mjs-title survit, expression complète, aucun écouteur fantôme", async () => {
    const src = `<script lang="coffee">\n$s = 'x'\n</script>\n<button @title={ /}/.test($s) ? 'a' : 'b' }>Aide</button>`
    const { output } = await transpile(src, { moduleName: 'tb6' })
    assert.match(output, /mjs-title=''/)
    assert.match(output, /_mjs_updAttr\('[^']+',\s*'mjs-title',\s*\/\}\/\.test\(\$\.s\)\s*\?\s*'a'\s*:\s*'b'\)/)
    assert.doesNotMatch(output, /_mjs_bindEvents\(\{"title"/)
  })

  it("@title={ /'/.test($s) ? 1 : 2 } (regex portant un guillemet) → passe-plat réactif normal", async () => {
    const src = `<script lang="coffee">\n$s = 'x'\n</script>\n<button @title={ /'/.test($s) ? 1 : 2 }>Aide</button>`
    const { output } = await transpile(src, { moduleName: 'tb7' })
    assert.match(output, /mjs-title=''/)
    assert.doesNotMatch(output, /_mjs_bindEvents\(\{"title"/)
  })

  it('@title={ $a / $b } (division, PAS une regex) → passe-plat réactif normal', async () => {
    const src = `<script lang="coffee">\n$a = 4\n$b = 2\n</script>\n<button @title={ $a / $b }>Aide</button>`
    const { output } = await transpile(src, { moduleName: 'tb8' })
    assert.match(output, /mjs-title=''/)
    assert.match(output, /_mjs_updAttr\('[^']+',\s*'mjs-title',\s*\$\.a\s*\/\s*\$\.b\)/)
  })

  // @confirm a la MÊME disambiguation que @title : un corps sans
  // `clé:` en tête est une EXPRESSION, passe-plat réactif. Le piège `/*` doit donc rendre ici ce
  // qu'il rend pour @title — l'expression intacte —, jamais un écouteur fantôme sur l'événement
  // 'confirm' (symptôme d'avant le correctif).
  it('@confirm={ /a*/*$n } (même piège `/*`) → expression intacte, aucun écouteur fantôme', async () => {
    const src = `<script lang="coffee">\n$n = 2\n</script>\n<a @confirm={ /a*/*$n }>Suppr</a>`
    const { output } = await transpile(src, { moduleName: 'tb9' })
    assert.match(output, /mjs-confirm=''/, 'le piège /* ne doit plus avaler la suite du fichier')
    assert.match(output, /_mjs_updAttr\('[^']+',\s*'mjs-confirm',\s*\/a\*\/\s*\*\s*\$\.n\)/, 'expression reçue INTACTE (regex + multiplication), pas tronquée')
    assert.doesNotMatch(output, /_mjs_bindEvents\(\{"confirm"/, 'écouteur DOM fantôme sur l\'événement "confirm"')
  })

  it('@confirm={ text: \'Sûr ?\' } (hash d\'options) garde son parsing strict — une valeur non littérale est refusée', async () => {
    const ok = await transpile(`<a @confirm={ text: 'Sûr ?' }>Suppr</a>`, { moduleName: 'tb9b' })
    assert.match(ok.output, /mjs-confirm/, 'la forme objet reste compilée en attribut')
    await assert.rejects(
      () => transpile(`<script lang="coffee">\n$m = 'x'\n</script>\n<a @confirm={ text: $m }>Suppr</a>`, { moduleName: 'tb9c' }),
      /forme objet invalide/,
    )
  })
})
