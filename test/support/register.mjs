/**
 * Install the storage-domain remap for this process.
 * @module dsh-scheduled-message/test/support/register
 */

import { register } from 'node:module'

register('./stub-loader.mjs', import.meta.url)
