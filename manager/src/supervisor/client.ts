// Ghost's end of the protocol, as docs/upgrade-supervisor.md#ghost-reaching-the-supervisor
// describes it: the API over the socket, and what Ghost reports when it
// cannot be reached or does not speak protocol 1.
//
// HttpUpgradeAdapter in Ghost core is the real client. This one is for
// requests made by hand (`supervisor request`), run as Ghost's uid with the
// volume mounted as Ghost mounts it, so the hand tooling exercises Ghost's
// access rather than the operator's; and it drives the supervisor's tests.
import { request as httpRequest } from 'node:http';
import type { z } from 'zod';
import {
    CLIENT_TIMEOUT_MS,
    errorBodySchema,
    handshakeSchema,
    upgradeJobResultSchema,
    upgradeJobSchema,
    upgradeStatusSchema,
    type ErrorCode,
    type UpgradeJob,
    type UpgradeJobResult,
    type UpgradeRequest,
} from './protocol.ts';

type Status = z.output<typeof upgradeStatusSchema>;

export type StatusRead =
    | { readonly availability: 'unavailable' | 'incompatible'; readonly reason: string }
    | { readonly availability: 'ready' | 'busy' | 'unavailable'; readonly status: Status };

export type RequestResult =
    | { readonly accepted: UpgradeJob; readonly replay: boolean }
    | { readonly rejected: ErrorCode | 'incompatible'; readonly reason: string };

export type Lookup = UpgradeJobResult | { readonly failed: string };

interface Response {
    readonly status: number;
    readonly body: unknown;
}

class Unreachable extends Error {}
class Incompatible extends Error {}

export class SupervisorClient {
    private readonly socketPath: string;
    private checked = false;

    constructor(socketPath: string) {
        this.socketPath = socketPath;
    }

    private call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        return new Promise((resolve, reject) => {
            const request = httpRequest(
                {
                    socketPath: this.socketPath,
                    // A connection per call: a kept-alive one outlives a
                    // supervisor restart and fails the next call with EPIPE.
                    agent: false,
                    method,
                    path,
                    timeout: CLIENT_TIMEOUT_MS,
                    headers:
                        payload === undefined
                            ? {}
                            : {
                                  'content-type': 'application/json',
                                  'content-length': Buffer.byteLength(payload),
                              },
                },
                (response) => {
                    const chunks: Buffer[] = [];
                    response.on('data', (chunk: Buffer) => chunks.push(chunk));
                    response.on('end', () => {
                        const text = Buffer.concat(chunks).toString('utf8');
                        try {
                            resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) });
                        } catch {
                            reject(
                                new Incompatible(
                                    `${path} answered ${response.statusCode} with something that is not JSON`,
                                ),
                            );
                        }
                    });
                },
            );
            request.on('timeout', () =>
                request.destroy(new Unreachable(`no answer within ${CLIENT_TIMEOUT_MS} ms`)),
            );
            request.on('error', (error: NodeJS.ErrnoException) =>
                reject(
                    error instanceof Unreachable || error instanceof Incompatible
                        ? error
                        : new Unreachable(error.code ?? error.message),
                ),
            );
            request.end(payload);
        });
    }

    /** GET /v1, once per client, and again after any failure. */
    private async handshake(): Promise<void> {
        if (this.checked) {
            return;
        }
        const answer = await this.call('GET', '/v1');
        if (answer.status !== 200 || !handshakeSchema.safeParse(answer.body).success) {
            throw new Incompatible(`GET /v1 answered ${answer.status}, not protocol 1`);
        }
        this.checked = true;
    }

    private async guarded<T>(
        work: () => Promise<T>,
        failed: (kind: 'unavailable' | 'incompatible', reason: string) => T,
    ): Promise<T> {
        try {
            await this.handshake();
            return await work();
        } catch (error) {
            this.checked = false;
            if (error instanceof Unreachable) {
                return failed('unavailable', `the supervisor cannot be reached: ${error.message}`);
            }
            if (error instanceof Incompatible) {
                return failed('incompatible', error.message);
            }
            throw error;
        }
    }

    readStatus(): Promise<StatusRead> {
        return this.guarded<StatusRead>(
            async () => {
                const answer = await this.call('GET', '/v1/status');
                if (answer.status >= 500) {
                    return {
                        availability: 'unavailable',
                        reason: `the supervisor answered ${answer.status}`,
                    };
                }
                const status = upgradeStatusSchema.safeParse(answer.body);
                if (answer.status !== 200 || !status.success || !status.data.supported) {
                    throw new Incompatible(
                        `GET /v1/status answered ${answer.status} with a body that is not a status`,
                    );
                }
                const { availability } = status.data;
                if (
                    availability !== 'ready' &&
                    availability !== 'busy' &&
                    availability !== 'unavailable'
                ) {
                    throw new Incompatible(
                        `the supervisor reported ${availability}, which only Ghost decides`,
                    );
                }
                return { availability, status: status.data };
            },
            (availability, reason) => ({ availability, reason }),
        );
    }

    createRequest(request: UpgradeRequest): Promise<RequestResult> {
        return this.guarded<RequestResult>(
            async () => {
                const answer = await this.call('POST', '/v1/requests', request);
                if (answer.status === 200 || answer.status === 202) {
                    const job = upgradeJobSchema.safeParse(answer.body);
                    if (!job.success) {
                        throw new Incompatible(
                            'POST /v1/requests answered with a body that is not a job',
                        );
                    }
                    return { accepted: job.data, replay: answer.status === 200 };
                }
                const error = errorBodySchema.safeParse(answer.body);
                if (!error.success) {
                    throw new Incompatible(
                        `POST /v1/requests answered ${answer.status} without an error body`,
                    );
                }
                const { code, diagnostics } = error.data.error;
                return { rejected: code, reason: diagnostics?.[0]?.message ?? code };
            },
            (kind, reason) => ({ rejected: kind, reason }),
        );
    }

    lookup(id: string): Promise<Lookup> {
        return this.guarded<Lookup>(
            async () => {
                const answer = await this.call('GET', `/v1/jobs/${encodeURIComponent(id)}`);
                const result = upgradeJobResultSchema.safeParse(answer.body);
                if (answer.status === 200 && result.success) {
                    return result.data;
                }
                const error = errorBodySchema.safeParse(answer.body);
                if (error.success) {
                    return {
                        failed: error.data.error.diagnostics?.[0]?.message ?? error.data.error.code,
                    };
                }
                throw new Incompatible(
                    `GET /v1/jobs answered ${answer.status} with a body that is not a job`,
                );
            },
            (_kind, reason) => ({ failed: reason }),
        );
    }
}
