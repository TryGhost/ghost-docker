// What a command is: its options, how many arguments it takes, and what it does.
//
// A command's options are a zod object keyed in camelCase. cli.ts derives the
// command line from it (`adminDomain` is `--admin-domain`; a boolean is a
// flag, anything else takes a value), parses the line with parseArgs, then the
// values with the schema, and renders help from it: each option's brief is its
// `.describe()`.
import type { ParseArgsOptionDescriptor } from 'node:util';
import { z } from 'zod';
import type { Io } from './io.ts';

export type Options = z.ZodObject;

export interface Command<O extends Options = Options> {
    brief: string;
    options?: O;
    /** The names of the positional arguments it takes, as help shows them; none if absent. */
    positionals?: string[];
    // A method, so a command with its own options still fits the table.
    run(values: z.output<O>, positionals: string[], io: Io): Promise<number>;
}

export const defineCommand = <O extends Options = z.ZodObject<{}>>(
    command: Command<O>,
): Command<O> => command;

/** A flag that takes no value: false unless given. */
export const flag = (brief: string) => z.boolean().default(false).describe(brief);

/**
 * Refines an option's value, reading `--option <text>: got 'value'` when it
 * is refused. It aborts, so a command's checks across options only ever see
 * values that passed their own.
 */
export const refused = (text: string) => ({
    error: (issue: { input?: unknown }) => `${text}: got '${String(issue.input)}'`,
    abort: true,
});

/** An option as the command line spells it. */
export interface Flag {
    /** As typed, kebab-case: `admin-domain`. */
    readonly name: string;
    /** As the schema and the handler key it: `adminDomain`. */
    readonly key: string;
    readonly type: ParseArgsOptionDescriptor['type'];
    readonly multiple: boolean;
    readonly brief: string;
}

/** The fields of a zod definition that wrap another schema. */
interface Wrapper {
    type: string;
    innerType?: z.ZodType;
    in?: z.ZodType;
    element?: z.ZodType;
}

/** The options a command's schema declares, unwrapped to what parseArgs reads. */
export function flagsOf(options: Options | undefined): Flag[] {
    return Object.entries(options?.shape ?? {}).map(([key, schema]) => {
        const name = key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
        let brief: string | undefined;
        let multiple = false;
        let current = schema as z.ZodType;
        for (;;) {
            brief ??= current.description;
            const def = current.def as Wrapper;
            const inner = def.innerType ?? def.in ?? def.element;
            if (!inner) {
                if (brief === undefined) {
                    throw new Error(`--${name} has no brief: describe() its schema`);
                }
                const type = def.type === 'boolean' ? 'boolean' : 'string';
                return { name, key, type, multiple, brief };
            }
            multiple ||= def.type === 'array';
            current = inner;
        }
    });
}
