// Dobles de prueba: reemplazan DynamoDB y el azar para que las pruebas sean rápidas y repetibles.
import { createSimulation } from '../src/lib/simulation.mjs';

// Llave de prueba (coincide con API_KEY abajo).
export const TEST_API_KEY = 'secreto123';

process.env.API_KEY ??= TEST_API_KEY;

// Repositorio en memoria con la misma interfaz que repository.mjs.
export const createMemoryRepository = () => {
  const items = new Map();
  return {
    items,
    async findPayment(pk) {
      return items.get(pk) ?? null;
    },
    async savePaymentIfNew(item) {
      if (items.has(item.pk)) return { created: false, existing: items.get(item.pk) };
      items.set(item.pk, item);
      return { created: true };
    },
  };
};

// `randomValues` se consumen en orden; sleep no espera de verdad.
export const createTestSimulation = ({ randomValues = [0.99], env = {} } = {}) => {
  const sleeps = [];
  let index = 0;
  const simulation = createSimulation({
    env,
    sleep: async (ms) => sleeps.push(ms),
    random: () => randomValues[index++ % randomValues.length],
  });
  return { simulation, sleeps };
};

// Por defecto envía x-api-key válida. Usar skipAuth: true para probar el 403.
export const httpEvent = ({ routeKey, headers = {}, body, pathParameters, skipAuth = false }) => ({
  routeKey,
  headers: skipAuth ? { ...headers } : { 'x-api-key': TEST_API_KEY, ...headers },
  pathParameters,
  body: body === undefined ? undefined : JSON.stringify(body),
  isBase64Encoded: false,
});

export const parseBody = (response) => JSON.parse(response.body);
