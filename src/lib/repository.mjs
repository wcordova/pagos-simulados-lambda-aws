// Capa: datos (DynamoDB). AWS SDK v3 — ya viene incluido en el runtime nodejs22.x de Lambda.
//
// Tabla con una sola llave: pk = "<DESTINO>#<idTransaccion>", por ejemplo "BANK#EQA-000123".
// El mismo id puede existir una vez en BANK y una vez en ERP (son sistemas distintos).
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

// Se crea FUERA del handler: se reutiliza entre invocaciones mientras el entorno esté caliente.
// DYNAMODB_ENDPOINT solo se usa en local (DynamoDB Local con `sam local`).
const documentClient = DynamoDBDocumentClient.from(
  new DynamoDBClient(
    process.env.DYNAMODB_ENDPOINT ? { endpoint: process.env.DYNAMODB_ENDPOINT } : {},
  ),
  { marshallOptions: { removeUndefinedValues: true } },
);

export const buildKey = (destination, transactionId) => `${destination}#${transactionId}`;

export const findPayment = async (pk) => {
  const { Item } = await documentClient.send(
    new GetCommand({ TableName: process.env.TABLE_NAME, Key: { pk }, ConsistentRead: true }),
  );
  return Item ?? null;
};

// ❌ Error común: primero GetItem ("¿existe?") y luego PutItem.
//    Si dos reintentos del mismo pago llegan al mismo tiempo, ambos leen "no existe"
//    y ambos escriben → pago duplicado.
// ✅ PutItem CONDICIONAL: DynamoDB evalúa la condición y escribe en una sola operación
//    atómica. Solo una petición gana; la otra recibe ConditionalCheckFailedException.
export const savePaymentIfNew = async (item) => {
  try {
    await documentClient.send(
      new PutCommand({
        TableName: process.env.TABLE_NAME,
        Item: item,
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
    return { created: true };
  } catch (error) {
    if (error.name !== 'ConditionalCheckFailedException') throw error;
    return { created: false, existing: await findPayment(item.pk) };
  }
};

export const dynamoRepository = { findPayment, savePaymentIfNew };
