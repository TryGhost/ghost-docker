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
