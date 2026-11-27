import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { rokuDeploy } from 'roku-deploy';
import { resolveTarget, type TargetParams } from '../roku-config.js';

export interface ScreenshotOptions extends TargetParams {
  /** Folder for the image; defaults to the OS temp folder. */
  outDir?: string;
  /** File name without extension; defaults to a timestamped name. */
  outFile?: string;
}

export interface Screenshot {
  filePath: string;
  data: Buffer;
  mimeType: 'image/png' | 'image/jpeg';
}

/** Captures the screen (a dev channel must be running) and saves it to a file. */
export async function screenshot(options: ScreenshotOptions = {}): Promise<Screenshot> {
  const target = await resolveTarget(options, { needPassword: true });
  let filePath: string;
  let data: Buffer;
  if (target.rce) {
    const shot = await target.rce.instance.screenshot();
    const dir = options.outDir ?? os.tmpdir();
    await fs.mkdir(dir, { recursive: true });
    filePath = path.join(dir, `${options.outFile ?? `screenshot-${Date.now()}`}.${shot.extension}`);
    await fs.writeFile(filePath, shot.data);
    data = shot.data;
  } else {
    const deployOptions: Record<string, unknown> = { host: target.host, password: target.password };
    if (options.outDir) deployOptions.outDir = options.outDir;
    if (options.outFile) deployOptions.outFile = options.outFile;
    filePath = await rokuDeploy.takeScreenshot(deployOptions as any);
    data = await fs.readFile(filePath);
  }
  return { filePath, data, mimeType: path.extname(filePath).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg' };
}
