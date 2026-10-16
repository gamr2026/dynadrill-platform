import { Injectable } from '@nestjs/common';
import { currentTraceparent, type AuthUser } from '@dyn/common';
import { EventBus } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { claveProvisional } from '../as2/clave-provisional';
import { sugerirRol } from '../as2/rol-por-cargo';
import { PrismaService } from '../prisma/prisma.service';
import { PasswordService } from './password.service';

export interface CuentaPropuesta {
  empleado: string;
  email: string;
  rolSugerido: string;
  /** false: el cargo no se reconoció; el rol es el más básico y debe asignarse a mano. */
  rolReconocido: boolean;
  resultado: 'crear' | 'vincular' | 'conflicto';
  motivo?: string;
}

export interface ReporteCuentas {
  /** true: no se escribió nada, es solo la vista previa. */
  simulacion: boolean;
  empleadosActivos: number;
  /** Activos sin correo en AS2: no se crea cuenta (decisión del 13/10/2026). */
  sinCorreo: number;
  /** Activos que ya tienen cuenta enlazada. */
  yaConCuenta: number;
  creadas: number;
  vinculadas: number;
  conflictos: number;
  detalle: CuentaPropuesta[];
}

/** Nombre completo en mayúsculas de AS2 → "Nombre Apellido" legible. */
const capitalizar = (s: string) =>
  s
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');

/**
 * Crea las cuentas del portal para los empleados ACTIVOS de AS2 que tienen correo. Reglas:
 *  - Solo con correo de AS2: no se inventan correos. Sin correo, no hay cuenta.
 *  - Las cuentas nacen INACTIVAS, con el rol sugerido por su cargo y una clave aleatoria que nadie conoce: un
 *    administrador revisa el rol, fija una clave provisional (con `forceChangePassword`) y activa la cuenta.
 *  - Si ya existe un usuario con ese correo y sin perfil, se le enlaza el perfil en vez de duplicarlo.
 *  - Un correo repetido entre empleados, o ya usado por otra persona, se informa como conflicto y no se crea.
 */
@Injectable()
export class As2CuentasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly bus: EventBus,
  ) {}

  async crearCuentas(actor: AuthUser, simular = true, cedulas?: string[]): Promise<ReporteCuentas> {
    const activos = await this.prisma.empleadoAs2.findMany({
      where: { activo: true, ...(cedulas?.length ? { cedula: { in: cedulas } } : {}) },
      include: { perfiles: { select: { id: true } } },
      orderBy: [{ apellidos: 'asc' }, { nombres: 'asc' }],
    });
    const yaConCuenta = activos.filter((e) => e.perfiles.length > 0).length;
    const sinCorreo = activos.filter((e) => !e.correoAs2).length;
    const candidatos = activos.filter((e) => e.perfiles.length === 0 && e.correoAs2);

    const veces = new Map<string, number>();
    for (const e of candidatos) {
      const k = e.correoAs2!.toLowerCase();
      veces.set(k, (veces.get(k) ?? 0) + 1);
    }

    const detalle: CuentaPropuesta[] = [];
    // Usuarios ACTIVOS del portal sin perfil: posibles cuentas de la misma persona con otro correo. Las cuentas ya
    // retiradas (inactivas) no cuentan: su dueño real recibe una cuenta propia.
    const usuariosExistentes = await this.prisma.usuario.findMany({
      where: { activo: true, perfil: { is: null } },
      select: { nombre: true, email: true },
    });
    const roles = new Map((await this.prisma.rol.findMany()).map((r) => [r.codigo, r.id]));
    const usernames = new Set<string>();
    let creadas = 0;
    let vinculadas = 0;

    for (const e of candidatos) {
      const email = e.correoAs2!.toLowerCase();
      const sugerido = sugerirRol(e.cargo);
      const base = {
        empleado: capitalizar(`${e.nombres} ${e.apellidos}`),
        email,
        rolSugerido: sugerido.rol,
        rolReconocido: sugerido.reconocido,
      };

      if ((veces.get(email) ?? 0) > 1) {
        detalle.push({
          ...base,
          resultado: 'conflicto',
          motivo: 'el correo está repetido entre empleados de AS2',
        });
        continue;
      }
      const existente = await this.prisma.usuario.findUnique({
        where: { email },
        include: { perfil: { select: { id: true } } },
      });
      if (existente?.perfil) {
        detalle.push({
          ...base,
          resultado: 'conflicto',
          motivo: 'ya existe un usuario con ese correo y con otro perfil',
        });
        continue;
      }
      // Misma persona con otro correo (p. ej. una cuenta de rol como facturacion@): no se duplica.
      if (!existente) {
        const parecido = this.mismaPersona(e, usuariosExistentes);
        if (parecido) {
          detalle.push({
            ...base,
            resultado: 'conflicto',
            motivo: `ya existe un usuario con nombre parecido (${parecido})`,
          });
          continue;
        }
      }
      const rolId = roles.get(sugerido.rol);
      if (!rolId) {
        detalle.push({
          ...base,
          resultado: 'conflicto',
          motivo: `no existe el rol ${sugerido.rol}`,
        });
        continue;
      }

      if (existente) {
        detalle.push({ ...base, resultado: 'vincular' });
        if (!simular) {
          await this.prisma.usuarioPerfil.create({
            data: { ...this.perfil(e), usuarioId: existente.id },
          });
          vinculadas++;
        }
        continue;
      }

      detalle.push({ ...base, resultado: 'crear' });
      if (simular) continue;
      const username = await this.usernameLibre(email, usernames);
      const passwordHash = await this.passwords.hash(claveProvisional(e.nombres, e.apellidos));
      const usuarioId = uuidv7();
      await this.prisma.$transaction(async (tx) => {
        const user = await tx.usuario.create({
          data: {
            id: usuarioId,
            email,
            username,
            nombre: base.empleado,
            passwordHash,
            rolId,
            activo: false,
            debeCambiarClave: true,
            tipoVinculo: 'empleado',
            createdBy: actor.id,
            updatedBy: actor.id,
            perfil: { create: this.perfil(e) },
          },
          include: { rol: true },
        });
        await this.bus.publish(
          tx,
          this.bus.create({
            type: 'plataforma.usuario.actualizado',
            subject: { type: 'usuario', id: user.id },
            data: {
              usuarioId: user.id,
              cambio: 'creado',
              activo: user.activo,
              rolCodigo: user.rol.codigo,
            },
            actor: { userId: actor.id, role: actor.roleCode },
            traceparent: currentTraceparent(),
          }),
        );
      });
      creadas++;
    }

    return {
      simulacion: simular,
      empleadosActivos: activos.length,
      sinCorreo,
      yaConCuenta,
      creadas: simular ? 0 : creadas,
      vinculadas: simular ? 0 : vinculadas,
      conflictos: detalle.filter((d) => d.resultado === 'conflicto').length,
      detalle,
    };
  }

  /** Nombre y primer apellido del empleado contenidos en el nombre de un usuario sin perfil: probable misma persona. */
  private mismaPersona(
    e: { nombres: string; apellidos: string },
    usuarios: { nombre: string; email: string }[],
  ): string | null {
    // Quita las tildes: el rango del reemplazo son las marcas diacríticas combinadas (U+0300 a U+036F).
    const norm = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const nombre = norm(e.nombres).split(/\s+/)[0];
    const apellido = norm(e.apellidos).split(/\s+/)[0];
    if (!nombre || !apellido) return null;
    const hallado = usuarios.find((u) => {
      const t = norm(u.nombre);
      return t.includes(nombre) && t.includes(apellido);
    });
    return hallado?.email ?? null;
  }

  private perfil(e: {
    id: string;
    cedula: string;
    nombres: string;
    apellidos: string;
    cargo: string | null;
    departamento: string | null;
    sucursal: string | null;
    tipoContrato: string | null;
    fechaIngreso: Date | null;
  }) {
    return {
      id: uuidv7(),
      cedula: e.cedula,
      nombres: e.nombres,
      apellidos: e.apellidos,
      cargo: e.cargo,
      departamento: e.departamento,
      sucursal: e.sucursal,
      tipoContrato: e.tipoContrato,
      fechaIngreso: e.fechaIngreso,
      empleadoActivo: true,
      empleadoAs2Id: e.id,
    };
  }

  /** `username` único a partir de la parte local del correo (mínimo 3 caracteres). */
  private async usernameLibre(email: string, tomados: Set<string>): Promise<string> {
    let base = email.split('@')[0].replace(/[^a-z0-9._-]/g, '');
    if (base.length < 3) base = `${base}usr`;
    for (let i = 0; ; i++) {
      const candidato = i === 0 ? base : `${base}${i + 1}`;
      if (tomados.has(candidato)) continue;
      const existe = await this.prisma.usuario.findUnique({
        where: { username: candidato },
        select: { id: true },
      });
      if (!existe) {
        tomados.add(candidato);
        return candidato;
      }
    }
  }
}
