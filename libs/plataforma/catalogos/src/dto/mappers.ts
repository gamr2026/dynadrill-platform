import type {
  Bodega,
  CondicionPago,
  Bloque,
  Campo,
  Cliente,
  PersonaContacto,
  Pozo,
  Taladro,
  Zona,
} from '../generated/client';
import type {
  BloqueResponse,
  CampoResponse,
  CatalogoAs2Response,
  CatalogoSimpleResponse,
  ClienteResponse,
  PersonaResponse,
  PozoResponse,
  TaladroResponse,
  TipoPersona,
} from './catalogos.dto';

/**
 * Traducen columnas de la base a las formas que ya lee el frontend (mismos nombres de campo que la demo),
 * más `legacyId` para los módulos que aún usan ids numéricos. Nunca se serializa la entidad completa:
 * así las columnas de auditoría no se filtran por accidente.
 */
export const toBloque = (b: Bloque): BloqueResponse => ({
  id: b.id,
  legacyId: b.legacyId,
  nombre: b.nombre,
  habilitado: b.habilitado,
});

/** Un campo se lee siempre con su zona (relación). */
export type CampoConRelaciones = Campo & { zona?: Zona | null };

export const toCampo = (c: CampoConRelaciones): CampoResponse => ({
  id: c.id,
  legacyId: c.legacyId,
  nombre: c.nombre,
  zona: c.zona?.nombre ?? null,
  zonaId: c.zonaId,
  habilitado: c.habilitado,
});

export const toCatalogoSimple = (c: Zona): CatalogoSimpleResponse => ({
  id: c.id,
  nombre: c.nombre,
  habilitado: c.habilitado,
});

export const toTaladro = (t: Taladro): TaladroResponse => ({
  id: t.id,
  legacyId: t.legacyId,
  nombre: t.nombre,
  rigContractual: t.rigContractual,
  habilitado: t.habilitado,
});

export const toPozo = (
  p: Pozo & { campo?: CampoConRelaciones | null; bloque?: Bloque | null },
): PozoResponse => ({
  id: p.id,
  legacyId: p.legacyId,
  codigo: p.codigo,
  nombreCompleto: p.nombreCompleto,
  campoId: p.campoId,
  bloqueId: p.bloqueId,
  habilitado: p.habilitado,
  campo: p.campo ? toCampo(p.campo) : null,
  bloque: p.bloque ? toBloque(p.bloque) : null,
});

export const toCliente = (c: Cliente): ClienteResponse => ({
  id: c.id,
  legacyId: c.legacyId,
  tipoIdentificacion: c.tipoIdentificacion,
  identificacion: c.identificacion,
  nombreComercial: c.nombreComercial,
  nombreFiscal: c.nombreFiscal,
  activo: c.activo,
});

export const toPersona = (p: PersonaContacto): PersonaResponse => ({
  id: p.id,
  legacyId: p.legacyId,
  tipo: p.tipo as TipoPersona,
  nombre: p.nombre,
  ...(p.cedula ? { cedula: p.cedula } : {}),
  activo: p.activo,
});

export const toCatalogoAs2 = (c: Bodega | CondicionPago): CatalogoAs2Response => ({
  id: c.id,
  as2Id: c.as2Id,
  nombre: c.nombre,
  habilitado: c.habilitado,
});
