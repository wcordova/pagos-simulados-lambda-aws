// Capa: backend (Lambda). Generación de comprobantes (formato definido en los contratos OpenAPI).
// Las fechas "de negocio" se calculan en hora de Guatemala (UTC−6, sin horario de verano).
import { randomInt } from 'node:crypto';

const GUATEMALA_OFFSET_MS = -6 * 60 * 60 * 1000;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

const pad = (value, length = 2) => String(value).padStart(length, '0');

// Desplaza la fecha a UTC−6; luego se leen sus partes con getUTC*().
const toGuatemala = (date) => new Date(date.getTime() + GUATEMALA_OFFSET_MS);

const compactDate = (date) => {
  const gt = toGuatemala(date);
  return `${gt.getUTCFullYear()}${pad(gt.getUTCMonth() + 1)}${pad(gt.getUTCDate())}`;
};

// crypto.randomInt en lugar de Math.random: distribución uniforme y no predecible.
const randomCode = (length) =>
  Array.from({ length }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');

// BNK-20261007-8F3K2Q / ERP-20261007-Q7W2ZX
export const buildReceiptId = (prefix, date) => `${prefix}-${compactDate(date)}-${randomCode(6)}`;

// "2026-10-07T23:14:58Z" (sin milisegundos, como en los ejemplos del contrato)
export const toIsoSeconds = (date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

// Banco: fecha valor = siguiente día hábil (lunes a viernes).
export const nextBusinessDay = (date) => {
  const gt = toGuatemala(date);
  const day = new Date(Date.UTC(gt.getUTCFullYear(), gt.getUTCMonth(), gt.getUTCDate()));
  do {
    day.setUTCDate(day.getUTCDate() + 1);
  } while (day.getUTCDay() === 0 || day.getUTCDay() === 6);
  return day.toISOString().slice(0, 10);
};

// ERP: periodo contable = mes en que se registró el pago.
export const accountingPeriod = (date) => {
  const gt = toGuatemala(date);
  return { anio: gt.getUTCFullYear(), mes: gt.getUTCMonth() + 1 };
};

// ERP: número de partida contable, por ejemplo PDA-2026-000873.
export const buildJournalEntryId = (date) =>
  `PDA-${toGuatemala(date).getUTCFullYear()}-${pad(randomInt(1_000_000), 6)}`;
