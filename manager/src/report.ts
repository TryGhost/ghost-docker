// One line of a report: doctor's checks, install's preflight and verification,
// check's diagnosis. Problems go to stderr so they separate from a summary.
import type { Io } from './io.ts';

export interface Check {
    /**
     * `note` is information that is neither a pass nor a problem: a port that
     * is published but could not be verified from the host, an HTTPS
     * certificate that is still pending.
     */
    status: 'ok' | 'note' | 'warn' | 'error';
    label: string;
    detail: string;
}

const STATUS_LABEL = {
    ok: 'ok      ',
    note: 'note    ',
    warn: 'warning ',
    error: 'ERROR   ',
} as const;

export function printChecks(io: Io, checks: readonly Check[], width = 18): void {
    for (const check of checks) {
        const [first, ...rest] = check.detail.split('\n');
        const pad = ' '.repeat(2 + 8 + 1 + width + 1);
        const line =
            `  ${STATUS_LABEL[check.status]} ${check.label.padEnd(width)} ${first}\n` +
            rest.map((more) => `${pad}${more}\n`).join('');
        (check.status === 'ok' || check.status === 'note' ? io.stdout : io.stderr)(line);
    }
}

export const failed = (checks: readonly Check[]): boolean =>
    checks.some((check) => check.status === 'error');
