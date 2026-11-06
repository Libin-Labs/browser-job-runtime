import {
  createBrowserJobRuntime,
  type CheckpointAdapter,
  type JobCheckpoint,
  type JobStep,
} from '@lp-labs/browser-job-runtime';

const entries = new Map<string, JobCheckpoint>();
const adapter: CheckpointAdapter = {
  async load(id) {
    return entries.get(id);
  },
  async save(id, checkpoint) {
    entries.set(id, checkpoint);
  },
  async clear(id) {
    entries.delete(id);
  },
};
const step: JobStep<{ total: number }> = {
  id: 'increment',
  run: (state) => ({ total: state.total + 1 }),
};
const result = await createBrowserJobRuntime(adapter).run('typed', [step], {
  initialState: { total: 0 },
});
const total: number = result.state.total;
void total;
