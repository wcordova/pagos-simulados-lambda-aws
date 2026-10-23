# Simuladores de pagos — AWS Lambda (Clase 13)

Implementación en **Node.js 22 + AWS Lambda + API Gateway (HTTP API) + DynamoDB** de los dos
sistemas externos de la Feature 3 (pagos por colas):

- **Banco simulado** → contrato `Clase12/pagos-simulados/openapi/bank-payments-api.yaml`
- **ERP municipal simulado** → contrato `Clase12/pagos-simulados/openapi/erp-payments-api.yaml`

Es una versión **simplificada** de `Clase12/pagos-simulados/Especificacion-Simuladores-Pagos.md`:
solo guarda el pago, detecta duplicados y falla a propósito para que los equipos practiquen
reintentos.

## Arquitectura

```
Consumidor del equipo ──HTTPS──► API Gateway HTTP API (stage prod)
 (Spring Boot + Feign)            ├─ /bank/v1/* ──► Lambda <stack>-bank-sim ──┐
                                  └─ /erp/v1/*  ──► Lambda <stack>-erp-sim  ──┴─► DynamoDB <stack>-pagos
                                                         │
                                                         └─► CloudWatch Logs (14 días)
```

## Comportamiento

Orden en cada `POST` (y en los `GET` de pagos):

1. **API key (`x-api-key`)** → sin header o llave incorrecta: `403` (no se reintenta; corregir configuración).
2. **Retardo aleatorio de 0 a 3 s** (`DELAY_MIN_MS` / `DELAY_MAX_MS`).
3. **Validación** del body → `400` si no cumple el contrato (no se reintenta).
4. **Error transitorio aleatorio** con probabilidad `ERROR_RATE = 0.2` (en promedio 1 de cada 5):
   responde `500` o `503` (con `Retry-After: 2`) y **no guarda** el pago → el reintento puede tener éxito.
5. **PutItem condicional** en DynamoDB:
   - no existía → `201` con el comprobante.
   - ya existía → `409` (`DUPLICATE_PAYMENT` / `DOCUMENTO_DUPLICADO`) con el comprobante original.
     Para el consumidor significa **"ya estaba entregado"**.

| Respuesta | ¿Quedó guardado? | Qué debe hacer el consumidor |
|---|---|---|
| `201` | Sí | Confirmar el mensaje y guardar el comprobante |
| `409` duplicado | Sí (antes) | Confirmar el mensaje: ya estaba entregado |
| `403` | No | Dead-letter + revisar `x-api-key` |
| `400` | No | Dead-letter (error de mapeo) |
| `500` / `503` | No | Reintentar con backoff (respetar `Retry-After`) |
| Timeout del cliente (retardo cercano a 3 s) | Puede que sí | Reintentar: si ya se guardó, recibirá `409` |

### Autenticación (`x-api-key`)

Misma llave para banco y ERP (variable de entorno `API_KEY`, parámetro SAM `ApiKey`).
Coincide con el esquema `ApiKeyAuth` del OpenAPI de la Clase 12.

```http
x-api-key: <llave-entregada>
```

Ejemplo:

```bash
curl -H "x-api-key: TuClaveSegura1" ...
```

- `/bank/v1/health` y `/erp/v1/salud` **no** piden autenticación.
- La seguridad real la da el **HTTPS** de API Gateway.
- Entregar la llave a los equipos por un canal privado (no por el chat general del curso).

> **¿Por qué "1 de cada 5" es una probabilidad y no un contador?** Lambda es **sin estado**:
> puede haber varios entornos atendiendo en paralelo y cada uno tendría su propio contador
> en memoria. Con probabilidad `0.2`, en promedio falla 1 de cada 5 sin compartir estado.

### Forzar un escenario (solo pruebas)

Header `X-Simulation-Scenario`: `SUCCESS` (sin retardo ni error), `ERROR_500`, `ERROR_503`.
Cualquier otro valor se trata como `AUTO` (aleatorio). Desactivar el día de la demo con el
parámetro `AllowScenarioHeader=false`.

## Endpoints

URL base (output `ApiBaseUrl`): `https://{apiId}.execute-api.us-east-1.amazonaws.com/prod`

| Método | Ruta | Auth | Llave de unicidad |
|---|---|---|---|
| POST | `/bank/v1/payments` | `x-api-key` | header `Idempotency-Key` |
| GET | `/bank/v1/payments/{idempotencyKey}` | `x-api-key` | — |
| GET | `/bank/v1/health` | No | — |
| POST | `/erp/v1/pagos` | `x-api-key` | body `documento_origen.numero` |
| GET | `/erp/v1/pagos/{numeroDocumento}` | `x-api-key` | — |
| GET | `/erp/v1/salud` | No | — |

El mismo id (por ejemplo `EQA-000123`) puede registrarse una vez en el banco y una vez en el
ERP: la llave en DynamoDB incluye el destino (`BANK#EQA-000123`, `ERP#EQA-000123`).

## Simplificaciones respecto a la especificación de la Clase 12

| Especificación completa | Esta versión |
|---|---|
| API Gateway **REST** con API key **por equipo** | **HTTP API** + `x-api-key` validado dentro de cada Lambda (**misma** clave para todos) |
| `409 PAYMENT_ID_REUSED` si cambian los datos | Cualquier id repetido → `409` duplicado |
| Reglas de negocio `422` | No se implementan |
| Escenarios `SLOW`, `TIMEOUT`, `LOST_ACK`, `RATE_LIMIT` | Retardo 0–3 s + error 500/503 aleatorio. Los `429` reales los genera el throttling de API Gateway (20 req/s) |
| Validación con `ajv` desde el YAML | Validación manual de campos obligatorios y formatos |

## Requisitos

- Node.js 22 (solo para pruebas locales)
- [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) con credenciales (`aws configure` o `aws login`)
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html) (`brew install aws-sam-cli` en macOS)
- Docker (solo para ejecución local con `sam local`)

## Estructura

```
pagos-simulados-lambda/
├── src/
│   ├── handlers/
│   │   ├── bank.mjs          # Lambda del banco (rutas /bank/v1/*)
│   │   └── erp.mjs           # Lambda del ERP (rutas /erp/v1/*)
│   └── lib/
│       ├── auth.mjs          # Validación del header x-api-key
│       ├── http.mjs          # respuestas JSON, headers, logs
│       ├── simulation.mjs    # retardo aleatorio + error 1 de cada 5
│       ├── repository.mjs    # DynamoDB: PutItem condicional y GetItem
│       ├── receipts.mjs      # formato de comprobantes
│       └── validation.mjs    # validación mínima del body
├── tests/                    # node:test con repositorio en memoria (sin AWS)
├── requests/                 # bodies de ejemplo para curl
├── template.yaml             # AWS SAM: tabla + API + 2 Lambdas + IAM + logs
├── env.local.example.json    # variables para sam local
└── package.json
```

El AWS SDK v3 (`@aws-sdk/*`) **ya viene incluido** en el runtime `nodejs22.x` de Lambda; por eso
está en `devDependencies` (solo para pruebas locales) y el paquete desplegado no lleva dependencias.

## Comandos

```bash
# Pruebas unitarias (no necesitan AWS)
npm install
npm test

# Desplegar en AWS (región us-east-1)
sam build
sam deploy --guided            # primera vez: stack "pagos-simulados", región us-east-1
                               # pide ApiKey (mín. 8 caracteres)
sam deploy                     # siguientes veces

# Cambiar el comportamiento o la clave sin tocar código
sam deploy --parameter-overrides \
  ErrorRate=0.3 DelayMaxMs=3000 AllowScenarioHeader=false \
  ApiKey='TuClaveSegura1'

# Ver logs en vivo durante la clase
sam logs --stack-name pagos-simulados --tail

# Eliminar todo (tabla incluida) al terminar el curso
sam delete --stack-name pagos-simulados
```

## Probar con curl

```bash
export API=https://xxxxxxxxxx.execute-api.us-east-1.amazonaws.com/prod
export API_KEY='TuClaveSegura1'   # la misma del deploy

# Banco: registrar (repetir el comando para ver el 409 o un 500/503 aleatorio)
curl -i -X POST "$API/bank/v1/payments" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: EQA-000123" \
  -d @requests/bank-payment.json

# Banco: forzar éxito sin retardo
curl -i -X POST "$API/bank/v1/payments" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: EQA-000124" \
  -H "X-Simulation-Scenario: SUCCESS" \
  -d @requests/bank-payment.json

# Banco: consultar
curl -i -H "x-api-key: $API_KEY" "$API/bank/v1/payments/EQA-000123"

# ERP: registrar y consultar
curl -i -X POST "$API/erp/v1/pagos" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" -d @requests/erp-pago.json
curl -i -H "x-api-key: $API_KEY" "$API/erp/v1/pagos/EQA-000123"

# Salud (sin autenticación)
curl -i "$API/bank/v1/health"
curl -i "$API/erp/v1/salud"
```

## Ejecución local (opcional)

```bash
# 1. DynamoDB Local + tabla
docker run -d --rm --name dynamodb-local -p 8000:8000 amazon/dynamodb-local
AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local aws dynamodb create-table \
  --endpoint-url http://localhost:8000 --region us-east-1 \
  --table-name pagos-simulados-local-pagos \
  --attribute-definitions AttributeName=pk,AttributeType=S \
  --key-schema AttributeName=pk,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST

# 2. API en http://localhost:3000
cp env.local.example.json env.local.json
sam build
sam local start-api --env-vars env.local.json
```

`host.docker.internal` funciona en Docker Desktop (macOS/Windows). En Linux usar
`--docker-network host` y `http://localhost:8000`.

## Configuración para los equipos (Spring Boot + Feign)

El OpenAPI declara `ApiKeyAuth` con header `x-api-key`. El cliente generado ya envía ese header;
solo hay que configurar el valor de la llave.

```yaml
bank:
  url: ${BANK_API_URL}   # https://xxxxxxxxxx.execute-api.us-east-1.amazonaws.com/prod
erp:
  url: ${ERP_API_URL}    # la misma URL base

bankpaymentssimulator.security.apiKeyAuth.key: ${BANK_API_KEY}
erppaymentssimulator.security.apiKeyAuth.key: ${ERP_API_KEY}
```

Timeouts recomendados: connect 2 s, read 3 s. Con un retardo de hasta 3 s, algunas peticiones
harán timeout del lado del cliente **después** de que el pago se guardó: el reintento recibirá
`409` y debe tratarse como éxito. El `403` **no** se reintenta.

## Seguridad y costos

- **HTTPS** siempre (API Gateway no expone HTTP plano).
- **`x-api-key`** en la Lambda: sin llave correcta → `403` (`FORBIDDEN` / `PROHIBIDO`). `/health` y `/salud` públicos.
- **IAM mínimo privilegio:** cada Lambda solo puede `PutItem` y `GetItem` sobre su tabla.
- **Sin datos personales en BD ni logs:** no se guarda `fullName`, `taxId` ni `nit`.
- La clave viaja como variable de entorno (`NoEcho` en el parámetro de SAM). Para producción
  preferir Secrets Manager; para el curso basta.
- **Costos:** Lambda y DynamoDB on-demand quedan dentro de la capa gratuita con el uso de clase;
  HTTP API ~US$1 por millón de peticiones. El throttling (20 req/s) limita el daño de un bucle
  de reintentos sin backoff. Crear una alerta de AWS Budgets (US$5).
