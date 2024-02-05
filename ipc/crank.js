'use strict'
const os = require('bare-os')
const path = require('bare-path')
const fs = require('bare-fs')
const { spawn } = require('bare-subprocess')
const { Readable } = require('streamx')
const fsext = require('fs-native-extensions')
const constants = require('../lib/constants')

class Crank {
  starting = null
  usage = null
  constructor (client) {
    this.client = client
  }

  async * run ({ args, dev, key = null, dir = null, dbgport = null, silent = false }) {

    return require('../lib/run')(this.client, key) // TODO clean up, fully integrate

    if (key !== null) args = [...args.filter((arg) => arg !== key), '--run', key]
    if (dev === true && args.includes('--dev') === false) args = ['--dev', ...args]
    args = args.map(String)

    // if desktop appling don't do this, just spawn DESKTOP_RUNTIME
    const { startId, type } = await this.start(args, os.getEnv(), os.cwd())
    args.push('--start-id=' + startId)

    const terminal = type === 'terminal'

    if (terminal) args = [...args, '--ua', 'pear/' + type]

    const iterable = new Readable({ objectMode: true })
    if (terminal === false) iterable.push({ tag: 'loaded', data: { forceClear: true } })

    const runtime = terminal ? constants.TERMINAL_RUNTIME : constants.DESKTOP_RUNTIME
    if (terminal) iterable.push({ tag: 'loaded' })
    else args = [path.resolve(__dirname, '..'), ...args]
    const child = spawn(runtime, args, {
      stdio: silent ? 'ignore' : ['inherit', 'pipe', 'pipe'],
      ...(terminal ? {} : { env: { ...os.getEnv(), NODE_PRESERVE_SYMLINKS: 1 } })
    })
    child.once('exit', (code) => { iterable.push({ tag: 'exit', data: { code } }) })

    if (silent === false) {
      child.stdout.on('data', (data) => { iterable.push({ tag: 'stdout', data }) })
      child.stderr.on('data', terminal
        ? (data) => { iterable.push({ tag: 'stderr', data }) }
        : (data) => {
            const str = data.toString()
            const ignore = str.indexOf('DevTools listening on ws://') > -1 ||
              str.indexOf('NSApplicationDelegate.applicationSupportsSecureRestorableState') > -1 ||
              str.indexOf('devtools://devtools/bundled/panels/elements/elements.js') > -1 ||
              str.indexOf('sysctlbyname for kern.hv_vmm_present failed with status -1')
            if (ignore) return
            iterable.push({ tag: 'stderr', data })
          })
    }

    yield * iterable
  }

  address () {
    return this.client.request('address')
  }

  identify () {
    return this.client.request('identify')
  }

  start (...args) {
    return this.client.request('start', { args })
  }

  wakeup (link, storage, appdev) {
    return this.client.request('wakeup', { args: [link, storage, appdev] })
  }

  unloading () {
    return this.client.request('unloading', {}, { errorlessClose: true })
  }

  async closeClients () {
    return this.client.request('closeClients')
  }

  async shutdown () {
    if (this.client.closed) return
    this.client.notify('shutdown')

    const fd = await new Promise((resolve, reject) => fs.open(path.join(constants.PLATFORM_DIR, 'corestores', 'platform', 'primary-key'), 'r+', (err, fd) => {
      if (err) {
        reject(err)
        return
      }
      resolve(fd)
    }))

    await fsext.waitForLock(fd)

    await new Promise((resolve, reject) => fs.close(fd, (err) => {
      if (err) {
        reject(err)
        return
      }
      resolve()
    }))
  }

  respond (channel, responder) {
    return this.client.method(channel, responder)
  }

  unrespond (channel) {
    return this.client.method(channel, null)
  }

  request (params) {
    return this.client.request(params.channel, params)
  }

  notify (params) {
    return this.client.notify('request', params)
  }

  repl () { return this.client.request('repl') }

  release (params, opts) { return this.#op('release', params, opts) }

  stage (params, opts) { return this.#op('stage', params, opts) }

  seed (params, opts) { return this.#op('seed', params, opts) }

  info (params, opts) { return this.#op('info', params, opts) }

  dump (params, opts) { return this.#op('dump', params, opts) }

  async * iterable (channel, params, { eager = false } = {}) {
    let tick = null
    let incoming = new Promise((resolve) => { tick = resolve })
    const payloads = []
    const responder = (payload) => {
      payloads.push(payload)
      tick()
      incoming = new Promise((resolve) => { tick = resolve })
    }
    this.respond(`${channel}:iterable`, responder)
    this.client.notify('iterable', { channel, params, eager })
    try {
      do {
        while (payloads.length > 0) {
          const payload = payloads.shift()
          if (payload === null) return // end of iterable
          yield payload.value
        }
        await incoming
      } while (true)
    } finally {
      this.unrespond(`${channel}:iterable`)
    }
  }

  async * #op (name, params, { close = true } = {}) {
    let tick = null
    let incoming = new Promise((resolve) => { tick = resolve })
    const payloads = []
    const responder = (payload) => {
      payloads.push(payload)
      tick()
      incoming = new Promise((resolve) => { tick = resolve })
    }

    const rcv = `${name}:${params.id}`
    this.respond(rcv, responder)
    this.client.notify(name, params)

    try {
      do {
        while (payloads.length > 0) {
          const payload = payloads.shift()
          if (payload === null) return
          yield payload.value
        }
        await incoming
      } while (true)
    } finally {
      this.unrespond(rcv)
      if (close) this.close()
    }
  }

  close () {
    return this.client.close()
  }
}

module.exports = Crank