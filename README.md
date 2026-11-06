# @lp-labs/browser-job-runtime

Resumable sequential jobs that checkpoint after each completed step through an injected adapter.
The adapter contract can be connected to IndexedDB, a server, or another store by the host.
This package does not promise that browsers keep work alive in the background. It has zero runtime
and peer dependencies.

## Install

```bash
npm install @lp-labs/browser-job-runtime
```

The package provides ESM, CommonJS, and TypeScript declarations.

## Quickstart

```js
import { createBrowserJobRuntime } from '@lp-labs/browser-job-runtime';

const records = new Map();
const runtime = createBrowserJobRuntime({
  async load(id) {
    return records.get(id);
  },
  async save(id, checkpoint) {
    records.set(id, checkpoint);
  },
  async clear(id) {
    records.delete(id);
  },
});
const result = await runtime.run(
  'daily-count',
  [{ id: 'count', run: (state) => ({ total: state.total + 1 }) }],
  { initialState: { total: 0 } },
);
if (result.state.total !== 1) throw new Error('Job did not complete');
await runtime.clear('daily-count');
```

## API

- `createBrowserJobRuntime(adapter)` requires `load(jobId)`, `save(jobId, checkpoint)`, and
  `clear(jobId)` async methods. `load` returns `undefined` if no checkpoint exists.
- `runtime.run(jobId, steps, options)` executes named steps in order, passing each step the previous
  state and `{ signal? }`. The saved checkpoint records the next step index and the strict-JSON
  state after the prior step. The result is `{ state, completed, resumed }`.
- `runtime.clear(jobId)` delegates checkpoint deletion to the adapter.
- `JobCheckpointError` indicates malformed or incompatible stored data and invalid checkpoint state.

Job IDs and step IDs are unique bounded strings; plans default to at most 500 steps and checkpoint
state defaults to at most 1,000,000 UTF-8 bytes, 100,000 values, and depth 64. State must be strict
JSON (finite numbers, plain objects, dense arrays; no cycles, accessors, functions, or class
instances). A saved plan must exactly match the supplied step IDs. Abort is cooperative: it is
checked between steps, not used to forcibly stop a running callback. Step and adapter errors
propagate; the last completed checkpoint remains available.

## Customization and limits

Implement persistence, encryption, quotas, and cross-device consistency in the adapter. Keep step
functions idempotent when they produce external side effects: a crash can occur after an effect but
before the next checkpoint save. This utility offers no locks, retry policy, transaction semantics,
worker scheduling, browser alarms, or background execution guarantee. Adapter atomicity and lifetime
are host responsibilities.

## Exported types

`JobCheckpoint`, `CheckpointAdapter`, `JobStep<T>`, `JobRunOptions<T>`, and `JobRunResult<T>` define
the public checkpoint and step contracts.

## Support

If this library is useful to you, consider supporting its maintenance with a [donation via PayPal](https://www.paypal.me/LibinPrasanth).

## Author

Created by [Libin Prasanth](https://www.linkedin.com/in/libinprasanth/). Connect on LinkedIn for updates and discussion.
