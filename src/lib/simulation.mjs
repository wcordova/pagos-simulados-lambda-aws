// Capa: backend (Lambda). Simulación de un sistema externo "inestable":
//   1. Retardo aleatorio entre DELAY_MIN_MS y DELAY_MAX_MS (por defecto 0–3 s).
//   2. Error transitorio (500 o 503) con probabilidad ERROR_RATE (por defecto 0.2 = 1 de cada 5).
//
// ¿Por qué probabilidad y no un contador "cada 5 registros"?
// Una Lambda es SIN ESTADO: puede haber varios entornos en paralelo y cada uno tendría su
// propio contador en memoria. Con probabilidad 0.2, en promedio 1 de cada 5 peticiones
// falla, sin necesidad de compartir estado entre ejecuciones.
import { randomInt } from 'node:crypto';

// Escenarios que se pueden forzar con el header X-Simulation-Scenario (solo para pruebas).
const FORCEABLE_SCENARIOS = ['SUCCESS', 'ERROR_500', 'ERROR_503'];

const numberFromEnv = (env, name, defaultValue) => {
  const value = Number(env[name]);
  return env[name] !== undefined && Number.isFinite(value) ? value : defaultValue;
};

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// `sleep` y `random` se pueden reemplazar en las pruebas para no esperar ni depender del azar.
export const createSimulation = ({
  env = process.env,
  sleep = defaultSleep,
  random = Math.random,
} = {}) => {
  const config = {
    delayMinMs: numberFromEnv(env, 'DELAY_MIN_MS', 0),
    delayMaxMs: numberFromEnv(env, 'DELAY_MAX_MS', 3000),
    errorRate: numberFromEnv(env, 'ERROR_RATE', 0.2),
    retryAfterSeconds: numberFromEnv(env, 'RETRY_AFTER_SECONDS', 2),
    allowScenarioHeader: env.ALLOW_SCENARIO_HEADER !== 'false',
  };

  return {
    config,

    // AUTO = comportamiento aleatorio. Si el docente desactiva el header, siempre es AUTO.
    resolveScenario(headers = {}) {
      const requested = headers['x-simulation-scenario']?.toUpperCase();
      return config.allowScenarioHeader && FORCEABLE_SCENARIOS.includes(requested)
        ? requested
        : 'AUTO';
    },

    // Devuelve los milisegundos esperados (útil para los logs).
    async applyDelay(scenario) {
      if (scenario === 'SUCCESS') return 0;
      const ms = randomInt(config.delayMinMs, config.delayMaxMs + 1);
      await sleep(ms);
      return ms;
    },

    // null = continuar normal; 500 o 503 = responder error SIN guardar el pago.
    pickError(scenario) {
      if (scenario === 'SUCCESS') return null;
      if (scenario === 'ERROR_500') return 500;
      if (scenario === 'ERROR_503') return 503;
      if (random() >= config.errorRate) return null;
      return random() < 0.5 ? 500 : 503;
    },
  };
};
