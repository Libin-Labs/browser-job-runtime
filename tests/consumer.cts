import { createBrowserJobRuntime, type JobRunOptions } from '@lp-labs/browser-job-runtime';
const store = new Map<string, unknown>();
const runtime = createBrowserJobRuntime({
  async load(id) {
    return store.get(id);
  },
  async save(id, checkpoint) {
    store.set(id, checkpoint);
  },
  async clear(id) {
    store.delete(id);
  },
});
const options: JobRunOptions<string> = { initialState: 'ready' };
const result: Promise<{ state: string; completed: number; resumed: boolean }> = runtime.run(
  'job',
  [{ id: 'done', run: (state) => state }],
  options,
);
void result;
