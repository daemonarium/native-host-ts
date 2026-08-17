#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CodecRegistry,
  deserializeTypeRegistry,
  ensureRpcCodecs,
  registerDynamicCodecs,
  SocketRpcClient,
  type LocalSocket,
} from '@wa-os/ts-rpc'
import { Direction, Kernel, LocalProcess, ModuleProcess } from '@wa-os/ts-kernel'
import {
  cleanupDir,
  createDbNative,
  createTsClient,
  fillViaRpc,
  makeDataDir,
  printPhase,
  registerInKernel,
  requireDbService,
  socketOpts,
  CLIENT_ID,
  DB_ID,
} from './harness.ts'

export const WASM_ID = 2

function parseArgs(argv: string[]) {
  let n = 10000
  let bufSize = 65536
  let doGet = true
  let doScan = true
  let wasmPath = process.env.DB_BENCH_WASM
    ?? join(
      dirname(fileURLToPath(import.meta.url)),
      '../../cmake-build-emscripten/examples/modules/db_bench_client.wasm'
    )
  for (const a of argv) {
    if (a.startsWith('--n=')) {
      n = Number(a.slice(4))
    } else if (a.startsWith('--buf-size=')) {
      bufSize = Number(a.slice(11))
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
  return { n, bufSize, doGet, doScan, wasmPath }
}

function methodId(registry: ReturnType<typeof deserializeTypeRegistry>, suffix: string): number {
  const methods = registry.getMethods()
  const hit = methods.find((m) => m.memberName === suffix || m.memberName.endsWith('.' + suffix))
  if (!hit) {
    throw new Error(`missing method ${suffix}; have ${methods.map((m) => m.memberName).join(',')}`)
  }
  return hit.methodId
}

async function main() {
  requireDbService()
  const cfg = parseArgs(process.argv.slice(2))
  console.log(
    `BENCH start n=${cfg.n} buf_size=${cfg.bufSize} layer=wasm wasm=${cfg.wasmPath}`
  )

  const dataDir = makeDataDir()
  const kernel = new Kernel()
  const db = await createDbNative(kernel, dataDir, cfg.bufSize)
  const { client, control, methods } = await createTsClient(kernel, db, cfg.bufSize, false)

  try {
    await fillViaRpc(control, methods, cfg.n)
    await kernel.unbind(CLIENT_ID, 0, DB_ID, 0, Direction.BOTH)

    const wasmCode = await readFile(cfg.wasmPath)
    const wasm = new ModuleProcess(kernel, WASM_ID, 2048, 10_000_000)
    await wasm.setModuleCode(wasmCode)
    await wasm.start()
    const setPid = wasm.instance?.exports.waos_set_process_id as ((pid: number) => void) | undefined
    if (!setPid) {
      throw new Error('db_bench_client.wasm is missing waos_set_process_id')
    }
    setPid(WASM_ID)
    registerInKernel(kernel, wasm, WASM_ID)

    await kernel.bind(WASM_ID, 1, DB_ID, 0, Direction.BOTH)
    await kernel.bind(WASM_ID, 2, DB_ID, 1, Direction.BOTH)

    const userSock = client.createSocket(10, socketOpts(cfg.bufSize))
    await kernel.bind(CLIENT_ID, 10, WASM_ID, 0, Direction.BOTH)

    const userRegistry = deserializeTypeRegistry(new Uint8Array(wasm.readRawRpcDescription(0)))
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
      printPhase('wasm', 'get', keys, Number(r.ms ?? 0))
    }

    if (cfg.doScan) {
      const r = await userClient.call(scanId) as {
        keys?: number | bigint
        ms?: number
        keys_per_s?: number
      }
      const keys = Number(r.keys ?? 0)
      printPhase('wasm', 'scan', keys, Number(r.ms ?? 0))
    }

    console.log('BENCH done')
    await wasm.kill(undefined)
  } finally {
    await db.kill(undefined)
    await client.kill(undefined)
    cleanupDir(dataDir)
  }
}

main().catch((err) => {
  console.error('BENCH FAIL', err)
  process.exit(1)
})
