<script>
  $name     = ''
  $value    = 'on'
  $checked  = false
  $disabled = false
  $group    = undefined

  @onChange = (e)->
    return unless e.target.checked
    self = @
    $checked = true
    $group   = $value
    scope = @closest('form') ?? document
    # sécurité : un name à guillemet cassait le sélecteur (SyntaxError sur querySelectorAll)
    safeName = if typeof CSS != 'undefined' and CSS.escape then CSS.escape($name) else String($name).replace(/["\\]/g, '\\$&')
    sel = 'mjs-radio[name="' + safeName + '"]'
    scope.querySelectorAll(sel).forEach (el)->
      el._set('checked', false) unless el == self

  µeffect ->
    if $group != undefined
      $checked = ($group == $value)

  hiddenInput = null

  µeffect ->
    active = $checked and not $disabled
    if active
      if not hiddenInput
        hiddenInput = document.createElement('input')
        hiddenInput.type = 'hidden'
        @@appendChild(hiddenInput)
      hiddenInput.name  = $name
      hiddenInput.value = $value
    else if hiddenInput
      hiddenInput.remove()
      hiddenInput = null
</script>

<label class="wrap" part="wrap" @class{$disabled}="disabled">
  <input type="radio" class="native" name="{$name}" value="{$value}" checked={$checked} disabled={$disabled} @change={@onChange(e)}>
  <span class="ring" part="dot" aria-hidden="true">
    <span class="dot"></span>
  </span>
  <span class="label" part="label"><slot></slot></span>
</label>

<style>
  :host
    display: inline-block
    --mjs-check-size: 20px
    --mjs-check-accent: var(--mjs-accent, #3b82f6)
    --mjs-check-color: #fff
    --mjs-check-border: var(--mjs-border, #888)

  .wrap
    display: inline-flex
    align-items: center
    gap: 8px
    cursor: pointer
    user-select: none

    &.disabled
      cursor: not-allowed
      opacity: .5

  input.native
    position: absolute
    opacity: 0
    width: var(--mjs-check-size)
    height: var(--mjs-check-size)
    margin: 0
    cursor: inherit

  .ring
    position: relative
    display: inline-flex
    align-items: center
    justify-content: center
    width: var(--mjs-check-size)
    height: var(--mjs-check-size)
    flex: none
    border: 2px solid var(--mjs-check-border)
    border-radius: 50%
    transition: border-color .18s ease

  .dot
    width: 50%
    height: 50%
    border-radius: 50%
    background-color: var(--mjs-check-accent)
    opacity: 0
    transform: scale(.4)
    transition: opacity .15s ease, transform .15s ease

  input.native:checked ~ .ring
    border-color: var(--mjs-check-accent)

    .dot
      opacity: 1
      transform: scale(1)

  input.native:focus-visible ~ .ring
    box-shadow: 0 0 0 3px rgba(59, 130, 246, .35)

  .label
    font-size: .9rem
</style>
