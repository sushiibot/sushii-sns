import { context, metrics, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { detectResources, envDetector, resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

// OTel is opt-in — activate by setting OTEL_EXPORTER_OTLP_ENDPOINT.
// All configuration uses standard OTel env vars:
//   OTEL_EXPORTER_OTLP_ENDPOINT     HTTP collector base URL (default: http://localhost:4318)
//   OTEL_EXPORTER_OTLP_HEADERS      auth headers (key=value,key2=value2)
//   OTEL_SERVICE_NAME               service name
//   OTEL_RESOURCE_ATTRIBUTES        e.g. deployment.environment=production
//   OTEL_TRACES_SAMPLER / _ARG      sampling (default: parentbased_always_on)
//   GIT_HASH                        mapped to service.version
//   OTEL_METRIC_EXPORT_INTERVAL     metric flush interval in ms (default 60000)

export interface OtelSDK {
  shutdown: () => Promise<void>;
}

export function setupOtel(): OtelSDK {
  const resource = detectResources({ detectors: [envDetector] }).merge(
    resourceFromAttributes({
      [ATTR_SERVICE_VERSION]: process.env.GIT_HASH ?? "unknown",
    }),
  );

  // BasicTracerProvider + HTTP exporter works correctly in Bun.
  // NodeSDK / NodeTracerProvider rely on async_hooks and import-in-the-middle
  // which silently produce NonRecordingSpan no-ops in Bun.
  const tracerProvider = new BasicTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
  });
  trace.setGlobalTracerProvider(tracerProvider);

  // AsyncLocalStorage is supported by Bun — required for correct parent-child
  // span relationships across async boundaries.
  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  context.setGlobalContextManager(contextManager);

  // UndiciInstrumentation uses diagnostics_channel (no module patching) so it
  // works in Bun. Captures HTTP calls made by discord.js.
  // Note: Bun's native fetch() is not undici and is not captured here.
  registerInstrumentations({
    instrumentations: [new UndiciInstrumentation()],
  });

  const parsed = parseInt(process.env.OTEL_METRIC_EXPORT_INTERVAL ?? "", 10);
  const exportIntervalMillis = Number.isNaN(parsed) ? 60_000 : parsed;

  const meterProvider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
        exportIntervalMillis,
      }),
    ],
  });
  metrics.setGlobalMeterProvider(meterProvider);

  return {
    shutdown: () => Promise.all([tracerProvider.shutdown(), meterProvider.shutdown()]).then(() => {}),
  };
}

// Initialise only when OTEL_EXPORTER_OTLP_ENDPOINT is set.
let otelSDK: OtelSDK | null = null;
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  otelSDK = setupOtel();
}

export { otelSDK };
export const tracer = trace.getTracer("sushii-sns");
