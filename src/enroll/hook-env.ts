// Shared env-file delivery for the hook install module: preserve any user-set
// keys not owned by the manager, overwrite the keys we own, write atomically
// with a backup. Ported verbatim from pinta-manager sidecar/src/enroll/hook-env.ts.

import fs from 'node:fs';
import { parseEnvFile, serializeEnvFile } from './env-file.js';
import { writeAtomicWithBackup } from './fs-util.js';

/**
 * Merge `newKeys` into the env file at `envFilePath`, preserving user-set keys
 * not present in `newKeys`, then write atomically with a backup. Missing or
 * unreadable files are treated as empty.
 */
export async function mergeAndWriteEnvFile(
  envFilePath: string,
  newKeys: Record<string, string>,
  backupRoot: string,
): Promise<void> {
  const existing = fs.existsSync(envFilePath)
    ? parseEnvFile(fs.readFileSync(envFilePath, 'utf-8'))
    : {};
  await writeAtomicWithBackup(
    envFilePath,
    serializeEnvFile({ ...existing, ...newKeys }),
    backupRoot,
  );
}
