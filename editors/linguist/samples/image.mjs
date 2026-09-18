<script>
$src ?= ''
$srcset ?= ''
$sizes ?= '100vw'
$alt ?= ''
$width ?= null
$height ?= null
$loading ?= 'lazy'
$decoding ?= 'async'
$fit ?= 'cover'
</script>

<img src={$src} srcset={$srcset} sizes={$sizes} alt={$alt} width={$width} height={$height} loading={$loading} decoding={$decoding} @style.objectFit={$fit}>

<theme>
  $$image-radius: 0
</theme>

<style>
  :host
    display: block
  img
    display: block
    max-width: 100%
    height: auto
    border-radius: $$image-radius
</style>
