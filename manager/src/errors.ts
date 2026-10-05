// Exit statuses, and the errors that map to them.
//
// The launcher passes the manager's exit status through unchanged, so these
// are the statuses a caller of `./ghost-docker` sees (plan §2.8).

export const EXIT = {
    ok: 0,
    /** The operation was attempted and did not succeed. */
    failure: 1,
    /** The command line was wrong. Nothing was attempted. */
    usage: 2,
    /** A documented command or option whose plan step has not landed. */
    unimplemented: 3,
} as const;

/** An error whose message is meant for the operator, with the status to exit with. */
export class CliError extends Error {
    readonly exitCode: number;

    constructor(message: string, exitCode: number = EXIT.failure) {
        super(message);
        this.name = 'CliError';
        this.exitCode = exitCode;
    }
}

export class UsageError extends CliError {
    constructor(message: string) {
        super(message, EXIT.usage);
        this.name = 'UsageError';
    }
}

/**
 * Part of the documented interface, not built yet. It fails naming the plan
 * step it belongs to rather than as an unknown command, so a script written
 * against the documented interface gets an answer it can act on.
 */
export class UnimplementedError extends CliError {
    constructor(what: string, step: string, hint?: string) {
        super(
            `${what} is not implemented yet (it lands in ${step}${hint ? `; ${hint}` : ''}).`,
            EXIT.unimplemented,
        );
        this.name = 'UnimplementedError';
    }
}
