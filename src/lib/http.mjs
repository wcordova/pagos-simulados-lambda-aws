// Capa: backend (Lambda). Utilidades HTTP para API Gateway HTTP API (payload v2.0).
//
// En una HTTP API, API Gateway convierte la petición en un objeto `event` y espera
// que la Lambda devuelva { statusCode, headers, body } con el body como TEXTO.
import { randomUUID } from 'node:crypto';

export const json = (statusCode, body, headers = {}) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  body: JSON.stringify(body),
});

// API Gateway puede entregar el body en base64 (isBase64Encoded = true).
// Devuelve { ok: true, value } solo si el body es un objeto JSON.
export const parseJsonBody = (event) => {
  if (!event.body) return { ok: false };

  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;

  try {
    const value = JSON.parse(raw);
    const isObject = value !== null && typeof value === 'object' && !Array.isArray(value);
    return isObject ? { ok: true, value } : { ok: false };
  } catch {
    return { ok: false };
  }
};

// En HTTP API (payload v2.0) los nombres de los headers llegan en minúsculas.
export const getHeader = (event, name) => event.headers?.[name.toLowerCase()];

export const getCorrelationId = (event) =>
  getHeader(event, 'x-correlation-id')?.slice(0, 64) || randomUUID();

// Logs estructurados (JSON) → CloudWatch Logs. Nunca incluir nombre, NIT ni el body completo.
export const log = (level, data) => console.log(JSON.stringify({ level, ...data }));
