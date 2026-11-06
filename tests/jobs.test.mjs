import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserJobRuntime, JobCheckpointError } from '../dist/esm/index.js';

function memoryAdapter() {
  const data = new Map();
  return {
    data,
    async load(id) {
      return data.get(id);
    },
    async save(id, checkpoint) {
      data.set(id, checkpoint);
    },
    async clear(id) {
      data.delete(id);
    },
  };
}

test('executes sequential steps and persists a strict checkpoint after each', async () => {
  const adapter = memoryAdapter();
  const runtime = createBrowserJobRuntime(adapter);
  const result = await runtime.run(
    'job',
    [
      { id: 'add', run: (state) => ({ count: state.count + 1 }) },
      { id: 'double', run: (state) => ({ count: state.count * 2 }) },
    ],
    { initialState: { count: 2 } },
  );
  assert.deepEqual(result, { state: { count: 6 }, completed: 2, resumed: false });
  assert.deepEqual(adapter.data.get('job'), {
    format: 1,
    jobId: 'job',
    plan: ['add', 'double'],
    completed: 2,
    state: { count: 6 },
  });
});

test('resumes from the last successful step after an error', async () => {
  const adapter = memoryAdapter();
  const runtime = createBrowserJobRuntime(adapter);
  const steps = [
    { id: 'one', run: (state) => state + 1 },
    {
      id: 'two',
      run: () => {
        throw new Error('interrupted');
      },
    },
    { id: 'three', run: (state) => state + 3 },
  ];
  await assert.rejects(runtime.run('resume', steps, { initialState: 0 }), /interrupted/);
  const resumed = await runtime.run(
    'resume',
    [steps[0], { id: 'two', run: (state) => state + 2 }, steps[2]],
    { initialState: 0 },
  );
  assert.deepEqual(resumed, { state: 6, completed: 3, resumed: true });
});

test('checks abort cooperatively between steps', async () => {
  const adapter = memoryAdapter();
  const runtime = createBrowserJobRuntime(adapter);
  const controller = new AbortController();
  controller.abort(new Error('stop'));
  await assert.rejects(
    runtime.run('aborted', [{ id: 'step', run: (state) => state }], {
      initialState: 0,
      signal: controller.signal,
    }),
    /stop/,
  );
  assert.equal(adapter.data.has('aborted'), false);
});

test('rejects a stored checkpoint for a different plan', async () => {
  const adapter = memoryAdapter();
  adapter.data.set('mismatch', {
    format: 1,
    jobId: 'mismatch',
    plan: ['old'],
    completed: 1,
    state: 1,
  });
  const runtime = createBrowserJobRuntime(adapter);
  await assert.rejects(
    runtime.run('mismatch', [{ id: 'new', run: (state) => state }], { initialState: 0 }),
    JobCheckpointError,
  );
});

test('rejects non-JSON state and duplicate step IDs', async () => {
  const runtime = createBrowserJobRuntime(memoryAdapter());
  await assert.rejects(
    runtime.run('invalid', [{ id: 'step', run: () => ({ value: undefined }) }], {
      initialState: {},
    }),
    JobCheckpointError,
  );
  await assert.rejects(
    runtime.run(
      'duplicate',
      [
        { id: 'same', run: (state) => state },
        { id: 'same', run: (state) => state },
      ],
      { initialState: 0 },
    ),
    TypeError,
  );
});

test('clears persisted state through the adapter and enforces limits', async () => {
  const adapter = memoryAdapter();
  const runtime = createBrowserJobRuntime(adapter);
  await runtime.run('clear-me', [], { initialState: null });
  await runtime.clear('clear-me');
  assert.equal(adapter.data.has('clear-me'), false);
  await assert.rejects(
    runtime.run('too-large', [{ id: 'x', run: (state) => state }], {
      initialState: 0,
      maxSteps: 0,
    }),
    RangeError,
  );
});
