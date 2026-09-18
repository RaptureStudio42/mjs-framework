<script>
  µeffect =>
    if $value == undefined then @removeAttribute('value') else @setAttribute('value', String($value))
    if $icon == undefined or $icon == null then @removeAttribute('icon') else @setAttribute('icon', String($icon))
</script>

<slot></slot>

<style>
  :host
    display: none
</style>
