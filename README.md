# `@wa-os/native-host`

N-API addon hosting `native_process` services. Currently registers the **`echo`** service.

Shared TypeScript (`NativeProcess`, `NativeSocket`, `NativeCircularBuffer`, `NativeProcessAddon`) lives in **`@wa-os/ts-kernel`**.

## Build

```bash
npm install -w native-host   # runs cmake-js compile
```

Produces `build/Release/nativeHost.node` (or Debug).

## Use

```ts
import { Kernel, LocalProcess, NativeProcess, Direction } from '@wa-os/ts-kernel'
import nativeHost from '@wa-os/native-host'

const kernel = new Kernel()
const client = new LocalProcess(kernel, 0)
const echo = new NativeProcess(kernel, 1, 1_000_000, 2, nativeHost, 'echo')
// create sockets, bind BOTH, write + flush...
```

## Services

`listServices()` returns `["echo"]`.
