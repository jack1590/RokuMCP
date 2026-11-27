/**
 * Which local paths a roku_run snippet may name: only inside the server's working directory,
 * never through a symlink that leaves it, and never a file that usually holds secrets.
 */
import fs from 'fs';
import path from 'path';
import { RokuError } from '../sdk/errors.js';

/** File names and folders a snippet can never read, write or pass to the SDK. */
const SECRET_NAME = /^(\.env(\..*)?|\.npmrc|\.netrc|\.pypirc|\.mcpregistry_.*|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|p12|pfx|keystore|jks))$/i;
const SECRET_DIR = /^(\.git|\.ssh|\.aws|\.gnupg|\.claude|\.cursor|\.vscode)$/i;

const denied = (message: string) => new RokuError('path_denied', message);

/** The deepest existing ancestor, resolved through symlinks, plus the rest of the path. */
function realish(abs: string): string {
  let dir = abs;
  const rest: string[] = [];
  while (!fs.existsSync(dir)) {
    rest.unshift(path.basename(dir));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(fs.realpathSync(dir), ...rest);
}

const inside = (child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

export class PathPolicy {
  readonly root: string;

  constructor(root: string = process.cwd()) {
    this.root = fs.realpathSync(root);
  }

  /** The absolute path for a snippet-supplied path, or a path_denied RokuError. */
  resolve(p: unknown, what = 'path'): string {
    if (typeof p !== 'string' || p === '') throw denied(`${what} must be a non-empty string`);
    const abs = realish(path.resolve(this.root, p));
    if (!inside(abs, this.root)) throw denied(`${what} "${p}" is outside the working directory (${this.root})`);
    for (const seg of path.relative(this.root, abs).split(path.sep)) {
      if (SECRET_NAME.test(seg) || SECRET_DIR.test(seg)) throw denied(`${what} "${p}" names a protected file or folder (${seg})`);
    }
    return abs;
  }

  /** A deploy rootDir: inside the root, and not holding a secret file at its top level. */
  resolveDeployRoot(p: unknown): string {
    const abs = this.resolve(p, 'rootDir');
    const secret = fs.existsSync(abs) ? fs.readdirSync(abs).find((n) => SECRET_NAME.test(n)) : undefined;
    if (secret) throw denied(`rootDir "${p}" holds ${secret}; deploy a build folder instead`);
    return abs;
  }

  /** Deploy globs stay relative and never name dotfiles. */
  checkGlobs(patterns: unknown): void {
    if (patterns === undefined) return;
    if (!Array.isArray(patterns)) throw denied('files must be an array of glob patterns');
    for (const g of patterns) {
      if (typeof g !== 'string' || path.isAbsolute(g) || /(^|[\\/])\.\.([\\/]|$)/.test(g) || /(^|[\\/{,!])\./.test(g)) {
        throw denied(`files pattern ${JSON.stringify(g)} must be relative, without "..", and must not name dotfiles`);
      }
    }
  }

  /** Whether a directory entry may be listed. */
  listable(name: string): boolean {
    return !SECRET_NAME.test(name) && !SECRET_DIR.test(name);
  }

  relative(abs: string): string {
    return path.relative(this.root, abs) || '.';
  }
}
