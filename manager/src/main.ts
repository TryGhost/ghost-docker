// Entry point of the manager image.
import { run } from './cli.ts';
import { processIo } from './io.ts';

// Set the status rather than calling process.exit, so output still pending on
// a pipe is flushed before the process ends.
process.exitCode = await run(process.argv.slice(2), processIo);
