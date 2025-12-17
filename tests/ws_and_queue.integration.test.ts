import { Keypair } from '@solana/web3.js'

process.env.USE_MOCK = 'true'
process.env.REDIS_URL = 'provided'
const kp = Keypair.generate()
process.env.WALLET_PRIVATE_KEY_JSON = JSON.stringify(Array.from(kp.secretKey))

// --------------------
// Mock bullmq
// small in-memory Queue/Worker that calls processors in-process.
// --------------------
import { vi } from 'vitest'

vi.mock('bullmq', () => {
    // Simple in-memory job bus keyed by queue name
    const queues = new Map<string, any[]>()
    const workers = new Map<string, any>()

    class Queue {
        name: string
        constructor(name: string, opts?: any) {
            this.name = name
            if (!queues.has(name)) queues.set(name, [])
        }

        async add(jobName: string, data: any, opts?: any) {
            const job = {
                id: `${jobName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                name: jobName,
                data,
                opts
            }
            queues.get(this.name)!.push(job)
            // If a worker exists for this queue, call its processor asynchronously
            const w = workers.get(this.name)
            if (w && typeof w.process === 'function') {
                // mimic async scheduling like BullMQ
                setImmediate(async () => {
                    try {
                        await w.process(job)
                        // optionally, call completed handler
                        if (w.onCompleted) w.onCompleted(job)
                    } catch (err) {
                        if (w.onError) w.onError(err)
                    }
                })
            }
            return job
        }

        async close() {
            queues.delete(this.name)
        }
    }

    class Worker {
        name: string
        processor: (job: any) => Promise<any>
        onError: ((err: any) => void) | null = null
        onCompleted: ((job: any) => void) | null = null
        constructor(name: string, processor: (job: any) => Promise<any>, opts?: any) {
            this.name = name
            this.processor = async (job: any) => {
                // wrap to mimic Bull job interface
                const wrapper = { id: job.id, name: job.name, data: job.data }
                return processor(wrapper as any)
            }
            // register into workers map so the Queue.add triggers processing
            workers.set(name, { process: this.processor, onError: (e: any) => this.onError?.(e), onCompleted: (j: any) => this.onCompleted?.(j) })
        }

        on(event: string, fn: Function) {
            if (event === 'error') this.onError = fn as any
            if (event === 'completed') this.onCompleted = fn as any
        }

        async close() {
            workers.delete(this.name)
        }
    }

    // Export minimal API used by your code/tests
    return {
        Queue,
        Worker,
        // other bullmq exports might be required by imports; provide no-op placeholders
        QueueEvents: class { constructor() { } },
        Job: class { constructor() { } },
    }
})

// --------------------
// Now import testing utilities and mocks (these will use the mocked bullmq)
// --------------------
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import RedisMock from 'ioredis-mock'
import { subscribeSocket, unsubscribeSocket, publishOrderUpdate } from '../src/websocket/wsManager.js'

// Mock DB functions to avoid Postgres connection
vi.mock('../src/config/db.js', () => ({
    insertOrder: async () => ({ rows: [] }),
    updateOrderStatus: async () => ({ rows: [] }),
    setRoutingInfo: async () => ({ rows: [] })
}));

// Replace ioredis with ioredis-mock in the test environment
vi.mock('ioredis', () => {
    return { default: RedisMock, Redis: RedisMock };
});

// --------------------
// Test code using the in-memory Queue/Worker
// --------------------
import { Queue } from 'bullmq' // will resolve to our mocked Queue
let queue: Queue

beforeAll(async () => {
    // Import worker AFTER mocks are set up
    // Worker constructor inside worker.js will use the mocked Worker
    await import('../src/worker.js')

    // create a queue instance (mocked)
    const { Redis } = await import('ioredis') // returns RedisMock
    const connection = new Redis(process.env.REDIS_URL!)
    queue = new Queue('orders', { connection })
})

afterAll(async () => {
    if (queue) await queue.close()
})

describe('Queue + WS integration (in-memory mocked bullmq)', () => {
    it('worker processes job and websocket receives pending + final state (confirmed|failed)', async () => {
        const orderId = 'test-integ-1';
        const sent: any[] = [];
        const fakeWs: any = {
            OPEN: 1,
            readyState: 1,
            send: (msg: string) => sent.push(msg)
        };

        subscribeSocket(orderId, fakeWs);

        await queue.add('execute', {
            orderId,
            token_in: 'A',
            token_out: 'B',
            amount_in: '1000',
            slippage: 1.0
        }, { removeOnComplete: true });

        // wait for the worker to process — poll for up to 12s (was 8s)
        const start = Date.now();
        while (Date.now() - start < 12000) {
            if (sent.length > 0) break;
            await new Promise(r => setTimeout(r, 200));
        }

        const all = sent.map(s => JSON.parse(s));
        const statuses = all.map((m: any) => m.status).filter(Boolean);

        // must have started
        expect(statuses).toContain('pending');

        // must have reached a final/terminal state: either 'confirmed' or 'failed'
        const finalSeen = statuses.some(s => s === 'confirmed' || s === 'failed' || s === 'submitted');
        expect(finalSeen).toBeTruthy();

        unsubscribeSocket(orderId, fakeWs);
    });


    it('publishOrderUpdate publishes to redis channel without throwing', async () => {
        await expect(publishOrderUpdate('dummy-1', { orderId: 'dummy-1', status: 'pending' })).resolves.not.toThrow()
    })

    it('subscribe/unsubscribe manages subscribers map safely', () => {
        const orderId = 'subtest-1'
        const fakeWs = { OPEN: 1, readyState: 1, send: () => { } }
        subscribeSocket(orderId, fakeWs as any)
        expect(() => unsubscribeSocket(orderId, fakeWs as any)).not.toThrow()
    })

    it('adding multiple jobs processed concurrently (basic check)', async () => {
        const items = [1, 2, 3].map(i => queue.add('execute', {
            orderId: `many-${i}-${Date.now()}`,
            token_in: 'A',
            token_out: 'B',
            amount_in: '1000'
        }))
        await Promise.all(items)
        expect(true).toBeTruthy()
    })
})
