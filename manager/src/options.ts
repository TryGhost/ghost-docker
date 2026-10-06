// Command options, parsed by Node's own util.parseArgs. Each command declares
// its options; anything else is a usage error that names the command.
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { UsageError } from './errors.ts';

type Options = NonNullable<ParseArgsConfig['options']>;

/** The options of `command`, strictly: no unknown options, no positionals. */
export function parseOptions<T extends Options>(
    command: string,
    args: readonly string[],
    options: T,
): ReturnType<typeof parseArgs<{ options: T; strict: true; allowPositionals: false }>>['values'] {
    try {
        return parseArgs({ args: [...args], options, strict: true, allowPositionals: false })
            .values;
    } catch (error) {
        const { code, message } = error as NodeJS.ErrnoException;
        switch (code) {
            case 'ERR_PARSE_ARGS_UNKNOWN_OPTION':
                throw new UsageError(`unknown option for ${command}: ${quoted(message)}`);
            case 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL':
                throw new UsageError(`${command} takes no arguments: ${quoted(message)}`);
            case 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE':
                throw new UsageError(`${command}: ${message}`);
            default:
                throw error;
        }
    }
}

/** The quoted token in a parseArgs message, such as `--foo` in "Unknown option '--foo'". */
const quoted = (message: string) => message.match(/'([^']*)'/)?.[1] ?? message;
