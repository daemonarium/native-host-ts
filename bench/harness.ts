import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Direction,
  Kernel,
  LocalProcess,
  NativeProcess,
  type Process,
} from '@wa-os/ts-kernel'
import type { LocalSocket } from '@wa-os/ts-rpc'
import nativeHost from '../index.js'
import {
  createDbCodecs,
  createDbRpcClient,
  createDbTypeRegistry,
  dbMethods,
  DURABLE_OPTS,
  type DbMethods,
} from './dbRegistry.ts'

export const CLIENT_ID = 0
export const DB_ID = 1
export const VALUE = new TextEncoder().encode('v0123456789abcd')

export function makeKey(i: number): Uint8Array {
  const s = `k${String(i).padStart(8, '0')}`
  return new TextEncoder().encode(s)
}

export function registerInKernel(kernel: Kernel, process: Process, id: number): void {
  while (kernel.processes.length <= id) {
    kernel.processes.push(null)
  }
  kernel.processes[id] = process
}

export function socketOpts(bufSize: number) {
  return {
    inputBufferSize: bufSize,
    outputBufferSize: bufSize,
    flushThreshold: bufSize,
    dataEventThreshold: 0,
    drainEventThreshold: 4,
    flags: 0,
  }
}

export function printPhase(
  layer: string,
  phase: string,
  keys: number,
  ms: number,
  flushes?: number
): number {
  const keysPerS = ms > 0 ? (keys * 1000) / ms : 0
  if (flushes !== undefined) {
    console.log(
      `BENCH layer=${layer} phase=${phase} keys=${keys} ms=${ms.toFixed(0)} keys_per_s=${keysPerS.toFixed(1)} flushes=${flushes}`
    )
  } else {
    console.log(
      `BENCH layer=${layer} phase=${phase} keys=${keys} ms=${ms.toFixed(0)} keys_per_s=${keysPerS.toFixed(1)}`
    )
  }
  return keysPerS
}

export function makeDataDir(): string {
  const dir = join(tmpdir(), `db_node_bench_${process.pid}_${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function requireDbService(): void {
  const services = nativeHost.listServices()
  if (!services.includes('db')) {
    throw new Error(
      "native-host was built without the db service. Run: npm run rebuild:db -w @wa-os/native-host"
    )
  }
}

export async function createDbNative(
  kernel: Kernel,
  dataDir: string,
  bufSize: number,
  socketCount = 16
): Promise<NativeProcess> {
  const db = new NativeProcess(
    kernel,
    DB_ID,
    10_000_000,
    socketCount,
    nativeHost,
    'db',
    { dataDir, bufSize }
  )
  registerInKernel(kernel, db, DB_ID)
  db.createSocket(0, socketOpts(bufSize))
  db.createSocket(1, socketOpts(bufSize))
  return db
}

export async function createTsClient(
  kernel: Kernel,
  db: NativeProcess,
  bufSize: number,
  bindPrivate = true
) {
  const client = new LocalProcess(kernel, CLIENT_ID, 10_000_000)
  registerInKernel(kernel, client, CLIENT_ID)
  const registry = createDbTypeRegistry()
  const codecs = createDbCodecs(registry)
  const methods = dbMethods(registry)
  const controlSock = client.createSocket(0, socketOpts(bufSize))
  await kernel.bind(CLIENT_ID, 0, DB_ID, 0, Direction.BOTH)
  const control = createDbRpcClient(controlSock as LocalSocket, registry, codecs)
  let priv = null as ReturnType<typeof createDbRpcClient> | null
  if (bindPrivate) {
    const privateSock = client.createSocket(1, socketOpts(bufSize))
    await kernel.bind(CLIENT_ID, 1, DB_ID, 1, Direction.BOTH)
    priv = createDbRpcClient(privateSock as LocalSocket, registry, codecs)
  }
  return { client, control, priv, methods, registry }
}

export async function openPrivateChannel(
  control: ReturnType<typeof createDbRpcClient>,
  methods: DbMethods,
  clientPid: number,
  clientSocket: number
): Promise<void> {
  await control.call(methods.open_socket, {
    pid: BigInt(clientPid),
    socket: clientSocket,
  })
}

export async function fillViaRpc(
  control: ReturnType<typeof createDbRpcClient>,
  methods: DbMethods,
  n: number,
  chunk = 256
): Promise<void> {
  for (let start = 0; start < n; start += chunk) {
    const end = Math.min(n, start + chunk)
    const entries = []
    for (let i = start; i < end; i++) {
      entries.push({
        key: makeKey(i),
        value: VALUE,
        timestamp: BigInt(i + 1),
      })
    }
    await control.call(methods.batch, entries, DURABLE_OPTS)
  }
}

export async function waitForScanDone(
  priv: ReturnType<typeof createDbRpcClient>,
  keysOnly: boolean
): Promise<number> {
  return new Promise((resolve, reject) => {
    let count = 0
    const itemType = keysOnly ? 'stream_key' : 'stream_item'
    priv.onMessage(itemType, () => {
      count++
    })
    priv.onMessage('stream_done', () => {
      resolve(count)
    })
    priv.onMessage('stream_reset', () => {
      count = 0
    })
    priv.onMessage('stream_error', (msg) => {
      const m = msg as { message?: string }
      reject(new Error(m.message ?? 'scan error'))
    })
  })
}

export function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // ignore
  }
}
