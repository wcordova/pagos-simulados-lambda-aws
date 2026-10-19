// Capa: backend (Lambda). Validación mínima del body.
//
// Aunque el cliente (Feign generado desde el contrato) ya valide, el backend SIEMPRE
// valida: cualquiera puede llamar la API con curl o Postman y saltarse el frontend/cliente.

export const TEAM_CODES = ['EQUIPO_A', 'EQUIPO_B', 'EQUIPO_C', 'EQUIPO_D'];

// Acumula errores de campo en lugar de cortar en el primero: el cliente ve todo lo que falla.
export const createValidator = () => {
  const errors = [];
  return {
    check(isValid, field, message) {
      if (!isValid) errors.push({ field, message });
    },
    errors,
  };
};

export const isRequiredString = (value, maxLength) =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;

export const isOptionalString = (value, maxLength) =>
  value === undefined || (typeof value === 'string' && value.length <= maxLength);

export const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// ISO-8601 con zona horaria obligatoria: 2026-10-01T16:15:00Z o 2026-10-01T10:15:00-06:00
const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
export const isDateTime = (value) =>
  typeof value === 'string' && DATE_TIME_PATTERN.test(value) && !Number.isNaN(Date.parse(value));

export const isDate = (value) =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
