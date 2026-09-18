// token-bucket — seau à jetons PARTAGÉ (cf. src/server/token-bucket.ts) :
// classe déjà éprouvée en place (index.ts/render-server.ts, copies collées avant extraction) —
// ce fichier couvre surtout `isIdle` et `pruneIdleBuckets`, NEUFS avec l'extraction.

import assert from 'node:assert/strict'
import { TokenBucket, pruneIdleBuckets } from '../src/server/token-bucket.js'

describe('TokenBucket — seau à jetons', () => {
  it('take() consomme un jeton par appel, jusqu\'à épuisement', () => {
    const bucket = new TokenBucket(3, 1)
    assert.equal(bucket.take(), true)
    assert.equal(bucket.take(), true)
    assert.equal(bucket.take(), true)
  })

  it('refus à sec : le seau vide refuse une prise supplémentaire', () => {
    const bucket = new TokenBucket(2, 1)
    assert.equal(bucket.take(), true)
    assert.equal(bucket.take(), true)
    assert.equal(bucket.take(), false)
  })

  it('recharge dans le temps : un seau à sec redonne des jetons après un délai réel', async () => {
    const bucket = new TokenBucket(2, 50)   // 50 jetons/s → 1 tous les 20ms
    assert.equal(bucket.take(), true)
    assert.equal(bucket.take(), true)
    assert.equal(bucket.take(), false, 'seau à sec')
    await new Promise((r) => setTimeout(r, 80))   // largement > 20ms, recharge au moins 1 jeton
    assert.equal(bucket.take(), true, 'recharge après le délai')
  })

  it('isIdle() vrai pour un seau plein (jamais consommé), faux juste après un take()', () => {
    const bucket = new TokenBucket(5, 1)
    assert.equal(bucket.isIdle(), true)
    bucket.take()
    assert.equal(bucket.isIdle(), false)
  })
})

describe('pruneIdleBuckets — purge paresseuse d\'une carte de seaux par IP', () => {
  it('sous le plafond : ne retire rien, même des seaux pleins', () => {
    const buckets = new Map<string, TokenBucket>()
    buckets.set('1.1.1.1', new TokenBucket(3, 1))
    buckets.set('2.2.2.2', new TokenBucket(3, 1))
    pruneIdleBuckets(buckets, 5)
    assert.equal(buckets.size, 2)
  })

  it('au-dessus du plafond : retire les seaux pleins (isIdle)', () => {
    const buckets = new Map<string, TokenBucket>()
    for (let i = 0; i < 5; i++) buckets.set(`ip-${i}`, new TokenBucket(3, 1))
    pruneIdleBuckets(buckets, 3)
    assert.equal(buckets.size, 0)
  })

  it('au-dessus du plafond : garde le seau qui vient de consommer, retire les autres', () => {
    const buckets = new Map<string, TokenBucket>()
    for (let i = 0; i < 4; i++) buckets.set(`ip-${i}`, new TokenBucket(3, 1))
    const actif = new TokenBucket(3, 1)
    actif.take()
    buckets.set('ip-active', actif)
    pruneIdleBuckets(buckets, 3)
    assert.equal(buckets.size, 1)
    assert.equal(buckets.has('ip-active'), true)
  })
})
