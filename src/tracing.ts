import { trace } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-grpc";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";

// OTel is opt-in — activate by setting OTEL_EXPORTER_OTLP_ENDPOINT.
// All configuration uses standard OTel env vars:
//   OTEL_EXPORTER_OTLP_ENDPOINT          gRPC collector base URL (e.g. http://localhost:4317)
//   OTEL_EXPORTER_OTLP_TRACES_ENDPOINT   override for traces only
//   OTEL_EXPORTER_OTLP_METRICS_ENDPOINT  override for metrics only
//   OTEL_SERVICE_NAME                    defaults to "sushii-sns"
//   OTEL_RESOURCE_ATTRIBUTES             extra k=v resource labels
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? "sushii-sns",
    traceExporter: new OTLPTraceExporter(),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
    }),
  });

  sdk.start();
  process.on("SIGTERM", () => void sdk.shutdown());
}

export const tracer = trace.getTracer("sushii-sns");
