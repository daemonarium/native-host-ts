import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))

function resolveAddonPath() {
  const roots = []
  if (process.env.NATIVE_HOST_BUILD) {
    roots.push(join(__dirname, process.env.NATIVE_HOST_BUILD))
  }
  roots.push(join(__dirname, 'build'))
  const candidates = []
  for (const root of roots) {
    candidates.push(
      join(root, 'Release', 'nativeHost.node'),
      join(root, 'Debug', 'nativeHost.node'),
      join(root, 'nativeHost.node'),
    )
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }
  throw new Error(
    'nativeHost.node not found. Run npm install in this package so cmake-js can compile it.'
  )
}

const addon = require(resolveAddonPath())

export default addon
export const {
  createNativeProcess,
  openSocket,
  closeSocket,
  isSocketOpen,
  handleData,
  handleDrain,
  flush,
  drain,
  setFlushCallback,
  setDrainCallback,
  registerSocketHandler,
  kill,
  isAlive,
  id,
  socketCount,
  inputBufferRef,
  outputBufferRef,
  bufferReadableBytes,
  bufferWritableBytes,
  bufferCapacity,
  bufferGetSize,
  bufferGetReadOffset,
  bufferSetReadOffset,
  bufferGetWriteOffset,
  bufferSetWriteOffset,
  bufferWrite,
  bufferRead,
  bufferPeek,
  bufferPoke,
  bufferSkipRead,
  bufferCommitWrite,
  bufferClear,
  bufferReadableViews,
  copyToNative,
  listServices,
} = addon
