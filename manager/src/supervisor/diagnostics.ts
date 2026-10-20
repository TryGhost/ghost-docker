// Diagnostics as Ghost shows them: plain text within Ghost's bounds
// (docs/upgrade-supervisor.md#job). Paths are relative to the site directory.
import { SOURCE, type UpgradeDiagnostic } from './protocol.ts';

const MESSAGE = 2048;
const DETAILS = 8192;

const clip = (text: string, bound: number): string =>
    text.length <= bound ? text : `${text.slice(0, bound - 1)}…`;

export function diagnostic(
    code: string,
    severity: UpgradeDiagnostic['severity'],
    message: string,
    details?: string,
): UpgradeDiagnostic {
    const trimmed = details?.trim();
    return {
        source: SOURCE,
        code,
        severity,
        message: clip(message.trim() || code, MESSAGE),
        ...(trimmed ? { details: clip(trimmed, DETAILS) } : {}),
    };
}
