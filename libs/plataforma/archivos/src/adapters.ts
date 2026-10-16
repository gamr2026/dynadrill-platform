import { BlobServiceClient, ContainerClient } from '@azure/storage-blob';
import { Socket } from 'node:net';
import type { Readable } from 'node:stream';
import {
  FileStoragePort,
  FirmaDigitalVerificada,
  FirmaVerificadorPort,
  ParametrosVerificacion,
  ResultadoEscaneo,
  ScannerPort,
  VerificacionFirma,
  VerificacionFirmaElectronica,
} from './ports';

/** Azure Blob Storage (o Azurite con `UseDevelopmentStorage=true`). Crea el contenedor la primera vez que se usa. */
export class AzureBlobStorage extends FileStoragePort {
  private contenedor?: Promise<ContainerClient>;

  constructor(
    private readonly cadenaConexion: string,
    private readonly nombreContenedor: string,
  ) {
    super();
  }

  private obtener(): Promise<ContainerClient> {
    this.contenedor ??= (async () => {
      const c = BlobServiceClient.fromConnectionString(this.cadenaConexion).getContainerClient(
        this.nombreContenedor,
      );
      await c.createIfNotExists();
      return c;
    })();
    return this.contenedor;
  }

  async guardar(clave: string, contenido: Buffer, mimeType: string): Promise<void> {
    const c = await this.obtener();
    await c.getBlockBlobClient(clave).uploadData(contenido, {
      blobHTTPHeaders: { blobContentType: mimeType },
    });
  }

  async leer(clave: string): Promise<Readable> {
    const c = await this.obtener();
    const r = await c.getBlobClient(clave).download();
    if (!r.readableStreamBody) throw new Error('El almacenamiento no devolvió contenido');
    return r.readableStreamBody as Readable;
  }

  async borrar(clave: string): Promise<void> {
    const c = await this.obtener();
    await c.getBlobClient(clave).deleteIfExists();
  }
}

/** Sin antivirus (solo desarrollo): deja constancia de que NO se analizó. */
export class SinEscaner extends ScannerPort {
  async escanear(): Promise<ResultadoEscaneo> {
    return { limpio: true, omitido: true };
  }
}

/** ClamAV por el protocolo `INSTREAM` de clamd. Si el servicio no responde, el archivo se rechaza (falla cerrada). */
export class EscanerClamAv extends ScannerPort {
  constructor(
    private readonly host: string,
    private readonly puerto: number,
    private readonly timeoutMs = 30_000,
  ) {
    super();
  }

  escanear(contenido: Buffer): Promise<ResultadoEscaneo> {
    return new Promise((resolver, rechazar) => {
      const socket = new Socket();
      const trozos: Buffer[] = [];
      socket.setTimeout(this.timeoutMs, () => {
        socket.destroy();
        rechazar(new Error('ClamAV no respondió a tiempo'));
      });
      socket.on('error', rechazar);
      socket.on('data', (d) => trozos.push(d));
      socket.on('end', () => {
        const respuesta = Buffer.concat(trozos).toString('utf8').replace(/\0/g, '').trim();
        // "stream: OK" | "stream: Eicar-Test-Signature FOUND" | "... ERROR"
        if (/\bOK$/.test(respuesta)) return resolver({ limpio: true });
        const hallazgo = /^stream:\s*(.+?)\s+FOUND$/.exec(respuesta);
        if (hallazgo) return resolver({ limpio: false, amenaza: hallazgo[1] });
        rechazar(new Error(`Respuesta inesperada de ClamAV: ${respuesta.slice(0, 80)}`));
      });
      socket.connect(this.puerto, this.host, () => {
        socket.write('zINSTREAM\0');
        const TROZO = 64 * 1024;
        for (let i = 0; i < contenido.length; i += TROZO) {
          const parte = contenido.subarray(i, i + TROZO);
          const largo = Buffer.alloc(4);
          largo.writeUInt32BE(parte.length);
          socket.write(largo);
          socket.write(parte);
        }
        socket.write(Buffer.alloc(4)); // fin del flujo
      });
    });
  }
}

/** Sin servicio de firmas configurado: la verificación no está disponible. */
export class SinVerificadorDeFirmas extends FirmaVerificadorPort {
  disponible() {
    return false;
  }
  async verificar(): Promise<VerificacionFirma> {
    throw new Error('El servicio de verificación de firmas no está configurado');
  }
  async verificarFirmaElectronica(): Promise<VerificacionFirmaElectronica> {
    throw new Error('El servicio de verificación de firmas no está configurado');
  }
}

/** Cliente HTTP del servicio `firmas-ocr` (contrato v1: `POST /v1/verificar`, llave en `X-API-Key`). */
export class FirmasOcrHttp extends FirmaVerificadorPort {
  constructor(
    private readonly url: string,
    private readonly apiKey: string,
    private readonly timeoutMs: number,
  ) {
    super();
  }

  disponible() {
    return true;
  }

  async verificar(
    contenido: Buffer,
    nombre: string,
    mimeType: string,
    p: ParametrosVerificacion,
  ): Promise<VerificacionFirma> {
    const form = new FormData();
    form.append('archivo', new Blob([new Uint8Array(contenido)], { type: mimeType }), nombre);
    if (p.nombreEsperado) form.append('nombre_esperado', p.nombreEsperado);
    if (p.cargoEsperado) form.append('cargo_esperado', p.cargoEsperado);
    const r = await fetch(`${this.url.replace(/\/+$/, '')}/v1/verificar`, {
      method: 'POST',
      headers: { 'X-API-Key': this.apiKey },
      body: form,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!r.ok) {
      const cuerpo = (await r.json().catch(() => null)) as { error?: { codigo?: string } } | null;
      throw new Error(
        `El servicio de firmas respondió ${r.status} ${cuerpo?.error?.codigo ?? ''}`.trim(),
      );
    }
    const j = (await r.json()) as {
      resultado: VerificacionFirma['resultado'];
      confianza: number;
      coincidencias?: { nombre?: { encontrado?: boolean } | null };
      firma_electronica?: { campos_firma_pdf?: number; sello_texto?: boolean };
      observaciones?: string[];
      paginas_analizadas?: number;
      duracion_ms?: number;
    };
    const nombreCoincide = j.coincidencias?.nombre
      ? Boolean(j.coincidencias.nombre.encontrado)
      : null;
    return {
      resultado: j.resultado,
      confianza: j.confianza,
      nombreCoincide,
      firmaElectronica: Boolean(
        j.firma_electronica?.campos_firma_pdf || j.firma_electronica?.sello_texto,
      ),
      observaciones: j.observaciones ?? [],
      paginasAnalizadas: j.paginas_analizadas ?? 0,
      duracionMs: j.duracion_ms ?? 0,
    };
  }

  /** `POST /v1/firma-electronica` (solo PDF): validación de las firmas digitales con pyHanko. */
  async verificarFirmaElectronica(
    contenido: Buffer,
    nombre: string,
  ): Promise<VerificacionFirmaElectronica> {
    const form = new FormData();
    form.append(
      'archivo',
      new Blob([new Uint8Array(contenido)], { type: 'application/pdf' }),
      nombre,
    );
    const r = await fetch(`${this.url.replace(/\/+$/, '')}/v1/firma-electronica`, {
      method: 'POST',
      headers: { 'X-API-Key': this.apiKey },
      body: form,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!r.ok) {
      const cuerpo = (await r.json().catch(() => null)) as { error?: { codigo?: string } } | null;
      throw new Error(
        `El servicio de firmas respondió ${r.status} ${cuerpo?.error?.codigo ?? ''}`.trim(),
      );
    }
    const j = (await r.json()) as {
      estado: VerificacionFirmaElectronica['estado'];
      resumen: string;
      duracion_ms?: number;
      firmas?: Array<{
        campo: string;
        integridad: {
          estado: FirmaDigitalVerificada['integridad'];
          firma_valida: boolean;
          documento_intacto: boolean;
        };
        firmante: { nombre: string | null; identificacion: string | null; correo: string | null };
        emisor: { nombre: string | null; organizacion: string | null };
        fecha_firma: string | null;
        origen_fecha: FirmaDigitalVerificada['origenFecha'];
        vigente_al_firmar: boolean | null;
        cadena: { reconocida: boolean; entidad: string | null };
        firmante_verificado: boolean;
        conclusion: string;
        advertencias?: string[];
      }>;
    };
    return {
      estado: j.estado,
      resumen: j.resumen,
      revocacion: 'no_verificada',
      duracionMs: j.duracion_ms ?? 0,
      firmas: (j.firmas ?? []).map((f) => ({
        campo: f.campo,
        integridad: f.integridad.estado,
        firmaValida: f.integridad.firma_valida,
        documentoIntacto: f.integridad.documento_intacto,
        firmanteNombre: f.firmante.nombre,
        firmanteIdentificacion: f.firmante.identificacion,
        firmanteCorreo: f.firmante.correo,
        emisor: f.emisor.organizacion ?? f.emisor.nombre,
        fechaFirma: f.fecha_firma,
        origenFecha: f.origen_fecha,
        vigenteAlFirmar: f.vigente_al_firmar,
        cadenaReconocida: f.cadena.reconocida,
        entidad: f.cadena.entidad,
        firmanteVerificado: f.firmante_verificado,
        conclusion: f.conclusion,
        advertencias: f.advertencias ?? [],
      })),
    };
  }
}
