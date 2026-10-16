import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { EventEnvelope } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import type { Prisma } from '../generated/client';
import { CorreoSeguroService } from '../mail/correo-seguro.service';
import { PrismaService } from '../prisma/prisma.service';
import { Destinatario, DestinatariosPort } from '../puertos/destinatarios.port';
import { renderizar, variablesDeEvento, type Variables } from '../plantillas';

const MAX_AVISOS = 50;

/**
 * Avisa de un hecho del sistema: por cada regla activa del evento, a cada persona ACTIVA con el rol de la regla (o, si el evento
 * trae las cuentas elegidas, a esas cuentas) le crea el
 * aviso de la campanita y le manda el correo (que en pruebas llega solo a la dirección de redirección). El texto sale de la
 * plantilla de la regla, con los datos del evento y los de la persona (nombre y cargo).
 */
@Injectable()
export class AvisosService {
  private readonly logger = new Logger(AvisosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly destinatarios: DestinatariosPort,
    private readonly correo: CorreoSeguroService,
  ) {}

  /** Procesa un evento. `tx` es la transacción del inbox: los avisos y la bitácora se guardan con el evento. */
  async procesar(
    tx: Prisma.TransactionClient,
    event: EventEnvelope,
  ): Promise<{ avisos: number; correos: number }> {
    const reglas = await tx.reglaAviso.findMany({
      where: { eventoTipo: event.type, activa: true, plantilla: { activa: true } },
      include: { plantilla: true },
    });
    const base = variablesDeEvento(event.data);
    let avisos = 0;
    let correos = 0;

    // Si el evento trae las cuentas elegidas (`asignados`), el aviso es solo para ellas y la regla se aplica a las que tienen su rol
    // en esa asignación; si no, es para todas las cuentas activas con el rol de la regla.
    const asignados = Array.isArray((event.data as { asignados?: unknown })?.asignados)
      ? ((event.data as { asignados: Array<{ usuarioId?: string; rolCodigo?: string }> })
          .asignados ?? [])
      : null;

    for (const regla of reglas) {
      let personas: Destinatario[];
      if (asignados) {
        const ids = asignados
          .filter((a) => a.rolCodigo === regla.rolCodigo && a.usuarioId)
          .map((a) => a.usuarioId as string);
        if (!ids.length) continue;
        personas = await this.destinatarios.activosPorIds(ids);
      } else {
        personas = await this.destinatarios.activosPorRol(regla.rolCodigo);
      }
      // sin nadie con el rol, igual sale un correo (para que se vea el aviso en pruebas), pero sin campanita
      const objetivos: Array<Destinatario | null> = personas.length ? personas : [null];

      for (const p of objetivos) {
        const vars: Variables = {
          ...base,
          nombre: p?.nombre ?? '(sin destinatario)',
          cargo: p?.cargo ?? regla.rolCodigo,
          rol: p?.rolNombre ?? regla.rolCodigo,
        };
        const pl = regla.plantilla;
        const enlace = pl.enlaceAviso ? renderizar(pl.enlaceAviso, vars) : null;

        if (p) {
          const r = await tx.aviso.createMany({
            data: [
              {
                id: uuidv7(),
                usuarioId: p.id,
                eventoId: event.id,
                titulo: renderizar(pl.tituloAviso, vars),
                detalle: renderizar(pl.detalleAviso, vars) || null,
                enlace,
                tono: pl.tono,
              },
            ],
            skipDuplicates: true,
          });
          avisos += r.count;
        }

        const asunto = renderizar(pl.asunto, vars);
        const yaEnviado = await tx.correoAviso.findFirst({
          where: {
            eventoId: event.id,
            reglaId: regla.id,
            usuarioId: p?.id ?? null,
            estado: 'enviado',
          },
          select: { id: true },
        });
        if (yaEnviado) continue;
        try {
          await this.correo.enviar({
            destinatarioNombre: p?.nombre ?? null,
            destinatarioCorreo: p?.email ?? null,
            asunto,
            contenidoHtml: renderizar(pl.cuerpoHtml, vars, true),
            contenidoTexto: renderizar(pl.cuerpoTexto, vars),
            enlace,
          });
          await this.bitacora(tx, event.id, regla.id, p, asunto, null);
          correos++;
        } catch (e) {
          // el correo es un canal más: si falla, la campanita ya quedó y la falla queda anotada
          const motivo = e instanceof Error ? e.message : String(e);
          this.logger.warn(`Correo de "${asunto}" no salió: ${motivo}`);
          await this.bitacora(tx, event.id, regla.id, p, asunto, motivo.slice(0, 500));
        }
      }
    }
    return { avisos, correos };
  }

  private bitacora(
    tx: Prisma.TransactionClient,
    eventoId: string,
    reglaId: string,
    p: Destinatario | null,
    asunto: string,
    error: string | null,
  ) {
    return tx.correoAviso.create({
      data: {
        id: uuidv7(),
        eventoId,
        reglaId,
        usuarioId: p?.id ?? null,
        enviadoA: this.correo.destinoReal,
        asunto: `[PRUEBA] ${asunto}`,
        estado: error ? 'fallido' : 'enviado',
        error,
      },
    });
  }

  // ---- campanita ----------------------------------------------------------------------------------------------

  /** Avisos sin leer de la persona, los más recientes primero. */
  async misAvisos(usuarioId: string) {
    const filas = await this.prisma.aviso.findMany({
      where: { usuarioId, leidoAt: null },
      orderBy: { createdAt: 'desc' },
      take: MAX_AVISOS,
    });
    return filas.map((a) => ({
      id: a.id,
      titulo: a.titulo,
      detalle: a.detalle,
      enlace: a.enlace,
      tono: a.tono,
      creadoAt: a.createdAt,
    }));
  }

  async leer(usuarioId: string, id: string): Promise<void> {
    const a = await this.prisma.aviso.findUnique({ where: { id }, select: { usuarioId: true } });
    if (!a) throw new NotFoundException('El aviso no existe');
    if (a.usuarioId !== usuarioId) throw new ForbiddenException('Ese aviso es de otra persona');
    await this.prisma.aviso.updateMany({
      where: { id, leidoAt: null },
      data: { leidoAt: new Date() },
    });
  }

  async leerTodos(usuarioId: string): Promise<number> {
    const r = await this.prisma.aviso.updateMany({
      where: { usuarioId, leidoAt: null },
      data: { leidoAt: new Date() },
    });
    return r.count;
  }
}
