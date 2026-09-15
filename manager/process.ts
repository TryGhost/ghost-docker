import fs from 'node:fs';
import { spawn } from 'node:child_process';

export interface RunOptions {
  input?: string;
  output?: string;
  env?: NodeJS.ProcessEnv;
  label?: string;
}

export async function run(bin: string, argv: string[], options: RunOptions = {}): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const fd = options.output ? fs.openSync(options.output, 'wx', 0o600) : null;
    const input = options.input ? fs.openSync(options.input, 'r') : null;
    const child = spawn(bin, argv, {
      env: { ...process.env, ...options.env },
      stdio: [input ?? 'ignore', fd ?? 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout?.on('data', (data) => {
      stdout += data;
    });
    // stderr may contain application configuration or credentials. Do not log it.
    child.stderr?.on('data', () => {});
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        if (fd !== null) {
          fs.fsyncSync(fd);
          fs.closeSync(fd);
        }
        if (input !== null) {
          fs.closeSync(input);
        }
        if (code !== 0) {
          reject(new Error(`${options.label || bin} failed (exit ${code})`));
        } else {
          resolve(stdout.trim());
        }
      } catch (error) {
        reject(error);
      }
    });
  });
}
