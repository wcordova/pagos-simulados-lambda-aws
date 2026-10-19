// Capa: backend (Lambda). Autenticación HTTP Basic Auth (opción A: validar en la función).
//
// Header esperado: Authorization: Basic base64(usuario:clave)
// Ejemplo: equipo:secreto → Authorization: Basic ZXF1aXBvOnNlY3JldG8=
//
// HTTPS lo aporta API Gateway: Basic Auth sin HTTPS enviaría la clave en texto claro
// (base64 no cifra, solo codifica).
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
export const verifyBasicAuth = (event, env = process.env) => {
  const expectedUser = env.BASIC_AUTH_USERNAME ?? '';
  const expectedPass = env.BASIC_AUTH_PASSWORD ?? '';

  // Sin credenciales configuradas en la Lambda, rechazar todo (fail-closed).
  if (!expectedUser || !expectedPass) {
    return { ok: false, reason: 'misconfigured' };
  }

  const header = getHeader(event, 'authorization');
  if (!header) return { ok: false, reason: 'missing' };

  const match = /^Basic\s+(\S+)$/i.exec(header.trim());
  if (!match) return { ok: false, reason: 'invalid' };

  let decoded;
  try {
    decoded = Buffer.from(match[1], 'base64').toString('utf8');
  } catch {
    return { ok: false, reason: 'invalid' };
  }

  // "usuario:clave" — la clave puede contener ':' (solo el primer ':' separa).
  const separator = decoded.indexOf(':');
  if (separator < 0) return { ok: false, reason: 'invalid' };

  const user = decoded.slice(0, separator);
  const pass = decoded.slice(separator + 1);

  if (!safeEqual(user, expectedUser) || !safeEqual(pass, expectedPass)) {
    return { ok: false, reason: 'invalid' };
  }

  return { ok: true };
};

export const basicAuthChallengeHeaders = () => ({
  'WWW-Authenticate': 'Basic realm="pagos-simulados"',
});
