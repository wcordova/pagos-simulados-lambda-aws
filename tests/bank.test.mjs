import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createHandler } from '../src/handlers/bank.mjs';
import { createSimulation } from '../src/lib/simulation.mjs';
import { createMemoryRepository, createTestSimulation, httpEvent, parseBody } from './helpers.mjs';

const validBody = JSON.parse(
  await readFile(new URL('../requests/bank-payment.json', import.meta.url), 'utf8'),
);

const postPayment = (body = validBody, key = 'EQA-000123') =>
  httpEvent({
    routeKey: 'POST /bank/v1/payments',
    headers: { 'idempotency-key': key },
    body,
  });

describe('Banco simulado', () => {
  it('registra un pago nuevo → 201 con comprobante', async () => {
    const repository = createMemoryRepository();
    const handler = createHandler({ repository, simulation: createTestSimulation().simulation });

    const response = await handler(postPayment());

    assert.equal(response.statusCode, 201);
    const receipt = parseBody(response);
    assert.match(receipt.receiptId, /^BNK-\d{8}-[A-Z0-9]{6}$/);
    assert.equal(receipt.idempotencyKey, 'EQA-000123');
    assert.equal(repository.items.size, 1);
  });

  it('reenvío del mismo pago → 409 DUPLICATE_PAYMENT con el comprobante original', async () => {
    const handler = createHandler({
      repository: createMemoryRepository(),
      simulation: createTestSimulation().simulation,
    });

    const first = parseBody(await handler(postPayment()));
    const second = await handler(postPayment());

    assert.equal(second.statusCode, 409);
    assert.equal(parseBody(second).code, 'DUPLICATE_PAYMENT');
    assert.deepEqual(parseBody(second).originalReceipt, first);
  });

  it('error simulado → 503 con Retry-After y NO guarda el pago', async () => {
    const repository = createMemoryRepository();
    // 0.1 < 0.2 → falla; 0.9 ≥ 0.5 → 503
    const { simulation } = createTestSimulation({ randomValues: [0.1, 0.9] });
    const handler = createHandler({ repository, simulation });

    const response = await handler(postPayment());

    assert.equal(response.statusCode, 503);
    assert.equal(response.headers['Retry-After'], '2');
    assert.equal(parseBody(response).retryable, true);
    assert.equal(repository.items.size, 0);
  });

  it('aplica un retardo entre 0 y 3000 ms', async () => {
    const { simulation, sleeps } = createTestSimulation();
    const handler = createHandler({ repository: createMemoryRepository(), simulation });

    await handler(postPayment());

    assert.equal(sleeps.length, 1);
    assert.ok(sleeps[0] >= 0 && sleeps[0] <= 3000);
  });

  it('body inválido → 400 VALIDATION_ERROR con el detalle de cada campo', async () => {
    const handler = createHandler({
      repository: createMemoryRepository(),
      simulation: createTestSimulation().simulation,
    });
    const body = { ...validBody, amount: { valueInCents: 150.75, currency: 'USD' } };

    const response = await handler(postPayment(body, 'corta'));

    assert.equal(response.statusCode, 400);
    const fields = parseBody(response).details.map((d) => d.field);
    assert.deepEqual(fields, ['Idempotency-Key', 'amount.valueInCents', 'amount.currency']);
  });

  it('GET de un pago inexistente → 404 PAYMENT_NOT_FOUND', async () => {
    const handler = createHandler({
      repository: createMemoryRepository(),
      simulation: createTestSimulation().simulation,
    });

    const response = await handler(
      httpEvent({
        routeKey: 'GET /bank/v1/payments/{idempotencyKey}',
        pathParameters: { idempotencyKey: 'EQA-999999' },
      }),
    );

    assert.equal(response.statusCode, 404);
    assert.equal(parseBody(response).code, 'PAYMENT_NOT_FOUND');
  });

  it('con ERROR_RATE 0.2, aproximadamente 1 de cada 5 peticiones falla', async (t) => {
    t.mock.method(console, 'log', () => {}); // 2000 líneas de log no aportan nada aquí
    const simulation = createSimulation({ env: {}, sleep: async () => {} });
    const handler = createHandler({ repository: createMemoryRepository(), simulation });

    const total = 2000;
    let failures = 0;
    for (let i = 0; i < total; i++) {
      const response = await handler(postPayment(validBody, `EQA-T${String(i).padStart(6, '0')}`));
      if (response.statusCode >= 500) failures++;
    }

    const rate = failures / total;
    assert.ok(rate > 0.15 && rate < 0.25, `tasa de error ${rate}`);
  });
});
