import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createHandler as createBankHandler } from '../src/handlers/bank.mjs';
import { createHandler as createErpHandler } from '../src/handlers/erp.mjs';
import { verifyBasicAuth } from '../src/lib/auth.mjs';
import {
  BASIC_AUTH_HEADER,
  createMemoryRepository,
  createTestSimulation,
  httpEvent,
  parseBody,
  TEST_AUTH_PASS,
  TEST_AUTH_USER,
} from './helpers.mjs';

const paymentBody = {
  teamCode: 'EQUIPO_A',
  payer: { customerCode: 'CLI-0001' },
  amount: { valueInCents: 100, currency: 'GTQ' },
  transactionDate: '2026-10-01T16:15:00Z',
  channel: 'CASH',
};

describe('Basic Auth', () => {
  it('acepta Authorization Basic válido', () => {
    const result = verifyBasicAuth(
      { headers: { authorization: BASIC_AUTH_HEADER } },
      { BASIC_AUTH_USERNAME: TEST_AUTH_USER, BASIC_AUTH_PASSWORD: TEST_AUTH_PASS },
    );
    assert.deepEqual(result, { ok: true });
  });

  it('rechaza si falta el header', () => {
    const result = verifyBasicAuth(
      { headers: {} },
      { BASIC_AUTH_USERNAME: TEST_AUTH_USER, BASIC_AUTH_PASSWORD: TEST_AUTH_PASS },
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'missing');
  });

  it('rechaza usuario o clave incorrectos', () => {
    const bad = `Basic ${Buffer.from('equipo:otra').toString('base64')}`;
    const result = verifyBasicAuth(
      { headers: { authorization: bad } },
      { BASIC_AUTH_USERNAME: TEST_AUTH_USER, BASIC_AUTH_PASSWORD: TEST_AUTH_PASS },
    );
    assert.equal(result.reason, 'invalid');
  });

  it('banco sin credenciales → 401 UNAUTHORIZED', async () => {
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

    assert.equal(response.statusCode, 401);
    assert.equal(parseBody(response).code, 'UNAUTHORIZED');
    assert.equal(response.headers['WWW-Authenticate'], 'Basic realm="pagos-simulados"');
  });

  it('banco con clave mala → 401', async () => {
    const handler = createBankHandler({
      repository: createMemoryRepository(),
      simulation: createTestSimulation().simulation,
    });
    const response = await handler(
      httpEvent({
        routeKey: 'POST /bank/v1/payments',
        headers: {
          authorization: `Basic ${Buffer.from('equipo:mala').toString('base64')}`,
          'idempotency-key': 'EQA-AUTH-002',
        },
        body: paymentBody,
      }),
    );

    assert.equal(response.statusCode, 401);
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

  it('ERP sin credenciales → 401 NO_AUTORIZADO', async () => {
    const handler = createErpHandler({
      repository: createMemoryRepository(),
      simulation: createTestSimulation().simulation,
    });
    const response = await handler(
      httpEvent({ routeKey: 'POST /erp/v1/pagos', skipAuth: true, body: { equipo: 'EQUIPO_A' } }),
    );

    assert.equal(response.statusCode, 401);
    assert.equal(parseBody(response).codigo_error, 'NO_AUTORIZADO');
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
