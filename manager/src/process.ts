// Running other programs, written as a template: exec`docker compose version`.
// Interpolated values are whole arguments, never re-split, and an array is
// several; there is no shell. More options are layered by calling the
// instance with them: exec({ timeout: 60_000 })`...`.
//
// Every run has a deadline, because a program that has wedged stops answering
// rather than returning an error, and failure is a result (`failed`,
// `exitCode`, `shortMessage`) rather than an exception, so callers read it.
import { execa } from 'execa';

export const exec = execa({
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
    reject: false,
    stdin: 'ignore',
});

export type Exec = typeof exec;
