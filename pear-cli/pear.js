#!/usr/bin/env node
const Hypercore = require('hypercore')
const HypercoreID = require('hypercore-id-encoding')
const os = require('os')
const path = require('path')
const fs = require('fs')

const PEAR_KEY = 'ibrjgm3s6ztkqt5ep4wsy5ushnbccdiyp9etp3uueckow6bacpso'
const DKEY = Hypercore.discoveryKey(HypercoreID.decode(PEAR_KEY)).toString('hex')

const IS_WIN = process.platform === 'win32'
const HOST = process.platform + '-' + process.arch

const PEAR_DIR = process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Application Support', 'pear')
  : process.platform === 'linux'
    ? path.join(os.homedir(), 'tmp', 'pear') // todo
    : path.join(os.homedir(), 'tmp', 'pear') // todo

const LINK = path.join(PEAR_DIR, 'current')
const BIN = path.join(PEAR_DIR, 'bin')
const CURRENT_BIN = path.join(LINK, 'by-arch', HOST, 'bin/pear-runtime' + (IS_WIN ? '.exe' : ''))

if (isInstalled()) {
  require('child_process').spawn(CURRENT_BIN, process.argv.slice(2), {
    stdio: 'inherit'
  }).on('exit', function (code) {
    process.exit(code)
  })
  return
}

const bootstrap = require('pear-updater-bootstrap')

console.log('Installing Pear Runtime (this might take a bit...)')
bootstrap(PEAR_KEY, PEAR_DIR).then(function () {
  console.log('Pear Runtime installed!')
  console.log()
  console.log('Finish the installation by opening the runtime app')
  console.log()
  console.log('pear run pear://runtime')
  if (!IS_WIN) {
    console.log()
    console.log('Or by adding the following to your path')
    console.log()
    console.log('export PATH="' + BIN + ':$PATH"')
  }
})

function makeBin () {
  if (IS_WIN) return
  try {
    fs.mkdirSync(BIN, { recursive: true })
    fs.symlinkSync(CURRENT_BIN, path.join(BIN, 'pear'))
  } catch {}
}

function isInstalled () {
  try {
    const p = fs.realpathSync(LINK)
    return path.basename(path.dirname(p)) === DKEY
  } catch {
    return false
  }
}