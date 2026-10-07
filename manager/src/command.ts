// What a command is: its options, how many arguments it takes, and what it does.
//
// cli.ts parses the command line against these and renders help from them;
// `defineCommand` only types a definition, so a handler sees exactly the
// options it declared.
import type { parseArgs, ParseArgsOptionDescriptor } from 'node:util';
import type { Io } from './io.ts';

export type Option = ParseArgsOptionDescriptor & { brief: string };
export type Options = Record<string, Option>;

/** `keep-probe` → `keepProbe`. */
type Camel<S extends string> = S extends `${infer Head}-${infer Tail}`
    ? `${Head}${Capitalize<Camel<Tail>>}`
    : S;

type Parsed<O extends Options> = ReturnType<
    typeof parseArgs<{ options: O; strict: true; allowPositionals: true }>
>['values'];

/** What parseArgs returns for these options, keyed in camelCase. */
export type Values<O extends Options> = {
    [K in keyof Parsed<O> & string as Camel<K>]: Parsed<O>[K];
};

export interface Command<O extends Options = Options> {
    brief: string;
    /** Options as typed on the command line, kebab-case. */
    options?: O;
    /** The most positional arguments the command takes. */
    positionals?: number;
    // A method, so a command with its own options still fits the table.
    run(values: Values<O>, positionals: string[], io: Io): Promise<number>;
}

export const defineCommand = <const O extends Options = Record<never, Option>>(
    command: Command<O>,
): Command<O> => command;
