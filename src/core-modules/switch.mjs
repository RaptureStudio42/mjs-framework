<script>
  $name     = ''
  $checked  = false
  $disabled = false
  $value    = 'on'

  @onChange = (e)->
    $checked = e.target.checked

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
  <input type="checkbox" role="switch" class="native" name="{$name}" value="{$value}" checked={$checked} disabled={$disabled} @change={@onChange(e)}>
  <span class="pill" part="pill" aria-hidden="true">
    <span class="knob"></span>
  </span>
  <span class="label" part="label"><slot></slot></span>
</label>

<style>
  :host
    display: inline-block
    --mjs-switch-width: 40px
    --mjs-switch-height: 22px
    --mjs-switch-accent: var(--mjs-accent, #3b82f6)
    --mjs-switch-color: #fff
    --mjs-switch-border: var(--mjs-border, #888)

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
    width: var(--mjs-switch-width)
    height: var(--mjs-switch-height)
    margin: 0
    cursor: inherit

  .pill
    position: relative
    display: inline-flex
    align-items: center
    box-sizing: border-box
    width: var(--mjs-switch-width)
    height: var(--mjs-switch-height)
    flex: none
    border: 2px solid var(--mjs-switch-border)
    border-radius: calc(var(--mjs-switch-height) / 2)
    background-color: transparent
    transition: background-color .2s ease, border-color .2s ease

  .knob
    position: absolute
    left: 2px
    width: calc(var(--mjs-switch-height) - 8px)
    height: calc(var(--mjs-switch-height) - 8px)
    border-radius: 50%
    background-color: var(--mjs-switch-border)
    transition: transform .2s ease, background-color .2s ease

  input.native:checked ~ .pill
    background-color: var(--mjs-switch-accent)
    border-color: var(--mjs-switch-accent)

    .knob
      background-color: var(--mjs-switch-color)
      transform: translateX(calc(var(--mjs-switch-width) - var(--mjs-switch-height)))

  input.native:focus-visible ~ .pill
    box-shadow: 0 0 0 3px rgba(59, 130, 246, .35)

  .label
    font-size: .9rem
</style>
