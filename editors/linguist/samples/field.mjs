<script>
  $name    ?= ''
  $label   ?= ''
  $help    ?= ''
  $okLabel ?= ''

  $status   = 'neutral'
  $fieldId  = ''
  $errorMsg = ''

  seen = false

  µmount ->
    µ.error('[mjs-field] l\'attribut « name » est requis.') unless $name
    els = slotRef?.assignedElements() ?? []
    target = els[0]
    if target
      if not target.id
        target.id = 'mjs-field-' + Math.random().toString(36).slice(2, 9)
      $fieldId = target.id

  µeffect ->
    err = µres.errors?.[$name]
    if err
      $status   = 'error'
      $errorMsg = if Array.isArray(err) then String(err[0] ?? '') else String(err)
    else
      $errorMsg = ''
      $status   = 'ok' if seen
    seen = true
</script>

<div class="field" part="field" @class{$status == 'error'}="has-error" @class{$status == 'ok'}="has-ok">
  {if $label}
    <label class="label" part="label" for="{$fieldId}">{$label}</label>
  {end}
  <slot @this=!{slotRef}></slot>
  <p class="help" part="help">{$help}</p>
  {if $status == 'error'}
    <p class="error" part="error">{$errorMsg}</p>
  {end}
  {if $status == 'ok'}
    <p class="ok" part="ok">{$okLabel}</p>
  {end}
</div>

<style>
  :host
    display: block
    --mjs-field-error-color: #e5484d
    --mjs-field-ok-color: #2e9e5b

  .field
    display: flex
    flex-direction: column
    gap: 4px

  .label
    font-size: .85rem
    font-weight: 600

  ::slotted(input), ::slotted(select), ::slotted(textarea)
    border: 1px solid var(--mjs-border, #888)
    border-radius: 6px
    padding: 6px 10px
    font: inherit
    transition: border-color .18s ease, box-shadow .18s ease

  // bordure d'état : un ::slotted() perd TOUJOURS face à une règle normale de l'arbre externe (page), quelle que soit la spécificité — seul !important inverse ce départage (spec CSS Scoping)
  .field.has-error ::slotted(input), .field.has-error ::slotted(select), .field.has-error ::slotted(textarea)
    border-color: var(--mjs-field-error-color) !important

  .field.has-ok ::slotted(input), .field.has-ok ::slotted(select), .field.has-ok ::slotted(textarea)
    border-color: var(--mjs-field-ok-color) !important

  .help
    margin: 0
    font-size: .78rem
    color: var(--mjs-fg-muted, #888)

  .field.has-error .help
    display: none

  .error
    margin: 0
    font-size: .78rem
    color: var(--mjs-field-error-color)

    &:empty
      display: none

  .ok
    margin: 0
    font-size: .78rem
    color: var(--mjs-field-ok-color)

    &:empty
      display: none
</style>
