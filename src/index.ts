export type JobCheckpoint = Readonly<{
  format: 1;
  jobId: string;
  plan: readonly string[];
  completed: number;
  state: unknown;
}>;

export interface CheckpointAdapter {
  load(jobId: string): Promise<unknown | undefined>;
  save(jobId: string, checkpoint: JobCheckpoint): Promise<void>;
  clear(jobId: string): Promise<void>;
}

export type JobStep<T> = Readonly<{
  id: string;
  run(state: T, context: Readonly<{ signal?: AbortSignal }>): T | Promise<T>;
}>;

export type JobRunOptions<T> = Readonly<{
  initialState: T;
  signal?: AbortSignal;
  maxSteps?: number;
  maxCheckpointBytes?: number;
}>;

export type JobRunResult<T> = Readonly<{
  state: T;
  completed: number;
  resumed: boolean;
}>;

export class JobCheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobCheckpointError';
  }
}

function cloneJson(value: unknown, maxBytes: number): unknown {
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 100_000 || depth > 64)
      throw new JobCheckpointError('Checkpoint state exceeds limits');
    if (
      item === null ||
      typeof item === 'string' ||
      typeof item === 'boolean' ||
      (typeof item === 'number' && Number.isFinite(item))
    ) {
      return;
    }
    if (typeof item !== 'object')
      throw new JobCheckpointError('Checkpoint state must be strict JSON');
    if (seen.has(item)) throw new JobCheckpointError('Checkpoint state must not contain cycles');
    seen.add(item);
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index += 1) {
        if (!(index in item))
          throw new JobCheckpointError('Sparse arrays are not valid checkpoint state');
        visit(item[index], depth + 1);
      }
      for (const key of Reflect.ownKeys(item)) {
        if (key === 'length') continue;
        if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= item.length) {
          throw new JobCheckpointError('Arrays must not contain custom properties');
        }
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          throw new JobCheckpointError('Checkpoint state must not contain accessors');
        }
      }
    } else {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new JobCheckpointError('Checkpoint state must contain plain objects');
      }
      for (const key of Reflect.ownKeys(item)) {
        if (typeof key !== 'string')
          throw new JobCheckpointError('Symbol keys are not valid JSON state');
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          throw new JobCheckpointError('Checkpoint state must not contain accessors');
        }
        visit(descriptor.value, depth + 1);
      }
    }
    seen.delete(item);
  };
  visit(value, 0);
  const json = JSON.stringify(value);
  if (json === undefined || new TextEncoder().encode(json).byteLength > maxBytes) {
    throw new JobCheckpointError('Checkpoint state exceeds maxCheckpointBytes');
  }
  return JSON.parse(json) as unknown;
}

function isCheckpoint(value: unknown, maxSteps: number): value is JobCheckpoint {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const checkpoint = value as Record<string, unknown>;
    const fields = new Map<string, unknown>();
    for (const key of ['format', 'jobId', 'plan', 'completed', 'state']) {
      const descriptor = Object.getOwnPropertyDescriptor(checkpoint, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) return false;
      fields.set(key, descriptor.value);
    }
    const plan = fields.get('plan');
    if (!Array.isArray(plan) || plan.length > maxSteps) return false;
    for (let index = 0; index < plan.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(plan, String(index));
      if (
        !descriptor?.enumerable ||
        !('value' in descriptor) ||
        typeof descriptor.value !== 'string'
      ) {
        return false;
      }
    }
    return (
      fields.get('format') === 1 &&
      typeof fields.get('jobId') === 'string' &&
      (fields.get('jobId') as string).length <= 128 &&
      Number.isSafeInteger(fields.get('completed')) &&
      (fields.get('completed') as number) >= 0 &&
      (fields.get('completed') as number) <= plan.length
    );
  } catch {
    return false;
  }
}

export function createBrowserJobRuntime(adapter: CheckpointAdapter) {
  if (
    !adapter ||
    typeof adapter.load !== 'function' ||
    typeof adapter.save !== 'function' ||
    typeof adapter.clear !== 'function'
  ) {
    throw new TypeError('adapter must implement load, save, and clear');
  }

  return Object.freeze({
    async run<T>(
      jobId: string,
      steps: readonly JobStep<T>[],
      options: JobRunOptions<T>,
    ): Promise<JobRunResult<T>> {
      if (!options || typeof options !== 'object') throw new TypeError('options are required');
      if (typeof jobId !== 'string' || jobId.length === 0 || jobId.length > 128) {
        throw new TypeError('jobId must be a nonempty string of at most 128 characters');
      }
      const maxSteps = options.maxSteps ?? 500;
      const maxBytes = options.maxCheckpointBytes ?? 1_000_000;
      if (!Number.isSafeInteger(maxSteps) || maxSteps < 1)
        throw new RangeError('maxSteps must be positive');
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
        throw new RangeError('maxCheckpointBytes must be positive');
      }
      if (!Array.isArray(steps) || steps.length > maxSteps)
        throw new RangeError('Step limit exceeded');
      const plan = steps.map((step) => step.id);
      if (
        plan.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 128) ||
        new Set(plan).size !== plan.length ||
        steps.some((step) => typeof step.run !== 'function')
      ) {
        throw new TypeError('Steps need unique bounded ids and run functions');
      }
      const stored = await adapter.load(jobId);
      let completed = 0;
      let state = options.initialState;
      let resumed = false;
      if (stored !== undefined) {
        if (!isCheckpoint(stored, maxSteps) || stored.jobId !== jobId) {
          throw new JobCheckpointError('Stored checkpoint is malformed or belongs to another job');
        }
        if (
          stored.plan.length !== plan.length ||
          stored.plan.some((id, index) => id !== plan[index])
        ) {
          throw new JobCheckpointError('Stored checkpoint plan does not match the supplied steps');
        }
        completed = stored.completed;
        state = cloneJson(stored.state, maxBytes) as T;
        resumed = completed > 0;
      } else {
        state = cloneJson(state, maxBytes) as T;
      }

      for (let index = completed; index < steps.length; index += 1) {
        if (options.signal?.aborted)
          throw options.signal.reason ?? new DOMException('Aborted', 'AbortError');
        state = await steps[index]!.run(state, Object.freeze({ signal: options.signal }));
        const checkpoint: JobCheckpoint = Object.freeze({
          format: 1,
          jobId,
          plan: Object.freeze([...plan]),
          completed: index + 1,
          state: cloneJson(state, maxBytes),
        });
        await adapter.save(jobId, checkpoint);
        completed = index + 1;
      }
      return Object.freeze({ state, completed, resumed });
    },
    clear(jobId: string): Promise<void> {
      return adapter.clear(jobId);
    },
  });
}
