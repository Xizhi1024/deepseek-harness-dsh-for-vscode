import { createDsh020Adapter } from './dsh020.js';

/** Exact 0.2.0-rc.1 entry point; freezes the identity pair it reports. */
export function createDsh020rc1Adapter({ ctx, runtimeInstanceId, integrationVersion, runtimeVersion }) {
  return createDsh020Adapter({ ctx, runtimeInstanceId, integrationVersion, runtimeVersion, adapterId: 'dsh-0.2.0-rc.1' });
}
