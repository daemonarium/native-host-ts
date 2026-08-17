import { expect } from 'chai'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
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
import { setupTestEnvironment, type TestContext } from '../../kernel-shield/ts-test/src/setup.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../..')
const KV_WASM = join(ROOT, 'cmake-build-emscripten/kv-storage-mem.wasm')
const CLIENT_WASM = join(ROOT, 'cmake-build-emscripten/examples/modules/db_bench_client.wasm')

const SHIELD_ID = 1
const SOCKET_OPTS = {
  inputBufferSize: 65536,
  outputBufferSize: 65536,
  flushThreshold: 65536,
  dataEventThreshold: 0,
  drainEventThreshold: 4,
  flags: 0,
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

function toBin(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function fromBin(b: Uint8Array | undefined): string {
  return new TextDecoder().decode(b ?? new Uint8Array())
}

function requireSetPid(mod: ModuleProcess, label: string): (pid: number) => void {
  const setPid = mod.instance?.exports.waos_set_process_id as ((pid: number) => void) | undefined
  if (!setPid) {
    throw new Error(`${label} is missing waos_set_process_id`)
  }
  return setPid
}

describe('db_bench_client WASM vs kv-storage-mem', () => {
  let ctx: TestContext
  let dbPid: number
  let wasmClientPid: number
  let user: SocketRpcClient
  let methods: {
    connect: number
    set: number
    get: number
    scan_collect: number
  }

  before(async function () {
    this.timeout(30000)
    if (!existsSync(KV_WASM)) {
      throw new Error(`missing ${KV_WASM}; build with the emscripten cmake tree`)
    }
    if (!existsSync(CLIENT_WASM)) {
      throw new Error(`missing ${CLIENT_WASM}; build db_bench_client with the emscripten cmake tree`)
    }

    ctx = await setupTestEnvironment()

    const dbCode = await readFile(KV_WASM)
    dbPid = await ctx.kernel.spawn(dbCode, 2048, 10_000_000)
    const db = ctx.kernel.processes[dbPid] as ModuleProcess
    expect(db).to.be.ok
    requireSetPid(db, 'kv-storage-mem.wasm')(dbPid)

    const registerId = methodId(ctx.rpcRegistry, 'register_process')
    const bindId = methodId(ctx.rpcRegistry, 'bind')
    await ctx.rpcClient.call(registerId, dbPid, 0, false)
    await ctx.rpcClient.call(
      bindId,
      dbPid,
      1,
      SHIELD_ID,
      (dbPid << 1) | 1,
      Direction.BOTH
    )

    const clientCode = await readFile(CLIENT_WASM)
    wasmClientPid = await ctx.kernel.spawn(clientCode, 2048, 10_000_000)
    const wasmClient = ctx.kernel.processes[wasmClientPid] as ModuleProcess
    expect(wasmClient).to.be.ok
    requireSetPid(wasmClient, 'db_bench_client.wasm')(wasmClientPid)
    await ctx.rpcClient.call(registerId, wasmClientPid, 0, false)

    await ctx.kernel.bind(wasmClientPid, 1, dbPid, 0, Direction.BOTH)

    const tsPid = await ctx.kernel.spawnLocal(10_000_000)
    const ts = ctx.kernel.processes[tsPid] as LocalProcess
    await ctx.rpcClient.call(registerId, tsPid, 0, false)

    const userRegistry = deserializeTypeRegistry(new Uint8Array(wasmClient.readRawRpcDescription(0)))
    userRegistry.assignMethodIds()
    const userCodecs = new CodecRegistry()
    registerDynamicCodecs(userCodecs, userRegistry)
    ensureRpcCodecs(userCodecs, userRegistry)
    methods = {
      connect: methodId(userRegistry, 'connect'),
      set: methodId(userRegistry, 'set'),
      get: methodId(userRegistry, 'get'),
      scan_collect: methodId(userRegistry, 'scan_collect'),
    }

    const userSock = ts.createSocket(0, SOCKET_OPTS)
    await ctx.kernel.bind(tsPid, 0, wasmClientPid, 0, Direction.BOTH)
    user = new SocketRpcClient(userSock as LocalSocket, userRegistry, userCodecs)
  })

  it('connect, set/get, tombstone, scan_collect', async () => {
    await user.call(methods.connect)

    await user.call(methods.set, toBin('a'), toBin('A'), 1n)
    const ga = await user.call(methods.get, toBin('a')) as {
      present: boolean
      value: Uint8Array
      timestamp: bigint
    }
    expect(ga.present).to.equal(true)
    expect(fromBin(ga.value)).to.equal('A')
    expect(Number(ga.timestamp)).to.equal(1)

    await user.call(methods.set, toBin('a'), toBin(''), 2n)
    const tomb = await user.call(methods.get, toBin('a')) as {
      present: boolean
      value: Uint8Array
      timestamp: bigint
    }
    expect(tomb.present).to.equal(true)
    expect(tomb.value.length).to.equal(0)
    expect(Number(tomb.timestamp)).to.equal(2)

    await user.call(methods.set, toBin('b'), toBin('B'), 3n)
    await user.call(methods.set, toBin('c'), toBin('C'), 4n)
    await user.call(methods.set, toBin('d'), toBin('D'), 5n)

    const count = Number(await user.call(methods.scan_collect))
    expect(count).to.be.at.least(3)
  })
})
