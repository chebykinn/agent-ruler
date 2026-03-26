import * as fs from 'fs';
import * as path from 'path';

/**
 * Walk up from cwd to find the project root (directory containing .claude/ or CLAUDE.md).
 * Falls back to cwd if nothing found.
 */
export function resolveProjectRoot(startDir?: string): string {
  let dir = startDir || process.cwd();

  while (true) {
    if (
      fs.existsSync(path.join(dir, '.claude')) ||
      fs.existsSync(path.join(dir, 'CLAUDE.md'))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return startDir || process.cwd();
}
