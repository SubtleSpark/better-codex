import { parentPort } from 'node:worker_threads';
parentPort.on('message', ({ id, source }) => {
  if (source.includes('TEST_TIMEOUT')) { while (true) {} }
  if (source.includes('TEST_CRASH')) { process.exit(1); }
  setTimeout(() => parentPort.postMessage({ id, ok: true,
    svg: `<svg xmlns="http://www.w3.org/2000/svg"><text>${id}</text></svg>`, engineVersion: 'test-fixture' }), 10);
});
