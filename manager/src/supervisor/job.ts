// A supervisor job: `update <version>`, run by the supervisor with the site
// lock held, through the same plan and executor as the CLI (commands/update.ts,
// update.ts). Its outcome becomes the job's final state; the words the CLI
// prints for it become the job's diagnostics.
import { relative } from 'node:path';
import { refuseDrift } from '../backup.ts';
import { ghostUpdatePlan, order, reference, type GhostUpdate } from '../commands/update.ts';
import { describeError } from '../errors.ts';
import { resolvePinned } from '../ghost.ts';
import type { Io } from '../io.ts';
import { requireMetadata } from '../meta.ts';
import { resolveSite } from '../resolved.ts';
import { readSettings, siteFacts } from '../site.ts';
import { runUpdate } from '../update.ts';
import { diagnostic } from './diagnostics.ts';
import type { Executor, JobOutcome } from './supervisor.ts';
import { SUPERVISOR_SERVICE } from './store.ts';

const refused = (code: string, message: string): JobOutcome => ({
    state: 'refused',
    diagnostics: [diagnostic(code, 'error', `${message} Nothing has been changed.`)],
});

export const ghostJob =
    (io: Io, dir: string): Executor =>
    async ({ record, stage, backup }) => {
        const { toVersion } = record.job;
        const settings = readSettings(dir);
        if (settings === null) {
            return refused('site-missing', 'The site has no .env.');
        }
        const site = siteFacts(dir, settings);
        const metadata = requireMetadata(
            dir,
            'the supervisor cannot tell which Ghost the site runs',
        );
        const from = metadata.ghost;
        if (settings.get('GHOST_IMAGE_REF') !== reference(from)) {
            return refused(
                'pin-mismatch',
                `\`.env\` pins \`GHOST_IMAGE_REF\` to something other than the Ghost \`.ghost-docker.json\` records (${from.version}).`,
            );
        }

        const { target } = record;
        if (target === null) {
            return refused('target-unapproved', `No image was pinned for Ghost ${toVersion}.`);
        }
        stage('pulling');
        let to;
        try {
            // Exactly what discovery found, by digest: never what a tag points to now.
            to = await resolvePinned(io, target.image, target.tag, target.digest);
        } catch (error) {
            return refused(
                'pull-failed',
                `Ghost ${toVersion} could not be pulled: ${describeError(error)}.`,
            );
        }
        if (to.version !== toVersion) {
            return refused(
                'target-mismatch',
                `${to.reference} is Ghost ${to.version}, not ${toVersion}.`,
            );
        }
        try {
            if ((await order(io, from, to)) !== 'newer') {
                return refused('not-newer', `This site already runs Ghost ${from.version}.`);
            }
            await refuseDrift(io, await resolveSite(io, dir));
        } catch (error) {
            return refused('refused', describeError(error));
        }

        const update: GhostUpdate = { io, site, metadata, from, to };
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
                const steps = [
                    ...outcome.problems,
                    ...(outcome.servicesChanged
                        ? [
                              `Ghost ${to.version} started before the update failed, so it may have migrated the database and accepted writes since the backup. Nothing was loaded over them.`,
                          ]
                        : []),
                    'In the site directory, choose one:',
                    ...(taken === null
                        ? []
                        : [
                              `  Put the site back on Ghost ${from.version} as it was, discarding anything written since: \`./ghost-docker restore --yes ${taken}\``,
                          ]),
                    `  Or find why Ghost ${to.version} did not start (\`docker compose logs ghost\`), fix it, then \`docker compose up -d\` and \`./ghost-docker check\``,
                    `The files as they were before the update are in \`${relative(dir, outcome.snapshot)}/files\`; once the site is as it should be, remove \`${relative(dir, outcome.snapshot)}\`.`,
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
