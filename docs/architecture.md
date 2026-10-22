# Architecture

`nativeHost.node` is an N-API addon. `@daemonarium/kernel` defines
`NativeProcessAddon`. This module implements that list: create a
process, open sockets, read and write circular buffers, `handleData`,
`handleDrain`, `flush`, `kill`.

## Registry

`service_registry` maps a service name to a factory.
`createNativeProcess(name, id, socketCount)` looks the name up.
This tag registers `echo` only. An unknown name throws.

## Echo

`echo_service` owns one `waos::native::native_process`. On
`on_socket_opened` it registers a data handler. The handler reads
the socket input buffer and writes those bytes to the output buffer,
then flushes. It does not interpret the bytes.

## Where the buffers come from

Two files from rpc-cpp `v0.1.0` are compiled into the addon:

- `src/native/native_process.cpp`
- `src/io/circular_buffer.c`

They are not linked as the reflection library. Echo does not use
`[[=...]]` reflection, so this build does not need
`reflection-toolchain`.

## Later

The database service is a later tag, after `daemonarium/db-cpp`.
The addon source still has `#ifdef NATIVE_HOST_DB` around that
registration. This repository's CMake does not define the macro, and
it does not contain `db_service`.
