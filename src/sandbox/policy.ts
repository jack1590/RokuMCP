/**
 * Which local paths a roku_run snippet may name. Reads: anywhere inside the server's working
 * directory except secret files. Writes: only inside its output folder (roku-run/ by default),
 * so a snippet cannot rewrite code, config or CI files that run later outside the sandbox.
 * Symlinks are followed (dangling ones too) before the inside-root check.
 */
import fs from 'fs';
import path from 'path';
import { RokuError } from '../sdk/errors.js';

/** File names that usually hold secrets, device passwords or MCP client config with tokens. */
const SECRET_NAME =
  /^(\.env(\..*)?|.*\.env|\.envrc|\.npmrc|\.yarnrc(\.yml)?|\.netrc|\.pypirc|\.git-credentials|\.mcpregistry_.*|\.?mcp\.json|opencode\.jsonc?|claude_desktop_config\.json|bsconfig.*\.json|rokudeploy.*\.json|(credentials|secrets?)\.(json|ya?ml|toml|ini|txt|env)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|p12|pfx|keystore|jks|secret))$/i;
/** Folders that hold credentials or editor and agent configuration. */
const SECRET_DIR = /^(\.git|\.ssh|\.aws|\.azure|\.gnupg|\.docker|\.kube|\.config|\.claude|\.cursor|\.vscode|\.windsurf|\.zed|\.idea|\.continue|\.codex|\.gemini|\.opencode)$/i;

/**
 * File types roku_run may create: data only. A .js, .ts, .sh or similar file in roku-run/ would
 * run later outside the sandbox (test runners pick up *.test.mjs anywhere in the project).
 */
// No .md or .html: CLAUDE.md, AGENTS.md and similar files are loaded as agent instructions.
const WRITABLE_EXT = /\.(txt|log|json|csv|tsv|xml|png|jpe?g|trace|bsprof|har|chlsj)$/i;
/** Config files that build tools discover anywhere in a project (Nx project.json, package.json, rc files). */
const TOOL_CONFIG = /^(package|project|tsconfig.*|jsconfig.*|deno|bunfig|lerna|nx|turbo|renovate|vercel|netlify|app|manifest|composer|.*\.config|\..*rc.*)\.json$/i;

export const OUTPUT_DIR = 'roku-run';

const denied = (message: string) => new RokuError('path_denied', message);

/** Windows ignores trailing dots and spaces, and "name:stream" is the same file: compare the plain name. */
const plainName = (seg: string) => (process.platform === 'win32' ? seg.split(':')[0].replace(/[. ]+$/, '') : seg);
// Windows 8.3 short names (ENV~1) would get past the name checks: refuse them.
const isSecret = (seg: string) => SECRET_NAME.test(plainName(seg)) || SECRET_DIR.test(plainName(seg)) || (process.platform === 'win32' && /~\d/.test(seg));

/** The path with every symlink resolved, dangling ones included; missing tail segments are kept. */
function resolveLinks(abs: string, hops = 0): string {
  if (hops > 40) throw denied('too many symlinks');
  const rest: string[] = [];
  let dir = abs;
  for (;;) {
    const st = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (st?.isSymbolicLink()) {
      const target = path.resolve(path.dirname(dir), fs.readlinkSync(dir));
      return resolveLinks(path.join(target, ...rest), hops + 1);
    }
    if (st) return path.join(fs.realpathSync(dir), ...rest);
    const parent = path.dirname(dir);
    if (parent === dir) return abs;
    rest.unshift(path.basename(dir));
    dir = parent;
  }
}

const inside = (child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

export class PathPolicy {
  readonly root: string;
  readonly outputDir: string;

  constructor(root: string = process.cwd()) {
    this.root = fs.realpathSync(root);
    this.outputDir = path.join(this.root, OUTPUT_DIR);
  }

  /** The absolute path for a snippet-supplied path, or a path_denied RokuError. */
  resolve(p: unknown, what = 'path'): string {
    if (typeof p !== 'string' || p === '' || p.includes('\0')) throw denied(`${what} must be a non-empty string`);
    if (process.platform === 'win32' && /:/.test(p.slice(path.isAbsolute(p) ? 2 : 0))) throw denied(`${what} "${p}" names an alternate data stream`);
    const abs = resolveLinks(path.resolve(this.root, p));
    if (!inside(abs, this.root)) throw denied(`${what} "${p}" is outside the working directory (${this.root})`);
    for (const seg of path.relative(this.root, abs).split(path.sep)) {
      if (isSecret(seg)) throw denied(`${what} "${p}" names a protected file or folder (${seg})`);
    }
    return abs;
  }

  /** A file to read: allowed path, and a regular file (a FIFO would block the server). */
  resolveRead(p: unknown, what = 'path'): string {
    const abs = this.resolve(p, what);
    const st = fs.statSync(abs, { throwIfNoEntry: false });
    if (st && !st.isFile() && !st.isDirectory()) throw denied(`${what} "${p}" is not a regular file`);
    return abs;
  }

  /** A folder or file to write: allowed, and inside the output folder (relative paths are taken from it). */
  resolveWrite(p: unknown, what = 'path'): string {
    if (typeof p !== 'string' || p === '') throw denied(`${what} must be a non-empty string`);
    const underOutput = path.isAbsolute(p) || p.split(/[\\/]/)[0] === OUTPUT_DIR ? p : path.join(OUTPUT_DIR, p);
    const abs = this.resolve(underOutput, what);
    if (!inside(abs, resolveLinks(this.outputDir))) throw denied(`${what} "${p}" is outside the ${OUTPUT_DIR}/ output folder; roku_run writes only there`);
    return abs;
  }

  /** A file to create: as resolveWrite, and a data file type. */
  resolveWriteFile(p: unknown, what = 'path'): string {
    const abs = this.resolveWrite(p, what);
    if (!WRITABLE_EXT.test(abs)) throw denied(`${what} "${p}" must be a data file (.txt, .log, .json, .csv, .xml, .png, .jpg, .trace, ...), not code or Markdown`);
    if (TOOL_CONFIG.test(path.basename(abs))) throw denied(`${what} "${p}" has the name of a tool config file; pick another name`);
    return abs;
  }

  /** A deploy rootDir: allowed, with no secret file and no symlink anywhere in it (it is zipped and uploaded). */
  resolveDeployRoot(p: unknown): string {
    const abs = this.resolve(p, 'rootDir');
    let seen = 0;
    const walk = (dir: string) => {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        if (++seen > 20_000) throw denied(`rootDir "${p}" has more than 20000 entries; deploy a build folder`);
        const rel = path.relative(abs, path.join(dir, d.name));
        if (d.isSymbolicLink()) throw denied(`rootDir "${p}" contains a symlink (${rel}); deploy a build folder without links`);
        if (isSecret(d.name)) throw denied(`rootDir "${p}" contains ${rel}; deploy a build folder without secrets`);
        if (d.isDirectory()) walk(path.join(dir, d.name));
      }
    };
    if (fs.statSync(abs, { throwIfNoEntry: false })?.isDirectory()) walk(abs);
    return abs;
  }

  /** A bare file name (no folders), for options such as outFile. */
  checkFileName(name: unknown, what: string): void {
    if (typeof name !== 'string' || name === '' || name === '.' || name === '..' || /[\\/:\0]/.test(name) || isSecret(name)) {
      throw denied(`${what} must be a plain file name without folders`);
    }
  }

  /** Creates roku-run/ with a .gitignore of "*", so its files stay out of git and the tools that skip ignored files. */
  ensureOutputDir(): void {
    fs.mkdirSync(this.outputDir, { recursive: true });
    const ignore = path.join(this.outputDir, '.gitignore');
    // lstat: a dangling symlink planted here must not be written through.
    if (fs.lstatSync(ignore, { throwIfNoEntry: false })) return;
    let fd: number;
    try {
      fd = fs.openSync(ignore, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if ((error as { code?: string }).code === 'EEXIST') return; // another call created it first
      throw error;
    }
    try {
      fs.writeSync(fd, '# Written by roku_run (roku-mcp code mode)\n*\n');
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Whether a directory entry may be listed. */
  listable(name: string): boolean {
    return !isSecret(name);
  }

  relative(abs: string): string {
    return path.relative(this.root, abs) || '.';
  }
}
