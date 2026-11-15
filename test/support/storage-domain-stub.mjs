/**
 * In-memory stand-in for `@deepseek-ai/dsh-storage-domain`.
 *
 * The Host half is imported through a module hook that maps that one specifier
 * here, so the Host smoke test can run without a DSH installation. The stub
 * mirrors the observable contract the Host relies on: `defineDomain` is an
 * identity check, `domainTable` wraps the value schema, `open` answers a
 * `Domain` whose `table()` returns a `KvTable` that parses on read.
 *
 * @module dsh-scheduled-message/test/support/storage-domain-stub
 */

export function defineDomain(spec) {
  if (typeof spec?.name !== 'string' || spec.name.length === 0) throw new Error('domain name is required')
  if (!Number.isInteger(spec.version) || spec.version < 0) {
    throw new Error('domain version must be a non-negative integer')
  }
  for (const compatible of spec.compatibleVersions ?? []) {
    if (!Number.isInteger(compatible) || compatible < 0 || compatible >= spec.version) {
      throw new Error('compatibleVersions entries must be non-negative integers below version ' + spec.version)
    }
  }
  return spec
}

export function domainTable(schema) {
  return { valueSchema: schema }
}

/**
 * Build the `storageDomain` service the Host injects.
 * @param log - optional sink receiving `[event, detail]` rows.
 * @returns a service with one asynchronous `open`.
 */
export function createStorageDomainStub(log) {
  const opened = []
  return {
    /** Domains opened so far, newest last; the test rewrites records through these. */
    opened,
    async open(spec) {
      const tables = new Map()
      const domain = {
        spec,
        closed: false,
        table(name) {
          let map = tables.get(name)
          if (map === undefined) {
            const entry = spec.tables?.[name]
            if (entry === undefined) throw new Error(`unknown table ${name}`)
            map = new Map()
            map.schema = entry.valueSchema
            tables.set(name, map)
          }
          const schema = map.schema
          return {
            get(key) {
              const raw = map.get(key)
              return raw === undefined ? undefined : schema.parse(raw)
            },
            entries() {
              return [...map.entries()].map(([key, value]) => [key, schema.parse(value)])[Symbol.iterator]()
            },
            keys() {
              return map.keys()
            },
            get size() {
              return map.size
            },
            async put(key, value) {
              map.set(key, schema.parse(value))
              log?.push(['put', key])
            },
            async delete(key) {
              return map.delete(key)
            },
            async deleteMany(keys) {
              let removed = 0
              for (const key of keys) if (map.delete(key)) removed += 1
              return removed
            },
            async update(key, change) {
              const current = map.get(key)
              if (current === undefined) return undefined
              const next = schema.parse(change(schema.parse(current)))
              map.set(key, next)
              return schema.parse(next)
            },
            /** Test-only: read the raw stored object. */
            raw(key) {
              return map.get(key)
            },
            /**
             * Test-only: store a record exactly as an older version wrote it.
             * The real store reads those bytes from disk before `parse` runs.
             * @param key - record key.
             * @param value - raw stored object, not parsed.
             */
            putRaw(key, value) {
              map.set(key, value)
            },
          }
        },
        get closedNow() {
          return domain.closed
        },
        async close() {
          domain.closed = true
        },
      }
      opened.push(domain)
      return domain
    },
  }
}
