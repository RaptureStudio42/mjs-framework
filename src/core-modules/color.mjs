<script>
  $value    = ''
  $editable = false
  $compact  = false
  $label    = 'Couleur'
  $before   = false                                  # pastille AVANT le code (defaut : apres)

  boolAttr = (v)-> v !== undefined and v !== false

  $swatchLabel  = if boolAttr($compact) then $value else undefined
  $swatchRole   = if boolAttr($compact) then 'img' else undefined
  $swatchHidden = not boolAttr($compact)

  $hex = null

  resolveHex = (v)->
    return null unless v
    return null unless document?.body
    probe = document.createElement('span')
    document.body.appendChild(probe)
    hex = null
    try
      probe.style.backgroundColor = v
      computed = getComputedStyle(probe).backgroundColor
      match = computed?.match(/^rgba?\((\d+), ?(\d+), ?(\d+)(?:, ?([\d.]+))?\)$/)
      if match and not (match[4] !== undefined and Number(match[4]) === 0)
        toHex = (n)-> Number(n).toString(16).padStart(2, '0')
        hex = '#' + toHex(match[1]) + toHex(match[2]) + toHex(match[3])
    finally
      probe.remove()
    hex

  µeffect ->
    $hex = if boolAttr($editable) then resolveHex($value) else null

  @onChange = (e)->
    $value = e.target.value                            # alimente la liaison two-way, comme checkbox/switch/select
    µemit 'change', e.target.value

  µmount ->
    µ.error('[mjs-color] l\'attribut « value » est requis.') unless $value
</script>

{if boolAttr($editable) and $hex}
  <input type="color" class="picker" part="picker" @class{boolAttr($before)}="before" aria-label={$label} value={$hex} @change={@onChange(e)}>
{else}
  <span class="swatch" part="swatch" @class{boolAttr($before)}="before" --mjs-color-value={$value} title={$swatchLabel} role={$swatchRole} aria-label={$swatchLabel} aria-hidden={$swatchHidden}></span>
{end}
{if not boolAttr($compact)}
  <span class="code" part="code">{$value}</span>
{end}

<style>
  :host
    display: inline-flex
    align-items: center
    gap: 8px
    // hauteur du texte (JAMAIS de // en fin de ligne sur une custom property : SASS le garde dans la valeur)
    --mjs-color-size: 1em
    --mjs-color-radius: 4px
    --mjs-color-border: var(--mjs-border, #888)
    // hauteur de ligne du code, partagee avec l'etai (JAMAIS de // en fin de ligne sur une custom property)
    --mjs-color-line: calc(.9rem * 1.4)

  // etai invisible : reserve TOUJOURS la hauteur de ligne du code, meme en compact ou il n'y a plus de texte -- sans lui la boite se reduit a la pastille et remonte de 3 px par rapport a ses voisines
  :host::before
    content: ''
    width: 0
    height: var(--mjs-color-line)

  .swatch, .picker
    display: inline-block
    box-sizing: border-box
    order: 1                                         // apres le code par defaut
    width: var(--mjs-color-size)
    height: var(--mjs-color-size)
    flex: none
    border: 1px solid var(--mjs-color-border)
    border-radius: var(--mjs-color-radius)

    &.before
      order: -1                                      // opt-in : pastille avant le code

  .swatch
    background: var(--mjs-color-value)

  .picker
    font: inherit                                    // Firefox donne sa propre police aux controles : sans ca, le 1em de la case vaut 13.3px au lieu de 16
    padding: 0
    cursor: pointer
    background: none
    appearance: none                                 // sinon Firefox et Chrome dessinent leur propre pave, plus petit que la case

    &::-webkit-color-swatch-wrapper
      padding: 0

    &::-webkit-color-swatch
      border: none
      border-radius: calc(var(--mjs-color-radius) - 1px)

    &::-moz-color-swatch
      border: none
      border-radius: calc(var(--mjs-color-radius) - 1px)

  .code
    font-size: .9rem
    font-family: monospace
    line-height: var(--mjs-color-line)
</style>
