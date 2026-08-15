#!/usr/bin/env node
import { Kernel } from '@wa-os/ts-kernel'
import { emptyScanQuery } from './dbRegistry.ts'
import {
  cleanupDir,
  createDbNative,
  createTsClient,
  fillViaRpc,
  makeDataDir,
  makeKey,
  openPrivateChannel,
  printPhase,
  requireDbService,
  waitForScanDone,
  CLIENT_ID,
} from './harness.ts'

function parseArgs(argv: string[]) {
  let n = 10000
  let bufSize = 65536
  let doGet = true
  let doScan = true
  let doScanKeys = true
  for (const a of argv) {
    if (a.startsWith('--n=')) {
      n = Number(a.slice(4))
    } else if (a.startsWith('--buf-size=')) {
      bufSize = Number(a.slice(11))
    } else if (a.startsWith('--phases=')) {
      doGet = false
      doScan = false
      doScanKeys = false
      for (const part of a.slice(9).split(',')) {
        if (part === 'get') doGet = true
        if (part === 'scan') doScan = true
        if (part === 'scan_keys') doScanKeys = true
      }
    } else if (a[0] !== '-') {
      n = Number(a)
    }
  }
  return { n, bufSize, doGet, doScan, doScanKeys }
}

async function main() {
  requireDbService()
  const cfg = parseArgs(process.argv.slice(2))
  console.log(
    `BENCH start n=${cfg.n} buf_size=${cfg.bufSize} layer=node get=${cfg.doGet ? 1 : 0} scan=${cfg.doScan ? 1 : 0}`
  )

  const dataDir = makeDataDir()
  const kernel = new Kernel()
  const db = await createDbNative(kernel, dataDir, cfg.bufSize)
  const { client, control, priv, methods } = await createTsClient(kernel, db, cfg.bufSize)

  try {
    await fillViaRpc(control, methods, cfg.n)
    await openPrivateChannel(control, methods, CLIENT_ID, 1)

    if (cfg.doGet) {
      const keys = Array.from({ length: cfg.n }, (_, i) => makeKey(i))
      const t0 = performance.now()
      let got = 0
      for (const key of keys) {
        const r = await control.call(methods.get, key) as { present?: boolean }
        if (r?.present) {
          got++
        }
      }
      printPhase('node', 'get', got, performance.now() - t0)
    }

    if (!priv) {
      throw new Error('private db channel is required for scan')
    }
    if (cfg.doScan) {
      const done = waitForScanDone(priv, false)
      const t0 = performance.now()
      await control.call(methods.start_scan, BigInt(CLIENT_ID), 1, emptyScanQuery(false))
      const count = await done
      printPhase('node', 'scan', count, performance.now() - t0)
    }

    if (cfg.doScanKeys) {
      const done = waitForScanDone(priv, true)
      const t0 = performance.now()
      await control.call(methods.start_scan, BigInt(CLIENT_ID), 1, emptyScanQuery(true))
      const count = await done
      printPhase('node', 'scan_keys', count, performance.now() - t0)
    }

    console.log('BENCH done')
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
