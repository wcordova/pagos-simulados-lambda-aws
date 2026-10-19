import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createHandler } from '../src/handlers/erp.mjs';
import { createMemoryRepository, createTestSimulation, httpEvent, parseBody } from './helpers.mjs';

const validBody = JSON.parse(
  await readFile(new URL('../requests/erp-pago.json', import.meta.url), 'utf8'),
);

const postPago = (body = validBody, headers = {}) =>
  httpEvent({ routeKey: 'POST /erp/v1/pagos', headers, body });

describe('ERP simulado', () => {
  it('registra un pago nuevo → 201 con comprobante', async () => {
    const handler = createHandler({
      repository: createMemoryRepository(),
      simulation: createTestSimulation().simulation,
    });

    const response = await handler(postPago());

    assert.equal(response.statusCode, 201);
    const comprobante = parseBody(response);
    assert.match(comprobante.numero_comprobante, /^ERP-\d{8}-[A-Z0-9]{6}$/);
    assert.match(comprobante.numero_partida, /^PDA-\d{4}-\d{6}$/);
    assert.equal(comprobante.estado, 'CONTABILIZADO');
  });

  it('reenvío del mismo documento → 409 DOCUMENTO_DUPLICADO', async () => {
    const handler = createHandler({
      repository: createMemoryRepository(),
      simulation: createTestSimulation().simulation,
    });

    const first = parseBody(await handler(postPago()));
    const second = await handler(postPago());

    assert.equal(second.statusCode, 409);
    assert.equal(parseBody(second).codigo_error, 'DOCUMENTO_DUPLICADO');
    assert.deepEqual(parseBody(second).comprobante_original, first);
  });

  it('el mismo número en banco y ERP no choca (llaves distintas)', async () => {
    const repository = createMemoryRepository();
    const handler = createHandler({ repository, simulation: createTestSimulation().simulation });
    repository.items.set('BANK#EQA-000123', { pk: 'BANK#EQA-000123' });

    const response = await handler(postPago());

    assert.equal(response.statusCode, 201);
  });

  it('header X-Simulation-Scenario: ERROR_500 fuerza el error (sin guardar)', async () => {
    const repository = createMemoryRepository();
    const handler = createHandler({ repository, simulation: createTestSimulation().simulation });

    const response = await handler(postPago(validBody, { 'x-simulation-scenario': 'ERROR_500' }));

    assert.equal(response.statusCode, 500);
    assert.equal(parseBody(response).codigo_error, 'ERROR_INTERNO');
    assert.equal(repository.items.size, 0);
  });

  it('con ALLOW_SCENARIO_HEADER=false el header se ignora', async () => {
    const { simulation } = createTestSimulation({ env: { ALLOW_SCENARIO_HEADER: 'false' } });
    const handler = createHandler({ repository: createMemoryRepository(), simulation });

    const response = await handler(postPago(validBody, { 'x-simulation-scenario': 'ERROR_500' }));

    assert.equal(response.statusCode, 201);
  });

  it('monto sin 2 decimales → 400 VALIDACION', async () => {
    const handler = createHandler({
      repository: createMemoryRepository(),
      simulation: createTestSimulation().simulation,
    });

    const response = await handler(postPago({ ...validBody, total: '150.5' }));

    assert.equal(response.statusCode, 400);
    assert.deepEqual(parseBody(response).errores.map((e) => e.campo), ['total']);
  });

  it('salud responde sin tocar la BD', async () => {
    const handler = createHandler({
      repository: createMemoryRepository(),
      simulation: createTestSimulation().simulation,
    });

    const response = await handler(httpEvent({ routeKey: 'GET /erp/v1/salud' }));

    assert.equal(response.statusCode, 200);
    assert.equal(parseBody(response).estado, 'ARRIBA');
  });
});
