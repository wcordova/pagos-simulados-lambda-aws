// Capa: backend (Lambda). Autenticación por API key (contrato OpenAPI: header x-api-key).
//
// Header esperado: x-api-key: <llave>
// En la especificación completa (Clase 12) API Gateway REST valida la key y hay una por equipo.
// Aquí (simplificación): la Lambda compara contra API_KEY en el entorno (misma clave para todos).
//
// HTTPS lo aporta API Gateway: sin TLS la llave viajaría en claro.
import { timingSafeEqual } from 'node:crypto';
import { getHeader } from './http.mjs';

// Comparación a tiempo constante: evita filtrar longitud/contenido midiendo cuánto tarda.
const safeEqual = (left, right) => {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

/**
 * @returns {{ ok: true } | { ok: false, reason: 'missing' | 'invalid' | 'misconfigured' }}
 */
export const verifyApiKey = (event, env = process.env) => {
  const expectedKey = env.API_KEY ?? '';

  // Sin llave configurada en la Lambda, rechazar todo (fail-closed).
  if (!expectedKey) {
    return { ok: false, reason: 'misconfigured' };
  }

  const provided = getHeader(event, 'x-api-key');
  if (!provided) return { ok: false, reason: 'missing' };

  if (!safeEqual(provided, expectedKey)) {
    return { ok: false, reason: 'invalid' };
  }

  return { ok: true };
};
