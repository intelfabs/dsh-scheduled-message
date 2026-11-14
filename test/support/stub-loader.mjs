/**
 * Resolve `@deepseek-ai/dsh-storage-domain` to the in-memory stub.
 *
 * The Host half imports that package from the running installation; the smoke
 * test remaps only that one specifier so the module loads in plain Node.
 * @module dsh-scheduled-message/test/support/stub-loader
 */

const STUB = new URL('./storage-domain-stub.mjs', import.meta.url).href

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/dsh-storage-domain') {
    return { url: STUB, shortCircuit: true }
  }
  return await nextResolve(specifier, context)
}
