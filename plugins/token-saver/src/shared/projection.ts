/**
 * Bridge a locally-typed zod schema into the harness projection `stateSchema`
 * slot. The plugin workspace installs its own zod (a distinct package instance
 * from the harness's), so the two `ZodType` identities differ even though the
 * runtime object is valid. `register` validates and uses the schema at runtime;
 * the cast only satisfies the host's nominal type at the registration boundary.
 *
 * @module @dsh-plugins/token-saver/shared/projection
 */

import type { ZodType } from 'zod'

/**
 * Type a locally-built zod schema for the harness projection slot. The plugin
 * workspace installs its own zod (a distinct package instance from the
 * harness's), so the two `ZodType` identities differ even though the runtime
 * object is valid; `register` validates and uses the schema at runtime, and the
 * `never` cast only satisfies the host's nominal type at the registration
 * boundary.
 * @param schema - the locally-built zod schema.
 * @returns the schema, type-erased for the harness registration slot.
 */
export function asProjectionStateSchema(schema: ZodType<unknown>): never {
  return schema as never
}
