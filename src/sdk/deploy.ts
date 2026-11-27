import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { rokuDeploy } from 'roku-deploy';
import { resolveTarget, type TargetParams } from '../roku-config.js';
import { RokuError } from './errors.js';

/** Whether either folder is, or contains, the other. Case-insensitive, since macOS file systems usually are. */
export function overlaps(a: string, b: string): boolean {
  const [x, y] = [path.resolve(a).toLowerCase(), path.resolve(b).toLowerCase()];
  const inside = (child: string, parent: string) => {
    const rel = path.relative(parent, child);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
  };
  return inside(x, y) || inside(y, x);
}

export interface DeployOptions extends TargetParams {
  /** Project root that contains the manifest. */
  rootDir: string;
  /** Glob patterns; defaults to every file. */
  files?: string[];
  /** Scratch folder roku-deploy empties, fills and deletes; never rootDir, inside it, or containing it. */
  stagingDir?: string;
}

/** Zips rootDir and sideloads it, replacing the dev channel and cold-starting it. */
export async function deploy(options: DeployOptions): Promise<{ rootDir: string; label: string; identical: boolean }> {
  const manifestPath = path.join(options.rootDir, 'manifest');
  try {
    await fs.access(manifestPath);
  } catch {
    throw new RokuError(
      'no_manifest',
      `No manifest file found at ${manifestPath}. The rootDir must point to the Roku project directory that contains the manifest file.`
    );
  }

  const target = await resolveTarget(options, { needPassword: true });
  const outDir = path.join(os.tmpdir(), 'roku-mcp-deploy');
  // Explicit: otherwise roku-deploy picks stagingDir from a bsconfig.json/rokudeploy.json in cwd,
  // and when that equals rootDir (e.g. "dist") it empties then deletes the build being deployed.
  const stagingDir = path.resolve(options.stagingDir ?? path.join(os.tmpdir(), `roku-mcp-staging-${Date.now()}`));
  if (overlaps(stagingDir, options.rootDir)) {
    throw new RokuError('bad_staging_dir', 'stagingDir must not be rootDir, inside it, or contain it (roku-deploy empties and deletes it).');
  }
  const deployOptions = {
    host: target.host,
    password: target.password,
    rootDir: options.rootDir,
    outDir,
    stagingDir,
    files: options.files && options.files.length > 0 ? options.files : ['**/*'],
    retainStagingDir: false,
  };

  if (target.rce) {
    await rokuDeploy.createPackage(deployOptions);
    const zipPath = rokuDeploy.getOutputZipFilePath(deployOptions);
    const result = await target.rce.instance.install(await fs.readFile(zipPath), path.basename(zipPath));
    return { rootDir: options.rootDir, label: target.label, identical: result.outcome === 'identical' };
  }
  await rokuDeploy.deploy(deployOptions);
  return { rootDir: options.rootDir, label: target.label, identical: false };
}

/** Removes the sideloaded dev channel. */
export async function deleteDevChannel(options: TargetParams = {}): Promise<{ label: string }> {
  const target = await resolveTarget(options, { needPassword: true });
  if (target.rce) await target.rce.instance.deleteDevChannel();
  else await rokuDeploy.deleteInstalledChannel({ host: target.host!, password: target.password! });
  return { label: target.label };
}
