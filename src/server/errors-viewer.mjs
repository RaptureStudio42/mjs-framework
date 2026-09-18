<script>
token := new URLSearchParams(location.search).get('token') ?? ''

withToken = (u) ->
  return u unless token
  sep = u.includes('?') ? '&' : '?'
  u + sep + 'token=' + encodeURIComponent(token)

formatDate = (ms) ->
  return '' unless ms
  new Date(ms).toLocaleString()

$entries = []
$filter = 'all'
$expanded = {}

refresh = ->
  fetch(withToken('/__mjs/errors.json')).then((r) -> r.json()).then((data) -> $entries = data ?? []).catch((err) -> µ.error(err))

toggle = (sig) ->
  $expanded[sig] = not $expanded[sig]

toggleKey = (e, sig) ->
  return unless e.key is 'Enter' or e.key is ' '
  e.preventDefault()
  toggle(sig)

doPurge = (source) ->
  label = source ? ('les entrées ' + source) : 'TOUTES les entrées'
  return unless window.confirm('Purger ' + label + ' du journal ?')
  qs = source ? ('?source=' + source) : ''
  fetch(withToken('/__mjs/errors' + qs), { method: 'DELETE' }).then((-> refresh())).catch((err) -> µ.error(err))

$filtered = $entries.filter (e) -> $filter == 'all' or e.source == $filter

µmount ->
  refresh()
</script>

<div class="panneau">
  <div class="barre">
    <h1>Journal d'erreurs</h1>
    <div class="filtres">
      <button @class{$filter == 'all'}="actif" @click={$filter = 'all'}>Tous</button>
      <button @class{$filter == 'server'}="actif" @click={$filter = 'server'}>Serveur</button>
      <button @class{$filter == 'client'}="actif" @click={$filter = 'client'}>Client</button>
    </div>
    <div class="actions">
      <button @click={refresh()}>Rafraîchir</button>
      <button class="danger" @click={doPurge('server')}>Purger serveur</button>
      <button class="danger" @click={doPurge('client')}>Purger client</button>
      <button class="danger" @click={doPurge(null)}>Purger tout</button>
    </div>
  </div>

  {if $filtered.length == 0}
    <p class="vide">Aucune erreur — tout va bien.</p>
  {else}
    <div class="liste">
      {for ent in $filtered by signature}
        <div class="entree" role="button" tabindex="0" @click={toggle(ent.signature)} @keydown={toggleKey(e, ent.signature)}>
          <div class="ligne">
            <span class="badge badge-{ent.source}">{ent.source}</span>
            <span class="compteur">×{ent.n}</span>
            <span class="message">{ent.message}</span>
            {if ent.version}<span class="version">{ent.version}</span>{end}
          </div>
          <div class="dates">premier {formatDate(ent.premier)} — dernier {formatDate(ent.dernier)}{if ent.url} — {ent.url}{end}</div>
          {if $expanded[ent.signature]}
            <pre class="pile">{ent.pile}</pre>
          {end}
        </div>
      {end}
    </div>
  {end}
</div>

<style>
  .panneau
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
  .filtres
    display: flex
    gap: 0.4rem
  .actions
    display: flex
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
  button.danger
    color: #ff8a8a
    &:hover
      background: #3a1f24
  .vide
    color: #8a8f9c
  .liste
    display: flex
    flex-direction: column
    gap: 0.4rem
  .entree
    background: #1b1f29
    border: 1px solid #2a2f3c
    border-radius: 8px
    padding: 0.6rem 0.8rem
    cursor: pointer
    &:hover
      border-color: #3a6df0
  .ligne
    display: flex
    align-items: baseline
    gap: 0.6rem
  .badge
    font-size: 0.7rem
    text-transform: uppercase
    letter-spacing: 0.04em
    padding: 0.1rem 0.45rem
    border-radius: 4px
    background: #363c4c
  .badge-server
    background: #5a3a8a
  .badge-client
    background: #2a6f5f
  .compteur
    color: #8a8f9c
    font-variant-numeric: tabular-nums
  .message
    flex: 1
    overflow: hidden
    text-overflow: ellipsis
    white-space: nowrap
  .version
    color: #6b7280
    font-size: 0.75rem
  .dates
    margin-top: 0.25rem
    color: #6b7280
    font-size: 0.75rem
    overflow: hidden
    text-overflow: ellipsis
    white-space: nowrap
  .pile
    margin-top: 0.5rem
    padding: 0.5rem
    background: #0d0f14
    border-radius: 6px
    overflow-x: auto
    font: 12px/1.4 ui-monospace, monospace
    white-space: pre-wrap
    word-break: break-all
</style>
