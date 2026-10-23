// Capa: backend (Lambda). Banco simulado — contrato: Clase12/pagos-simulados/openapi/bank-payments-api.yaml
//
// Rutas (API Gateway HTTP API → esta Lambda):
//   POST /bank/v1/payments                     registra el pago (idempotente por header Idempotency-Key)
//   GET  /bank/v1/payments/{idempotencyKey}    consulta un pago (reconciliación)
//   GET  /bank/v1/health                       disponibilidad
//
// Flujo del POST:
//   retardo 0–3 s → validar (400) → ¿error simulado? (500/503, NO guarda)
//   → PutItem condicional → 201 (nuevo) | 409 DUPLICATE_PAYMENT (ya existía)
import { verifyApiKey } from '../lib/auth.mjs';
import { getCorrelationId, getHeader, json, log, parseJsonBody } from '../lib/http.mjs';
import { buildKey, dynamoRepository } from '../lib/repository.mjs';
import { buildReceiptId, nextBusinessDay, toIsoSeconds } from '../lib/receipts.mjs';
import { createSimulation } from '../lib/simulation.mjs';
import {
  TEAM_CODES,
  createValidator,
  isDateTime,
  isObject,
  isOptionalString,
  isRequiredString,
} from '../lib/validation.mjs';

const DESTINATION = 'BANK';
const VERSION = '1.0.0';
const KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const CHANNELS = ['CASH', 'CARD', 'BANK_TRANSFER', 'CHECK'];
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

// Formato de error del banco (schema BankError del contrato).
const bankError = (status, code, message, correlationId, extra = {}, headers = {}) =>
  json(
    status,
    {
      status,
      code,
      message,
      retryable: RETRYABLE_STATUS.has(status),
      correlationId,
      timestamp: toIsoSeconds(new Date()),
      ...extra,
    },
    { 'X-Correlation-Id': correlationId, ...headers },
  );

export const validateBankPayment = (idempotencyKey, body) => {
  const v = createValidator();

  v.check(
    typeof idempotencyKey === 'string' && KEY_PATTERN.test(idempotencyKey),
    'Idempotency-Key',
    'es obligatorio: 8 a 64 caracteres [A-Za-z0-9_-]',
  );
  v.check(TEAM_CODES.includes(body.teamCode), 'teamCode', `debe ser uno de ${TEAM_CODES.join(', ')}`);
  v.check(isObject(body.payer), 'payer', 'es obligatorio');
  v.check(isRequiredString(body.payer?.customerCode, 50), 'payer.customerCode', 'es obligatorio (1 a 50 caracteres)');
  v.check(isOptionalString(body.payer?.fullName, 150), 'payer.fullName', 'máximo 150 caracteres');
  v.check(isOptionalString(body.payer?.taxId, 20), 'payer.taxId', 'máximo 20 caracteres');
  v.check(isObject(body.amount), 'amount', 'es obligatorio');
  v.check(
    Number.isInteger(body.amount?.valueInCents) &&
      body.amount.valueInCents >= 1 &&
      body.amount.valueInCents <= 99_999_999,
    'amount.valueInCents',
    'debe ser un entero entre 1 y 99999999 (centavos)',
  );
  v.check(body.amount?.currency === 'GTQ', 'amount.currency', 'debe ser GTQ');
  v.check(isDateTime(body.transactionDate), 'transactionDate', 'debe ser fecha-hora ISO-8601 con zona horaria');
  v.check(CHANNELS.includes(body.channel), 'channel', `debe ser uno de ${CHANNELS.join(', ')}`);
  v.check(isOptionalString(body.description, 140), 'description', 'máximo 140 caracteres');

  return v.errors;
};

// Las dependencias se inyectan para poder probar el handler sin AWS (ver tests/).
export const createHandler = ({
  repository = dynamoRepository,
  simulation = createSimulation(),
  now = () => new Date(),
  authenticate = verifyApiKey,
} = {}) => {
  const health = () =>
    json(200, { status: 'UP', destination: DESTINATION, version: VERSION, timestamp: toIsoSeconds(now()) });

  // 403: mismo status que API Gateway cuando falta o falla la API key (contrato OpenAPI).
  const forbidden = (correlationId, reason) =>
    bankError(
      403,
      'FORBIDDEN',
      reason === 'misconfigured'
        ? 'Autenticación no configurada en el simulador'
        : 'API key ausente o inválida (header x-api-key)',
      correlationId,
    );

  const createPayment = async (event, correlationId) => {
    const scenario = simulation.resolveScenario(event.headers);
    await simulation.applyDelay(scenario);

    const parsed = parseJsonBody(event);
    if (!parsed.ok) {
      return bankError(400, 'VALIDATION_ERROR', 'El request no cumple el contrato', correlationId, {
        details: [{ field: 'body', message: 'debe ser un objeto JSON válido' }],
      });
    }

    const body = parsed.value;
    const idempotencyKey = getHeader(event, 'idempotency-key');
    const details = validateBankPayment(idempotencyKey, body);
    if (details.length > 0) {
      return bankError(400, 'VALIDATION_ERROR', 'El request no cumple el contrato', correlationId, { details });
    }

    // Fallo transitorio simulado: el pago NO se guarda, así el reintento puede tener éxito.
    const simulatedStatus = simulation.pickError(scenario);
    if (simulatedStatus === 500) {
      return bankError(500, 'INTERNAL_ERROR', 'Error inesperado procesando el pago', correlationId);
    }
    if (simulatedStatus === 503) {
      return bankError(
        503,
        'SERVICE_UNAVAILABLE',
        'El banco no está disponible en este momento',
        correlationId,
        {},
        { 'Retry-After': String(simulation.config.retryAfterSeconds) },
      );
    }

    const receivedAt = now();
    const receipt = {
      receiptId: buildReceiptId('BNK', receivedAt),
      idempotencyKey,
      teamCode: body.teamCode,
      status: 'ACCEPTED',
      amount: { valueInCents: body.amount.valueInCents, currency: body.amount.currency },
      receivedAt: toIsoSeconds(receivedAt),
      valueDate: nextBusinessDay(receivedAt),
    };

    // Solo se guardan datos de negocio: sin nombre ni NIT del cliente (datos personales).
    const result = await repository.savePaymentIfNew({
      pk: buildKey(DESTINATION, idempotencyKey),
      destination: DESTINATION,
      transactionId: idempotencyKey,
      teamCode: body.teamCode,
      customerCode: body.payer.customerCode,
      channel: body.channel,
      transactionDate: body.transactionDate,
      receipt,
      correlationId,
      createdAt: receivedAt.toISOString(),
    });

    if (!result.created) {
      return bankError(
        409,
        'DUPLICATE_PAYMENT',
        `El pago con Idempotency-Key ${idempotencyKey} ya fue registrado`,
        correlationId,
        { originalReceipt: result.existing?.receipt },
      );
    }

    return json(201, receipt, { 'X-Correlation-Id': correlationId });
  };

  const getPayment = async (event, correlationId) => {
    const scenario = simulation.resolveScenario(event.headers);
    await simulation.applyDelay(scenario);

    const idempotencyKey = event.pathParameters?.idempotencyKey ?? '';
    const item = KEY_PATTERN.test(idempotencyKey)
      ? await repository.findPayment(buildKey(DESTINATION, idempotencyKey))
      : null;

    if (!item) {
      return bankError(404, 'PAYMENT_NOT_FOUND', 'No existe un pago con esa Idempotency-Key', correlationId);
    }
    return json(200, item.receipt, { 'X-Correlation-Id': correlationId });
  };

  return async (event, context) => {
    const startedAt = Date.now();
    const correlationId = getCorrelationId(event);
    let response;

    try {
      // /health queda público (comprobar disponibilidad sin credenciales).
      const needsAuth = event.routeKey !== 'GET /bank/v1/health';
      if (needsAuth) {
        const auth = authenticate(event);
        if (!auth.ok) {
          response = forbidden(correlationId, auth.reason);
        }
      }

      if (!response) {
        switch (event.routeKey) {
          case 'POST /bank/v1/payments':
            response = await createPayment(event, correlationId);
            break;
          case 'GET /bank/v1/payments/{idempotencyKey}':
            response = await getPayment(event, correlationId);
            break;
          case 'GET /bank/v1/health':
            response = health();
            break;
          default:
            response = bankError(404, 'NOT_FOUND', 'Ruta no encontrada', correlationId);
        }
      }
    } catch (error) {
      // El detalle técnico va a CloudWatch; al cliente solo un mensaje genérico.
      log('error', { destination: DESTINATION, correlationId, error: error.message, stack: error.stack });
      response = bankError(500, 'INTERNAL_ERROR', 'Error inesperado procesando el pago', correlationId);
    }

    log('info', {
      destination: DESTINATION,
      routeKey: event.routeKey,
      transactionId: getHeader(event, 'idempotency-key') ?? event.pathParameters?.idempotencyKey,
      statusCode: response.statusCode,
      durationMs: Date.now() - startedAt,
      correlationId,
      requestId: context?.awsRequestId,
    });
    return response;
  };
};

export const handler = createHandler();
