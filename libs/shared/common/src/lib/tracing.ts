import { context, propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { ExpressInstrumentation, ExpressLayerType } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

let sdk: NodeSDK | undefined;

/**
 * Trazas OpenTelemetry (equivalente local de Application Insights; en Azure solo cambia el endpoint).
 * Debe llamarse en la PRIMERA línea de `main.ts`, antes de importar Nest/Express, para que las
 * instrumentaciones alcancen a envolver `http` y `express`. Propaga `traceparent` entre el gateway
 * y los contenedores. Sin `OTEL_EXPORTER_OTLP_ENDPOINT` no hace nada.
 */
export function initTracing(
  serviceName: string,
  endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'],
): void {
  if (!endpoint || sdk) return;
  sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` }),
    instrumentations: [
      new HttpInstrumentation({
        // no trazar los health checks: son ruido
        ignoreIncomingRequestHook: (req) => req.url?.startsWith('/health') ?? false,
      }),
      // un span por middleware/handler de Express es ruido y costo de ingesta; basta el span HTTP y el de la ruta
      new ExpressInstrumentation({
        ignoreLayersType: [ExpressLayerType.MIDDLEWARE, ExpressLayerType.REQUEST_HANDLER],
      }),
    ],
  });
  sdk.start();
  const shutdown = () => void sdk?.shutdown().catch(() => undefined);
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

/** Vacía las trazas pendientes (útil al terminar un proceso corto o en pruebas). */
export async function shutdownTracing(): Promise<void> {
  await sdk?.shutdown();
  sdk = undefined;
}

/** `traceparent` (W3C) del contexto activo, para ponerlo en el sobre de los eventos. */
export function currentTraceparent(): string | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier['traceparent'];
}

/**
 * Ejecuta `fn` dentro de un span de consumidor enlazado al `traceparent` del evento, de modo que
 * la traza del HTTP que lo originó continúa en quien lo procesa (aunque pasen por RabbitMQ).
 */
export function runInEventSpan<T>(
  name: string,
  traceparent: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const parent = traceparent
    ? propagation.extract(context.active(), { traceparent })
    : context.active();
  return trace
    .getTracer('dyn-messaging')
    .startActiveSpan(name, { kind: SpanKind.CONSUMER }, parent, async (span) => {
      try {
        return await fn();
      } catch (e) {
        span.recordException(e as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw e;
      } finally {
        span.end();
      }
    });
}
