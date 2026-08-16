#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Direction, LocalProcess, ModuleProcess } from '@wa-os/ts-kernel'
import {
  deserializeTypeRegistry,
  SocketRpcClient,
  type LocalSocket,
} from '@wa-os/ts-rpc'
import { setupTestEnvironment } from '../../kernel-shield/ts-test/src/setup.ts'
import { attachDbMessages, createDbCodecs, emptyScanQuery } from './dbRegistry.ts'
import { fillViaRpc, makeKey, printPhase } from './harness.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const KV_WASM = join(__dirname, '../../cmake-build-emscripten/kv-storage-mem.wasm')
const SHIELD_ID = 1
const SOCKET_OPTS = {
  inputBufferSize: 65536,
  outputBufferSize: 65536,
  flushThreshold: 65536,
  dataEventThreshold: 0,
  drainEventThreshold: 4,
  flags: 0,
}

function parseArgs(argv: string[]) {
  // Sequential 256-entry batches currently trap in WASM around ~3k keys;
  // 2k is enough to report get/scan keys/sec on the RAM DB module.
  let n = 2000
  let doGet = true
  let doScan = true
  for (const a of argv) {
    if (a.startsWith('--n=')) {
      n = Number(a.slice(4))
    } else if (a.startsWith('--phases=')) {
      doGet = false
      doScan = false
      for (const part of a.slice(9).split(',')) {
        if (part === 'get') doGet = true
        if (part === 'scan') doScan = true
      }
    } else if (a[0] !== '-') {
      n = Number(a)
    }
  }
  return { n, doGet, doScan }
}

function methodId(registry: ReturnType<typeof deserializeTypeRegistry>, suffix: string): number {
  const methods = registry.getMethods()
  const hit = methods.find(
    (m) => m.memberName === suffix || m.memberName.endsWith('.' + suffix) || m.memberName.endsWith(suffix)
  )
  if (!hit) {
    throw new Error(`missing method ${suffix}; have ${methods.map((m) => m.memberName).join(',')}`)
  }
  return hit.methodId
}

async function main() {
  const cfg = parseArgs(process.argv.slice(2))
  console.log(`BENCH start n=${cfg.n} layer=ram-wasm wasm=${KV_WASM}`)

  const ctx = await setupTestEnvironment()
  const code = await readFile(KV_WASM)
  const dbPid = await ctx.kernel.spawn(code, 2048, 10_000_000)
  const db = ctx.kernel.processes[dbPid] as ModuleProcess
  const setPid = db.instance?.exports.waos_set_process_id as ((pid: number) => void) | undefined
  if (!setPid) {
    throw new Error('kv-storage-mem.wasm is missing waos_set_process_id')
  }
  setPid(dbPid)

  const registerId = methodId(ctx.rpcRegistry, 'register_process')
  const bindId = methodId(ctx.rpcRegistry, 'bind')
  await ctx.rpcClient.call(registerId, dbPid, 0, false)
  await ctx.rpcClient.call(bindId, dbPid, 1, SHIELD_ID, (dbPid << 1) | 1, Direction.BOTH)

  const clientPid = await ctx.kernel.spawnLocal(10_000_000)
  const client = ctx.kernel.processes[clientPid] as LocalProcess
  await ctx.rpcClient.call(registerId, clientPid, 0, false)

  const dbRegistry = deserializeTypeRegistry(new Uint8Array(db.readRawRpcDescription(0)))
  dbRegistry.assignMethodIds()
  const codecs = createDbCodecs(dbRegistry)
  const methods = {
    get: methodId(dbRegistry, 'get'),
    set: methodId(dbRegistry, 'set'),
    batch: methodId(dbRegistry, 'batch'),
    open_socket: methodId(dbRegistry, 'open_socket'),
    close_socket: methodId(dbRegistry, 'close_socket'),
    start_scan: methodId(dbRegistry, 'start_scan'),
    cancel_scan: methodId(dbRegistry, 'cancel_scan'),
  }

  const controlSock = client.createSocket(0, SOCKET_OPTS)
  await ctx.kernel.bind(clientPid, 0, dbPid, 0, Direction.BOTH)
  const control = new SocketRpcClient(controlSock as LocalSocket, dbRegistry, codecs)
  attachDbMessages(control)

  const privateSock = client.createSocket(1, SOCKET_OPTS)
  const priv = new SocketRpcClient(privateSock as LocalSocket, dbRegistry, codecs)
  attachDbMessages(priv)
  const opened = new Promise<void>((resolve) => {
    priv.onMessage('db_socket_opened', () => resolve())
  })
  await control.call(methods.open_socket, BigInt(clientPid), 1)
  await opened

  await fillViaRpc(control, methods, cfg.n)

  if (cfg.doGet) {
    const t0 = performance.now()
    for (let i = 0; i < cfg.n; i++) {
      await control.call(methods.get, makeKey(i))
    }
    printPhase('ram-wasm', 'get', cfg.n, performance.now() - t0)
  }

  if (cfg.doScan) {
    const done = new Promise<number>((resolve, reject) => {
      let count = 0
      priv.onMessage('db_scan_item', () => {
        count++
      })
      priv.onMessage('db_scan_done', () => resolve(count))
      priv.onMessage('db_scan_error', (msg) => {
        reject(new Error((msg as { message?: string }).message ?? 'scan error'))
      })
    })
    const t0 = performance.now()
    await control.call(methods.start_scan, BigInt(clientPid), 1, emptyScanQuery(false))
    const keys = await done
    printPhase('ram-wasm', 'scan', keys, performance.now() - t0)
  }

  console.log('BENCH done')
  await ctx.kernel.kill(dbPid)
}

main().catch((err) => {
  console.error('BENCH FAIL', err)
  process.exit(1)
})
