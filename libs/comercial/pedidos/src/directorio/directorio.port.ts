export interface ClienteRef {
  id: string;
  nombre: string;
  ruc: string | null;
}

export interface NombreRef {
  id: string;
  nombre: string;
}

export interface CampoRef extends NombreRef {
  zonaId: string | null;
  zona: string | null;
}

export interface ArchivoRef {
  id: string;
  modulo: string;
  nombre: string;
  mimeType: string;
  tamanoBytes: number;
  subidoPor: string;
}

/** Resultado de la lectura automática de una firma (ayuda para revisar; no certifica la autenticidad). */
export interface VerificacionFirmaRef {
  resultado: 'firma_detectada' | 'no_detectada' | 'no_concluyente';
  confianza: number;
  nombreCoincide: boolean | null;
}

export interface TransportistaRef extends NombreRef {
  identificacion: string;
}

export interface VehiculoRef {
  id: string;
  placa: string;
  /** Tipo, marca y modelo (p. ej. "CAMION JAC HFC1040K2"); `null` si el catálogo no los tiene. */
  descripcion: string | null;
  transportistaId: string | null;
}

export interface ChoferRef extends NombreRef {
  transportistaId: string;
}

/** Resultado de validar las firmas digitales de un PDF (servicio de firmas, vía `archivos`). */
export interface FirmaElectronicaRef {
  estado:
    | 'sin_firmas_digitales'
    | 'verificado'
    | 'verificado_con_advertencias'
    | 'firmantes_no_verificados'
    | 'alterado';
  resumen: string;
  firmas: Array<{
    firmanteNombre: string | null;
    firmanteIdentificacion: string | null;
    emisor: string | null;
    integridad:
      | 'intacto'
      | 'intacto_con_revisiones_posteriores'
      | 'modificado_despues_de_firmar'
      | 'firma_invalida';
    firmaValida: boolean;
    firmanteVerificado: boolean;
    vigenteAlFirmar: boolean | null;
    fechaFirma: string | null;
    origenFecha: 'sello_de_tiempo' | 'declarada_por_el_firmante' | 'desconocida';
    conclusion: string;
  }>;
}

export interface PozoRef extends NombreRef {
  campoId: string | null;
  bloqueId: string | null;
}

export interface UsuarioRef {
  id: string;
  name: string;
  roleCode: string;
  activo: boolean;
}

/** Un pedido de AS2 tal como lo entrega el contenedor de plataforma (registro de integraciones). */
export interface As2PedidoRef {
  idPedidoCliente: number;
  numero: string;
  fecha: string | null;
  estado: string;
  total: number;
  descuento: number;
  impuesto: number;
  descripcion: string | null;
  empresaNombre: string | null;
  empresaIdentificacion: string | null;
  bodega: string | null;
  condicionPago: string | null;
  zona: string | null;
  lineasEstado: 'con_lineas' | 'sin_lineas';
  lineas?: Array<{
    codigo: string | null;
    nombre: string | null;
    cantidad: number;
    precio: number;
  }>;
}

/**
 * Lo que el contenedor comercial necesita de otros contenedores (catálogos, directorio de personas, pedidos de AS2).
 * No hay FK entre schemas ni lectura directa de sus tablas: se consulta por su API. El token de quien hace la petición
 * se reenvía, así los permisos se aplican igual que si llamara directamente.
 */
export abstract class DirectorioPort {
  abstract cliente(id: string, token: string): Promise<ClienteRef | null>;
  abstract clientePorRuc(ruc: string, token: string): Promise<ClienteRef | null>;
  abstract campo(id: string, token: string): Promise<CampoRef | null>;
  /** Metadatos de un archivo del módulo `archivos` (null si no existe o no se puede ver). */
  abstract archivo(id: string, token: string): Promise<ArchivoRef | null>;
  /** Pide a `archivos` que lea la firma del archivo (servicio de OCR). `null` si no se pudo (nunca bloquea el flujo). */
  abstract verificarFirma(
    archivoId: string,
    params: { nombreEsperado?: string; cargoEsperado?: string },
    token: string,
  ): Promise<VerificacionFirmaRef | null>;
  /** Pide a `archivos` validar las firmas digitales del PDF. `null` si no se pudo (nunca bloquea el flujo). */
  abstract verificarFirmaElectronica(
    archivoId: string,
    token: string,
  ): Promise<FirmaElectronicaRef | null>;
  /** Baja lógica del archivo en `archivos` (al quitar un adjunto). */
  abstract eliminarArchivo(id: string, token: string): Promise<void>;
  abstract bodega(id: string, token: string): Promise<NombreRef | null>;
  abstract condicionPago(id: string, token: string): Promise<NombreRef | null>;
  /** Busca por nombre (sin distinguir mayúsculas ni espacios sobrantes); sirve para enlazar lo que viene de AS2. */
  abstract bodegaPorNombre(nombre: string, token: string): Promise<NombreRef | null>;
  abstract condicionPagoPorNombre(nombre: string, token: string): Promise<NombreRef | null>;
  abstract transportista(id: string, token: string): Promise<TransportistaRef | null>;
  abstract vehiculo(id: string, token: string): Promise<VehiculoRef | null>;
  abstract chofer(id: string, token: string): Promise<ChoferRef | null>;
  abstract bloque(id: string, token: string): Promise<NombreRef | null>;
  abstract taladro(id: string, token: string): Promise<NombreRef | null>;
  abstract pozo(id: string, token: string): Promise<PozoRef | null>;
  abstract persona(id: string, token: string): Promise<NombreRef | null>;
  abstract usuarios(ids: string[], token: string): Promise<UsuarioRef[]>;
  abstract as2Pedido(idPedidoCliente: number, token: string): Promise<As2PedidoRef | null>;
}
