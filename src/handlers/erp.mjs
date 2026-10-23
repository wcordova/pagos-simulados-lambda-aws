// Capa: backend (Lambda). ERP municipal simulado — contrato: Clase12/pagos-simulados/openapi/erp-payments-api.yaml
//
// Rutas (API Gateway HTTP API → esta Lambda):
//   POST /erp/v1/pagos                       registra el pago (idempotente por documento_origen.numero)
//   GET  /erp/v1/pagos/{numeroDocumento}     consulta un documento (reconciliación)
//   GET  /erp/v1/salud                       disponibilidad
//
// Mismo flujo que el banco; cambian los nombres (español, snake_case) y el formato de error.
import { verifyApiKey } from '../lib/auth.mjs';
import { getCorrelationId, json, log, parseJsonBody } from '../lib/http.mjs';
import { buildKey, dynamoRepository } from '../lib/repository.mjs';
import {
  accountingPeriod,
  buildJournalEntryId,
  buildReceiptId,
  toIsoSeconds,
} from '../lib/receipts.mjs';
import { createSimulation } from '../lib/simulation.mjs';
import {
  TEAM_CODES,
  createValidator,
  isDate,
  isDateTime,
  isObject,
  isOptionalString,
  isRequiredString,
} from '../lib/validation.mjs';

const DESTINATION = 'ERP';
const VERSION = '1.0.0';
const DOCUMENT_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
const AMOUNT_PATTERN = /^(0|[1-9][0-9]{0,8})\.[0-9]{2}$/;
const DOCUMENT_TYPES = ['RECIBO_CAJA', 'BOLETA_DEPOSITO', 'VOUCHER_TARJETA'];
const PAYMENT_METHODS = ['EFECTIVO', 'TARJETA', 'TRANSFERENCIA', 'CHEQUE'];
const ITEM_TYPES = ['AGUA_POTABLE', 'RECONEXION', 'MORA', 'NUEVA_CONEXION', 'OTROS'];
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

// Formato de error del ERP (schema ErpError del contrato).
const erpError = (status, code, message, correlationId, extra = {}, headers = {}) =>
  json(
    status,
    {
      estado_http: status,
      codigo_error: code,
      mensaje: message,
      reintentable: RETRYABLE_STATUS.has(status),
      id_correlacion: correlationId,
      fecha_hora: toIsoSeconds(new Date()),
      ...extra,
    },
    { 'X-Correlation-Id': correlationId, ...headers },
  );

const isAmount = (value) => typeof value === 'string' && AMOUNT_PATTERN.test(value);

export const validateErpPayment = (body) => {
  const v = createValidator();
  const doc = body.documento_origen;
  const period = body.periodo_fiscal;

  v.check(TEAM_CODES.includes(body.equipo), 'equipo', `debe ser uno de ${TEAM_CODES.join(', ')}`);
  v.check(isObject(doc), 'documento_origen', 'es obligatorio');
  v.check(DOCUMENT_TYPES.includes(doc?.tipo), 'documento_origen.tipo', `debe ser uno de ${DOCUMENT_TYPES.join(', ')}`);
  v.check(
    typeof doc?.numero === 'string' && DOCUMENT_PATTERN.test(doc.numero),
    'documento_origen.numero',
    'es obligatorio: 1 a 40 caracteres [A-Za-z0-9_-]',
  );
  v.check(isDate(doc?.fecha_emision), 'documento_origen.fecha_emision', 'debe ser fecha YYYY-MM-DD');
  v.check(isRequiredString(body.contribuyente?.codigo_cliente, 50), 'contribuyente.codigo_cliente', 'es obligatorio (1 a 50 caracteres)');
  v.check(isOptionalString(body.contribuyente?.nit, 20), 'contribuyente.nit', 'máximo 20 caracteres');
  v.check(
    Number.isInteger(period?.anio) && period.anio >= 2000 && period.anio <= 2100,
    'periodo_fiscal.anio',
    'debe estar entre 2000 y 2100',
  );
  v.check(Number.isInteger(period?.mes) && period.mes >= 1 && period.mes <= 12, 'periodo_fiscal.mes', 'debe estar entre 1 y 12');
  v.check(PAYMENT_METHODS.includes(body.forma_pago), 'forma_pago', `debe ser uno de ${PAYMENT_METHODS.join(', ')}`);
  v.check(isDateTime(body.fecha_pago), 'fecha_pago', 'debe ser fecha-hora ISO-8601 con zona horaria');
  v.check(isAmount(body.total), 'total', 'debe tener exactamente 2 decimales, por ejemplo "150.50"');

  const detail = body.detalle;
  v.check(Array.isArray(detail) && detail.length >= 1 && detail.length <= 10, 'detalle', 'debe tener entre 1 y 10 líneas');
  (Array.isArray(detail) ? detail : []).forEach((line, index) => {
    v.check(ITEM_TYPES.includes(line?.rubro), `detalle[${index}].rubro`, `debe ser uno de ${ITEM_TYPES.join(', ')}`);
    v.check(isAmount(line?.monto), `detalle[${index}].monto`, 'debe tener exactamente 2 decimales');
  });

  // El contrato del ERP usa { campo, mensaje } en lugar de { field, message }.
  return v.errors.map(({ field, message }) => ({ campo: field, mensaje: message }));
};

export const createHandler = ({
  repository = dynamoRepository,
  simulation = createSimulation(),
  now = () => new Date(),
  authenticate = verifyApiKey,
} = {}) => {
  const health = () =>
    json(200, { estado: 'ARRIBA', destino: DESTINATION, version: VERSION, fecha_hora: toIsoSeconds(now()) });

  // 403: mismo status que API Gateway cuando falta o falla la API key (contrato OpenAPI).
  const forbidden = (correlationId, reason) =>
    erpError(
      403,
      'PROHIBIDO',
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
      return erpError(400, 'VALIDACION', 'La solicitud no cumple el contrato', correlationId, {
        errores: [{ campo: 'body', mensaje: 'debe ser un objeto JSON válido' }],
      });
    }

    const body = parsed.value;
    const errores = validateErpPayment(body);
    if (errores.length > 0) {
      return erpError(400, 'VALIDACION', 'La solicitud no cumple el contrato', correlationId, { errores });
    }

    // Fallo transitorio simulado: el pago NO se guarda, así el reintento puede tener éxito.
    const simulatedStatus = simulation.pickError(scenario);
    if (simulatedStatus === 500) {
      return erpError(500, 'ERROR_INTERNO', 'Error inesperado registrando el pago', correlationId);
    }
    if (simulatedStatus === 503) {
      return erpError(
        503,
        'SERVICIO_NO_DISPONIBLE',
        'El ERP está en proceso de cierre diario, intente más tarde',
        correlationId,
        {},
        { 'Retry-After': String(simulation.config.retryAfterSeconds) },
      );
    }

    const documentNumber = body.documento_origen.numero;
    const registeredAt = now();
    const receipt = {
      numero_comprobante: buildReceiptId('ERP', registeredAt),
      numero_documento_origen: documentNumber,
      equipo: body.equipo,
      estado: 'CONTABILIZADO',
      total: body.total,
      fecha_registro: toIsoSeconds(registeredAt),
      periodo_contable: accountingPeriod(registeredAt),
      numero_partida: buildJournalEntryId(registeredAt),
    };

    // Solo datos de negocio: sin NIT del contribuyente (dato personal).
    const result = await repository.savePaymentIfNew({
      pk: buildKey(DESTINATION, documentNumber),
      destination: DESTINATION,
      transactionId: documentNumber,
      teamCode: body.equipo,
      customerCode: body.contribuyente.codigo_cliente,
      paymentMethod: body.forma_pago,
      paidAt: body.fecha_pago,
      receipt,
      correlationId,
      createdAt: registeredAt.toISOString(),
    });

    if (!result.created) {
      return erpError(
        409,
        'DOCUMENTO_DUPLICADO',
        `El documento ${documentNumber} ya fue contabilizado`,
        correlationId,
        { comprobante_original: result.existing?.receipt },
      );
    }

    return json(201, receipt, { 'X-Correlation-Id': correlationId });
  };

  const getPayment = async (event, correlationId) => {
    const scenario = simulation.resolveScenario(event.headers);
    await simulation.applyDelay(scenario);

    const documentNumber = event.pathParameters?.numeroDocumento ?? '';
    const item = DOCUMENT_PATTERN.test(documentNumber)
      ? await repository.findPayment(buildKey(DESTINATION, documentNumber))
      : null;

    if (!item) {
      return erpError(404, 'DOCUMENTO_NO_ENCONTRADO', `No existe el documento ${documentNumber}`, correlationId);
    }
    return json(200, item.receipt, { 'X-Correlation-Id': correlationId });
  };

  return async (event, context) => {
    const startedAt = Date.now();
    const correlationId = getCorrelationId(event);
    let response;
    let transactionId = event.pathParameters?.numeroDocumento;

    try {
      // /salud queda público (comprobar disponibilidad sin credenciales).
      const needsAuth = event.routeKey !== 'GET /erp/v1/salud';
      if (needsAuth) {
        const auth = authenticate(event);
        if (!auth.ok) {
          response = forbidden(correlationId, auth.reason);
        }
      }

      if (!response) {
        switch (event.routeKey) {
          case 'POST /erp/v1/pagos':
            transactionId = parseJsonBody(event).value?.documento_origen?.numero;
            response = await createPayment(event, correlationId);
            break;
          case 'GET /erp/v1/pagos/{numeroDocumento}':
            response = await getPayment(event, correlationId);
            break;
          case 'GET /erp/v1/salud':
            response = health();
            break;
          default:
            response = erpError(404, 'RUTA_NO_ENCONTRADA', 'Ruta no encontrada', correlationId);
        }
      }
    } catch (error) {
      log('error', { destination: DESTINATION, correlationId, error: error.message, stack: error.stack });
      response = erpError(500, 'ERROR_INTERNO', 'Error inesperado registrando el pago', correlationId);
    }

    log('info', {
      destination: DESTINATION,
      routeKey: event.routeKey,
      transactionId,
      statusCode: response.statusCode,
      durationMs: Date.now() - startedAt,
      correlationId,
      requestId: context?.awsRequestId,
    });
    return response;
  };
};

export const handler = createHandler();
