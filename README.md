# native-host

The Node addon for Daemonarium native processes. This tag registers
one service, `echo`. `NativeProcess` and `NativeProcessAddon` live in
`@daemonarium/kernel`. This package is the `.node` file those types
call.

The npm package is `@daemonarium/native-host`. This repository is
`daemonarium/native-host-ts`.

## Why it is separate

`@daemonarium/kernel` runs in the browser and in Node, and it does
not need a C++ compiler. A native addon cannot make that claim. Echo
is a normal process in the kernel: sockets, circular buffers, and
`bind`. The addon only supplies the process body.

A later tag, after `db-cpp`, adds the database service. This cut
does not. `listServices()` returns `["echo"]`.

## Install

```
npm i @daemonarium/native-host
```

The install script compiles `nativeHost.node`. You need CMake and a
C++20 compiler. The package depends on `@daemonarium/kernel`.

The circular buffers are compiled from
[rpc-cpp](https://github.com/daemonarium/rpc-cpp) `v0.1.0`
(`native_process.cpp` and `circular_buffer.c`). This build does not
use the reflection toolchain.

## One example

```ts
import nativeHost from '@daemonarium/native-host'
import { Kernel, LocalProcess, NativeProcess, kernelApi } from '@daemonarium/kernel'

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
```

Write bytes on the client socket, copy them into the echo input,
call `echo.handleData(0)`, and copy the echo output back. The full
round-trip is in [docs/examples.md](docs/examples.md).

## License

MIT. Upstream notices are in `NOTICE`. Conduct is in
`CODE_OF_CONDUCT.md`.
