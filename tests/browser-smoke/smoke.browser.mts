// SMOKE navigateur RÉEL (Chromium + Firefox, via playwright, PAS @playwright/test) sur
// les 5 modules cœur (select/field/checkbox/radio/switch) et @title. Hors de `npm test` : ce
// fichier porte l'extension `.mts`, que le glob de npm test (`mocha --recursive tests/
// --extension ts`, cf. package.json) ne reconnaît PAS (`hasMatchingExtname` exige un suffixe
// littéral ".ts", que ".mts" n'a pas — vérifié par lecture de mocha/lib/cli/lookup-files.js :
// AUCUN filtre par NOM/sous-dossier n'existe réellement dans cette invocation, contrairement à
// une hypothèse initiale — seule l'extension compte). `npm run test:browser` cible ce fichier
// PAR SON NOM EXACT (argument fichier direct) : l'extension n'a alors plus d'importance pour
// mocha, qui charge tout chemin de fichier existant tel quel (cf. lookupFiles).
//
// Shadow DOM : mode CLOSED par défaut côté client (mjs_element.ts, attachShadow closed) — accès
// depuis page.evaluate via la propriété interne `_shadow` (même idiome que tests/core-select.test.ts,
// tests/aria-attr-false.test.ts et surtout tests/browser-playwright.test.ts, seul autre test à
// Chromium réel du dépôt : « le component MJS attache un Shadow DOM closed. On accède via le
// tag. »). `.click()`/`.focus()` appelés depuis page.evaluate restent de VRAIES actions DOM
// (focus réellement trusted, click natif sur un input coché/décoche pour de vrai) — seul le
// survol (Popover, positionnement) utilise de VRAIES coordonnées souris (page.mouse), point
// précis où happy-dom diverge le plus (Popover absent, cf. mjs_title.ts `__titlePopoverOk`).

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, copyFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, firefox } from 'playwright'

const __dirname     = dirname(fileURLToPath(import.meta.url))
const MODULARJS_ROOT = join(__dirname, '..', '..')
const FIXTURE_DIR   = join(__dirname, 'fixture')
const OUT_DIR        = join(FIXTURE_DIR, 'sortie')
const BIN_MJS        = join(MODULARJS_ROOT, 'bin', 'mjs')

const HMR_PREFIX = '[HMR]' // bruit LÉGITIME du serveur dev (server/hmr.ts) — jamais une erreur applicative

const TITLE_DELETE = 'Supprime définitivement cette ligne'
const TITLE_SUBMIT = 'Valide le formulaire'
const FIELD_ERROR  = 'Cet email est déjà utilisé.'

let serverLog = ''

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = addr && typeof addr === 'object' ? addr.port : 0
      srv.close(() => resolvePort(port))
    })
  })
}

function spawnDevServer(port: number): any {
  const child = spawn(process.execPath, [BIN_MJS, 'dev', '--root', FIXTURE_DIR, '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', (b: Buffer) => { serverLog += b.toString() })
  child.stderr?.on('data', (b: Buffer) => { serverLog += b.toString() })
  return child
}

async function stopServer(child: any): Promise<void> {
  if (!child || child.exitCode !== null) return
  await new Promise<void>((resolveStop) => {
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* déjà mort */ } }, 5000)
    child.once('exit', () => { clearTimeout(timer); resolveStop() })
    child.kill('SIGTERM')
  })
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (; ;) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch { /* pas encore prêt */ }
    if (Date.now() > deadline) throw new Error(`serveur dev indisponible après ${timeoutMs}ms (${url})\n${serverLog}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

const CORE_TAGS = ['mjs-select', 'mjs-field', 'mjs-checkbox', 'mjs-radio', 'mjs-switch']

// bordure calculée de l'input email de mjs-field (démo `email`), comparée à une sonde
// qui lit la MÊME variable CSS depuis le MÊME point d'héritage (enfant de <mjs-field>, comme
// l'input réel — un enfant de document.body ne verrait jamais --mjs-field-*-color, posée sur
// :host, scoped à cet arbre). `border-color` est en `transition: .18s ease` (règle de base du
// module) : un délai FIXE s'est montré flaky en vrai (piège débusqué, mesure attrapée en
// plein milieu de l'animation) — on POLL jusqu'à convergence, marge large sur l'environnement.
async function measureFieldBorder(page: any, varName: string): Promise<{ actual: string; expected: string }> {
  const expected = await page.evaluate((varName: string) => {
    const field: any = document.querySelector('mjs-demo')._shadow.querySelector('mjs-field')
    const probe = document.createElement('div')
    field.appendChild(probe)
    probe.style.borderColor = `var(${varName})`
    const v = getComputedStyle(probe).borderColor
    probe.remove()
    return v
  }, varName)
  try {
    await page.waitForFunction((expected: string) => {
      const field: any = document.querySelector('mjs-demo')._shadow.querySelector('mjs-field')
      const input: any = field.querySelector('input[name=email]')
      return getComputedStyle(input).borderColor === expected
    }, expected, { timeout: 2000 })
  } catch { /* pas convergé dans les temps : l'assertion appelante rapportera actual ≠ expected */ }
  const actual = await page.evaluate(() => {
    const field: any = document.querySelector('mjs-demo')._shadow.querySelector('mjs-field')
    const input: any = field.querySelector('input[name=email]')
    return getComputedStyle(input).borderColor
  })
  return { actual, expected }
}

describe('smoke navigateur réel (Chromium + Firefox) : modules cœur + @title', function () {
  this.timeout(180000)

  let child: any = null
  let baseUrl = ''

  before(async function () {
    const port = await freePort()
    baseUrl = `http://127.0.0.1:${port}/sortie`
    mkdirSync(OUT_DIR, { recursive: true })
    copyFileSync(join(FIXTURE_DIR, 'index.html'), join(OUT_DIR, 'index.html'))
    child = spawnDevServer(port)
    try {
      // bundle.js (pas index.html, écrit par NOUS avant même le lancement du serveur — donc
      // toujours prêt) : seul signal qui prouve que le build INITIAL du bundler a bien eu lieu.
      await waitForServer(`${baseUrl}/bundle.js`, 25000)
    } catch (e) {
      await stopServer(child)
      child = null
      throw e
    }
  })

  after(async function () {
    await stopServer(child)
  })

  for (const engine of [chromium, firefox]) {
    describe(`moteur ${engine.name()}`, function () {
      let browser: any = null
      let page: any = null
      const consoleIssues: string[] = []

      before(async function () {
        browser = await engine.launch({ headless: true })
        page = await browser.newPage()
        page.on('console', (msg: any) => {
          const text = msg.text()
          if (text.startsWith(HMR_PREFIX)) return
          consoleIssues.push(`console.${msg.type()}: ${text}`)
        })
        page.on('pageerror', (err: any) => { consoleIssues.push(`pageerror: ${err.message}`) })
        await page.goto(`${baseUrl}/index.html`, { waitUntil: 'load' })
        await page.waitForFunction(() => {
          const d: any = document.querySelector('mjs-demo')
          const sel: any = d && d._shadow && d._shadow.querySelector('mjs-select')
          const btn = sel && sel._shadow && sel._shadow.querySelector('.select-btn')
          return !!btn
        }, null, { timeout: 20000 })
      })

      after(async function () {
        await browser?.close()
      })

      it('les 5 modules cœur sont montés (customElements.get + shadow présent)', async function () {
        const result = await page.evaluate((tags: string[]) => {
          const defined = tags.every((t) => !!customElements.get(t))
          const d: any = document.querySelector('mjs-demo')
          const shadows = !!(d && d._shadow) && tags.every((t) => {
            const el: any = d._shadow.querySelector(t)
            return !!(el && el._shadow)
          })
          return { defined, shadows, hasDemoShadow: !!(d && d._shadow) }
        }, CORE_TAGS)
        assert.equal(result.hasDemoShadow, true, 'le composant démo doit lui-même exposer un shadow root')
        assert.equal(result.defined, true, 'customElements.get doit être défini pour les 5 tags mjs-*')
        assert.equal(result.shadows, true, 'chaque module cœur doit exposer son propre shadow root (_shadow)')
      })

      it('SELECT — aria-expanded fermé/ouvert, recherche, choix, FormData', async function () {
        const closed = await page.evaluate(() => {
          const btn: any = document.querySelector('mjs-demo')._shadow.querySelector('mjs-select')._shadow.querySelector('.select-btn')
          return { present: btn.hasAttribute('aria-expanded'), value: btn.getAttribute('aria-expanded') }
        })
        assert.equal(closed.present, true, 'aria-expanded doit être PRÉSENT à l\'état fermé (correctif aria-*)')
        assert.equal(closed.value, 'false', 'aria-expanded doit valoir la chaîne "false", pas être absent')

        await page.evaluate(() => {
          document.querySelector('mjs-demo')._shadow.querySelector('mjs-select')._shadow.querySelector('.select-btn').click()
        })
        await page.waitForFunction(() => {
          const btn: any = document.querySelector('mjs-demo')._shadow.querySelector('mjs-select')._shadow.querySelector('.select-btn')
          return btn.getAttribute('aria-expanded') === 'true'
        })
        await page.waitForFunction(() => {
          const sel: any = document.querySelector('mjs-demo')._shadow.querySelector('mjs-select')
          const search = sel._shadow.querySelector('.select-search')
          return !!search && sel._shadow.activeElement === search
        })

        await page.keyboard.type('Belgique')
        await page.waitForFunction(() => {
          const sel: any = document.querySelector('mjs-demo')._shadow.querySelector('mjs-select')
          const opts = Array.from(sel._shadow.querySelectorAll('.select-option')) as any[]
          return opts.length === 1 && opts[0].textContent.includes('Belgique')
        })

        await page.evaluate(() => {
          document.querySelector('mjs-demo')._shadow.querySelector('mjs-select')._shadow.querySelector('.select-option').click()
        })
        await page.waitForFunction(() => {
          const btn: any = document.querySelector('mjs-demo')._shadow.querySelector('mjs-select')._shadow.querySelector('.select-btn')
          return btn.getAttribute('aria-expanded') === 'false' && btn.textContent.includes('Belgique')
        })

        const countryValue = await page.evaluate(() => {
          const form: any = document.querySelector('mjs-demo')._shadow.querySelector('#demo-form')
          return new FormData(form).get('country')
        })
        assert.equal(countryValue, 'be', 'FormData doit porter la value de l\'option choisie ("be")')
      })

      // select MULTIPLE lié two-way à un TABLEAU ($langues=!{}) : c'est
      // exactement le cas qui gelait le navigateur (ping-pong parent↔enfant)
      // avant le fix « reconnaissance des enveloppes + époques ». Chaque
      // `page.waitForFunction` porte un timeout DUR explicite : AVANT le fix, la
      // page reste bloquée en boucle (CPU 100 %) et cet appel ne rend JAMAIS la
      // main — le timeout qui expire EST l'assertion anti-gel, pas un détail.
      it('SELECT MULTIPLE — liaison two-way TABLEAU inter-composants (pas de gel), 2 clics réels, état + visuel', async function () {
        await page.evaluate(() => {
          const d: any = document.querySelector('mjs-demo')
          const el = d._shadow.querySelectorAll('mjs-select')[1]
          el._shadow.querySelector('.select-btn').click()
        })
        await page.waitForFunction(() => {
          const d: any = document.querySelector('mjs-demo')
          const el = d._shadow.querySelectorAll('mjs-select')[1]
          return el._shadow.querySelector('.select-btn').getAttribute('aria-expanded') === 'true'
        }, null, { timeout: 8000 })

        // 1er clic RÉEL (Français) — le ping-pong, s'il existait encore, se
        // déclencherait DÈS cette première mutation d'objet two-way.
        await page.evaluate(() => {
          const d: any = document.querySelector('mjs-demo')
          const el = d._shadow.querySelectorAll('mjs-select')[1]
          ;(el._shadow.querySelectorAll('.select-option')[0] as any).click()
        })
        await page.waitForFunction(() => {
          const d: any = document.querySelector('mjs-demo')
          const el = d._shadow.querySelectorAll('mjs-select')[1]
          const opt = el._shadow.querySelectorAll('.select-option')[0]
          return opt.classList.contains('selected') && opt.getAttribute('aria-selected') === 'true'
        }, null, { timeout: 8000 })

        // 2e clic RÉEL (Anglais) — 2 mutations d'objet consécutives sur la
        // MÊME liaison two-way : le terrain exact de la boucle infinie.
        await page.evaluate(() => {
          const d: any = document.querySelector('mjs-demo')
          const el = d._shadow.querySelectorAll('mjs-select')[1]
          ;(el._shadow.querySelectorAll('.select-option')[1] as any).click()
        })
        await page.waitForFunction(() => {
          const d: any = document.querySelector('mjs-demo')
          const el = d._shadow.querySelectorAll('mjs-select')[1]
          const opts = el._shadow.querySelectorAll('.select-option')
          return opts[0].classList.contains('selected') && opts[1].classList.contains('selected')
        }, null, { timeout: 8000 })

        // État RÉACTIF (pas seulement visuel) : le tableau two-way doit porter
        // les 2 valeurs, côté ENFANT (select) ET côté PARENT (démo) — preuve que
        // la liaison a bien convergé des 2 côtés, pas juste que le DOM local a
        // basculé une classe CSS.
        const state = await page.evaluate(() => {
          const d: any = document.querySelector('mjs-demo')
          const el = d._shadow.querySelectorAll('mjs-select')[1]
          return {
            child: Array.from(el._state.value as any[]),
            parent: Array.from(d._state.langues as any[]),
          }
        })
        assert.deepEqual(state.child, ['fr', 'en'], "l'état interne du select (enfant) doit porter les 2 valeurs")
        assert.deepEqual(state.parent, ['fr', 'en'], "l'état du composant démo (parent) doit porter les mêmes 2 valeurs")

        // Panneau resté OUVERT (comportement multiple, non lié au fix — non-
        // régression) + libellé du bouton à jour.
        const stillOpenAndLabelled = await page.evaluate(() => {
          const d: any = document.querySelector('mjs-demo')
          const el = d._shadow.querySelectorAll('mjs-select')[1]
          const btn = el._shadow.querySelector('.select-btn')
          return { open: btn.getAttribute('aria-expanded') === 'true', label: btn.textContent.trim() }
        })
        assert.equal(stillOpenAndLabelled.open, true, 'le panneau doit rester ouvert en mode multiple')
        assert.equal(stillOpenAndLabelled.label, 'Français, Anglais')

        await page.evaluate(() => {
          const d: any = document.querySelector('mjs-demo')
          const el = d._shadow.querySelectorAll('mjs-select')[1]
          el._shadow.querySelector('.select-btn').click()
        })
        await page.waitForFunction(() => {
          const d: any = document.querySelector('mjs-demo')
          const el = d._shadow.querySelectorAll('mjs-select')[1]
          return el._shadow.querySelector('.select-btn').getAttribute('aria-expanded') === 'false'
        }, null, { timeout: 8000 })
      })

      it('FIELD — erreur 422 via µres.errors (µ._mjs_resMerge), puis passage au succès', async function () {
        await page.evaluate((msg: string) => {
          ;(window as any).µ._mjs_resMerge({ errors: { email: msg } })
        }, FIELD_ERROR)
        await page.waitForFunction((msg: string) => {
          const field: any = document.querySelector('mjs-demo')._shadow.querySelector('mjs-field')
          const box = field._shadow.querySelector('.field')
          const err = field._shadow.querySelector('[part=error]')
          return !!box && box.classList.contains('has-error') && !!err && err.textContent === msg
        }, FIELD_ERROR)

        // bordure RÉELLEMENT calculée de l'input slotté (getComputedStyle), pas
        // seulement la classe has-error : `demo.mjs` porte une règle `input[type="email"]`
        // (feuille de PAGE) qui, sans
        // !important sur le ::slotted() du module, gagnerait la cascade shadow DOM et
        // laisserait le cadre gris de la page au lieu du rouge d'état. `border-color` est
        // en `transition: .18s ease` (règle de base du module) : un `waitForFunction` (pas
        // un délai fixe, constaté FLAKY en vrai) attend que la couleur
        // ait CONVERGÉ vers sa cible avant de figer la mesure finale de l'assertion.
        const errorBorder = await measureFieldBorder(page, '--mjs-field-error-color')
        assert.equal(errorBorder.actual, errorBorder.expected, `bordure d'état erreur : attendu ${errorBorder.expected} (--mjs-field-error-color), mesuré ${errorBorder.actual}`)

        await page.evaluate(() => {
          ;(window as any).µ._mjs_resMerge({ errors: {} })
        })
        await page.waitForFunction(() => {
          const field: any = document.querySelector('mjs-demo')._shadow.querySelector('mjs-field')
          const box = field._shadow.querySelector('.field')
          const ok = field._shadow.querySelector('[part=ok]')
          return !!box && !box.classList.contains('has-error') && box.classList.contains('has-ok') && !!ok && ok.textContent === 'Adresse valide'
        })

        const okBorder = await measureFieldBorder(page, '--mjs-field-ok-color')
        assert.equal(okBorder.actual, okBorder.expected, `bordure d'état succès : attendu ${okBorder.expected} (--mjs-field-ok-color), mesuré ${okBorder.actual}`)
        assert.notEqual(okBorder.actual, errorBorder.actual, 'les 2 états doivent porter des couleurs de bordure différentes')
      })

      it('CHECKBOX/SWITCH — coché/décoché + FormData ; RADIO — exclusivité de groupe', async function () {
        await page.evaluate(() => {
          document.querySelector('mjs-demo')._shadow.querySelector('mjs-checkbox')._shadow.querySelector('input.native').click()
        })
        await page.waitForFunction(() => !!document.querySelector('mjs-demo')._shadow.querySelector('mjs-checkbox').querySelector('input[type=hidden]'))
        let fd = await page.evaluate(() => {
          const form: any = document.querySelector('mjs-demo')._shadow.querySelector('#demo-form')
          return new FormData(form).get('terms')
        })
        assert.equal(fd, 'on', 'checkbox cochée : FormData doit porter "on"')

        await page.evaluate(() => {
          document.querySelector('mjs-demo')._shadow.querySelector('mjs-checkbox')._shadow.querySelector('input.native').click()
        })
        await page.waitForFunction(() => !document.querySelector('mjs-demo')._shadow.querySelector('mjs-checkbox').querySelector('input[type=hidden]'))
        fd = await page.evaluate(() => {
          const form: any = document.querySelector('mjs-demo')._shadow.querySelector('#demo-form')
          return new FormData(form).get('terms')
        })
        assert.equal(fd, null, 'checkbox décochée : absente de FormData')

        await page.evaluate(() => {
          document.querySelector('mjs-demo')._shadow.querySelector('mjs-switch')._shadow.querySelector('input.native').click()
        })
        await page.waitForFunction(() => !!document.querySelector('mjs-demo')._shadow.querySelector('mjs-switch').querySelector('input[type=hidden]'))
        fd = await page.evaluate(() => {
          const form: any = document.querySelector('mjs-demo')._shadow.querySelector('#demo-form')
          return new FormData(form).get('alerts')
        })
        assert.equal(fd, 'on', 'switch activé : FormData doit porter "on"')

        await page.evaluate(() => {
          document.querySelector('mjs-demo')._shadow.querySelector('mjs-switch')._shadow.querySelector('input.native').click()
        })
        await page.waitForFunction(() => !document.querySelector('mjs-demo')._shadow.querySelector('mjs-switch').querySelector('input[type=hidden]'))
        fd = await page.evaluate(() => {
          const form: any = document.querySelector('mjs-demo')._shadow.querySelector('#demo-form')
          return new FormData(form).get('alerts')
        })
        assert.equal(fd, null, 'switch désactivé : absent de FormData')

        await page.evaluate(() => {
          const radios: any = document.querySelector('mjs-demo')._shadow.querySelectorAll('mjs-radio')
          radios[1]._shadow.querySelector('input.native').click()
        })
        await page.waitForFunction(() => {
          const radios: any = document.querySelector('mjs-demo')._shadow.querySelectorAll('mjs-radio')
          return radios[1]._shadow.querySelector('input.native').checked === true && radios[0]._shadow.querySelector('input.native').checked === false
        })
        fd = await page.evaluate(() => {
          const form: any = document.querySelector('mjs-demo')._shadow.querySelector('#demo-form')
          return new FormData(form).get('size')
        })
        assert.equal(fd, 'm', 'le 2ᵉ radio (M) coché : FormData doit porter "m"')

        await page.evaluate(() => {
          const radios: any = document.querySelector('mjs-demo')._shadow.querySelectorAll('mjs-radio')
          radios[2]._shadow.querySelector('input.native').click()
        })
        await page.waitForFunction(() => {
          const radios: any = document.querySelector('mjs-demo')._shadow.querySelectorAll('mjs-radio')
          return radios[2]._shadow.querySelector('input.native').checked === true && radios[1]._shadow.querySelector('input.native').checked === false
        })
        fd = await page.evaluate(() => {
          const form: any = document.querySelector('mjs-demo')._shadow.querySelector('#demo-form')
          return new FormData(form).get('size')
        })
        assert.equal(fd, 'l', 'bascule exclusive : le 3ᵉ radio (L) remplace le 2ᵉ, FormData ne porte plus que "l"')
      })

      it('@title — survol (Popover réel), sortie, focus clavier (Tab)', async function () {
        await page.mouse.move(2, 2)
        const rect = await page.evaluate(() => {
          const btn: any = document.querySelector('mjs-demo')._shadow.querySelector('#btn-delete')
          const r = btn.getBoundingClientRect()
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
        })
        await page.mouse.move(rect.x, rect.y)
        await page.waitForFunction((expected: string) => {
          const d: any = document.querySelector('mjs-demo')
          const bubble = d._shadow.querySelector('.mjs-title.mjs-title-visible')
          const btn = d._shadow.querySelector('#btn-delete')
          return !!bubble && bubble.textContent === expected && btn.getAttribute('aria-describedby') === bubble.id
        }, TITLE_DELETE, { timeout: 3000 })

        await page.mouse.move(2, 2)
        await page.waitForFunction(() => {
          const d: any = document.querySelector('mjs-demo')
          const btn = d._shadow.querySelector('#btn-delete')
          return !d._shadow.querySelector('.mjs-title-visible') && !btn.hasAttribute('aria-describedby')
        }, null, { timeout: 3000 })

        await page.evaluate(() => {
          const ae: any = document.activeElement
          if (ae && typeof ae.blur === 'function') ae.blur()
        })
        let landed = false
        for (let i = 0; i < 40 && !landed; i++) {
          await page.keyboard.press('Tab')
          landed = await page.evaluate(() => {
            const d: any = document.querySelector('mjs-demo')
            return d._shadow.activeElement === d._shadow.querySelector('#btn-submit')
          })
        }
        assert.equal(landed, true, 'le bouton #btn-submit doit être atteignable par Tab depuis un focus vide')

        await page.waitForFunction((expected: string) => {
          const d: any = document.querySelector('mjs-demo')
          const bubble = d._shadow.querySelector('.mjs-title.mjs-title-visible')
          return !!bubble && bubble.textContent === expected
        }, TITLE_SUBMIT, { timeout: 3000 })
      })

      it('zéro bruit console sur toute la session (hors HMR filtré)', function () {
        assert.equal(consoleIssues.length, 0, consoleIssues.join('\n'))
      })
    })
  }
})
