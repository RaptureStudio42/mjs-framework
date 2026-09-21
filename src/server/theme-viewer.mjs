<script>
KIND_LABELS := { module: 'module', theme: 'thème', framework: 'framework', stylesheet: 'feuille partagée' }

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

$vars = []
$query = ''
$kind = 'all'
$expanded = {}
$live = false
$clients = 0
$edits = {}
$write = false
$etats = {}

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

cibleEcriture = (themeVar) ->
  themeVar.declarations.find((d) -> d.kind != 'framework') ?? themeVar.declarations[0]

enregistrer = (themeVar) ->
  d := cibleEcriture(themeVar)
  return unless d
  corps := { name: themeVar.name, value: $edits[themeVar.name], file: d.file, line: d.line }
  fetch('/__mjs/theme/write', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corps) }).then((r) -> r.json()).then((res) -> $etats[themeVar.name] = { ok: res.written, texte: if res.written then 'écrit dans ' + res.file + ':' + res.line else (MOTIFS[res.reason] ?? res.reason) }).catch((err) -> µ.error(err))

modifier = (themeVar, value) ->
  $edits[themeVar.name] = value
  envoyer(themeVar.name, value)
  enregistrer(themeVar) if $write

retablir = (name) ->
  delete $edits[name]
  delete $etats[name]
  envoyer(name, '')

retablirTout = ->
  for name of $edits
    envoyer(name, '')
  $edits = {}
  $etats = {}

refresh = ->
  fetch('/__mjs/theme.json').then((r) -> r.json()).then((data) -> $vars = Object.keys(data ?? {}).sort().map((name) -> ({ name, declarations: data[name].declarations, readBy: data[name].readBy }))).catch((err) -> µ.error(err))

etatDirect = ->
  fetch('/__mjs/theme/edit').then((r) -> r.json()).then((d) -> $live = d.live; $clients = d.clients).catch(-> $live = false)

toggle = (name) ->
  $expanded[name] = not $expanded[name]

toggleKey = (e, name) ->
  return unless e.key is 'Enter' or e.key is ' '
  e.preventDefault()
  toggle(name)

$filtered = $vars.filter (themeVar) -> ($kind == 'all' or themeVar.declarations.some((d) -> d.kind == $kind)) and (not $query or themeVar.name.toLowerCase().includes($query.toLowerCase()) or themeVar.declarations.some((d) -> d.declaredBy.toLowerCase().includes($query.toLowerCase())) or themeVar.readBy.some((r) -> r.toLowerCase().includes($query.toLowerCase())))

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
        <span class="precision ecrit">Chaque couleur choisie part dans le fichier qui la déclare. « Rétablir » ne défait que l'aperçu : ce qui est écrit reste écrit.</span>
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
        <button @class{$kind == 'module'}="actif" @click={$kind = 'module'}>Module</button>
        <button @class{$kind == 'theme'}="actif" @click={$kind = 'theme'}>Thème</button>
        <button @class{$kind == 'framework'}="actif" @click={$kind = 'framework'}>Framework</button>
        <button @class{$kind == 'stylesheet'}="actif" @click={$kind = 'stylesheet'}>Feuille partagée</button>
      </div>
    </div>

    {if $filtered.length == 0}
      <p class="vide">Aucune variable ne correspond à la recherche.</p>
    {else}
      <div class="liste">
        {for themeVar in $filtered by name}
          {const first = themeVar.declarations[0]}
          <div class="variable" role="button" tabindex="0" @click={toggle(themeVar.name)} @keydown={toggleKey(e, themeVar.name)}>
            {const courante = $edits[themeVar.name] ?? first.value}
            {const hex = $live ? versHex(courante) : ''}
            <div class="ligne">
              {if hex}
                <input class="pastille vive" type="color" aria-label="Couleur de {themeVar.name}" value={hex} @click.stop={} @input.stop={modifier(themeVar, e.target.value)}>
              {else}
                {if looksLikeColor(courante)}<span class="pastille" @style.background={courante}></span>{end}
              {end}
              <span class="nom">{themeVar.name}</span>
              <span class="valeur">{courante}</span>
              {if $edits[themeVar.name]}
                <button class="retablir" aria-label="Rétablir {themeVar.name}" @click.stop={retablir(themeVar.name)}>rétablir</button>
              {end}
              {if $etats[themeVar.name]}
                <span class="ecriture" @class{$etats[themeVar.name].ok == false}="rate">{$etats[themeVar.name].texte}</span>
              {end}
              <span class="badge badge-{first.kind}">{formatKind(first.kind)}</span>
              <span class="declarant">{first.declaredBy}</span>
              <span class="lecteurs">{themeVar.readBy.length} lecteur{if themeVar.readBy.length > 1}s{end}</span>
            </div>
            {if $expanded[themeVar.name]}
              <div class="detail">
                {if themeVar.declarations.length > 1}
                  <p class="cascade">{themeVar.declarations.length} déclarations — la cascade s'applique, le plus proche gagne.</p>
                {end}
                {if $write}
                  {const c = cibleEcriture(themeVar)}
                  <p class="cible">Enregistrement vers {c.file}:{c.line}</p>
                {end}
                <div class="declarations">
                  {for d in themeVar.declarations}
                    <div class="declaration">
                      <span class="badge badge-{d.kind}">{formatKind(d.kind)}</span>
                      <span class="declarant">{d.declaredBy}</span>
                      {if d.variant}<span class="variante">variante {d.variant}</span>{end}
                      <span class="valeur">{d.value}</span>
                      <span class="emplacement">{d.file}:{d.line}</span>
                      {if d.doc}<p class="doc">{d.doc}</p>{end}
                    </div>
                  {end}
                </div>
                {if themeVar.readBy.length == 0}
                  <p class="sans-lecteur">Aucun lecteur — déclaré mais jamais consommé.</p>
                {else}
                  <div class="lecteurs-liste">
                    <span class="titre-lecteurs">Lu par</span>
                    {for r in themeVar.readBy}
                      <span class="lecteur">{r}</span>
                    {end}
                  </div>
                {end}
              </div>
            {end}
          </div>
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
  .liste
    display: flex
    flex-direction: column
    gap: 0.4rem
  .variable
    background: #1b1f29
    border: 1px solid #2a2f3c
    border-radius: 8px
    padding: 0.6rem 0.8rem
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
    flex-basis: 100%
    margin: 0.2rem 0 0
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
