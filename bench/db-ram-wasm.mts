#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Direction, LocalProcess, ModuleProcess } from '@wa-os/ts-kernel'
import {
  CodecRegistry,
  deserializeTypeRegistry,
  ensureRpcCodecs,
  registerDynamicCodecs,
  SocketRpcClient,
  type LocalSocket,
} from '@wa-os/ts-rpc'
import { setupTestEnvironment } from '../../kernel-shield/ts-test/src/setup.ts'
import { createDbCodecs } from './dbRegistry.ts'
import { fillViaRpc, printPhase } from './harness.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const KV_WASM = join(__dirname, '../../cmake-build-emscripten/kv-storage-mem.wasm')
const CLIENT_WASM = process.env.DB_BENCH_WASM
  ?? join(__dirname, '../../cmake-build-emscripten/examples/modules/db_bench_client.wasm')
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
  let wasmPath = CLIENT_WASM
  for (const a of argv) {
    if (a.startsWith('--n=')) {
      n = Number(a.slice(4))
    } else if (a.startsWith('--wasm=')) {
      wasmPath = a.slice(7)
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
  return { n, doGet, doScan, wasmPath }
}

function methodId(registry: ReturnType<typeof deserializeTypeRegistry>, suffix: string): number {
  const methods = registry.getMethods()
  const hit = methods.find(
    (m) => m.memberName === suffix || m.memberName.endsWith('.' + suffix)
  )
  if (!hit) {
    throw new Error(`missing method ${suffix}; have ${methods.map((m) => m.memberName).join(',')}`)
  }
  return hit.methodId
}

function requireSetPid(mod: ModuleProcess, label: string): (pid: number) => void {
  const setPid = mod.instance?.exports.waos_set_process_id as ((pid: number) => void) | undefined
  if (!setPid) {
    throw new Error(`${label} is missing waos_set_process_id`)
  }
  return setPid
}

async function main() {
  const cfg = parseArgs(process.argv.slice(2))
  console.log(
    `BENCH start n=${cfg.n} layer=ram-wasm-client kv=${KV_WASM} wasm=${cfg.wasmPath}`
  )

  const ctx = await setupTestEnvironment()
  const dbCode = await readFile(KV_WASM)
  const dbPid = await ctx.kernel.spawn(dbCode, 2048, 10_000_000)
  const db = ctx.kernel.processes[dbPid] as ModuleProcess
  requireSetPid(db, 'kv-storage-mem.wasm')(dbPid)

  const registerId = methodId(ctx.rpcRegistry, 'register_process')
  const bindId = methodId(ctx.rpcRegistry, 'bind')
  await ctx.rpcClient.call(registerId, dbPid, 0, false)
  await ctx.rpcClient.call(bindId, dbPid, 1, SHIELD_ID, (dbPid << 1) | 1, Direction.BOTH)

  const tsPid = await ctx.kernel.spawnLocal(10_000_000)
  const ts = ctx.kernel.processes[tsPid] as LocalProcess
  await ctx.rpcClient.call(registerId, tsPid, 0, false)

  const dbRegistry = deserializeTypeRegistry(new Uint8Array(db.readRawRpcDescription(0)))
  dbRegistry.assignMethodIds()
  const dbCodecs = createDbCodecs(dbRegistry)
  const dbMethods = {
    get: methodId(dbRegistry, 'get'),
    set: methodId(dbRegistry, 'set'),
    batch: methodId(dbRegistry, 'batch'),
    open_socket: methodId(dbRegistry, 'open_socket'),
    close_socket: methodId(dbRegistry, 'close_socket'),
    start_scan: methodId(dbRegistry, 'start_scan'),
    cancel_scan: methodId(dbRegistry, 'cancel_scan'),
  }

  const fillSock = ts.createSocket(0, SOCKET_OPTS)
  await ctx.kernel.bind(tsPid, 0, dbPid, 0, Direction.BOTH)
  const fillClient = new SocketRpcClient(fillSock as LocalSocket, dbRegistry, dbCodecs)
  await fillViaRpc(fillClient, dbMethods, cfg.n)
  await ctx.kernel.unbind(tsPid, 0, dbPid, 0, Direction.BOTH)

  const clientCode = await readFile(cfg.wasmPath)
  const wasmClientPid = await ctx.kernel.spawn(clientCode, 2048, 10_000_000)
  const wasmClient = ctx.kernel.processes[wasmClientPid] as ModuleProcess
  requireSetPid(wasmClient, 'db_bench_client.wasm')(wasmClientPid)
  await ctx.rpcClient.call(registerId, wasmClientPid, 0, false)
  await ctx.kernel.bind(wasmClientPid, 1, dbPid, 0, Direction.BOTH)

  const userSock = ts.createSocket(10, SOCKET_OPTS)
  await ctx.kernel.bind(tsPid, 10, wasmClientPid, 0, Direction.BOTH)
  const userRegistry = deserializeTypeRegistry(new Uint8Array(wasmClient.readRawRpcDescription(0)))
  userRegistry.assignMethodIds()
  const userCodecs = new CodecRegistry()
  registerDynamicCodecs(userCodecs, userRegistry)
  ensureRpcCodecs(userCodecs, userRegistry)
  const userClient = new SocketRpcClient(userSock as LocalSocket, userRegistry, userCodecs)
  const getId = methodId(userRegistry, 'bench_get')
  const scanId = methodId(userRegistry, 'bench_scan')

  if (cfg.doGet) {
    const r = await userClient.call(getId, cfg.n) as {
      keys?: number | bigint
      ms?: number
      keys_per_s?: number
    }
    const keys = Number(r.keys ?? 0)
    printPhase('ram-wasm-client', 'get', keys, Number(r.ms ?? 0))
  }

  if (cfg.doScan) {
    const r = await userClient.call(scanId) as {
      keys?: number | bigint
      ms?: number
      keys_per_s?: number
    }
    const keys = Number(r.keys ?? 0)
    printPhase('ram-wasm-client', 'scan', keys, Number(r.ms ?? 0))
  }

  console.log('BENCH done')
  await ctx.kernel.kill(wasmClientPid)
  await ctx.kernel.kill(dbPid)
}

main().catch((err) => {
  console.error('BENCH FAIL', err)
  process.exit(1)
})
