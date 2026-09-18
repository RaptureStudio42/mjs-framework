// loadAtBoot() ne doit JAMAIS lever pour une entrée restaurée `data: null` : une
// entrée invalide est journalisée et ignorée, le boot poursuit avec les entrées valides.
import assert from 'node:assert/strict'
import { createPersistEngine } from '../src/mjs-server/index.js'
import type { MjsServerPersistAdapter } from '../src/mjs-server/index.js'

describe('persist.ts — loadAtBoot() : entrée data: null', () => {
  it('une entrée data:null est ignorée avec avertissement, une entrée valide restaurée', async () => {
    const bouchon: MjsServerPersistAdapter = {
      load: async () => [{ id: 'x', data: null as any }, { id: 'y', data: { id: 'y', type: 'compteur' } as any }],
      save: () => {},
      remove: () => {},
    }
    const logs: Array<[string, string]> = []
    const engine = createPersistEngine({ adapter: bouchon, debounce: 150, snapshotEvery: 0 }, (level, msg) => logs.push([level, msg]))
    assert.ok(engine)
    const restaurees: string[] = []
    const restore = (data: any) => { restaurees.push(data.id); return true }
    await engine!.loadAtBoot(restore)
    assert.deepEqual(restaurees, ['y'])
    assert.ok(logs.some(([level]) => level === 'warn'), 'un avertissement doit être journalisé pour l\'entrée x')
  })
})
