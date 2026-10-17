import { createDsh020Adapter } from './dsh020.js';

/** Exact 0.2.1-rc.2 entry point over the audited public controller operations. */
export function createDsh021rc2Adapter({ ctx, runtimeInstanceId, integrationVersion, runtimeVersion }) {
  return createDsh020Adapter({ ctx, runtimeInstanceId, integrationVersion, runtimeVersion, adapterId: 'dsh-0.2.1-rc.2' });
}
