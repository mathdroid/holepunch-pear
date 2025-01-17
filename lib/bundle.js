'use strict'
const pipeline = require('streamx').pipelinePromise
const Hyperdrive = require('hyperdrive')
const DriveBundler = require('drive-bundler')
const hypercoreid = require('hypercore-id-encoding')
const Tracer = require('./tracer')
const Replicator = require('./replicator')
const { SWAP } = require('./constants')
const noop = Function.prototype

module.exports = class Bundle {
  platformVersion = null
  warmup = { blocks: 0, total: 0 }
  #log = null

  static async provisioned (corestore, key) {
    const drive = new Hyperdrive(corestore.session(), key)
    await drive.ready()
    const res = drive.core.length > 0
    await drive.close()
    return res
  }

  constructor (opts = {}) {
    const {
      corestore = false, drive = false, checkout = 'release', appling,
      key, channel, trace = null, stage = false, log = noop, failure,
      updateNotify
    } = opts
    this.checkout = checkout
    this.appling = appling
    this.key = key ? Buffer.from(key, 'hex') : null
    this.hexKey = this.key ? this.key.toString('hex') : null
    this.channel = channel || null
    this.local = !this.key
    this.log = log
    this.failure = failure
    this.corestore = corestore
    this.trace = trace
    this.stage = stage
    this.drive = drive || new Hyperdrive(this.corestore, this.key)
    this.tracer = null
    if (this.corestore) {
      this.replicator = new Replicator(this.drive, { appling: this.appling })
      this.replicator.on('announce', () => this.log({ tag: 'announced' }))
      this.drive.core.on('peer-add', (peer) => {
        this.log({ tag: 'peer-add', data: peer.remotePublicKey.toString('hex') })
      })
      this.drive.core.on('peer-remove', (peer) => {
        this.log({ tag: 'peer-remove', data: peer.remotePublicKey.toString('hex') })
      })
    } else {
      this.replicator = null
    }
    if (typeof updateNotify === 'function') this.#updates(updateNotify)

    this.release = null

    this.batch = null
    this.ranges = null
    this.queue = []
    this.closed = false

    this.progress = this.progresser()

    this.announcing = null
    this.leaving = null
    this.swarm = null

    this.initializing = this.#init()

    this._onseq = this.trace ? this.trace.instrument() : null
  }

  async #updates (updateNotify) {
    await this.ready()
    for await (const [current] of this.drive.watch()) {
      const release = await current.db.get('release')?.value
      if (release && this.drive.version === release) continue
      updateNotify(
        { key: this.hexKey, length: current.version, fork: current.core.fork }
      )
    }
  }

  startTracing () {
    this.tracer = new Tracer()
    return this.tracer
  }

  async finalizeTracing () {
    if (this.opened === false) throw new Error('Internal Platform Error: Bundle must be opened before warmup can commence')
    if (!this.tracer) throw new Error('Internal Platform Error: Bundle critical called without a tracer present')
    const ranges = this.tracer.deflate()
    await this.drive.db.put('warmup', ranges)
  }

  async #init () {
    await this.drive.ready()
    if (this.channel && this.drive.db.feed.writable) {
      const existing = await this.drive.db.get('channel')
      if (!existing || existing.value !== this.channel) {
        await this.drive.db.put('channel', this.channel)
      }
    }
  }

  get version () {
    return this.drive.version
  }

  get db () {
    return this.drive.db
  }

  get discoveryKey () {
    return this.drive.discoveryKey
  }

  get opened () {
    return this.drive.opened
  }

  async fatal (err) {
    try {
      this.log({ tag: 'bundle-error', data: err })
      if (typeof this.failure === 'function') {
        await this.failure(err)
      } else {
        throw err
      }
    } finally {
      await this.close()
    }
  }

  async ready () {
    await this.initializing
  }

  entry (key) {
    return this.drive.entry(key, { onseq: this._onseq })
  }

  compare (...args) {
    return this.drive.compare(...args)
  }

  async get (key) {
    const entry = await this.entry(key)
    const result = await this.drive.get(entry)
    if (this.trace && result !== null) {
      if (entry.value.blob) await this.trace.capture([entry.value.blob.blockLength, entry.value.blob.blockOffset])
    }
    return result
  }

  async has (key) {
    const meta = await this.entry(key)
    return meta !== null
  }

  async del (key) {
    return await this.drive.del(key)
  }

  async streamFrom (key) {
    const meta = await this.entry(key)
    if (meta === null) return null
    const stream = this.drive.createReadStream(meta)
    if (this.trace && meta.value.blob) await this.trace.capture([meta.value.blob.blockLength, meta.value.blob.blockOffset])
    return stream
  }

  async flush () {
    if (!this.batch) return
    await this.batch.flush()
    this.batch = null
  }

  async drain () {
    await this.flush()
    const queue = this.queue.splice(-this.queue.length)
    if (queue.length === 0) return
    await Promise.allSettled(queue)
    await this.drain()
  }

  get live () {
    return !!(this.checkout === 'release' && this.release)
  }

  async bundle () {
    if (!this.opened) await this.ready()
    const id = this.drive.id || 'dev'
    const res = await DriveBundler.bundle(this.drive, {
      entrypoint: '.',
      cwd: SWAP,
      absolutePrebuilds: true,
      mount: 'pear://' + id
    })

    return { key: id, ...res }
  }

  absorbReadStream (key, readStream, metadata) {
    this.batch = this.batch || this.drive.batch()
    const inner = async () => {
      try {
        const writeStream = this.drive.createWriteStream(key, { metadata })
        await pipeline(readStream, writeStream)
      } finally {
        this.queue.splice(this.queue.findIndex((p) => p === promise), 1)
      }
    }
    const promise = inner()
    this.queue.push(promise)
    return promise
  }

  async join (swarm, { seeders, server = false, client = true } = {}) {
    if (this.announcing) return this.announcing
    const announceSeeds = seeders ? seeders.split(',').map((s) => hypercoreid.decode(s)) : null
    this.swarm = swarm
    this.announcing = this.replicator.join(swarm, { announceSeeds, server, client })
    this.announcing.then(() => { this.leaving = null })
    this.announcing.catch(err => this.fatal(err))
    return this.announcing
  }

  async leave () {
    if (!this.swarm) return
    if (this.leaving) return this.leaving
    this.leaving = this.replicator.leave(this.swarm)
    this.leaving.then(() => { this.announcing = null })
    this.leaving.catch(err => this.fatal(err))
    return this.leaving
  }

  async calibrate () {
    await this.ready()

    if (this.stage === false && !this.trace) {
      if (this.checkout === 'release') {
        this.release = (await this.db.get('release'))?.value
        if (this.release) this.drive = this.drive.checkout(this.release)
      } else if (Number.isInteger(+this.checkout)) {
        this.drive = this.drive.checkout(+this.checkout)
      }
    }

    const { db } = this.drive
    this.platformVersion = ((await db.get('platformVersion'))?.value) || null

    if (this.channel === null) this.channel = (await db.get('channel'))?.value || ''

    const warmup = (await db.get('warmup'))?.value

    if (warmup) {
      this.ranges = Tracer.inflate(warmup.meta, warmup.data)
      this.prefetch(this.ranges)
    }
  }

  async * progresser () {
    if (this.local) {
      // no need for critical path, bail
      yield 100
      return
    }

    if (this.ranges) {
      await this.prefetch(this.ranges)
    }

    // TODO calculate percentage (need hypercore api updates to be able to do this)

    yield 100
  }

  async prefetch ({ meta = { start: 0, end: -1 }, data = { start: 0, end: -1 } } = {}) {
    if (Array.isArray(meta) === false) meta = [meta]
    if (Array.isArray(data) === false) data = [data]
    await this.drive.downloadRange(meta, data)
  }

  async close () {
    this.closed = true
    await this.leave()
    if (this.trace) this.trace.push(null)
    if (this.tracer) this.tracer.destroy()
    await this.drain()
    await this.drive.close()
  }
}
