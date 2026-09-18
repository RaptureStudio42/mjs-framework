// `mjs serveur` doit avoir le MÊME repli d'hôte que `mjs ws` (défaut
// loopback 127.0.0.1, --host prioritaire) et la MÊME borne de port (1-65535).

import assert from 'node:assert/strict'
import { buildServeurRunPlan } from '../src/cli/server.js'

describe('cli/server — buildServeurRunPlan (défaut host loopback)', () => {
  const noWarn = () => { throw new Error('aucun warn attendu ici') }

  it('host : aucune source → repli 127.0.0.1 (jamais toutes les interfaces)', () => {
    const plan = buildServeurRunPlan({ options: {} }, undefined, undefined, noWarn)
    assert.equal(plan.host, '127.0.0.1')
  })

  it('host : --host prioritaire sur serveur.host', () => {
    const plan = buildServeurRunPlan({ options: {} }, { host: '0.0.0.0' }, undefined, noWarn, '::')
    assert.equal(plan.host, '::')
  })

  it('host : serveur.host utilisé si --host absent', () => {
    const plan = buildServeurRunPlan({ options: {} }, { host: '0.0.0.0' }, undefined, noWarn)
    assert.equal(plan.host, '0.0.0.0')
  })

  it('host : --host chaîne vide = absent → repli 127.0.0.1', () => {
    const plan = buildServeurRunPlan({ options: {} }, undefined, undefined, noWarn, '  ')
    assert.equal(plan.host, '127.0.0.1')
  })

  it('port : hors plage (0-65535) lève', () => {
    assert.throws(() => buildServeurRunPlan({ options: {} }, undefined, 99999999, noWarn), /port/)
  })
})
