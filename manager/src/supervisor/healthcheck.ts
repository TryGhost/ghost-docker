// The supervisor service's health check (compose.yml): healthy while it
// answers `GET /v1` on its socket with the protocol it speaks.
import { request } from 'node:http';
import { CLIENT_TIMEOUT_MS, PROTOCOL, SOCKET_PATH } from './protocol.ts';

const healthy = await new Promise<boolean>((resolve) => {
    const call = request({ socketPath: SOCKET_PATH, path: '/v1', agent: false }, (response) => {
        let body = '';
        response.on('data', (chunk: Buffer) => (body += chunk));
        response.on('end', () => {
            try {
                resolve(response.statusCode === 200 && JSON.parse(body).protocol === PROTOCOL);
            } catch {
                resolve(false);
            }
        });
    });
    call.setTimeout(CLIENT_TIMEOUT_MS, () => call.destroy());
    call.on('error', () => resolve(false));
    call.end();
});
process.exit(healthy ? 0 : 1);
