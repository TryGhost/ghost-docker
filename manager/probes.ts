// These scripts execute inside Ghost via `node -e`, where CommonJS require is
// available. Keep them readable here instead of compressing code into CLI args.
export const GHOST_READINESS_PROBE = `
const http = require('node:http');
const url = new URL(process.argv[1]);

http.get({
  host: '127.0.0.1',
  port: 2368,
  path: process.argv[2],
  headers: {
    Host: url.host,
    'X-Forwarded-Proto': url.protocol.slice(0, -1)
  }
}, response => {
  process.exit(response.statusCode === 200 ? 0 : 1);
}).on('error', () => process.exit(1));
`;

export const CADDY_ROUTING_PROBE = `
const https = require('node:https');
const domain = process.argv[1];

https.get({
  host: 'caddy',
  port: 443,
  path: '/ghost/api/admin/site/',
  servername: domain,
  headers: {Host: domain},
  rejectUnauthorized: false
}, response => {
  process.exit(response.statusCode === 200 ? 0 : 1);
}).on('error', () => process.exit(1));
`;
