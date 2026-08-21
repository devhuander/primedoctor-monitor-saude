// Executa as sondas contra o alvo simulado e imprime o resultado em JSON.
// Roda num processo separado a cada caso, porque config.mjs lê process.env no
// topo do módulo e o cache de módulos do Node congelaria a configuração.
import { checkEdgeFunctions } from '../probe/checks/edge.mjs';
import { checkBackend, signIn } from '../probe/checks/backend.mjs';
import { checkFrontend } from '../probe/checks/frontend.mjs';

const session = await signIn();
const [edge, backend, frontend] = await Promise.all([
  checkEdgeFunctions(),
  checkBackend(session),
  checkFrontend(),
]);

process.stdout.write(
  '\n__RESULT__' +
    JSON.stringify({
      session: { ok: session.ok, skipped: session.skipped, monitorFault: session.monitorFault ?? false },
      edge,
      backend,
      frontend,
      db: backend.items.find((i) => i.key === 'database'),
    }),
);
process.exit(0);
