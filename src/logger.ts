import { trace } from "@opentelemetry/api";
import pino from "pino";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  mixin() {
    const span = trace.getActiveSpan();
    if (!span) return {};

    const { traceId, spanId, traceFlags } = span.spanContext();
    if (!traceId) return {};

    return { trace_id: traceId, span_id: spanId, trace_flags: traceFlags };
  },
});

export default logger;
