import { Body, Controller, Get, INestApplication, Module, Post } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { generateKeyPairSync } from 'node:crypto';
import { IsString } from 'class-validator';
import request from 'supertest';
import { ModuleRoles, RoleCode } from '@dyn/authz';
import { AppConfigModule, baseEnvSchema, defineEnv, jwtVerifyEnvSchema } from '@dyn/config';
import { configureApp } from './bootstrap';
import { AnyAuthenticated, CurrentUser, Public, RequirePermission, Roles } from './auth/decorators';
import { AuthUser } from './auth/auth-user';
import { CommonModule } from './common.module';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// AppConfigModule.forRoot valida el entorno al cargar este archivo, así que se fija antes.
Object.assign(process.env, {
  SERVICE_NAME: 'prueba',
  PORT: '3999',
  JWT_PUBLIC_KEY: publicKey,
  JWT_ISSUER: 'dynadrill-plataforma',
  LOG_LEVEL: 'silent',
});

class EchoDto {
  @IsString()
  texto!: string;
}

@Controller('prueba')
class PruebaController {
  @Public()
  @Get('publica')
  publica() {
    return { ok: true };
  }

  @AnyAuthenticated()
  @Get('yo')
  yo(@CurrentUser() user: AuthUser) {
    return { id: user.id, role: user.roleCode };
  }

  @Roles(...ModuleRoles.qhse)
  @Get('qhse')
  qhse() {
    return { ok: true };
  }

  @RequirePermission('qhse.iperc.aprobar')
  @Get('iperc')
  iperc() {
    return { ok: true };
  }

  @RequirePermission('qhse.iperc.aprobar', 'qhse.general.gestionar')
  @Get('uno-de-dos')
  unoDeDos() {
    return { ok: true };
  }

  @Get('sin-politica')
  sinPolitica() {
    return { ok: true };
  }

  @AnyAuthenticated()
  @Post('echo')
  echo(@Body() dto: EchoDto) {
    return dto;
  }
}

const envSchema = defineEnv(baseEnvSchema, jwtVerifyEnvSchema);

@Module({
  imports: [AppConfigModule.forRoot(envSchema), CommonModule.forRoot({ serviceName: 'prueba' })],
  controllers: [PruebaController],
})
class PruebaModule {}

describe('CommonModule (integración HTTP)', () => {
  let app: INestApplication;
  const signer = new JwtService({
    privateKey,
    signOptions: { algorithm: 'RS256', issuer: 'dynadrill-plataforma' },
  });
  const token = (roleCode: string, extra: object = {}) =>
    signer.sign({
      sub: '0192f7a4-5c1e-7b3a-9e21-8d4c6a1f0b77',
      email: 'a@b.c',
      roleId: 'r1',
      roleCode,
      ...extra,
    });

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [PruebaModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app, { corsOrigins: ['http://localhost:4200'] });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('health es público y no lleva prefijo /api', async () => {
    await request(app.getHttpServer()).get('/health/live').expect(200, { status: 'ok' });
  });

  it('ruta @Public responde sin token y devuelve x-request-id', async () => {
    const res = await request(app.getHttpServer()).get('/api/prueba/publica').expect(200);
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('respeta un x-request-id entrante válido y reemplaza uno malicioso', async () => {
    const ok = await request(app.getHttpServer())
      .get('/api/prueba/publica')
      .set('x-request-id', 'req-123');
    expect(ok.headers['x-request-id']).toBe('req-123');
    const bad = await request(app.getHttpServer())
      .get('/api/prueba/publica')
      .set('x-request-id', 'a b<script>');
    expect(bad.headers['x-request-id']).not.toBe('a b<script>');
  });

  it('401 sin token y con token inválido', async () => {
    await request(app.getHttpServer()).get('/api/prueba/yo').expect(401);
    await request(app.getHttpServer())
      .get('/api/prueba/yo')
      .set('Authorization', 'Bearer basura')
      .expect(401);
  });

  it('rechaza un token firmado con otra clave', async () => {
    const other = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const forged = new JwtService({
      privateKey: other.privateKey,
      signOptions: { algorithm: 'RS256', issuer: 'dynadrill-plataforma' },
    }).sign({ sub: 'x', email: 'x', roleId: 'x', roleCode: RoleCode.SUPERADMIN });
    await request(app.getHttpServer())
      .get('/api/prueba/yo')
      .set('Authorization', `Bearer ${forged}`)
      .expect(401);
  });

  it('rechaza HS256 aunque use la clave pública como secreto (confusión de algoritmo)', async () => {
    const hs = new JwtService({
      secret: publicKey,
      signOptions: { algorithm: 'HS256', issuer: 'dynadrill-plataforma' },
    }).sign({
      sub: 'x',
      email: 'x',
      roleId: 'x',
      roleCode: RoleCode.SUPERADMIN,
    });
    await request(app.getHttpServer())
      .get('/api/prueba/yo')
      .set('Authorization', `Bearer ${hs}`)
      .expect(401);
  });

  it('@AnyAuthenticated deja pasar y expone el usuario', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/prueba/yo')
      .set('Authorization', `Bearer ${token(RoleCode.OPERADOR)}`)
      .expect(200);
    expect(res.body).toEqual({ id: '0192f7a4-5c1e-7b3a-9e21-8d4c6a1f0b77', role: 'operador' });
  });

  it('@Roles: 403 con otro rol, 200 con rol permitido', async () => {
    await request(app.getHttpServer())
      .get('/api/prueba/qhse')
      .set('Authorization', `Bearer ${token(RoleCode.OPERADOR)}`)
      .expect(403);
    await request(app.getHttpServer())
      .get('/api/prueba/qhse')
      .set('Authorization', `Bearer ${token(RoleCode.GERENTE_HSE)}`)
      .expect(200);
  });

  it('@RequirePermission: decide por los permisos del token, no por el rol', async () => {
    const con = token(RoleCode.OPERADOR, { permissions: ['qhse.iperc.aprobar'] });
    const sin = token(RoleCode.SUPERADMIN, { permissions: ['otro.recurso.accion'] });
    const sinClave = token(RoleCode.SUPERADMIN); // token sin la clave permissions
    await request(app.getHttpServer())
      .get('/api/prueba/iperc')
      .set('Authorization', `Bearer ${con}`)
      .expect(200);
    // un superadmin sin ese permiso NO pasa: el permiso manda, no el nombre del rol
    await request(app.getHttpServer())
      .get('/api/prueba/iperc')
      .set('Authorization', `Bearer ${sin}`)
      .expect(403);
    await request(app.getHttpServer())
      .get('/api/prueba/iperc')
      .set('Authorization', `Bearer ${sinClave}`)
      .expect(403);
    await request(app.getHttpServer()).get('/api/prueba/iperc').expect(401);
  });

  it('@RequirePermission con varios códigos exige al menos uno', async () => {
    const uno = token(RoleCode.OPERADOR, { permissions: ['qhse.general.gestionar'] });
    const ninguno = token(RoleCode.OPERADOR, { permissions: ['x.y.z'] });
    await request(app.getHttpServer())
      .get('/api/prueba/uno-de-dos')
      .set('Authorization', `Bearer ${uno}`)
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/prueba/uno-de-dos')
      .set('Authorization', `Bearer ${ninguno}`)
      .expect(403);
  });

  it('una ruta sin política declarada se rechaza (cierre por defecto)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/prueba/sin-politica')
      .set('Authorization', `Bearer ${token(RoleCode.SUPERADMIN)}`)
      .expect(403);
    expect(res.body.detail).toMatch(/no declara/);
  });

  it('errores: RFC 7807 más los campos del contrato actual', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/prueba/echo')
      .set('Authorization', `Bearer ${token(RoleCode.OPERADOR)}`)
      .send({ texto: 'hola', extra: 'no permitido' })
      .expect(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body).toMatchObject({
      status: 400,
      statusCode: 400,
      title: 'BAD_REQUEST',
      path: '/api/prueba/echo',
      method: 'POST',
    });
    expect(res.body.requestId).toBeTruthy();
    expect(JSON.stringify(res.body.message)).toContain('extra');
  });

  it('una ruta inexistente responde 404 con el mismo formato de error', async () => {
    const res = await request(app.getHttpServer()).get('/api/no-existe').expect(404);
    expect(res.body).toMatchObject({ status: 404, statusCode: 404 });
    expect(res.body.requestId).toBeTruthy();
  });
});
