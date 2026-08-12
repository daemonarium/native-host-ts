import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))

function resolveAddonPath() {
  const candidates = [
    join(__dirname, 'build', 'Release', 'nativeHost.node'),
    join(__dirname, 'build', 'Debug', 'nativeHost.node'),
    join(__dirname, 'build', 'nativeHost.node'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }
  throw new Error(
    'nativeHost.node not found. Run: npm install / cmake-js compile in native-host'
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
