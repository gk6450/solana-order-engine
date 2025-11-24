import Fastify from 'fastify';
import './worker.js';  // <-- your existing worker code (no changes needed)

const app = Fastify();

app.get('/health', async () => ({ ok: true }));

const port = Number(process.env.PORT ?? 3000);

app.listen({ port, host: '0.0.0.0' })
  .then(() => console.log("Worker web server running on port", port))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
