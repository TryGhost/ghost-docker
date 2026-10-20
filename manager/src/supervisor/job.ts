// A supervisor job: `update <version>`, run by the supervisor with the site
// lock held, through the same checks, plan and executor as the CLI (ghost-update.ts,
// update.ts). Its outcome becomes the job's final state; the words the CLI
// prints for it become the job's diagnostics.
import { relative } from 'node:path';
import { CliError, describeError } from '../errors.ts';
import { resolvePinned, type ResolvedGhost } from '../ghost.ts';
import {
    directionTo,
    ghostUpdatePlan,
    recoveryAdvice,
    refuseSiteDrift,
    Refused,
    siteGhost,
    type GhostUpdate,
} from '../ghost-update.ts';
import type { Io } from '../io.ts';
import { readSettings, siteFacts } from '../site.ts';
import { runUpdate } from '../update.ts';
import { diagnostic } from './diagnostics.ts';
import type { Executor, JobOutcome } from './supervisor.ts';
import { SUPERVISOR_SERVICE } from './store.ts';

const refused = (code: string, message: string): JobOutcome => ({
    state: 'refused',
    diagnostics: [diagnostic(code, 'error', `${message} Nothing has been changed.`)],
});

/**
 * What the update's own checks refused, under their code, in update's words;
 * those that say nothing has been changed are not told it twice.
 */
function refusedBy(error: unknown): JobOutcome {
    if (!(error instanceof CliError)) {
        return refused('refused', describeError(error));
    }
    const code = error instanceof Refused ? error.code : 'refused';
    return error.message.endsWith('Nothing has been changed.')
        ? { state: 'refused', diagnostics: [diagnostic(code, 'error', error.message)] }
        : refused(code, error.message);
}

export const ghostJob =
    (io: Io, dir: string): Executor =>
    async ({ record, stage, backup }) => {
        const { toVersion } = record.job;
        const settings = readSettings(dir);
        if (settings === null) {
            return refused('site-missing', 'The site has no .env.');
        }
        const { target } = record;
        if (target === null) {
            return refused('target-unapproved', `No image was pinned for Ghost ${toVersion}.`);
        }
        let update: GhostUpdate;
        try {
            const { metadata, from } = siteGhost(dir, settings, 'the supervisor');
            stage('pulling');
            let to: ResolvedGhost;
            try {
                // Exactly what discovery found, by digest: never what a tag points to now.
                to = await resolvePinned(io, target.image, target.tag, target.digest);
            } catch (error) {
                return refused(
                    'pull-failed',
                    `Ghost ${toVersion} could not be pulled: ${describeError(error)}.`,
                );
            }
            if ((await directionTo(io, from, to, toVersion)) !== 'newer') {
                return refused('not-newer', `This site already runs Ghost ${from.version}.`);
            }
            await refuseSiteDrift(io, dir);
            update = { io, site: siteFacts(dir, settings), metadata, from, to };
        } catch (error) {
            return refusedBy(error);
        }
        const { from, to } = update;
        const outcome = await runUpdate(
            ghostUpdatePlan(update, {
                except: [SUPERVISOR_SERVICE],
                onStage: stage,
                onBackup: (path) => backup(relative(dir, path)),
            }),
        );
        const taken = outcome.backup === null ? null : relative(dir, outcome.backup);
        const backedUp =
            taken === null ? '' : ` Before the update, the site was backed up to \`${taken}\`.`;
        switch (outcome.state) {
            case 'done':
                return {
                    state: 'done',
                    diagnostics: [
                        diagnostic(
                            'backup',
                            'info',
                            `Updated Ghost from ${from.version} to ${to.version}.${backedUp} Going back to Ghost ${from.version} means restoring that backup, which discards anything written since.`,
                        ),
                    ],
                };
            case 'restored':
                return {
                    state: 'restored',
                    diagnostics: [
                        diagnostic(
                            'restored',
                            'error',
                            `The update failed before Ghost ${to.version} started; the site is back on Ghost ${from.version}, as it was.${backedUp}`,
                            describeError(outcome.error),
                        ),
                    ],
                };
            case 'needs-operator': {
                const advice = recoveryAdvice(update, outcome);
                const steps = [
                    ...advice.facts,
                    ...(advice.choices.length === 0
                        ? []
                        : [
                              advice.choices.length === 1
                                  ? 'In the site directory:'
                                  : 'In the site directory, choose one:',
                              ...advice.choices.map(
                                  (choice) =>
                                      `  ${choice.does}: ${choice.commands.map((command) => `\`${command}\``).join(', then ')}`,
                              ),
                          ]),
                    `The files as they were before the update are in \`${advice.snapshot}/files\`; once the site is as it should be, remove \`${advice.snapshot}\`.`,
                ];
                return {
                    state: 'needs-operator',
                    diagnostics: [
                        diagnostic(
                            'needs-operator',
                            'error',
                            `The update to Ghost ${to.version} failed and the site is stopped; it needs the operator.${backedUp}`,
                            `${describeError(outcome.error)}\n\n${steps.join('\n')}`,
                        ),
                    ],
                };
            }
        }
    };
