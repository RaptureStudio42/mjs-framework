<script>
KIND_LABELS := { module: 'module', theme: 'thème', framework: 'framework', stylesheet: 'feuille partagée' }
ORDRE_KIND  := { theme: 0, module: 1, stylesheet: 2, framework: 3 }

formatKind = (k) -> KIND_LABELS[k] ?? k

COLOR_RE := new RegExp('^#|^rgb\\(|^hsl\\(|^oklch\\(|^color\\(', 'i')

looksLikeColor = (v) -> COLOR_RE.test(v)

MOTIFS := {
  introuvable:        'déclaration introuvable dans le fichier — reconstruire ?'
  ambigu:             'plusieurs déclarations dans ce fichier, ligne indécidable'
  inchange:           'déjà à cette couleur'
  'hors-projet':      'fichier hors du projet (framework, lien symbolique)'
  'racine-inconnue':  'racine du projet inconnue du serveur'
  'valeur-refusee':   'valeur refusée par le crible'
  'nom-refuse':       'nom de variable refusé'
  'fichier-manquant': 'aucun fichier déclarant connu'
}

$vars     = []
$query    = ''
$kind     = 'all'
$expanded = {}
$live     = false
$clients  = 0
$edits    = {}
$write    = false
$etats    = {}

versHex = (v) ->
  s := (v ?? '').trim()
  court := s.match(/^#([0-9A-Fa-f])([0-9A-Fa-f])([0-9A-Fa-f])$/)
  return '#' + court[1] + court[1] + court[2] + court[2] + court[3] + court[3] if court
  long := s.match(/^#([0-9A-Fa-f]{6})(?:[0-9A-Fa-f]{2})?$/)
  return '#' + long[1].toLowerCase() if long
  canaux := s.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/)
  return '' unless canaux
  '#' + [1, 2, 3].map((i) -> Math.min(255, +canaux[i]).toString(16).padStart(2, '0')).join('')

envoyer = (name, value) ->
  fetch('/__mjs/theme/edit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vars: { [name]: value } }) }).then((r) -> r.json()).then((d) -> $clients = d.clients).catch((err) -> µ.error(err))

cmp = (x, y) -> x < y ? -1 : x > y ? 1 : 0

ecrivable = (d) -> d.kind != 'framework'

cleSource = (d) -> [d.kind, d.declaredBy, d.file, d.variant ?? ''].join('::')

grouper = (vars) ->
  index := new Map()
  vars.forEach (themeVar) ->
    themeVar.declarations.forEach (d) ->
      cle := cleSource(d)
      groupe := index.get(cle) ?? { cle, kind: d.kind, declaredBy: d.declaredBy, file: d.file, variant: d.variant ?? '', lignes: [] }
      groupe.lignes.push({ cle: cle + '::' + themeVar.name, name: themeVar.name, decl: d, readBy: themeVar.readBy, autres: themeVar.declarations.filter((x) -> x != d) })
      index.set(cle, groupe)
  [...index.values()].sort((a, b) -> ((ORDRE_KIND[a.kind] ?? 9) - (ORDRE_KIND[b.kind] ?? 9)) or cmp(a.declaredBy, b.declaredBy) or cmp(a.variant, b.variant) or cmp(a.file, b.file))

retient = (ligne, q) -> not q or ligne.name.toLowerCase().includes(q) or ligne.decl.declaredBy.toLowerCase().includes(q) or ligne.readBy.some((r) -> r.toLowerCase().includes(q))

enregistrer = (ligne) ->
  return unless ecrivable(ligne.decl)
  corps := { name: ligne.name, value: $edits[ligne.name], file: ligne.decl.file, line: ligne.decl.line }
  fetch('/__mjs/theme/write', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corps) }).then((r) -> r.json()).then((res) -> $etats[ligne.cle] = { ok: res.written, texte: if res.written then 'écrit dans ' + res.file + ':' + res.line else (MOTIFS[res.reason] ?? res.reason) }).catch((err) -> µ.error(err))

modifier = (ligne, value) ->
  $edits[ligne.name] = value
  envoyer(ligne.name, value)
  enregistrer(ligne) if $write

retablir = (ligne) ->
  delete $edits[ligne.name]
  delete $etats[ligne.cle]
  envoyer(ligne.name, '')

retablirTout = ->
  Object.keys($edits).forEach((name) -> envoyer(name, ''))
  $edits = {}
  $etats = {}

refresh = ->
  fetch('/__mjs/theme.json').then((r) -> r.json()).then((data) -> $vars = Object.keys(data ?? {}).sort().map((name) -> ({ name, declarations: data[name].declarations, readBy: data[name].readBy }))).catch((err) -> µ.error(err))

etatDirect = ->
  fetch('/__mjs/theme/edit').then((r) -> r.json()).then((d) -> $live = d.live; $clients = d.clients).catch(-> $live = false)

toggle = (cle) ->
  $expanded[cle] = not $expanded[cle]

toggleKey = (e, cle) ->
  return unless e.key is 'Enter' or e.key is ' '
  e.preventDefault()
  toggle(cle)

$groupes = grouper($vars)
$filtres = $groupes.filter((g) -> $kind == 'all' or g.kind == $kind).map((g) -> ({ ...g, lignes: g.lignes.filter((l) -> retient(l, $query.trim().toLowerCase())) })).filter((g) -> g.lignes.length > 0)

$countRead = $vars.filter((themeVar) -> themeVar.readBy.length > 0).length
$countDecl = $vars.reduce((n, themeVar) -> n + themeVar.declarations.length, 0)

$nbEdits = Object.keys($edits).length

µmount ->
  refresh()
  etatDirect()
</script>

<div class="atelier">
  <div class="barre">
    <h1>Variables de thème</h1>
    <div class="stats">
      <span class="stat">{$groupes.length} source{if $groupes.length > 1}s{end}</span>
      <span class="stat">{$vars.length} variables</span>
      <span class="stat">{$countDecl} déclarations</span>
      <span class="stat">{$countRead} variables lues par au moins un composant</span>
    </div>
  </div>

  <div class="direct">
    {if $live}
      <span class="temoin"></span>
      <span class="etat">Aperçu en direct — {$clients} page{if $clients > 1}s{end} à l'écoute</span>
      <label class="bascule">
        <input type="checkbox" checked=!{$write}>
        <span>Enregistrer dans le source</span>
      </label>
      {if $write}
        <span class="precision ecrit">Chaque couleur choisie part dans la ligne exacte où sa source la déclare. « Rétablir » ne défait que l'aperçu : ce qui est écrit reste écrit.</span>
      {else}
        <span class="precision">Rien n'est écrit sur le disque : fermez l'onglet et tout revient.</span>
      {end}
    {else}
      <span class="temoin hors"></span>
      <span class="etat hors">Lecture seule — l'aperçu en direct demande « mjs dev ».</span>
    {end}
    {if $nbEdits > 0}
      <button class="retablir-tout" @click={retablirTout()}>Rétablir les {$nbEdits} couleurs modifiées</button>
    {end}
  </div>

  {if $vars.length == 0}
    <p class="vide">Ce projet ne déclare et ne lit aucune variable de thème ($$) pour l'instant — c'est le silence par défaut du compilateur, pas une panne.</p>
  {else}
    <div class="controles">
      <input class="recherche" type="text" aria-label="Rechercher une variable de thème" placeholder="Rechercher une variable, un déclarant, un lecteur…" value=!{$query}>
      <div class="filtres">
        <button @class{$kind == 'all'}="actif" @click={$kind = 'all'}>Tous</button>
        <button @class{$kind == 'theme'}="actif" @click={$kind = 'theme'}>Thèmes</button>
        <button @class{$kind == 'module'}="actif" @click={$kind = 'module'}>Modules</button>
        <button @class{$kind == 'stylesheet'}="actif" @click={$kind = 'stylesheet'}>Feuilles partagées</button>
        <button @class{$kind == 'framework'}="actif" @click={$kind = 'framework'}>Framework</button>
      </div>
    </div>

    {if $filtres.length == 0}
      <p class="vide">Aucune variable ne correspond à la recherche.</p>
    {else}
      <div class="groupes">
        {for g in $filtres by cle}
          <section class="groupe">
            <header class="tete">
              <span class="badge badge-{g.kind}">{formatKind(g.kind)}</span>
              <span class="source">{g.declaredBy}</span>
              {if g.variant}<span class="variante">variante {g.variant}</span>{end}
              <span class="emplacement">{g.file}</span>
              {if not ecrivable(g.lignes[0].decl)}<span class="lecture-seule">lecture seule</span>{end}
              <span class="compte">{g.lignes.length} variable{if g.lignes.length > 1}s{end}</span>
            </header>
            <div class="liste">
              {for l in g.lignes by cle}
                <div class="variable" role="button" tabindex="0" @click={toggle(l.cle)} @keydown={toggleKey(e, l.cle)}>
                  {const courante = $edits[l.name] ?? l.decl.value}
                  {const hex = $live ? versHex(courante) : ''}
                  <div class="ligne">
                    {if hex}
                      <input class="pastille vive" type="color" aria-label="Couleur de {l.name}" value={hex} @click.stop={} @input.stop={modifier(l, e.target.value)}>
                    {else}
                      {if looksLikeColor(courante)}<span class="pastille" @style.background={courante}></span>{end}
                    {end}
                    <span class="nom">{l.name}</span>
                    <span class="valeur">{courante}</span>
                    {if $edits[l.name]}
                      <span class="valeur source-valeur">source {l.decl.value}</span>
                      <button class="retablir" aria-label="Rétablir {l.name}" @click.stop={retablir(l)}>rétablir</button>
                    {end}
                    {if $etats[l.cle]}
                      <span class="ecriture" @class{$etats[l.cle].ok == false}="rate">{$etats[l.cle].texte}</span>
                    {end}
                    <span class="emplacement">ligne {l.decl.line}</span>
                    {if l.autres.length > 0}
                      <span class="ailleurs">+{l.autres.length} ailleurs</span>
                    {end}
                    <span class="lecteurs">{l.readBy.length} lecteur{if l.readBy.length > 1}s{end}</span>
                  </div>
                  {if $expanded[l.cle]}
                    <div class="detail">
                      {if l.decl.doc}<p class="doc">{l.decl.doc}</p>{end}
                      {if $write}
                        {if ecrivable(l.decl)}
                          <p class="cible">Enregistrement vers {l.decl.file}:{l.decl.line}</p>
                        {else}
                          <p class="cible">Aucune écriture possible : cette déclaration appartient au framework.</p>
                        {end}
                      {end}
                      {if l.autres.length > 0}
                        <p class="cascade">Ce nom est aussi déclaré ailleurs — la cascade s'applique, le plus proche gagne, et l'aperçu en direct les repeint toutes ensemble. L'enregistrement, lui, ne touche que la ligne ci-dessus.</p>
                        <div class="declarations">
                          {for d in l.autres}
                            <div class="declaration">
                              <span class="badge badge-{d.kind}">{formatKind(d.kind)}</span>
                              <span class="declarant">{d.declaredBy}</span>
                              {if d.variant}<span class="variante">variante {d.variant}</span>{end}
                              <span class="valeur">{d.value}</span>
                              <span class="emplacement">{d.file}:{d.line}</span>
                            </div>
                          {end}
                        </div>
                      {end}
                      {if l.readBy.length == 0}
                        <p class="sans-lecteur">Aucun lecteur — déclaré mais jamais consommé.</p>
                      {else}
                        <div class="lecteurs-liste">
                          <span class="titre-lecteurs">Lu par</span>
                          {for r in l.readBy}
                            <span class="lecteur">{r}</span>
                          {end}
                        </div>
                      {end}
                    </div>
                  {end}
                </div>
              {end}
            </div>
          </section>
        {end}
      </div>
    {end}
  {end}
</div>

<style>
  .atelier
    display: block
    background: #14171f
    color: #e4e6ec
    font: 14px/1.5 system-ui, sans-serif
    min-height: 100vh
    padding: 1.5rem
    box-sizing: border-box
  .barre
    display: flex
    flex-wrap: wrap
    align-items: center
    gap: 1rem
    margin-bottom: 1.25rem
  h1
    font-size: 1.1rem
    margin: 0
    margin-right: auto
    color: #f4f4f5
  .stats
    display: flex
    gap: 1rem
    color: #8a8f9c
    font-size: 0.85rem
  .vide
    color: #8a8f9c
  .controles
    display: flex
    flex-wrap: wrap
    align-items: center
    gap: 0.75rem
    margin-bottom: 1.25rem
  .recherche
    flex: 1
    min-width: 240px
    background: #1b1f29
    color: #e4e6ec
    border: 1px solid #363c4c
    border-radius: 6px
    padding: 0.45rem 0.7rem
    font: inherit
    &:focus
      outline: none
      border-color: #3a6df0
  .filtres
    display: flex
    flex-wrap: wrap
    gap: 0.4rem
  button
    background: #232733
    color: #e4e6ec
    border: 1px solid #363c4c
    border-radius: 6px
    padding: 0.4rem 0.8rem
    cursor: pointer
    font: inherit
    &:hover
      background: #2c3140
  button.actif
    background: #3a6df0
    border-color: #3a6df0
    color: #fff
  .groupes
    display: flex
    flex-direction: column
    gap: 0.9rem
  .groupe
    background: #171b24
    border: 1px solid #2a2f3c
    border-radius: 8px
    overflow: hidden
  .tete
    display: flex
    flex-wrap: wrap
    align-items: center
    gap: 0.6rem
    padding: 0.55rem 0.8rem
    background: #1f2430
    border-bottom: 1px solid #2a2f3c
  .source
    font-family: ui-monospace, monospace
    font-weight: 600
    color: #f4f4f5
  .compte
    margin-left: auto
    color: #6b7280
    font-size: 0.75rem
    white-space: nowrap
  .lecture-seule
    color: #c07a2a
    font-size: 0.75rem
  .liste
    display: flex
    flex-direction: column
    gap: 0.3rem
    padding: 0.5rem
  .variable
    background: #1b1f29
    border: 1px solid #2a2f3c
    border-radius: 6px
    padding: 0.5rem 0.7rem
    cursor: pointer
    &:hover
      border-color: #3a6df0
  .ligne
    display: flex
    align-items: center
    gap: 0.6rem
  .pastille
    display: inline-block
    width: 12px
    height: 12px
    border-radius: 50%
    border: 1px solid rgba(255, 255, 255, 0.3)
    flex-shrink: 0
  input.pastille.vive
    width: 18px
    height: 18px
    padding: 0
    cursor: pointer
    background: none
    &::-webkit-color-swatch-wrapper
      padding: 0
    &::-webkit-color-swatch
      border: none
      border-radius: 50%
    &::-moz-color-swatch
      border: none
      border-radius: 50%
  .direct
    display: flex
    flex-wrap: wrap
    align-items: center
    gap: 0.6rem
    margin-bottom: 1.25rem
    padding: 0.5rem 0.8rem
    background: #1b1f29
    border: 1px solid #2a2f3c
    border-radius: 8px
  .temoin
    width: 8px
    height: 8px
    border-radius: 50%
    background: #3fb950
    flex-shrink: 0
  .temoin.hors
    background: #6b7280
  .etat
    color: #e4e6ec
    font-size: 0.85rem
  .etat.hors
    color: #8a8f9c
  .precision
    color: #6b7280
    font-size: 0.8rem
  .precision.ecrit
    color: #d8b34a
  .bascule
    display: inline-flex
    align-items: center
    gap: 0.35rem
    color: #e4e6ec
    font-size: 0.8rem
    cursor: pointer
    user-select: none
  .bascule input
    accent-color: #3fb950
    cursor: pointer
  .retablir-tout
    margin-left: auto
    font-size: 0.8rem
    padding: 0.3rem 0.6rem
  .retablir
    font-size: 0.7rem
    padding: 0.05rem 0.4rem
    border-radius: 4px
    flex-shrink: 0
  .ecriture
    color: #3fb950
    font-size: 0.75rem
    font-family: ui-monospace, monospace
  .ecriture.rate
    color: #e5714d
  .nom
    font-family: ui-monospace, monospace
    font-weight: 600
  .valeur
    color: #a9afbc
    font-family: ui-monospace, monospace
    font-size: 0.85rem
    overflow: hidden
    text-overflow: ellipsis
    white-space: nowrap
  .source-valeur
    color: #6b7280
    font-size: 0.75rem
  .badge
    font-size: 0.7rem
    text-transform: uppercase
    letter-spacing: 0.04em
    padding: 0.1rem 0.45rem
    border-radius: 4px
    background: #363c4c
    flex-shrink: 0
  .badge-module
    background: #3a6df0
  .badge-theme
    background: #8a5ff0
  .badge-framework
    background: #c07a2a
  .badge-stylesheet
    background: #2a6f5f
  .declarant
    color: #8a8f9c
    font-size: 0.8rem
  .ailleurs
    color: #d8b34a
    font-size: 0.75rem
    white-space: nowrap
  .lecteurs
    margin-left: auto
    color: #6b7280
    font-size: 0.75rem
    white-space: nowrap
  .detail
    margin-top: 0.6rem
    padding-top: 0.6rem
    border-top: 1px solid #2a2f3c
  .cascade
    margin: 0 0 0.5rem
    color: #d8b34a
    font-size: 0.8rem
  .cible
    margin: 0 0 0.5rem
    color: #8a8f9c
    font-size: 0.8rem
    font-family: ui-monospace, monospace
  .declarations
    display: flex
    flex-direction: column
    gap: 0.4rem
  .declaration
    display: flex
    flex-wrap: wrap
    align-items: baseline
    gap: 0.5rem
    padding: 0.4rem 0.5rem
    background: #0d0f14
    border-radius: 6px
  .variante
    color: #6b7280
    font-size: 0.75rem
    font-style: italic
  .emplacement
    color: #6b7280
    font-size: 0.75rem
    font-family: ui-monospace, monospace
  .doc
    margin: 0 0 0.5rem
    color: #8a8f9c
    font-size: 0.8rem
  .sans-lecteur
    margin: 0.5rem 0 0
    color: #6b7280
    font-size: 0.8rem
  .lecteurs-liste
    display: flex
    flex-wrap: wrap
    align-items: center
    gap: 0.4rem
    margin-top: 0.5rem
  .titre-lecteurs
    color: #6b7280
    font-size: 0.75rem
  .lecteur
    background: #232733
    border-radius: 4px
    padding: 0.1rem 0.5rem
    font-size: 0.8rem
    font-family: ui-monospace, monospace
</style>
