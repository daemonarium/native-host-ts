import { expect } from 'chai'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Direction, LocalProcess, ModuleProcess } from '@wa-os/ts-kernel'
import {
  deserializeTypeRegistry,
  SocketRpcClient,
  type LocalSocket,
} from '@wa-os/ts-rpc'
import { setupTestEnvironment, type TestContext } from '../../kernel-shield/ts-test/src/setup.ts'
import {
  attachDbMessages,
  createDbCodecs,
  DURABLE_OPTS,
  emptyScanQuery,
  channelHandle,
  streamHandle,
  type DbMethods,
} from '../bench/dbRegistry.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../..')
const KV_WASM = join(ROOT, 'cmake-build-emscripten/kv-storage-mem.wasm')

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
    (m) => m.memberName === suffix || m.memberName.endsWith('.' + suffix) || m.memberName.endsWith(suffix)
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

describe('kv-storage-mem WASM RAM DB', () => {
  let ctx: TestContext
  let dbPid: number
  let clientPid: number
  let client: LocalProcess
  let db: ModuleProcess
  let control: SocketRpcClient
  let priv: SocketRpcClient
  let methods: Omit<DbMethods, 'cancel_scan'>
  let scanWaiter: {
    items: Array<{ key: string, value: string, uid: bigint }>
    keys: string[]
    resolve: (result: {
      items: Array<{ key: string, value: string, uid: bigint }>
      keys: string[]
    }) => void
    reject: (err: Error) => void
  } | null = null

  function waitScan() {
    const items: Array<{ key: string, value: string, uid: bigint }> = []
    const keys: string[] = []
    return new Promise<{
      items: Array<{ key: string, value: string, uid: bigint }>
      keys: string[]
    }>((resolve, reject) => {
      scanWaiter = { items, keys, resolve, reject }
    })
  }

  before(async function () {
    this.timeout(60000)
    if (!existsSync(KV_WASM)) {
      throw new Error(`missing ${KV_WASM}; build with the emscripten cmake tree`)
    }
    ctx = await setupTestEnvironment()
    const code = await readFile(KV_WASM)
    dbPid = await ctx.kernel.spawn(code, 2048, 10_000_000)
    db = ctx.kernel.processes[dbPid] as ModuleProcess
    expect(db).to.be.ok

    const setPid = db.instance?.exports.waos_set_process_id as ((pid: number) => void) | undefined
    if (!setPid) {
      throw new Error('kv-storage-mem.wasm is missing waos_set_process_id')
    }
    setPid(dbPid)

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

    clientPid = await ctx.kernel.spawnLocal(10_000_000)
    client = ctx.kernel.processes[clientPid] as LocalProcess
    await ctx.rpcClient.call(registerId, clientPid, 0, false)

    const dbRegistry = deserializeTypeRegistry(new Uint8Array(db.readRawRpcDescription(0)))
    dbRegistry.assignMethodIds()
    const codecs = createDbCodecs(dbRegistry)
    methods = {
      get: methodId(dbRegistry, 'get'),
      set: methodId(dbRegistry, 'set'),
      batch: methodId(dbRegistry, 'batch'),
      open_socket: methodId(dbRegistry, 'open_socket'),
      close_socket: methodId(dbRegistry, 'close_socket'),
      start_scan: methodId(dbRegistry, 'start_scan'),
    }

    const controlSock = client.createSocket(0, SOCKET_OPTS)
    await ctx.kernel.bind(clientPid, 0, dbPid, 0, Direction.BOTH)
    control = new SocketRpcClient(controlSock as LocalSocket, dbRegistry, codecs)
    attachDbMessages(control)

    const privateSock = client.createSocket(1, SOCKET_OPTS)
    priv = new SocketRpcClient(privateSock as LocalSocket, dbRegistry, codecs)
    attachDbMessages(priv)
    priv.onMessage('stream_item', (msg) => {
      const m = msg as { key: Uint8Array, value: Uint8Array, stream_id: bigint }
      scanWaiter?.items.push({ key: fromBin(m.key), value: fromBin(m.value), uid: m.stream_id })
    })
    priv.onMessage('stream_key', (msg) => {
      scanWaiter?.keys.push(fromBin((msg as { key: Uint8Array }).key))
    })
    priv.onMessage('stream_done', () => {
      const w = scanWaiter
      scanWaiter = null
      w?.resolve({ items: w.items, keys: w.keys })
    })
    priv.onMessage('stream_reset', () => {
      if (scanWaiter) {
        scanWaiter.items.length = 0
        scanWaiter.keys.length = 0
      }
    })
    priv.onMessage('stream_error', (msg) => {
      const w = scanWaiter
      scanWaiter = null
      w?.reject(new Error((msg as { message?: string }).message ?? 'scan error'))
    })

    const opened = new Promise<void>((resolve) => {
      priv.onMessage('socket_opened', () => resolve())
    })
    await control.call(methods.open_socket, channelHandle(clientPid, 1))
    await opened
  })

  it('set/get and tombstone', async () => {
    await control.call(methods.set, toBin('a'), toBin('A'), 1n, DURABLE_OPTS)
    const ga = await control.call(methods.get, toBin('a')) as {
      present: boolean
      value: Uint8Array
      timestamp: bigint
    }
    expect(ga.present).to.equal(true)
    expect(fromBin(ga.value)).to.equal('A')
    expect(Number(ga.timestamp)).to.equal(1)

    await control.call(methods.set, toBin('a'), toBin(''), 2n, DURABLE_OPTS)
    const tomb = await control.call(methods.get, toBin('a')) as {
      present: boolean
      value: Uint8Array
      timestamp: bigint
    }
    expect(tomb.present).to.equal(true)
    expect(tomb.value.length).to.equal(0)
    expect(Number(tomb.timestamp)).to.equal(2)

    const missing = await control.call(methods.get, toBin('zzz')) as { present: boolean }
    expect(missing.present).to.equal(false)
  })

  it('batch + forward scan', async () => {
    await control.call(methods.batch, [
      { key: toBin('b'), value: toBin('B'), timestamp: 3n },
      { key: toBin('c'), value: toBin('C'), timestamp: 4n },
    ], DURABLE_OPTS)
    const done = waitScan()
    await control.call(methods.start_scan, streamHandle(clientPid, 1, 1n), emptyScanQuery(false))
    const result = await done
    const keys = result.items.map((i) => i.key)
    expect(keys).to.include('b')
    expect(keys).to.include('c')
  })

  it('keys_only reverse scan with limit', async () => {
    const done = waitScan()
    await control.call(methods.start_scan, streamHandle(clientPid, 1, 2n), {
      ...emptyScanQuery(true),
      reverse: true,
      limit: 2n,
    })
    const result = await done
    expect(result.keys.length).to.equal(2)
  })

  it('stream_cancel on the private channel emits stream_done', async () => {
    const entries = []
    for (let i = 0; i < 40; i++) {
      const n = String(i).padStart(3, '0')
      entries.push({ key: toBin(`z${n}`), value: toBin('v'), timestamp: BigInt(1000 + i) })
    }
    await control.call(methods.batch, entries, DURABLE_OPTS)

    const streamId = 99n
    const done = waitScan()
    await control.call(methods.start_scan, streamHandle(clientPid, 1, streamId), emptyScanQuery(false))
    priv.sendMessage('stream_cancel', { stream_id: streamId })
    const result = await done
    expect(result).to.be.ok
  })

  it('notify_visible / notify_durable order matches write mode', async () => {
    const events: string[] = []
    control.onMessage('db_visible_event', () => events.push('visible'))
    control.onMessage('db_durable_event', () => events.push('durable'))

    await control.call(methods.set, toBin('n1'), toBin('x'), 20n, {
      mode: 0,
      notify_visible: true,
      notify_durable: true,
    })
    expect(events.slice(-2)).to.deep.equal(['durable', 'visible'])

    await control.call(methods.set, toBin('n2'), toBin('y'), 21n, {
      mode: 1,
      notify_visible: true,
      notify_durable: true,
    })
    expect(events.slice(-2)).to.deep.equal(['visible', 'durable'])
  })

  it('live overwrite is visible on the next scan', async () => {
    await control.call(methods.set, toBin('live'), toBin('old'), 30n, DURABLE_OPTS)
    await control.call(methods.set, toBin('live'), toBin('new'), 31n, DURABLE_OPTS)
    const done = waitScan()
    await control.call(methods.start_scan, streamHandle(clientPid, 1, 2n), {
      ...emptyScanQuery(false),
      lower: toBin('live'),
      lower_mode: 2,
      upper: toBin('live'),
      upper_mode: 2,
    })
    const result = await done
    expect(result.items.map((i) => i.value)).to.deep.equal(['new'])
  })

  it('delta scan emits only keys newer than since_timestamp', async () => {
    await control.call(methods.set, toBin('d1'), toBin('1'), 100n, DURABLE_OPTS)
    await control.call(methods.set, toBin('d2'), toBin('2'), 101n, DURABLE_OPTS)
    await control.call(methods.set, toBin('d3'), toBin('3'), 102n, DURABLE_OPTS)
    const done = waitScan()
    await control.call(
      methods.start_scan,
      streamHandle(clientPid, 1, 3n, 101n),
      emptyScanQuery(false)
    )
    const result = await done
    const hit = result.items.filter((i) => i.key.startsWith('d'))
    expect(hit.map((i) => i.key)).to.deep.equal(['d3'])
  })
})
