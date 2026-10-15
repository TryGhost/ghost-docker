// The supervisor service's health check (compose.yml): healthy while it
// answers on its socket as Ghost would ask it, protocol handshake included.
// Busy or unavailable is still healthy: the supervisor is up and saying why.
import { SupervisorClient } from './client.ts';
import { SOCKET_PATH } from './protocol.ts';

const read = await new SupervisorClient(SOCKET_PATH).readStatus();
if (!('status' in read)) {
    process.stderr.write(`${read.availability}: ${read.reason}\n`);
}
process.exit('status' in read ? 0 : 1);
