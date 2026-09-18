<script>
  $name          = ''
  $checked       = false
  $disabled      = false
  $indeterminate = false
  $value         = 'on'

  @onChange = (e)->
    $checked = e.target.checked

  hiddenInput = null
  native      = null

  µeffect ->
    native.indeterminate = $indeterminate if native

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
  <input type="checkbox" class="native" name="{$name}" value="{$value}" checked={$checked} disabled={$disabled} @this=!{native} @change={@onChange(e)}>
  <span class="box" part="box" aria-hidden="true">
    <svg class="tick" viewBox="0 0 16 16" fill="none">
      <path d="M3 8.5L6.5 12L13 4.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path>
    </svg>
    <span class="dash"></span>
  </span>
  <span class="label" part="label"><slot></slot></span>
</label>

<style>
  :host
    display: inline-block
    --mjs-check-size: 20px
    --mjs-check-radius: 4px
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

  .box
    position: relative
    display: inline-flex
    align-items: center
    justify-content: center
    width: var(--mjs-check-size)
    height: var(--mjs-check-size)
    flex: none
    border: 2px solid var(--mjs-check-border)
    border-radius: var(--mjs-check-radius)
    background-color: transparent
    transition: background-color .18s ease, border-color .18s ease

  .tick
    width: 70%
    height: 70%
    color: var(--mjs-check-color)
    opacity: 0
    transform: scale(.5)
    transition: opacity .15s ease, transform .15s ease

  .dash
    position: absolute
    inset: 0
    margin: auto
    width: 60%
    height: 2px
    border-radius: 1px
    background-color: var(--mjs-check-color)
    opacity: 0
    transition: opacity .15s ease

  input.native:checked ~ .box
    background-color: var(--mjs-check-accent)
    border-color: var(--mjs-check-accent)

    .tick
      opacity: 1
      transform: scale(1)

  input.native:indeterminate ~ .box
    background-color: var(--mjs-check-accent)
    border-color: var(--mjs-check-accent)

    .tick
      opacity: 0
      transform: scale(.5)

    .dash
      opacity: 1

  input.native:focus-visible ~ .box
    box-shadow: 0 0 0 3px rgba(59, 130, 246, .35)

  .label
    font-size: .9rem
</style>
