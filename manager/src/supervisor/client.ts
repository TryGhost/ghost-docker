// Ghost's end of the exchange, as docs/upgrade-supervisor.md#what-each-end-does
// describes it: reading status, making a request and looking up a job.
//
// FileDropUpgradeAdapter in Ghost core is the real client. This is the same
// algorithm for requests made by hand (`supervisor request`), run as Ghost's
// uid with the exchange mounted as Ghost mounts it, so the hand tooling
// exercises Ghost's permissions rather than the operator's.
import { join } from 'node:path';
import {
    BOUNDS,
    createExchangeFile,
    ExchangeFileError,
    jobFileSchema,
    jobIdOf,
    parseExchangeFile,
    PROTOCOL,
    readExchangeFile,
    REQUEST_MAX_AGE_MS,
    requestFileSchema,
    STALE_AFTER_MS,
    statusFileSchema,
    type StatusFile,
    type UpgradeJob,
    type UpgradeRequest,
} from './protocol.ts';
import { JOBS, REQUESTS, STATUS, STATUS_FILE } from './store.ts';

export type Availability = 'ready' | 'busy' | 'unavailable' | 'stale' | 'incompatible';

export type StatusRead =
    | { readonly availability: 'unavailable'; readonly reason: string }
    | { readonly availability: 'incompatible'; readonly reason: string }
    | { readonly availability: 'stale'; readonly file: StatusFile }
    | { readonly availability: 'ready' | 'busy' | 'unavailable'; readonly file: StatusFile };

export type RequestResult =
    | { readonly accepted: UpgradeJob }
    | {
          readonly rejected:
              | 'unavailable'
              | 'busy'
              | 'target-unapproved'
              | 'idempotency-conflict'
              | 'request-expired';
          readonly reason: string;
      };

export type Lookup = UpgradeJob | { readonly id: string; readonly state: 'unknown' | 'expired' };

export class ExchangeClient {
    private readonly requests: string;
    private readonly status: string;
    private readonly jobs: string;
    private readonly now: () => Date;

    constructor(root: string, now = () => new Date()) {
        this.requests = join(root, REQUESTS);
        this.status = join(root, STATUS);
        this.jobs = join(root, STATUS, JOBS);
        this.now = now;
    }

    readStatus(): StatusRead {
        const path = join(this.status, STATUS_FILE);
        let file: StatusFile;
        try {
            const read = readExchangeFile(path, BOUNDS.status);
            if (read === undefined) {
                return {
                    availability: 'unavailable',
                    reason: 'the supervisor has not published a status',
                };
            }
            file = parseExchangeFile(statusFileSchema, read, path);
        } catch (error) {
            if (error instanceof ExchangeFileError) {
                return { availability: 'incompatible', reason: error.message };
            }
            if ((error as NodeJS.ErrnoException).code === 'EACCES') {
                return { availability: 'unavailable', reason: `${path} cannot be read` };
            }
            throw error;
        }
        const age = this.now().getTime() - Date.parse(file.heartbeatAt);
        if (age > STALE_AFTER_MS || age < -STALE_AFTER_MS) {
            return { availability: 'stale', file };
        }
        return { availability: file.status.availability, file };
    }

    private job(id: string): UpgradeJob | undefined {
        const path = join(this.jobs, `${id}.json`);
        const read = readExchangeFile(path, BOUNDS.job);
        return read === undefined ? undefined : parseExchangeFile(jobFileSchema, read, path).job;
    }

    private pending(id: string): { request: UpgradeRequest; mtimeMs: number } | undefined {
        const path = join(this.requests, `${id}.json`);
        const read = readExchangeFile(path, BOUNDS.request);
        return read === undefined
            ? undefined
            : {
                  request: parseExchangeFile(requestFileSchema, read, path).request,
                  mtimeMs: read.mtimeMs,
              };
    }

    private pendingJob(id: string, request: UpgradeRequest, at: Date): UpgradeJob {
        return {
            id,
            state: 'pending',
            component: request.component,
            toVersion: request.toVersion,
            createdAt: at.toISOString(),
            updatedAt: at.toISOString(),
        };
    }

    /** An earlier request with this key, if there is one: Ghost's step 4. */
    private earlier(
        id: string,
        request: UpgradeRequest,
        pruned: readonly string[],
    ): RequestResult | undefined {
        const same = (other: { component: string; toVersion: string }) =>
            other.component === request.component && other.toVersion === request.toVersion;
        const conflict: RequestResult = {
            rejected: 'idempotency-conflict',
            reason: 'this idempotency key was used for another update',
        };
        const job = this.job(id);
        if (job !== undefined) {
            return same(job) ? { accepted: job } : conflict;
        }
        const pending = this.pending(id);
        if (pending !== undefined) {
            return same(pending.request)
                ? { accepted: this.pendingJob(id, pending.request, new Date(pending.mtimeMs)) }
                : conflict;
        }
        if (pruned.includes(id)) {
            return { rejected: 'request-expired', reason: 'the job of this key has been pruned' };
        }
        return undefined;
    }

    createRequest(request: UpgradeRequest): RequestResult {
        const status = this.readStatus();
        if (status.availability !== 'ready') {
            return {
                rejected: status.availability === 'busy' ? 'busy' : 'unavailable',
                reason:
                    'reason' in status ? status.reason : `the supervisor is ${status.availability}`,
            };
        }
        const offered = status.file.status.oneClick.some(
            (entry) =>
                entry.component === request.component && entry.toVersion === request.toVersion,
        );
        if (!offered) {
            return {
                rejected: 'target-unapproved',
                reason: `${request.component} ${request.toVersion} is not offered as a one-click update`,
            };
        }
        const id = jobIdOf(request.idempotencyKey);
        const pruned = status.file.prunedJobIds;
        for (;;) {
            const earlier = this.earlier(id, request, pruned);
            if (earlier !== undefined) {
                return earlier;
            }
            const at = this.now();
            if (
                createExchangeFile(
                    this.requests,
                    `${id}.json`,
                    { protocol: PROTOCOL, request },
                    BOUNDS.request,
                )
            ) {
                return { accepted: this.pendingJob(id, request, at) };
            }
            // An identical request raced this one: read it back.
        }
    }

    lookup(id: string): Lookup {
        const job = this.job(id);
        if (job !== undefined) {
            return job;
        }
        const pending = this.pending(id);
        const fresh =
            pending !== undefined && this.now().getTime() - pending.mtimeMs < REQUEST_MAX_AGE_MS;
        if (pending !== undefined && fresh) {
            return this.pendingJob(id, pending.request, new Date(pending.mtimeMs));
        }
        const status = this.readStatus();
        const pruned = 'file' in status ? status.file.prunedJobIds : [];
        return { id, state: pending !== undefined || pruned.includes(id) ? 'expired' : 'unknown' };
    }
}
