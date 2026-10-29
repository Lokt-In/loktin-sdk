// The scheduler examples (E5, W108): each one parses, and keeps the settings
// that make a pass safe to run.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const examples = join(import.meta.dirname, '..', 'examples');
const read = (name: string) => readFile(join(examples, name), 'utf8');

// The run flags every example uses (E6).
const RUN_FLAGS = [
  '--rm',
  '--init',
  '--read-only',
  '--cap-drop ALL',
  '--security-opt no-new-privileges',
  '-e LOKTIN_KEEPER_SECRET_FILE=/run/secrets/loktin_keeper_secret',
];
const KEY_MOUNT = /-v \S+:\/run\/secrets\/loktin_keeper_secret:ro/;

// The parts of the CronJob's pod the test checks.
interface PodSpec {
  restartPolicy: string;
  securityContext: Record<string, unknown>;
  containers: {
    env: { name: string; value: string }[];
    securityContext: {
      readOnlyRootFilesystem: boolean;
      allowPrivilegeEscalation: boolean;
      capabilities: { drop: string[] };
    };
    volumeMounts: { name: string; mountPath: string; readOnly: boolean }[];
  }[];
  volumes: {
    name: string;
    secret: {
      secretName: string;
      items: { key: string; path: string }[];
      defaultMode: number;
    };
  }[];
}

describe('the scheduler examples', () => {
  it('crontab: one line, every hour at a minute away from the hour', async () => {
    const lines = (await read('crontab'))
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.startsWith('#'));
    expect(lines).toHaveLength(1);
    const [minute, hour, day, month, weekday, ...command] =
      lines[0]?.split(' ') ?? [];
    expect([hour, day, month, weekday]).toEqual(['*', '*', '*', '*']);
    expect(Number(minute)).toBeGreaterThan(5);
    expect(Number(minute)).toBeLessThan(55);
    const run = command.join(' ');
    expect(run.startsWith('docker run ')).toBe(true);
    for (const flag of RUN_FLAGS) {
      expect(run).toContain(flag);
    }
    expect(run).toMatch(KEY_MOUNT);
    expect(run).toContain('-e LOKTIN_KEEPER_INTEGRATORS=');
  });

  it('Kubernetes: no overlap, the key as a file the node user reads, read-only and non-root', async () => {
    const job = parse(await read('kubernetes-cronjob.yaml')) as {
      apiVersion: string;
      kind: string;
      spec: {
        schedule: string;
        concurrencyPolicy: string;
        jobTemplate: { spec: { template: { spec: PodSpec } } };
      };
    };
    expect(job.apiVersion).toBe('batch/v1');
    expect(job.kind).toBe('CronJob');
    expect(job.spec.schedule).toBe('23 * * * *');
    expect(job.spec.concurrencyPolicy).toBe('Forbid');

    const pod = job.spec.jobTemplate.spec.template.spec;
    expect(pod.restartPolicy).toBe('Never');
    expect(pod.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
      fsGroup: 1000,
    });
    expect(pod.containers).toHaveLength(1);
    const [container] = pod.containers;
    expect(container?.securityContext).toEqual({
      readOnlyRootFilesystem: true,
      allowPrivilegeEscalation: false,
      capabilities: { drop: ['ALL'] },
    });
    expect(container?.env).toContainEqual({
      name: 'LOKTIN_KEEPER_SECRET_FILE',
      value: '/run/secrets/loktin_keeper_secret',
    });
    expect(container?.env.map((entry) => entry.name)).not.toContain(
      'LOKTIN_KEEPER_SECRET',
    );
    expect(container?.volumeMounts).toEqual([
      { name: 'keeper-secret', mountPath: '/run/secrets', readOnly: true },
    ]);
    expect(pod.volumes).toEqual([
      {
        name: 'keeper-secret',
        secret: {
          secretName: 'loktin-keeper',
          items: [{ key: 'secret', path: 'loktin_keeper_secret' }],
          // Read only, for the owner and the fsGroup (uid 1000's group).
          defaultMode: 0o440,
        },
      },
    ]);
  });

  it('GitHub Actions: four times an hour, no overlap, the key only as a file', async () => {
    const workflow = parse(await read('github-actions.yml')) as {
      on: { schedule: { cron: string }[]; workflow_dispatch: null };
      permissions: Record<string, string>;
      concurrency: { group: string; 'cancel-in-progress': boolean };
      jobs: {
        keeper: {
          'timeout-minutes': number;
          steps: {
            uses?: string;
            run?: string;
            env?: Record<string, string>;
          }[];
        };
      };
    };
    expect(Object.keys(workflow.on).sort()).toEqual([
      'schedule',
      'workflow_dispatch',
    ]);
    expect(workflow.on.schedule.map((entry) => entry.cron)).toEqual([
      '7 * * * *',
      '22 * * * *',
      '37 * * * *',
      '52 * * * *',
    ]);
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.concurrency['cancel-in-progress']).toBe(false);
    expect(workflow.jobs.keeper['timeout-minutes']).toBe(10);

    const steps = workflow.jobs.keeper.steps;
    // Every action is pinned by its commit hash.
    for (const step of steps.filter((s) => s.uses !== undefined)) {
      expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
    }
    // Only the step that runs the keeper sees the secret.
    const withSecret = steps.filter((step) =>
      Object.values(step.env ?? {}).some((value) => value.includes('secrets.')),
    );
    expect(withSecret).toHaveLength(1);
    const script = withSecret[0]?.run ?? '';
    expect(script).toContain('umask 077');
    expect(script).toContain('mktemp -d');
    expect(script).toContain(`trap 'rm -rf "$secret_dir"' EXIT`);
    expect(script).toContain('chmod 0444');
    const run = script.replace(/\\\n\s*/g, '');
    for (const flag of RUN_FLAGS) {
      expect(run).toContain(flag);
    }
    expect(run).toMatch(KEY_MOUNT);
    // The container never gets the secret variable itself.
    expect(run).not.toMatch(/-e LOKTIN_KEEPER_SECRET(\s|=)/);
  });
});
