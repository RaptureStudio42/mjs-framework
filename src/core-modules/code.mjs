<script>
  $label       = 'Copier le code'
  $copiedLabel = 'Copié !'
  $copied      = false
  $offset      = '0px'
  $block       = false
  slotRef      = null
  watcher      = null
  timer        = null


  nodes = -> slotRef?.assignedNodes({ flatten: true }) ?? []

  blocks = -> slotRef?.assignedElements({ flatten: true }) ?? []

  hostOf = -> slotRef?.getRootNode()?.host

  # mode bloc : rien de préformaté n'est projeté, le module pose lui-même le cadre du code
  bare = -> not blocks().some((el)-> el.tagName is 'PRE' or !!el.querySelector?('pre'))

  # retire l'indentation commune que le gabarit appelant a laissée devant chaque ligne
  dedent = ->
    ns = nodes()
    return unless ns.length
    # <@slot {i}> (éditeur de tuto) projette UN SEUL élément déjà structuré (<code data-file>,
    # un <div> par ligne) : le texte à dédenter est dans SES enfants, pas dans ce wrapper lui-même
    ns = Array.from(ns[0].childNodes) if ns.length is 1 and ns[0].nodeType is 1
    return unless ns.length
    lines = ns.map((n)-> n.textContent or '').join('').split('\n')
    pads  = lines.slice(1).filter((l)-> l.trim()).map((l)-> l.match(/^[ \t]*/)[0].length)
    pad   = if pads.length then Math.min(...pads) else 0
    cut   = new RegExp('\\n[ \\t]{0,' + pad + '}', 'g')
    texts = ns.filter((n)-> n.nodeType is 3)
    return unless texts.length
    # un nœud 100% blanc n'est que l'espacement entre éléments du gabarit (ex. un <div> par ligne) :
    # aucun contenu à dédenter, et le garder à 1 \n doublerait un saut de ligne déjà posé par ces éléments
    texts.forEach (n)-> n.nodeValue = if n.nodeValue.trim() then n.nodeValue.replace(cut, '\n') else ''
    first = texts[0]
    last  = texts[texts.length - 1]
    first.nodeValue = first.nodeValue.replace(/^[ \t]*\n/, '')
    last.nodeValue  = last.nodeValue.replace(/\n[ \t]*$/, '')

  # haut réel du premier bloc dans l'hôte : 0 quand sa marge déborde de l'hôte (flux normal), sa marge quand l'hôte la garde (élément de flex ou de grille)
  align = ->
    first   = blocks()[0]
    host    = hostOf()
    $offset = (first.getBoundingClientRect().top - host.getBoundingClientRect().top) + 'px' if first and host

  sourceOf = ->
    els = blocks()
    src = if els.length then els.map((el)-> el.innerText or el.textContent or '') else nodes().map((n)-> n.textContent or '')
    src.join('\n').replace(/\s+$/, '')

  # repli sans API presse-papier (page servie en http hors localhost) : sélection du premier bloc puis commande copier
  selectAndCopy = ->
    target = blocks()[0] or slotRef
    return false unless target and document.execCommand
    selection = window.getSelection()
    range     = document.createRange()
    range.selectNodeContents(target)
    selection.removeAllRanges()
    selection.addRange(range)
    ok = false
    try
      ok = document.execCommand('copy')
    catch
      ok = false
    selection.removeAllRanges()
    ok

  done = ->
    $copied = true
    clearTimeout(timer) if timer
    timer = setTimeout (-> $copied = false), 1600

  copy = ->
    text = sourceOf()
    if navigator.clipboard?.writeText
      navigator.clipboard.writeText(text).then(done).catch(-> done() if selectAndCopy())
    else if selectAndCopy()
      done()


  µmount ->
    $block = bare()
    dedent() if $block
    align()
    host = hostOf()
    return unless host and window.ResizeObserver
    watcher = new ResizeObserver(align)
    watcher.observe(host)

  µdestroy ->
    watcher?.disconnect()
    clearTimeout(timer) if timer
</script>

<pre class="box" @class{$block}="block" part="box"><span class="anchor" --mjs-code-offset={$offset}><button type="button" class="copy" part="button" @class{$copied}="ok" aria-label={$copied ? $copiedLabel : $label} title={$label} @click={copy()}>{if $copied}<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>{else}<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>{end}</button></span><code class="src" part="code"><slot @this=!{slotRef}></slot></code></pre>

<style>
  :host
    display: block

  // enveloppe NEUTRE par défaut : le bloc préformaté projeté garde entièrement son apparence
  .box
    margin: 0
    padding: 0
    border: 0
    background: none
    font: inherit
    color: inherit
    white-space: inherit
    tab-size: inherit

  .src
    display: block
    font: inherit
    white-space: inherit

  // mode bloc : plus rien de préformaté n'est projeté, le module habille le code lui-même
  .box.block
    border: 1px solid var(--mjs-code-border, var(--mjs-code-copy-border, rgba(#fff, .14)))
    border-radius: var(--mjs-code-radius, 10px)
    background: var(--mjs-code-bg, #0d1117)
    color: var(--mjs-code-fg, #c9d1d9)
    font-family: var(--mjs-code-font, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)
    font-size: var(--mjs-code-size, .92em)
    line-height: var(--mjs-code-line, 1.55)
    white-space: pre
    tab-size: 2

  // ancre de largeur nulle, collante : le bouton reste dans l'angle haut-droit du bloc, et le suit tant que le bloc défile sous le haut de la zone visible
  .anchor
    float: right
    position: sticky
    top: var(--mjs-code-copy-top, 0px)
    z-index: 2
    width: 0
    height: 36px
    margin-top: var(--mjs-code-offset, 0px)
    margin-bottom: -36px
    font-size: 0
    white-space: normal

  .box.block .src
    overflow-x: auto
    padding: var(--mjs-code-pad, 14px 16px)

  .box.block .anchor
    margin-top: 0

  .copy
    position: absolute
    top: 6px
    right: 6px
    display: inline-flex
    align-items: center
    justify-content: center
    width: 30px
    height: 30px
    padding: 0
    border: 1px solid var(--mjs-code-copy-border, rgba(#fff, .14))
    border-radius: 8px
    background: var(--mjs-code-copy-bg, rgba(#0d1117, .82))
    color: var(--mjs-code-copy-fg, #8b949e)
    cursor: pointer
    opacity: .75
    transition: color .15s, opacity .15s, border-color .15s

    &:hover, &:focus-visible
      opacity: 1

    &.ok
      opacity: 1
      color: var(--mjs-code-copy-ok, #3fb950)
      border-color: currentColor
</style>
