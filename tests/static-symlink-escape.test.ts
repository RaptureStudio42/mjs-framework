// le service de fichiers statiques rejetait bien `..` et
// `\0` dans l'URL, mais lisait ensuite le chemin SANS résoudre les liens symboliques. Un lien posé
// DANS la racine servie et pointant ailleurs sortait donc de l'arborescence sans jamais écrire
// `..` : prouvé par un lien vers un fichier système, servi en HTTP 200 avec son contenu réel.
//
// Fix : `isRealPathWithin` compare les chemins RÉELS (liens résolus des deux côtés) avant lecture.
// La racine peut elle-même vivre derrière un lien — d'où la résolution des DEUX côtés, sans quoi
// un déploiement dont le dossier est un lien (courant : `current -> releases/2026-08-22`) rendrait
// 404 sur tout.

import { strict as assert } from 'node:assert'
import { mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { StaticServer } from '../src/server/index.ts'
import { mjsTmp } from './helpers/tmp.js'

async function get(port: number, path: string) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`)
  return { status: res.status, body: await res.text() }
}

describe('service statique — un lien symbolique ne sort pas de la racine servie', function () {
  this.timeout(15000)

  let base: string, server: any, port: number

  before(async () => {
    base = mjsTmp('symlink')
    const racine = join(base, 'servi')
    const dehors = join(base, 'dehors')
    mkdirSync(racine)
    mkdirSync(dehors)
    writeFileSync(join(racine, 'legitime.txt'), 'contenu legitime')
    writeFileSync(join(dehors, 'secret.txt'), 'CONTENU HORS RACINE')
    symlinkSync(join(dehors, 'secret.txt'), join(racine, 'fuite.txt'))
    symlinkSync(join(racine, 'legitime.txt'), join(racine, 'interne.txt'))

    server = new StaticServer({ rootDir: racine, port: 0, host: '127.0.0.1' })
    await server.start()
    port = server.server.address().port
  })

  after(async () => {
    if (server) await server.stop()
    rmSync(base, { recursive: true, force: true })
  })

  it('un fichier normal est servi', async () => {
    const r = await get(port, '/modularjs/legitime.txt')
    assert.equal(r.status, 200)
    assert.equal(r.body, 'contenu legitime')
  })

  it('un lien vers un fichier HORS de la racine → 404, contenu jamais divulgué', async () => {
    const r = await get(port, '/modularjs/fuite.txt')
    assert.equal(r.status, 404, 'AVANT le fix : 200 avec le contenu du fichier visé')
    assert.doesNotMatch(r.body, /CONTENU HORS RACINE/)
  })

  it('un lien INTERNE à la racine reste servi (le fix ne casse pas les liens légitimes)', async () => {
    const r = await get(port, '/modularjs/interne.txt')
    assert.equal(r.status, 200)
    assert.equal(r.body, 'contenu legitime')
  })
})
