Examples of each message of [the upgrade supervisor protocol](../../../../docs/upgrade-supervisor.md),
at protocol 1. `valid/` must parse and `invalid/` must be refused, by the
supervisor's tests here and by Ghost's FileDropUpgradeAdapter tests, which
keep copies. A fixture changes only together with the protocol document.

Fixtures are named for what they show. In an exchange a request lives at
`requests/<idempotencyKey>.json` and a job at `status/jobs/<id>.json`, where the
job's ID is that key: `valid/request.json` and the job fixtures use a key of 64
zeros, so `0000…0000.json` (64 zeros) is the name they take there.
