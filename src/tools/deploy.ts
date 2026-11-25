import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { rokuDeploy } from 'roku-deploy';
import { DESTRUCTIVE, friendlyError, passwordParam, resolveTarget, targetParams } from '../roku-config.js';

/** Whether either folder is, or contains, the other. Case-insensitive, since macOS file systems usually are. */
export function overlaps(a: string, b: string): boolean {
  const [x, y] = [path.resolve(a).toLowerCase(), path.resolve(b).toLowerCase()];
  const inside = (child: string, parent: string) => {
    const rel = path.relative(parent, child);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
  };
  return inside(x, y) || inside(y, x);
}

export function registerDeployTools(server: McpServer): void {
  server.registerTool(
    'roku_deploy',
    {
      title: 'Deploy dev channel',
      annotations: DESTRUCTIVE,
      description: 'Sideload (deploy) a Roku application to the device. Packages the files in rootDir into a zip and uploads it, which replaces the installed dev channel and cold-starts it. Works on LAN devices and on Roku Cloud Emulator devices (rceDevice).',
      inputSchema: {
        ...targetParams,
        password: passwordParam,
        rootDir: z.string().describe('Absolute path to the project root directory containing the manifest file'),
        files: z
          .array(z.string())
          .optional()
          .describe('Glob patterns for files to include. Defaults to all files in rootDir (**/*).'),
        stagingDir: z
          .string()
          .optional()
          .describe('Scratch folder roku-deploy empties, fills and deletes. Defaults to a unique temp folder; must not be rootDir, inside it, or contain it.'),
      },
    },
    async (params) => {
      try {
        const manifestPath = path.join(params.rootDir, 'manifest');
        try {
          await fs.access(manifestPath);
        } catch {
          return {
            content: [{ type: 'text', text: `Deploy failed: No manifest file found at ${manifestPath}. The rootDir must point to the Roku project directory that contains the manifest file.` }],
            isError: true,
          };
        }

        const target = await resolveTarget(params, { needPassword: true });
        const outDir = path.join(os.tmpdir(), 'roku-mcp-deploy');
        // Explicit: otherwise roku-deploy picks stagingDir from a bsconfig.json/rokudeploy.json in cwd,
        // and when that equals rootDir (e.g. "dist") it empties then deletes the build being deployed.
        const stagingDir = path.resolve(params.stagingDir ?? path.join(os.tmpdir(), `roku-mcp-staging-${Date.now()}`));
        if (overlaps(stagingDir, params.rootDir)) {
          return {
            content: [{ type: 'text', text: 'Deploy failed: stagingDir must not be rootDir, inside it, or contain it (roku-deploy empties and deletes it).' }],
            isError: true,
          };
        }
        const deployOptions = {
          host: target.host,
          password: target.password,
          rootDir: params.rootDir,
          outDir,
          stagingDir,
          files: params.files && params.files.length > 0 ? params.files : ['**/*'],
          retainStagingDir: false,
        };

        if (target.rce) {
          await rokuDeploy.createPackage(deployOptions);
          const zipPath = rokuDeploy.getOutputZipFilePath(deployOptions);
          const result = await target.rce.instance.install(await fs.readFile(zipPath), path.basename(zipPath));
          const note = result.outcome === 'identical' ? ' (the device reported the package as identical to the installed one)' : '';
          return {
            content: [{ type: 'text', text: `Successfully deployed app from ${params.rootDir} to ${target.label}${note}` }],
          };
        }
        await rokuDeploy.deploy(deployOptions);
        return {
          content: [{ type: 'text', text: `Successfully deployed app from ${params.rootDir} to ${target.label}` }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Deploy failed: ${friendlyError(error)}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'roku_delete_dev_channel',
    {
      title: 'Delete dev channel',
      annotations: DESTRUCTIVE,
      description: 'Delete the currently sideloaded developer channel from the Roku device (LAN or Roku Cloud Emulator).',
      inputSchema: {
        ...targetParams,
        password: passwordParam,
      },
    },
    async (params) => {
      try {
        const target = await resolveTarget(params, { needPassword: true });
        if (target.rce) await target.rce.instance.deleteDevChannel();
        else await rokuDeploy.deleteInstalledChannel({ host: target.host!, password: target.password! });
        return {
          content: [{ type: 'text', text: `Successfully deleted dev channel from ${target.label}` }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Delete dev channel failed: ${friendlyError(error)}` }],
          isError: true,
        };
      }
    }
  );
}
