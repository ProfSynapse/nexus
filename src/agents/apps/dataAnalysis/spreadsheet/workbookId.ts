/** Derive a filesystem-safe mirror id from a workbook's vault path. */
export function workbookIdFromPath(path: string): string {
  const base = (path.split('/').pop() ?? path).replace(/\.(xlsx|xlsm|xls)$/i, '');
  const safe = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return safe.length > 0 ? safe : 'workbook';
}
