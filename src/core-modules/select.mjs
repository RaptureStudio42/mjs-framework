<script module>
  nextId = 0
</script>

<script>
  $value = null
  $open  = false

  $placeholder       = 'Choisir…'
  $searchPlaceholder = 'Rechercher…'
  $emptyLabel        = 'Aucun résultat'
  $match             = 'contains'

  $iconChecked   = '✔'
  $iconUnchecked = ''

  $optionsData = []
  $query       = ''
  $activeIndex = -1
  $panelUp     = false
  $panelMax    = '280px'

  uid     = "mjs-select-#{nextId++}"
  panelId = "#{uid}-panel"

  optionId = (i)-> "#{uid}-opt-#{i}"

  wrapperRef     = null
  buttonRef      = null
  searchInputRef = null
  slotRef        = null

  multiOf    = (multiple)-> multiple !== undefined and multiple !== false
  searchOnOf = (search)-> search !== undefined and search !== false
  normalize  = (s)-> (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

  # sous-suite : chaque lettre de q, dans l'ordre, avec des trous permis
  subsequence = (label, q)->
    j = 0
    for ch in label
      j++ if j < q.length and ch == q[j]
    j == q.length

  matchers = {
    contains:       (label, q)-> label.includes(q)
    starts:         (label, q)-> label.startsWith(q)
    fuzzy:          (label, q)-> subsequence(label, q)
    'starts-fuzzy': (label, q)-> label[0] == q[0] and subsequence(label.slice(1), q.slice(1))
  }

  filterFn = (query, search, match, options)->
    return options unless searchOnOf(search)
    q = normalize(query.trim())
    return options unless q
    test = matchers[match] or matchers.contains
    options.filter (o)-> test(normalize(o.label), q)

  isSelected = (v, value, multiple)->
    if multiOf(multiple) then Array.isArray(value) and value.includes(v) else value == v

  selectedOf = (value, multiple, options)->
    options.filter (o)-> isSelected(o.value, value, multiple)

  labelFn = (value, multiple, options, placeholder)->
    sel = selectedOf(value, multiple, options)
    if sel.length then sel.map((o)-> o.label).join(', ') else placeholder

  iconFn = (value, multiple, options)->
    return null if multiOf(multiple)
    sel = selectedOf(value, multiple, options)
    if sel.length then sel[0].icon else null

  activeDescendantFn = (open, activeIndex, query, search, match, options)->
    return undefined unless open
    opt = filterFn(query, search, match, options)[activeIndex]
    return undefined unless opt
    optionId(activeIndex)

  $searchOn         = searchOnOf($search)
  $multi            = multiOf($multiple)
  $filtered         = filterFn($query, $search, $match, $optionsData)
  $currentLabel     = labelFn($value, $multiple, $optionsData, $placeholder)
  $currentIcon      = iconFn($value, $multiple, $optionsData)
  $activeDescendant = activeDescendantFn($open, $activeIndex, $query, $search, $match, $optionsData)

  refreshOptions = ->
    return unless slotRef
    # assignedElements() ne rend que les enfants DIRECTS du slot : un wrapper intermédiaire est
    # lui-même slotté, pas les <mjs-option> qu'il contient → on descend dedans au besoin
    els = slotRef.assignedElements().flatMap (el)-> if el.tagName.toLowerCase() == 'mjs-option' then [el] else Array.from(el.querySelectorAll('mjs-option'))
    $optionsData = els.map (el)-> { value: el.getAttribute('value'), icon: el.getAttribute('icon'), label: (el.textContent or '').trim() }

  updatePlacement = ->
    return unless buttonRef
    rect      = buttonRef.getBoundingClientRect()
    vh        = window.innerHeight
    below     = vh - rect.bottom
    above     = Math.min(rect.top, vh)
    $panelUp  = below < 280 and above > below
    available = if $panelUp then above else below
    $panelMax = "#{Math.round(Math.max(Math.min(available - 12, 280), 0))}px"

  openPanel = ->
    return if $open
    $query = ''
    idx = $optionsData.findIndex (o)-> o.value == $value
    $activeIndex = if idx >= 0 then idx else 0
    $open = true
    updatePlacement()

  closePanel = ->
    $open        = false
    $activeIndex = -1

  toggleValue = (v)->
    if $multi
      arr = if Array.isArray($value) then Array.from($value) else []
      idx = arr.indexOf(v)
      if idx == -1 then arr.push(v) else arr.splice(idx, 1)
      $value = arr
    else
      $value = v
      closePanel()
      buttonRef?.focus()

  onButtonClick = ->
    if $open then closePanel() else openPanel()

  onSearchInput = ->
    $activeIndex = (if filterFn($query, $search, $match, $optionsData).length then 0 else -1)

  onKeydown = (e)->
    unless $open
      if e.key == 'ArrowDown' or e.key == 'Enter' or e.key == ' '
        e.preventDefault()
        openPanel()
      return
    if e.key == 'ArrowDown'
      e.preventDefault()
      $activeIndex = Math.min($activeIndex + 1, $filtered.length - 1)
    else if e.key == 'ArrowUp'
      e.preventDefault()
      $activeIndex = Math.max($activeIndex - 1, 0)
    else if e.key == 'Home'
      e.preventDefault()
      $activeIndex = 0
    else if e.key == 'End'
      e.preventDefault()
      $activeIndex = $filtered.length - 1
    else if e.key == 'Enter'
      e.preventDefault()
      opt = $filtered[$activeIndex]
      toggleValue(opt.value) if opt
    else if e.key == 'Escape'
      e.preventDefault()
      closePanel()
      buttonRef?.focus()

  onWrapperClick = (e)->
    e._mjs_mjsSelectWrappers = e._mjs_mjsSelectWrappers or new Set()
    e._mjs_mjsSelectWrappers.add(wrapperRef)

  onDocumentClick = (e)->
    return unless $open
    return if e._mjs_mjsSelectWrappers?.has(wrapperRef)
    closePanel()

  µeffect ->
    if $open and searchOnOf($search)
      queueMicrotask -> searchInputRef?.focus()

  µeffect =>
    for node in Array.from(@querySelectorAll(':scope > input[type="hidden"]'))
      node.remove()
    return unless $name
    values = if multiOf($multiple) then (if Array.isArray($value) then $value else []) else (if $value? then [$value] else [])
    for v in values
      input = document.createElement('input')
      input.type  = 'hidden'
      input.name  = $name
      input.value = String(v)
      @appendChild(input)

  µmount ->
    refreshOptions()
    queueMicrotask refreshOptions
    slotRef.addEventListener('slotchange', refreshOptions)
    wrapperRef.addEventListener('click', onWrapperClick)
</script>

<div class="select" @this=!{wrapperRef} @keydown={onKeydown(e)}>
  <span class="select-sizer" aria-hidden="true"><span>{$placeholder}</span>{for opt in $optionsData}<span>{if $multi}<i class="select-check"></i>{end}{if opt.icon}<i class="select-icon">{opt.icon}</i>{end}{opt.label}</span>{end}</span>
  <button type="button" part="button" class="select-btn" @this=!{buttonRef} role="combobox" aria-haspopup="listbox" aria-expanded={$open} aria-controls={panelId} aria-activedescendant={$activeDescendant} @click={onButtonClick()}>
    {if $currentIcon}<span class="select-icon">{$currentIcon}</span>{end}
    <span class="select-label">{$currentLabel}</span>
  </button>
  {if $open}
    <div class="select-panel" part="panel" id={panelId} role="listbox" aria-multiselectable={$multi} @class{$panelUp}="up" --mjs-select-panel-max={$panelMax}>
      {if $searchOn}
        <input type="text" part="search" class="select-search" aria-label={$searchPlaceholder} placeholder={$searchPlaceholder} value=!{$query} @this=!{searchInputRef} @input={onSearchInput()}>
      {end}
      {if $filtered.length == 0}
        <div class="select-empty">{$emptyLabel}</div>
      {else}
        {for i, opt in $filtered by value}
          <div class="select-option" part="option" role="option" id={optionId(i)} @class{i == $activeIndex}="active" @class{isSelected(opt.value, $value, $multiple)}="selected" aria-selected={isSelected(opt.value, $value, $multiple)} @click={toggleValue(opt.value)} @mouseenter={$activeIndex = i}>
            {if $multi}<span class="select-check">{if isSelected(opt.value, $value, $multiple)}{$iconChecked}{else}{$iconUnchecked}{end}</span>{end}
            {if opt.icon}<span class="select-icon">{opt.icon}</span>{end}
            <span class="select-option-label">{opt.label}</span>
          </div>
        {end}
      {end}
    </div>
  {end}
</div>

<@document @click={onDocumentClick(e)}>
<@window @resize={updatePlacement() if $open}>

<slot @this=!{slotRef}></slot>

<style @display="inline-block">
  :host
    position: relative
    min-width: 0
    font: inherit

  .select
    position: relative
    display: inline-block
    width: 100%

  .select-btn
    display: flex
    align-items: center
    gap: 8px
    width: 100%
    box-sizing: border-box
    padding: 8px 12px
    background: var(--mjs-select-bg, var(--mjs-surface, #fff))
    color: var(--mjs-select-fg, var(--mjs-fg, #222))
    border: 1px solid var(--mjs-select-border, var(--mjs-border, #d0d0d0))
    border-radius: var(--mjs-select-radius, 6px)
    font: inherit
    text-align: left
    cursor: pointer

    &:hover
      background: var(--mjs-select-hover, var(--mjs-hover, #f2f2f2))

  .select-label
    flex: 1
    overflow: hidden
    white-space: nowrap
    text-overflow: ellipsis

  .select-sizer
    display: grid
    height: 0
    max-width: var(--mjs-select-max, 22rem)
    overflow: hidden
    visibility: hidden
    pointer-events: none
    padding: 0 12px
    border-inline: 1px solid transparent

    > span
      display: flex
      gap: 8px
      grid-area: 1 / 1
      white-space: nowrap

  .select-icon
    flex: none

  .select-panel
    position: absolute
    top: calc(100% + 4px)
    left: 0
    z-index: 20
    width: 100%
    max-height: var(--mjs-select-panel-max, 280px)
    overflow-y: auto
    box-sizing: border-box
    background: var(--mjs-select-panel-bg, var(--mjs-surface, #fff))
    color: var(--mjs-select-fg, var(--mjs-fg, #222))
    border: 1px solid var(--mjs-select-border, var(--mjs-border, #d0d0d0))
    border-radius: var(--mjs-select-radius, 6px)
    box-shadow: var(--mjs-select-panel-shadow, 0 10px 30px var(--mjs-shadow, rgba(0, 0, 0, .18)))

    &.up
      top: auto
      bottom: calc(100% + 4px)

  .select-search
    position: sticky
    top: 0
    box-sizing: border-box
    width: 100%
    padding: 8px 10px
    border: 0
    border-bottom: 1px solid var(--mjs-select-border, var(--mjs-border, #d0d0d0))
    font: inherit
    background: var(--mjs-select-panel-bg, var(--mjs-surface, #fff))
    color: inherit

    &:focus
      outline: none

  .select-empty
    padding: 10px 12px
    color: var(--mjs-select-fg, var(--mjs-fg, #222))
    opacity: .6
    font-size: .9em

  .select-option
    display: flex
    align-items: center
    gap: 8px
    padding: 8px 12px
    cursor: pointer

    &:hover
      background: var(--mjs-select-hover, var(--mjs-hover, #f2f2f2))

    &.active
      background: var(--mjs-select-hover, var(--mjs-hover, #f2f2f2))

    &.selected
      background: var(--mjs-select-selected, var(--mjs-selected, #e6f0ff))
      font-weight: 600

  .select-check
    flex: none
    width: 1em

  .select-option-label
    flex: 1
    overflow: hidden
    white-space: nowrap
    text-overflow: ellipsis
</style>
