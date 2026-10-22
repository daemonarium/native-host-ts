import { expect } from 'chai'
import {
  Kernel,
  LocalProcess,
  NativeProcess,
  kernelApi,
} from '@daemonarium/kernel'
import type { Process } from '@daemonarium/kernel'
import nativeHost from '../index.js'

function transferPartial(
  from: Process,
  fromSock: number,
  to: Process,
  toSock: number
): number {
  const fromSocket = from.getSocket(fromSock)
  const toSocket = to.getSocket(toSock)
  if (!fromSocket || !toSocket) {
    return 0
  }
  return fromSocket.outputBuffer.copyTo(toSocket.inputBuffer)
}

function textEncoder() {
  return new TextEncoder()
}

function textDecoder() {
  return new TextDecoder()
}

function registerInKernel(kernel: Kernel, process: Process, id: number): void {
  while (kernel.processes.length <= id) {
    kernel.processes.push(null)
  }
  kernel.processes[id] = process
}

describe('native-host NativeProcess', () => {
  it('listServices returns echo', () => {
    expect(nativeHost.listServices()).to.include('echo')
  })

  it('echo round-trip', async () => {
    const kernel = new Kernel()
    const client = new LocalProcess(kernel, 0)
    const echo = new NativeProcess(kernel, 1, 1_000_000, 2, nativeHost, 'echo')
    registerInKernel(kernel, client, 0)
    registerInKernel(kernel, echo, 1)

    client.createSocket(0, {
      inputBufferSize: 4096,
      outputBufferSize: 4096,
      flushThreshold: 64,
      dataEventThreshold: 0,
      drainEventThreshold: 4,
      flags: 0,
    })
    echo.createSocket(0, {
      inputBufferSize: 4096,
      outputBufferSize: 4096,
      flushThreshold: 1,
      dataEventThreshold: 0,
      drainEventThreshold: 4,
      flags: 0,
    })

    await kernel.bind(0, 0, 1, 0, kernelApi.direction.BOTH)

    const payload = textEncoder().encode('ping')
    const written = client.getSocket(0)!.write(payload, payload.length)
    expect(written).to.equal(payload.length)

    const toEcho = transferPartial(client, 0, echo, 0)
    expect(toEcho).to.equal(payload.length)
    echo.handleData(0)

    transferPartial(echo, 0, client, 0)

    const out = new Uint8Array(payload.length)
    const read = client.getSocket(0)!.read(out, out.length)
    expect(read).to.equal(payload.length)
    expect(textDecoder().decode(out)).to.equal('ping')
  })

  it('large payload chunked through buffers', async () => {
    const kernel = new Kernel()
    const client = new LocalProcess(kernel, 0)
    const echo = new NativeProcess(kernel, 1, 1_000_000, 2, nativeHost, 'echo')
    registerInKernel(kernel, client, 0)
    registerInKernel(kernel, echo, 1)

    const bufSize = 4096
    client.createSocket(0, {
      inputBufferSize: bufSize,
      outputBufferSize: bufSize,
      flushThreshold: 1024,
      dataEventThreshold: 0,
      drainEventThreshold: 4,
      flags: 0,
    })
    echo.createSocket(0, {
      inputBufferSize: bufSize,
      outputBufferSize: bufSize,
      flushThreshold: 1,
      dataEventThreshold: 0,
      drainEventThreshold: 4,
      flags: 0,
    })
    await kernel.bind(0, 0, 1, 0, kernelApi.direction.BOTH)

    const payload = new Uint8Array(8192)
    for (let i = 0; i < payload.length; i++) {
      payload[i] = i & 0xff
    }

    const received: number[] = []
    let offset = 0
    while (offset < payload.length || echo.getSocket(0)!.outputBuffer.readableBytes() > 0
        || client.getSocket(0)!.outputBuffer.readableBytes() > 0
        || echo.getSocket(0)!.inputBuffer.readableBytes() > 0) {
      if (offset < payload.length) {
        const chunk = payload.subarray(offset, Math.min(offset + 2048, payload.length))
        const w = client.getSocket(0)!.write(chunk, chunk.length)
        offset += w
      }

      transferPartial(client, 0, echo, 0)
      if (echo.getSocket(0)!.inputBuffer.readableBytes() > 0) {
        echo.handleData(0)
      }
      transferPartial(echo, 0, client, 0)

      const readable = client.getSocket(0)!.readableBytes()
      if (readable > 0) {
        const tmp = new Uint8Array(readable)
        client.getSocket(0)!.read(tmp, readable)
        for (const b of tmp) {
          received.push(b)
        }
      }

      if (offset >= payload.length
          && client.getSocket(0)!.outputBuffer.readableBytes() === 0
          && echo.getSocket(0)!.inputBuffer.readableBytes() === 0
          && echo.getSocket(0)!.outputBuffer.readableBytes() === 0
          && client.getSocket(0)!.inputBuffer.readableBytes() === 0) {
        break
      }
    }

    expect(received.length).to.equal(payload.length)
    expect(Uint8Array.from(received)).to.deep.equal(payload)
  })

  it('backpressure with small buffers', async () => {
    const kernel = new Kernel()
    const client = new LocalProcess(kernel, 0)
    const echo = new NativeProcess(kernel, 1, 1_000_000, 2, nativeHost, 'echo')
    registerInKernel(kernel, client, 0)
    registerInKernel(kernel, echo, 1)

    const bufSize = 256
    client.createSocket(0, {
      inputBufferSize: bufSize,
      outputBufferSize: bufSize,
      flushThreshold: 32,
      dataEventThreshold: 0,
      drainEventThreshold: 4,
      flags: 0,
    })
    echo.createSocket(0, {
      inputBufferSize: bufSize,
      outputBufferSize: bufSize,
      flushThreshold: 1,
      dataEventThreshold: 0,
      drainEventThreshold: 4,
      flags: 0,
    })
    await kernel.bind(0, 0, 1, 0, kernelApi.direction.BOTH)

    const payload = new Uint8Array(2048)
    payload.fill(0xab)

    const received: number[] = []
    let offset = 0
    let rounds = 0
    while (received.length < payload.length && rounds < 10000) {
      rounds++
      if (offset < payload.length) {
        const space = client.getSocket(0)!.writableBytes()
        if (space > 0) {
          const n = Math.min(space, payload.length - offset)
          const w = client.getSocket(0)!.write(payload.subarray(offset, offset + n), n)
          offset += w
        }
      }
      transferPartial(client, 0, echo, 0)
      if (echo.getSocket(0)!.inputBuffer.readableBytes() > 0) {
        echo.handleData(0)
      }
      transferPartial(echo, 0, client, 0)
      const readable = client.getSocket(0)!.readableBytes()
      if (readable > 0) {
        const tmp = new Uint8Array(readable)
        client.getSocket(0)!.read(tmp, readable)
        for (const b of tmp) received.push(b)
      }
    }

    expect(received.length).to.equal(payload.length)
    expect(Uint8Array.from(received)).to.deep.equal(payload)
  })

  it('kill closes sockets and makes handleData a no-op', async () => {
    const kernel = new Kernel()
    const echo = new NativeProcess(kernel, 1, 1_000_000, 2, nativeHost, 'echo')
    registerInKernel(kernel, echo, 1)
    echo.createSocket(0, {
      inputBufferSize: 1024,
      outputBufferSize: 1024,
      flushThreshold: 1,
      dataEventThreshold: 0,
      drainEventThreshold: 4,
      flags: 0,
    })

    await echo.kill(undefined)
    expect(echo.isAlive).to.equal(false)
    expect(echo.getSocket(0)).to.equal(null)
    expect(() => echo.handleData(0)).to.not.throw()
    expect(nativeHost.isAlive(echo.handle)).to.equal(false)
  })

  it('multiple sockets echo independently', async () => {
    const kernel = new Kernel()
    const clientA = new LocalProcess(kernel, 0)
    const clientB = new LocalProcess(kernel, 1)
    const echo = new NativeProcess(kernel, 2, 1_000_000, 4, nativeHost, 'echo')
    registerInKernel(kernel, clientA, 0)
    registerInKernel(kernel, clientB, 1)
    registerInKernel(kernel, echo, 2)

    const opts = {
      inputBufferSize: 1024,
      outputBufferSize: 1024,
      flushThreshold: 1,
      dataEventThreshold: 0,
      drainEventThreshold: 4,
      flags: 0,
    }
    clientA.createSocket(0, opts)
    clientB.createSocket(0, opts)
    echo.createSocket(0, opts)
    echo.createSocket(1, opts)

    await kernel.bind(0, 0, 2, 0, kernelApi.direction.BOTH)
    await kernel.bind(1, 0, 2, 1, kernelApi.direction.BOTH)

    const a = textEncoder().encode('alpha')
    const b = textEncoder().encode('beta')
    clientA.getSocket(0)!.write(a, a.length)
    clientB.getSocket(0)!.write(b, b.length)

    transferPartial(clientA, 0, echo, 0)
    transferPartial(clientB, 0, echo, 1)
    echo.handleData(0)
    echo.handleData(1)
    transferPartial(echo, 0, clientA, 0)
    transferPartial(echo, 1, clientB, 0)

    const outA = new Uint8Array(a.length)
    const outB = new Uint8Array(b.length)
    clientA.getSocket(0)!.read(outA, outA.length)
    clientB.getSocket(0)!.read(outB, outB.length)
    expect(textDecoder().decode(outA)).to.equal('alpha')
    expect(textDecoder().decode(outB)).to.equal('beta')
  })

  it('multiple instances of echo are independent', async () => {
    const kernel = new Kernel()
    const client1 = new LocalProcess(kernel, 0)
    const client2 = new LocalProcess(kernel, 1)
    const echo1 = new NativeProcess(kernel, 2, 1_000_000, 2, nativeHost, 'echo')
    const echo2 = new NativeProcess(kernel, 3, 1_000_000, 2, nativeHost, 'echo')
    registerInKernel(kernel, client1, 0)
    registerInKernel(kernel, client2, 1)
    registerInKernel(kernel, echo1, 2)
    registerInKernel(kernel, echo2, 3)

    const opts = {
      inputBufferSize: 1024,
      outputBufferSize: 1024,
      flushThreshold: 1,
      dataEventThreshold: 0,
      drainEventThreshold: 4,
      flags: 0,
    }
    client1.createSocket(0, opts)
    client2.createSocket(0, opts)
    echo1.createSocket(0, opts)
    echo2.createSocket(0, opts)

    await kernel.bind(0, 0, 2, 0, kernelApi.direction.BOTH)
    await kernel.bind(1, 0, 3, 0, kernelApi.direction.BOTH)

    const p1 = textEncoder().encode('one')
    const p2 = textEncoder().encode('two')
    client1.getSocket(0)!.write(p1, p1.length)
    client2.getSocket(0)!.write(p2, p2.length)

    transferPartial(client1, 0, echo1, 0)
    transferPartial(client2, 0, echo2, 0)
    echo1.handleData(0)
    echo2.handleData(0)
    transferPartial(echo1, 0, client1, 0)
    transferPartial(echo2, 0, client2, 0)

    const o1 = new Uint8Array(p1.length)
    const o2 = new Uint8Array(p2.length)
    client1.getSocket(0)!.read(o1, o1.length)
    client2.getSocket(0)!.read(o2, o2.length)
    expect(textDecoder().decode(o1)).to.equal('one')
    expect(textDecoder().decode(o2)).to.equal('two')
  })
})
