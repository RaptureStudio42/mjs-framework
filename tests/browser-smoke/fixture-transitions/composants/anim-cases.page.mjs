<routes target="vt">
  /   vt-page-a
  /b  vt-page-b
</routes>

<script>
  $fade          = true
  $fly           = true
  $slide         = true
  $scale         = true
  $blur          = true
  $elastic_fly   = true
  $elastic_scale = true
  $typewriter    = true
  $draw          = true
  $iris          = true
  $volet         = true
  $zoom          = true
  $zoomOut       = true
  $swipe         = true
  $bars          = true
  $blocks        = true
  $spin          = true
  $typer         = true
  $inout         = true
  $shared        = true
  $global        = true
  $events        = true
  $status        = 'attente'
  $face          = 0
  $k             = 0
  $todos         = [{ id: 1, text: 'un' }, { id: 2, text: 'deux' }, { id: 3, text: 'trois' }]
  $done          = []
  $order         = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]
  $progress      = µinterpolate(0, 400)
  $size          = µspring(10, 0.1, 0.25)
  trio           = [1, 2, 3]

  µanim.create 'spin',
    duration: 300
    css: (t)->
      transform: "scale(#{t}) rotate(#{t * 360}deg)"

  µanim.create 'typer', (node)->
    text = node.textContent
    { duration: 300, tick: (t)-> node.textContent = text.slice(0, Math.trunc(text.length * t)) }

  µanim.crossfade 'todo', { duration: 300 }

  message = (k)-> "message numero #{k}"

  finishFirst = ->
    return unless $todos.length
    todo   = $todos[0]
    $todos = $todos.filter((t)-> t.id != todo.id)
    $done  = $done.concat(todo)

  shuffle = -> $order = $order.slice().reverse()
</script>

<section class="cases">
  <button id="btn-fade" @click={$fade = not $fade}>fade</button>
  {if $fade}
    <p data-case="fade" @transition.fade={ duration: 300 }>fade</p>
  {end}

  <button id="btn-fly" @click={$fly = not $fly}>fly</button>
  {if $fly}
    <p data-case="fly" @transition.fly={ y: 40, duration: 300 }>fly</p>
  {end}

  <button id="btn-slide" @click={$slide = not $slide}>slide</button>
  {if $slide}
    <p data-case="slide" @transition.slide={ duration: 300 }>slide</p>
  {end}

  <button id="btn-scale" @click={$scale = not $scale}>scale</button>
  {if $scale}
    <p data-case="scale" @transition.scale={ duration: 300 }>scale</p>
  {end}

  <button id="btn-blur" @click={$blur = not $blur}>blur</button>
  {if $blur}
    <p data-case="blur" @transition.blur={ duration: 300 }>blur</p>
  {end}

  <button id="btn-elastic_fly" @click={$elastic_fly = not $elastic_fly}>elastic_fly</button>
  {if $elastic_fly}
    <p data-case="elastic_fly" @transition.elastic_fly={ y: 40, duration: 300 }>elastic fly</p>
  {end}

  <button id="btn-elastic_scale" @click={$elastic_scale = not $elastic_scale}>elastic_scale</button>
  {if $elastic_scale}
    <p data-case="elastic_scale" @transition.elastic_scale={ duration: 300 }>elastic scale</p>
  {end}

  <button id="btn-typewriter" @click={$typewriter = not $typewriter}>typewriter</button>
  {if $typewriter}
    <p data-case="typewriter" @transition.typewriter={ speed: 20 }>le vif zephyr jubile sur les kumquats</p>
  {end}

  <button id="btn-draw" @click={$draw = not $draw}>draw</button>
  <div class="wrap" @childtransition="all">
    {if $draw}
      <svg viewBox="0 0 120 40" width="120" height="40">
        <path data-case="draw" d="M10 20 L110 20" @transition.draw={ duration: 300 }/>
      </svg>
    {end}
  </div>

  <button id="btn-iris" @click={$iris = not $iris}>iris</button>
  {if $iris}
    <p data-case="iris" @transition.iris={ duration: 300 }>iris</p>
  {end}

  <button id="btn-volet" @click={$volet = not $volet}>volet</button>
  {if $volet}
    <p data-case="volet" @transition.volet={ dir: 'down', duration: 300 }>volet</p>
  {end}

  <button id="btn-zoom" @click={$zoom = not $zoom}>zoom</button>
  {if $zoom}
    <p data-case="zoom" @transition.zoom={ duration: 300 }>zoom</p>
  {end}

  <button id="btn-zoomOut" @click={$zoomOut = not $zoomOut}>zoomOut</button>
  {if $zoomOut}
    <p data-case="zoomOut" @transition.zoomOut={ duration: 300 }>zoom out</p>
  {end}

  <button id="btn-swipe" @click={$swipe = not $swipe}>swipe</button>
  {if $swipe}
    <p data-case="swipe" @transition.swipe={ dir: 'left', duration: 300 }>swipe</p>
  {end}

  <button id="btn-bars" @click={$bars = not $bars}>bars</button>
  {if $bars}
    <p data-case="bars" @transition.bars={ dir: 'up', duration: 300 }>bars</p>
  {end}

  <button id="btn-blocks" @click={$blocks = not $blocks}>blocks</button>
  {if $blocks}
    <p data-case="blocks" @transition.blocks={ duration: 300 }>blocks</p>
  {end}

  <button id="btn-spin" @click={$spin = not $spin}>spin</button>
  {if $spin}
    <p data-case="spin" @transition.spin={ duration: 300 }>spin</p>
  {end}

  <button id="btn-typer" @click={$typer = not $typer}>typer</button>
  {if $typer}
    <p data-case="typer" @transition.typer>tape ce texte lettre a lettre</p>
  {end}

  <button id="btn-inout" @click={$inout = not $inout}>in/out</button>
  {if $inout}
    <p data-case="inout" @in.fly={ y: 30, duration: 300 } @out.fade={ duration: 300 }>in fly, out fade</p>
  {end}

  <button id="btn-shared" @click={$shared = not $shared}>shared</button>
  {if $shared}
    <p data-case="shared" @transition.fade.shared={ duration: 300 }>shared</p>
  {end}

  <button id="btn-events" @click={$events = not $events}>events</button>
  <p id="status">{$status}</p>
  {if $events}
    <p data-case="events" @transition.fly={ y: 30, duration: 300 } @introstart={$status = 'introstart'} @introend={$status = 'introend'} @outrostart={$status = 'outrostart'} @outroend={$status = 'outroend'}>events</p>
  {end}

  <button id="btn-global" @click={$global = not $global}>global</button>
  <div class="wrap" @childtransition="all">
    {if $global}
      <ul>
        {for n in trio}
          <li data-case="global" @transition.fade.global={ duration: 300 }>{n}</li>
        {end}
      </ul>
    {end}
  </div>

  <button id="btn-face" @click={$face++}>face</button>
  <div class="deck" data-deck="reveal">
    {key $face}
      <div data-case="reveal" @transition.reveal={ duration: 300 }>reveal {$face}</div>
    {end}
  </div>
  <div class="deck" data-deck="flip">
    {key $face}
      <div data-case="flip" @transition.flip={ duration: 300 }>flip {$face}</div>
    {end}
  </div>
  <div class="deck" data-deck="cube">
    {key $face}
      <div data-case="cube" @transition.cube={ duration: 300 }>cube {$face}</div>
    {end}
  </div>
  <div class="deck" data-deck="turn">
    {key $face}
      <div data-case="turn" @transition.turn={ duration: 300 }>turn {$face}</div>
    {end}
  </div>

  <button id="btn-keyed" @click={$k++}>keyed</button>
  <div class="deck" data-deck="keyed">
    {key $k}
      <p data-case="keyed" @in.typewriter={ speed: 40 }>{message($k)}</p>
    {end}
  </div>

  <button id="btn-finish" @click={finishFirst()}>finish</button>
  <ul data-list="todo">
    {for t in $todos by id}
      <li data-case="todo" @in.todoReceive={ key: t.id } @out.todoSend={ key: t.id } @flip=300>{t.text}</li>
    {end}
  </ul>
  <ul data-list="done">
    {for t in $done by id}
      <li data-case="done" @in.todoReceive={ key: t.id } @out.todoSend={ key: t.id } @flip=300>{t.text}</li>
    {end}
  </ul>

  <button id="btn-shuffle" @click={shuffle()}>shuffle</button>
  <ul data-list="order">
    {for o in $order by id}
      <li data-case="order" @flip=300>{o.id}</li>
    {end}
  </ul>

  <button id="btn-progress" @click={$progress = 100}>progress</button>
  <span id="progress">{Math.round($progress.current)}</span>

  <button id="btn-size" @click={$size = 30}>size</button>
  <span id="size">{Math.round($size.current)}</span>

  <a id="lnk-a" href="#/">A</a>
  <a id="lnk-b" href="#/b">B</a>
  <@view vt @viewTransition.cube={ dir: left }>
</section>

<style>
  .cases
    display: flex
    flex-direction: column
    gap: 6px
    padding: 12px
    font-family: sans-serif

  p, li, .deck > div
    margin: 0
    padding: 6px 10px
    background: #eef
    color: #123

  .wrap
    min-height: 20px

  .deck
    position: relative
    min-height: 32px

  ul
    display: flex
    gap: 8px
    margin: 0
    padding: 0
    list-style: none

  path
    stroke: #123
    stroke-width: 3
    fill: none
</style>
