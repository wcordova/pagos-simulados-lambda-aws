// Dobles de prueba: reemplazan DynamoDB y el azar para que las pruebas sean rápidas y repetibles.
import { createSimulation } from '../src/lib/simulation.mjs';

// Credenciales de prueba (coinciden con BASIC_AUTH_* abajo).
export const TEST_AUTH_USER = 'equipo';
export const TEST_AUTH_PASS = 'secreto123';
export const BASIC_AUTH_HEADER = `Basic ${Buffer.from(`${TEST_AUTH_USER}:${TEST_AUTH_PASS}`).toString('base64')}`;

process.env.BASIC_AUTH_USERNAME ??= TEST_AUTH_USER;
process.env.BASIC_AUTH_PASSWORD ??= TEST_AUTH_PASS;

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

// Por defecto envía Basic Auth válido. Usar skipAuth: true para probar el 401.
export const httpEvent = ({ routeKey, headers = {}, body, pathParameters, skipAuth = false }) => ({
  routeKey,
  headers: skipAuth ? { ...headers } : { authorization: BASIC_AUTH_HEADER, ...headers },
  pathParameters,
  body: body === undefined ? undefined : JSON.stringify(body),
  isBase64Encoded: false,
});

export const parseBody = (response) => JSON.parse(response.body);
