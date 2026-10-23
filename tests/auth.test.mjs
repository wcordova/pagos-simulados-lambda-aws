import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createHandler as createBankHandler } from '../src/handlers/bank.mjs';
import { createHandler as createErpHandler } from '../src/handlers/erp.mjs';
import { verifyApiKey } from '../src/lib/auth.mjs';
import {
  createMemoryRepository,
  createTestSimulation,
  httpEvent,
  parseBody,
  TEST_API_KEY,
} from './helpers.mjs';

const paymentBody = {
  teamCode: 'EQUIPO_A',
  payer: { customerCode: 'CLI-0001' },
  amount: { valueInCents: 100, currency: 'GTQ' },
  transactionDate: '2026-10-01T16:15:00Z',
  channel: 'CASH',
};

describe('API key (x-api-key)', () => {
  it('acepta x-api-key válida', () => {
    const result = verifyApiKey(
      { headers: { 'x-api-key': TEST_API_KEY } },
      { API_KEY: TEST_API_KEY },
    );
    assert.deepEqual(result, { ok: true });
  });

  it('rechaza si falta el header', () => {
    const result = verifyApiKey({ headers: {} }, { API_KEY: TEST_API_KEY });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'missing');
  });

  it('rechaza llave incorrecta', () => {
    const result = verifyApiKey(
      { headers: { 'x-api-key': 'otra-clave' } },
      { API_KEY: TEST_API_KEY },
    );
    assert.equal(result.reason, 'invalid');
  });

  it('banco sin credenciales → 403 FORBIDDEN', async () => {
    const handler = createBankHandler({
      repository: createMemoryRepository(),
      simulation: createTestSimulation().simulation,
    });
    const response = await handler(
      httpEvent({
        routeKey: 'POST /bank/v1/payments',
        headers: { 'idempotency-key': 'EQA-AUTH-001' },
        body: paymentBody,
        skipAuth: true,
      }),
    );

    assert.equal(response.statusCode, 403);
    assert.equal(parseBody(response).code, 'FORBIDDEN');
  });

  it('banco con llave mala → 403', async () => {
    const handler = createBankHandler({
      repository: createMemoryRepository(),
      simulation: createTestSimulation().simulation,
    });
    const response = await handler(
      httpEvent({
        routeKey: 'POST /bank/v1/payments',
        headers: {
          'x-api-key': 'clave-incorrecta',
          'idempotency-key': 'EQA-AUTH-002',
        },
        body: paymentBody,
        skipAuth: true,
      }),
    );

    assert.equal(response.statusCode, 403);
  });

  it('/health no exige autenticación', async () => {
    const handler = createBankHandler({
      repository: createMemoryRepository(),
      simulation: createTestSimulation().simulation,
    });
    const response = await handler(
      httpEvent({ routeKey: 'GET /bank/v1/health', skipAuth: true }),
    );
    assert.equal(response.statusCode, 200);
  });

  it('ERP sin credenciales → 403 PROHIBIDO', async () => {
    const handler = createErpHandler({
      repository: createMemoryRepository(),
      simulation: createTestSimulation().simulation,
    });
    const response = await handler(
      httpEvent({ routeKey: 'POST /erp/v1/pagos', skipAuth: true, body: { equipo: 'EQUIPO_A' } }),
    );

    assert.equal(response.statusCode, 403);
    assert.equal(parseBody(response).codigo_error, 'PROHIBIDO');
  });

  it('/salud no exige autenticación', async () => {
    const handler = createErpHandler({
      repository: createMemoryRepository(),
      simulation: createTestSimulation().simulation,
    });
    const response = await handler(httpEvent({ routeKey: 'GET /erp/v1/salud', skipAuth: true }));
    assert.equal(response.statusCode, 200);
  });
});
