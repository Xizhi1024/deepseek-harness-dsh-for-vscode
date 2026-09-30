import { createDsh020Adapter } from './dsh020.js';

/** Exact 0.2.0-rc.2 entry point; freezes the identity pair it reports. */
export function createDsh020rc2Adapter({ ctx, runtimeInstanceId, integrationVersion, runtimeVersion }) {
  return createDsh020Adapter({ ctx, runtimeInstanceId, integrationVersion, runtimeVersion, adapterId: 'dsh-0.2.0-rc.2' });
}
