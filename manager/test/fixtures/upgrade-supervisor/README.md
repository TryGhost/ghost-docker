Examples of each body of [the upgrade supervisor protocol](../../../../docs/upgrade-supervisor.md),
at protocol 1: `valid/` must parse and `invalid/` must be refused, by the
supervisor's tests here and by Ghost's HttpUpgradeAdapter tests, which keep
copies in [`ghost/test/utils/fixtures/upgrade-supervisor/`](https://github.com/TryGhost/Ghost/tree/main/ghost/test/utils/fixtures/upgrade-supervisor).
A fixture changes only together with the protocol document, and in both places.

The prefix names the body: `request` (POST /v1/requests), `status`
(GET /v1/status), `job` (a job, as POST /v1/requests and GET /v1/jobs/<id>
answer it), `lookup` (GET /v1/jobs/<id> for a job not kept), `handshake`
(GET /v1) and `error` (any error response). The job fixtures use the key of
`valid/request.json`, 64 zeros, as their ID.
