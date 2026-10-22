# Example

Echo copies whatever arrives on a socket back out of that socket.
The host supplies no Wasm. `nativeHost.node` is built by
`npm install`.

```ts
import nativeHost from '@daemonarium/native-host'
import { Kernel, LocalProcess, NativeProcess, kernelApi } from '@daemonarium/kernel'
import type { Process } from '@daemonarium/kernel'

function copyOutputToInput(from: Process, fromSock: number, to: Process, toSock: number): number {
  const source = from.getSocket(fromSock)
  const dest = to.getSocket(toSock)
  if (!source || !dest) return 0
  return source.outputBuffer.copyTo(dest.inputBuffer)
}

const kernel = new Kernel()
const client = new LocalProcess(kernel, 0)
const echo = new NativeProcess(kernel, 1, 1_000_000, 2, nativeHost, 'echo')
kernel.processes[0] = client
kernel.processes[1] = echo

const opts = {
  inputBufferSize: 4096,
  outputBufferSize: 4096,
  flushThreshold: 64,
  dataEventThreshold: 0,
  drainEventThreshold: 4,
  flags: 0,
}
client.createSocket(0, opts)
echo.createSocket(0, { ...opts, flushThreshold: 1 })
await kernel.bind(0, 0, 1, 0, kernelApi.direction.BOTH)

const payload = new TextEncoder().encode('ping')
client.getSocket(0)!.write(payload, payload.length)
copyOutputToInput(client, 0, echo, 0)
echo.handleData(0)
copyOutputToInput(echo, 0, client, 0)

const out = new Uint8Array(payload.length)
client.getSocket(0)!.read(out, out.length)
// out is "ping"
```

`listServices()` on the addon returns `["echo"]`.
