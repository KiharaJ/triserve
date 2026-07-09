import { join, normalize, relative } from 'node:path';

/**
 * Resolve `key` to an absolute path INSIDE `baseDir`, rejecting any key that
 * would traverse outside it (`../..`, absolute paths, etc.). Shared by
 * {@link LocalStorageDriver} (writes/deletes) and AttachmentFileController
 * (reads, via the signed-token route) so both enforce the exact same
 * containment guarantee.
 */
export function resolveLocalStoragePath(baseDir: string, key: string): string {
  const full = normalize(join(baseDir, key));
  const rel = relative(baseDir, full);
  if (rel.startsWith('..') || rel === '') {
    throw new Error(`Refusing to resolve storage key outside baseDir: ${key}`);
  }
  return full;
}
