import {
  CodecRegistry,
  SocketRpcClient,
  TypeDescription,
  TypeKind,
  TypeRegistry,
  deserializeValueByType,
  ensureRpcCodecs,
  ensureRpcTypesInRegistry,
  serializeValueByType,
  type JsonValue,
  type LocalSocket,
} from '@wa-os/ts-rpc'

export const DB_MESSAGES = [
  'db_socket_opened',
  'db_scan_item',
  'db_scan_key',
  'db_scan_done',
  'db_scan_error',
  'db_visible_event',
  'db_durable_event',
] as const

export interface DbMethods {
  get: number
  set: number
  batch: number
  open_socket: number
  close_socket: number
  start_scan: number
  cancel_scan: number
}

/** Hand-written registry matching waos::db method order (0=get … 6=cancel_scan). */
export function createDbTypeRegistry(): TypeRegistry {
  const registry = new TypeRegistry()
  const t = (name: string) => {
    const found = registry.getTypeByName(name)
    if (!found) {
      throw new Error(`missing builtin ${name}`)
    }
    return found
  }
  const voidType = t('void')
  const boolType = t('bool')
  const binary = t('binary')
  const uint32 = t('uint32')
  const uint64 = t('uint64')
  const stringType = t('string')

  const writeMode = TypeDescription.create({
    name: 'db_write_mode',
    kind: TypeKind.Enum,
    enumMembers: [
      { name: 'durable', value: 0 },
      { name: 'instant', value: 1 },
    ],
  })
  const boundMode = TypeDescription.create({
    name: 'db_bound_mode',
    kind: TypeKind.Enum,
    enumMembers: [
      { name: 'none', value: 0 },
      { name: 'exclusive', value: 1 },
      { name: 'inclusive', value: 2 },
    ],
  })
  registry.registerType(writeMode)
  registry.registerType(boundMode)

  const getResult = TypeDescription.create({
    name: 'db_get_result',
    kind: TypeKind.Object,
    members: [
      { name: 'present', type: boolType, annotations: [] },
      { name: 'value', type: binary, annotations: [] },
      { name: 'timestamp', type: uint64, annotations: [] },
    ],
  })
  const writeOpts = TypeDescription.create({
    name: 'db_write_options',
    kind: TypeKind.Object,
    members: [
      { name: 'mode', type: writeMode, annotations: [] },
      { name: 'notify_visible', type: boolType, annotations: [] },
      { name: 'notify_durable', type: boolType, annotations: [] },
    ],
  })
  const writeEntry = TypeDescription.create({
    name: 'db_write_entry',
    kind: TypeKind.Object,
    members: [
      { name: 'key', type: binary, annotations: [] },
      { name: 'value', type: binary, annotations: [] },
      { name: 'timestamp', type: uint64, annotations: [] },
    ],
  })
  const writeEntryVec = TypeDescription.create({
    name: 'vector<db_write_entry>',
    kind: TypeKind.Array,
    item: writeEntry,
  })
  const scanQuery = TypeDescription.create({
    name: 'db_scan_query',
    kind: TypeKind.Object,
    members: [
      { name: 'lower', type: binary, annotations: [] },
      { name: 'lower_mode', type: boundMode, annotations: [] },
      { name: 'upper', type: binary, annotations: [] },
      { name: 'upper_mode', type: boundMode, annotations: [] },
      { name: 'limit', type: uint64, annotations: [] },
      { name: 'reverse', type: boolType, annotations: [] },
      { name: 'keys_only', type: boolType, annotations: [] },
    ],
  })
  registry.registerType(getResult)
  registry.registerType(writeOpts)
  registry.registerType(writeEntry)
  registry.registerType(writeEntryVec)
  registry.registerType(scanQuery)

  const unknownExc = TypeDescription.create({
    name: 'unknown_exception',
    kind: TypeKind.Exception,
    members: [{ name: 'what', type: stringType, annotations: [] }],
  })
  const dbError = TypeDescription.create({
    name: 'db_error',
    kind: TypeKind.Exception,
    members: [{ name: 'what', type: stringType, annotations: [] }],
  })
  const dbInvalid = TypeDescription.create({
    name: 'db_invalid_argument',
    kind: TypeKind.Exception,
    bases: [dbError],
    members: [{ name: 'what', type: stringType, annotations: [] }],
  })
  const dbClosed = TypeDescription.create({
    name: 'db_closed',
    kind: TypeKind.Exception,
    bases: [dbError],
    members: [{ name: 'what', type: stringType, annotations: [] }],
  })
  const dbIo = TypeDescription.create({
    name: 'db_io_error',
    kind: TypeKind.Exception,
    bases: [dbError],
    members: [{ name: 'what', type: stringType, annotations: [] }],
  })
  registry.registerType(unknownExc)
  registry.registerType(dbError)
  registry.registerType(dbInvalid)
  registry.registerType(dbClosed)
  registry.registerType(dbIo)

  registry.registerType(TypeDescription.create({
    name: 'db_socket_opened',
    kind: TypeKind.Message,
    members: [],
  }))
  registry.registerType(TypeDescription.create({
    name: 'db_scan_item',
    kind: TypeKind.Message,
    members: [
      { name: 'scan_uid', type: uint64, annotations: [] },
      { name: 'key', type: binary, annotations: [] },
      { name: 'value', type: binary, annotations: [] },
      { name: 'timestamp', type: uint64, annotations: [] },
    ],
  }))
  registry.registerType(TypeDescription.create({
    name: 'db_scan_key',
    kind: TypeKind.Message,
    members: [
      { name: 'scan_uid', type: uint64, annotations: [] },
      { name: 'key', type: binary, annotations: [] },
    ],
  }))
  registry.registerType(TypeDescription.create({
    name: 'db_scan_done',
    kind: TypeKind.Message,
    members: [{ name: 'scan_uid', type: uint64, annotations: [] }],
  }))
  registry.registerType(TypeDescription.create({
    name: 'db_scan_error',
    kind: TypeKind.Message,
    members: [
      { name: 'scan_uid', type: uint64, annotations: [] },
      { name: 'message', type: stringType, annotations: [] },
    ],
  }))
  registry.registerType(TypeDescription.create({
    name: 'db_visible_event',
    kind: TypeKind.Message,
    members: [{ name: 'request_id', type: uint64, annotations: [] }],
  }))
  registry.registerType(TypeDescription.create({
    name: 'db_durable_event',
    kind: TypeKind.Message,
    members: [{ name: 'request_id', type: uint64, annotations: [] }],
  }))

  const getFn = TypeDescription.create({
    name: 'db.get',
    kind: TypeKind.Function,
    members: [{ name: 'key', type: binary, annotations: [] }],
    item: getResult,
  })
  const setFn = TypeDescription.create({
    name: 'db.set',
    kind: TypeKind.Function,
    members: [
      { name: 'key', type: binary, annotations: [] },
      { name: 'value', type: binary, annotations: [] },
      { name: 'timestamp', type: uint64, annotations: [] },
      { name: 'opts', type: writeOpts, annotations: [] },
    ],
    item: voidType,
  })
  const batchFn = TypeDescription.create({
    name: 'db.batch',
    kind: TypeKind.Function,
    members: [
      { name: 'entries', type: writeEntryVec, annotations: [] },
      { name: 'opts', type: writeOpts, annotations: [] },
    ],
    item: voidType,
  })
  const openFn = TypeDescription.create({
    name: 'db.open_socket',
    kind: TypeKind.Function,
    members: [
      { name: 'client_pid', type: uint64, annotations: [] },
      { name: 'client_socket', type: uint32, annotations: [] },
    ],
    item: voidType,
  })
  const closeFn = TypeDescription.create({
    name: 'db.close_socket',
    kind: TypeKind.Function,
    members: [
      { name: 'client_pid', type: uint64, annotations: [] },
      { name: 'client_socket', type: uint32, annotations: [] },
    ],
    item: voidType,
  })
  const startScanFn = TypeDescription.create({
    name: 'db.start_scan',
    kind: TypeKind.Function,
    members: [
      { name: 'client_pid', type: uint64, annotations: [] },
      { name: 'client_socket', type: uint32, annotations: [] },
      { name: 'query', type: scanQuery, annotations: [] },
    ],
    item: voidType,
  })
  const cancelScanFn = TypeDescription.create({
    name: 'db.cancel_scan',
    kind: TypeKind.Function,
    members: [{ name: 'scan_uid', type: uint64, annotations: [] }],
    item: voidType,
  })

  const dbType = TypeDescription.create({
    name: 'db',
    kind: TypeKind.Object,
    members: [
      { name: 'get', type: getFn, annotations: [] },
      { name: 'set', type: setFn, annotations: [] },
      { name: 'batch', type: batchFn, annotations: [] },
      { name: 'open_socket', type: openFn, annotations: [] },
      { name: 'close_socket', type: closeFn, annotations: [] },
      { name: 'start_scan', type: startScanFn, annotations: [] },
      { name: 'cancel_scan', type: cancelScanFn, annotations: [] },
    ],
  })
  registry.registerType(getFn)
  registry.registerType(setFn)
  registry.registerType(batchFn)
  registry.registerType(openFn)
  registry.registerType(closeFn)
  registry.registerType(startScanFn)
  registry.registerType(cancelScanFn)
  registry.registerType(dbType)
  registry.assignMethodIds()
  return registry
}

export function createDbCodecs(registry: TypeRegistry): CodecRegistry {
  const codecs = new CodecRegistry()
  ensureRpcTypesInRegistry(registry)
  ensureRpcCodecs(codecs, registry)
  const registerMessage = (type: TypeDescription) => {
    if (type.kind !== TypeKind.Message || codecs.messages.has(type.name)) {
      return
    }
    codecs.messages.register({
      name: type.name,
      serialize: (writer, value) => {
        serializeValueByType(writer, registry, type, value as JsonValue)
      },
      deserialize: (reader, output) => {
        deserializeValueByType(reader, registry, type, output)
      },
    })
  }
  // Wire indexes must match C++ setup_server_ / attachDbMessages, not blob order.
  for (const name of DB_MESSAGES) {
    const type = registry.getTypeByName(name)
    if (type) {
      registerMessage(type)
    }
  }
  for (const type of registry.getTypes()) {
    registerMessage(type)
  }
  return codecs
}

export function attachDbMessages(client: SocketRpcClient): void {
  for (const name of DB_MESSAGES) {
    client.registerMessageType(name)
  }
}

export function createDbRpcClient(
  socket: LocalSocket,
  registry: TypeRegistry,
  codecs: CodecRegistry
): SocketRpcClient {
  const client = new SocketRpcClient(socket, registry, codecs)
  attachDbMessages(client)
  return client
}

export function dbMethods(registry: TypeRegistry): DbMethods {
  const byName = new Map(registry.getMethods().map((m) => [m.memberName, m.methodId]))
  const id = (name: string) => {
    const v = byName.get(name)
    if (v === undefined) {
      throw new Error(`missing method ${name}; have ${[...byName.keys()].join(',')}`)
    }
    return v
  }
  return {
    get: id('get'),
    set: id('set'),
    batch: id('batch'),
    open_socket: id('open_socket'),
    close_socket: id('close_socket'),
    start_scan: id('start_scan'),
    cancel_scan: id('cancel_scan'),
  }
}

export function emptyScanQuery(keysOnly = false) {
  return {
    lower: new Uint8Array(0),
    lower_mode: 0,
    upper: new Uint8Array(0),
    upper_mode: 0,
    limit: 0n,
    reverse: false,
    keys_only: keysOnly,
  }
}

export const DURABLE_OPTS = {
  mode: 0,
  notify_visible: false,
  notify_durable: false,
}
