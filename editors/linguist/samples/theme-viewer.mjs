<script>
KIND_LABELS := { module: 'module', theme: 'thème', framework: 'framework', stylesheet: 'feuille partagée' }

formatKind = (k) -> KIND_LABELS[k] ?? k

COLOR_RE := new RegExp('^#|^rgb\\(|^hsl\\(|^oklch\\(|^color\\(', 'i')

looksLikeColor = (v) -> COLOR_RE.test(v)

$vars = []
$query = ''
$kind = 'all'
$expanded = {}

refresh = ->
  fetch('/__mjs/theme.json').then((r) -> r.json()).then((data) -> $vars = Object.keys(data ?? {}).sort().map((name) -> ({ name, declarations: data[name].declarations, readBy: data[name].readBy }))).catch((err) -> µ.error(err))

toggle = (name) ->
  $expanded[name] = not $expanded[name]

toggleKey = (e, name) ->
  return unless e.key is 'Enter' or e.key is ' '
  e.preventDefault()
  toggle(name)

$filtered = $vars.filter (themeVar) -> ($kind == 'all' or themeVar.declarations.some((d) -> d.kind == $kind)) and (not $query or themeVar.name.toLowerCase().includes($query.toLowerCase()) or themeVar.declarations.some((d) -> d.declaredBy.toLowerCase().includes($query.toLowerCase())) or themeVar.readBy.some((r) -> r.toLowerCase().includes($query.toLowerCase())))

$countRead = $vars.filter((themeVar) -> themeVar.readBy.length > 0).length
$countDecl = $vars.reduce((n, themeVar) -> n + themeVar.declarations.length, 0)

µmount ->
  refresh()
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
            <div class="ligne">
              {if looksLikeColor(first.value)}<span class="pastille" @style.background={first.value}></span>{end}
              <span class="nom">{themeVar.name}</span>
              <span class="valeur">{first.value}</span>
              <span class="badge badge-{first.kind}">{formatKind(first.kind)}</span>
              <span class="declarant">{first.declaredBy}</span>
              <span class="lecteurs">{themeVar.readBy.length} lecteur{if themeVar.readBy.length > 1}s{end}</span>
            </div>
            {if $expanded[themeVar.name]}
              <div class="detail">
                {if themeVar.declarations.length > 1}
                  <p class="cascade">{themeVar.declarations.length} déclarations — la cascade s'applique, le plus proche gagne.</p>
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
