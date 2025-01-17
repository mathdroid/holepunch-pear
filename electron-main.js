'use strict'
const IPC = require('./ipc/main')
const Context = require('./ctx/shared')
const { App } = require('./lib/gui')
const { SWAP, RUNTIME } = require('./lib/constants')
const crasher = require('./lib/crasher')
const connect = require('./lib/connect.js')

configureElectron()

electronMain().catch(console.error)

async function electronMain () {
  crasher('electron-main', SWAP)
  const channel = await connect()
  const ctx = new Context({
    argv: (process.argv.length > 1 && process.argv[1][0] === '-')
      ? process.argv.slice(1)
      : process.argv.slice(2)
  })
  if (ctx.error) {
    console.error(ctx.error)
    require('electron').app.quit(1)
    return
  }
  const client = channel
  const ipc = new IPC(ctx, client)

  if (await ipc.wakeup()) { // note: would be unhandled rejection on failure, but should never fail
    require('electron').app.quit(0)
    return
  }
  const app = new App(ctx)
  client.once('close', async () => { app.quit() })
  app.start(ipc).catch(console.error)
  await app.starting
  ipc.unloading().then(() => {
    app.close()
  }) // note: would be unhandled rejection on failure, but should never fail
}

function configureElectron () {
  const electron = require('electron')
  if (process.platform === 'linux') {
    linuxSetup(RUNTIME)
  }

  if (process.platform === 'win32') {
    const ap = applingPath()
    if (ap) {
      electron.app.setAsDefaultProtocolClient('holepunch', ap) // legacy
      electron.app.setAsDefaultProtocolClient('punch', ap) // legacy
      electron.app.setAsDefaultProtocolClient('pear', ap)
    }
  }

  const appName = applingName()
  if (appName) {
    process.title = appName
    electron.app.on('ready', () => { process.title = appName })
  }

  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'

  /* c8 ignore start */
  const inspix = process.argv.indexOf('--inspector-port')
  if (inspix > -1) {
    electron.app.commandLine.appendSwitch('remote-debugging-port', inspix + 1)
  }
  /* c8 ignore stop */
  electron.protocol.registerSchemesAsPrivileged([
    { scheme: 'file', privileges: { secure: true, bypassCSP: true, corsEnabled: true, supportFetchAPI: true, allowServiceWorkers: true } }
  ])

  // TODO: Remove when issue https://github.com/electron/electron/issues/29458 is resolved.
  electron.app.commandLine.appendSwitch('disable-features', 'WindowCaptureMacV2')

  // Needed for running fully-local WebRTC proxies
  electron.app.commandLine.appendSwitch('allow-loopback-in-peer-connection')

  if (process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland') {
    electron.app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer,WaylandWindowDecorations')
    electron.app.commandLine.appendSwitch('ozone-platform-hint', 'auto')
  }
}

function applingPath () {
  const i = process.argv.indexOf('--appling')
  if (i === -1 || process.argv.length <= i + 1) return null
  return process.argv[i + 1]
}

function applingName () {
  const a = applingPath()
  if (!a) return null

  if (process.platform === 'darwin') {
    const end = a.indexOf('.app')
    if (end === -1) return null
    const start = a.lastIndexOf('/', end) + 1
    return a.slice(start, end)
  }

  if (process.platform === 'win32') {
    const name = a.slice(a.lastIndexOf('\\') + 1).replace(/\.exe$/i, '')
    return name || null
  }

  return null
}

function linuxSetup (executable) {
  const fs = require('fs')
  const os = require('os')
  const { join } = require('path')
  const { execSync } = require('child_process')
  const APP_NAME = 'Keet'
  const ICON_NAME = 'keet'
  const DESKTOP_FILE_NAME = 'keet.desktop'
  const DESKTOP_FILE_PATH = join(os.homedir(), '.local', 'share', 'applications', DESKTOP_FILE_NAME)
  const MIME_TYPES = [
    'x-scheme-handler/holepunch', // legacy
    'x-scheme-handler/punch', // legacy
    'x-scheme-handler/pear' // pear
  ]

  if (!executable) return
  try {
    if (!checkDesktopFile(executable)) {
      fs.writeFileSync(DESKTOP_FILE_PATH, generateDesktopFile(executable), { encoding: 'utf-8' })
    }
    for (const mimeType of MIME_TYPES) {
      if (!checkMimeType(mimeType)) {
        registerMimeType(mimeType)
      }
    }
  } catch (err) {
    console.warn('could not install protocol handler:', err)
  }

  function checkDesktopFile () {
    try {
      fs.statSync(DESKTOP_FILE_PATH)
      return true
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
      return false
    }
  }

  function checkMimeType (mimeType) {
    return execSync(`xdg-mime query default ${mimeType}`) === DESKTOP_FILE_NAME
  }

  function registerMimeType (mimeType) {
    return execSync(`xdg-mime default ${DESKTOP_FILE_NAME} ${mimeType}`)
  }

  function generateDesktopFile (executable) {
    return `\
  [Desktop Entry]
  Name=${APP_NAME}
  Exec=${executable} %U
  Terminal=false
  Icon=${ICON_NAME}
  Type=Application
  StartupWMClass=${APP_NAME}
  X-AppImage-Version=1.0.1
  Comment=${APP_NAME}
  MimeType=${MIME_TYPES.join(';')}
  `
  }
}
