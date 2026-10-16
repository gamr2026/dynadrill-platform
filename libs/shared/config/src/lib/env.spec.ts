import {
  baseEnvSchema,
  databaseEnvSchema,
  defineEnv,
  EnvValidationError,
  normalizePem,
  parseCorsOrigins,
  rabbitEnvSchema,
  validateEnv,
} from './env';

const schema = defineEnv(baseEnvSchema, databaseEnvSchema, rabbitEnvSchema);

const valid = {
  SERVICE_NAME: 'plataforma',
  PORT: '3001',
  DATABASE_URL: 'postgresql://app_plataforma:x@localhost:6432/dynadrill?schema=identidad',
  RABBITMQ_URL: 'amqp://u:p@localhost:5672',
};

describe('validateEnv', () => {
  it('aplica defaults y convierte tipos', () => {
    const env = validateEnv(schema, valid);
    expect(env).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3001,
      LOG_LEVEL: 'info',
      OUTBOX_RELAY_ENABLED: true,
      OUTBOX_RELAY_INTERVAL_MS: 1000,
    });
  });

  it('reporta todos los problemas a la vez', () => {
    try {
      validateEnv(schema, { PORT: '99999', DATABASE_URL: 'mysql://x' });
      fail('debía lanzar');
    } catch (e) {
      expect(e).toBeInstanceOf(EnvValidationError);
      const issues = (e as EnvValidationError).issues.join('|');
      expect(issues).toContain('SERVICE_NAME');
      expect(issues).toContain('PORT');
      expect(issues).toContain('DATABASE_URL');
      expect(issues).toContain('RABBITMQ_URL');
    }
  });
});

describe('helpers', () => {
  it('normaliza PEM con \n literales', () => {
    expect(normalizePem('-----A-----\nB\n-----C-----')).toBe('-----A-----\nB\n-----C-----');
  });
  it('separa orígenes CORS', () => {
    expect(parseCorsOrigins('http://a, http://b ,')).toEqual(['http://a', 'http://b']);
  });
});
