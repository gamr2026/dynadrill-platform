import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ArchivoRef,
  As2PedidoRef,
  ChoferRef,
  FirmaElectronicaRef,
  TransportistaRef,
  VehiculoRef,
  VerificacionFirmaRef,
  CampoRef,
  ClienteRef,
  DirectorioPort,
  NombreRef,
  PozoRef,
  UsuarioRef,
} from './directorio.port';

const TIMEOUT_MS = 10_000;
/** La lectura de una firma puede tardar (hasta unos 20 s en documentos de varias páginas). */
const VERIFICACION_TIMEOUT_MS = 90_000;

type Json = Record<string, unknown>;
const texto = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * Adaptador HTTP hacia el contenedor de plataforma (`PLATAFORMA_URL`, por defecto el puerto local 3101). Reenvía el
 * token de quien llama. Un 404 es "no existe" (null); cualquier otro fallo es 503 con un mensaje claro.
 */
@Injectable()
export class DirectorioHttpAdapter extends DirectorioPort {
  private readonly base: string;

  constructor(cfg: ConfigService) {
    super();
    this.base = (cfg.get<string>('PLATAFORMA_URL') ?? 'http://localhost:3101').replace(/\/+$/, '');
  }

  async cliente(id: string, token: string): Promise<ClienteRef | null> {
    const c = await this.get<Json>(`/api/catalogos/clientes/${id}`, token);
    return c ? this.aCliente(c) : null;
  }

  async clientePorRuc(ruc: string, token: string): Promise<ClienteRef | null> {
    const lista = await this.get<Json[]>('/api/catalogos/clientes', token);
    const c = lista?.find((x) => texto(x['identificacion']) === ruc.trim());
    return c ? this.aCliente(c) : null;
  }

  async campo(id: string, token: string): Promise<CampoRef | null> {
    const r = await this.get<Json>(`/api/catalogos/campos/${id}`, token);
    return r
      ? {
          id: String(r['id']),
          nombre: texto(r['nombre']) ?? String(r['id']),
          zonaId: texto(r['zonaId']),
          zona: texto(r['zona']),
        }
      : null;
  }
  async archivo(id: string, token: string): Promise<ArchivoRef | null> {
    const r = await this.get<Json>(`/api/archivos/${id}`, token);
    return r
      ? {
          id: String(r['id']),
          modulo: String(r['modulo']),
          nombre: String(r['nombre']),
          mimeType: String(r['mimeType']),
          tamanoBytes: Number(r['tamanoBytes']),
          subidoPor: String(r['subidoPor']),
        }
      : null;
  }
  async verificarFirma(
    archivoId: string,
    params: { nombreEsperado?: string; cargoEsperado?: string },
    token: string,
  ): Promise<VerificacionFirmaRef | null> {
    try {
      const r = await fetch(`${this.base}/api/archivos/${archivoId}/verificar-firma`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(VERIFICACION_TIMEOUT_MS),
      });
      if (!r.ok) return null;
      const j = (await r.json()) as Json;
      return {
        resultado: j['resultado'] as VerificacionFirmaRef['resultado'],
        confianza: Number(j['confianza']),
        nombreCoincide: typeof j['nombreCoincide'] === 'boolean' ? j['nombreCoincide'] : null,
      };
    } catch {
      return null;
    }
  }
  async eliminarArchivo(id: string, token: string): Promise<void> {
    try {
      await fetch(`${this.base}/api/archivos/${id}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      // la baja del archivo es de mejor esfuerzo: el adjunto ya se quitó del pedido
    }
  }
  async verificarFirmaElectronica(
    archivoId: string,
    token: string,
  ): Promise<FirmaElectronicaRef | null> {
    try {
      const r = await fetch(`${this.base}/api/archivos/${archivoId}/verificar-firma-electronica`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(VERIFICACION_TIMEOUT_MS),
      });
      if (!r.ok) return null;
      return (await r.json()) as FirmaElectronicaRef;
    } catch {
      return null;
    }
  }
  async transportista(id: string, token: string): Promise<TransportistaRef | null> {
    const r = await this.get<Json>(`/api/catalogos/transportistas/${id}`, token);
    if (!r) return null;
    return {
      id: String(r['id']),
      nombre: texto(r['nombreFiscal']) ?? String(r['id']),
      identificacion: texto(r['identificacion']) ?? '',
    };
  }
  async vehiculo(id: string, token: string): Promise<VehiculoRef | null> {
    const r = await this.get<Json>(`/api/catalogos/vehiculos/${id}`, token);
    if (!r) return null;
    const tipo = r['tipoVehiculo'] as Json | null;
    const dueno = r['transportista'] as Json | null;
    const descripcion = [texto(tipo?.['nombre']), texto(r['marca']), texto(r['modelo'])]
      .filter(Boolean)
      .join(' ');
    return {
      id: String(r['id']),
      placa: texto(r['placa']) ?? '',
      descripcion: descripcion || null,
      transportistaId: texto(dueno?.['id']),
    };
  }
  async chofer(id: string, token: string): Promise<ChoferRef | null> {
    const r = await this.get<Json>(`/api/catalogos/choferes/${id}`, token);
    if (!r) return null;
    return {
      id: String(r['id']),
      nombre: texto(r['nombre']) ?? String(r['id']),
      transportistaId: String(r['transportistaId']),
    };
  }
  bodega(id: string, token: string) {
    return this.nombre(`/api/catalogos/bodegas/${id}`, token);
  }
  condicionPago(id: string, token: string) {
    return this.nombre(`/api/catalogos/condiciones-pago/${id}`, token);
  }
  bodegaPorNombre(nombre: string, token: string) {
    return this.porNombre('/api/catalogos/bodegas', nombre, token);
  }
  condicionPagoPorNombre(nombre: string, token: string) {
    return this.porNombre('/api/catalogos/condiciones-pago', nombre, token);
  }
  bloque(id: string, token: string) {
    return this.nombre(`/api/catalogos/bloques/${id}`, token);
  }
  taladro(id: string, token: string) {
    return this.nombre(`/api/catalogos/taladros/${id}`, token);
  }
  persona(id: string, token: string) {
    return this.nombre(`/api/catalogos/personas/${id}`, token);
  }

  async pozo(id: string, token: string): Promise<PozoRef | null> {
    const p = await this.get<Json>(`/api/catalogos/pozos/${id}`, token);
    if (!p) return null;
    return {
      id: String(p['id']),
      nombre: texto(p['nombreCompleto']) ?? texto(p['codigo']) ?? String(p['id']),
      campoId: texto(p['campoId']),
      bloqueId: texto(p['bloqueId']),
    };
  }

  async usuarios(ids: string[], token: string): Promise<UsuarioRef[]> {
    if (ids.length === 0) return [];
    const r = await this.get<UsuarioRef[]>(`/api/directorio/usuarios?ids=${ids.join(',')}`, token);
    return r ?? [];
  }

  async as2Pedido(idPedidoCliente: number, token: string): Promise<As2PedidoRef | null> {
    return this.get<As2PedidoRef>(`/api/as2/pedidos/${idPedidoCliente}`, token);
  }

  // ----------------------------------------------------------------------------------------------------------

  private aCliente(c: Json): ClienteRef {
    return {
      id: String(c['id']),
      nombre: texto(c['nombreFiscal']) ?? texto(c['nombreComercial']) ?? String(c['id']),
      ruc: texto(c['identificacion']),
    };
  }

  private async porNombre(ruta: string, nombre: string, token: string): Promise<NombreRef | null> {
    const lista = await this.get<Json[]>(ruta, token);
    const buscado = nombre.trim().toLowerCase();
    const r = lista?.find((x) => (texto(x['nombre']) ?? '').toLowerCase() === buscado);
    return r ? { id: String(r['id']), nombre: texto(r['nombre']) ?? String(r['id']) } : null;
  }

  private async nombre(ruta: string, token: string): Promise<NombreRef | null> {
    const r = await this.get<Json>(ruta, token);
    return r ? { id: String(r['id']), nombre: texto(r['nombre']) ?? String(r['id']) } : null;
  }

  private async get<T>(ruta: string, token: string): Promise<T | null> {
    let r: Response;
    try {
      r = await fetch(`${this.base}${ruta}`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new ServiceUnavailableException('No se pudo consultar el catálogo de plataforma');
    }
    if (r.status === 404) return null;
    if (!r.ok) {
      throw new ServiceUnavailableException(`El catálogo de plataforma respondió ${r.status}`);
    }
    return (await r.json()) as T;
  }
}
