import { createNoopMeter, diag, metrics, ProxyTracerProvider, trace } from "@opentelemetry/api";

let installed: ReturnType<typeof trace.getTracerProvider> | undefined;
const meter = { getMeter: () => createNoopMeter() };
export function isolatedTelemetry(): void {
  if (process.env.NODE_OPTIONS || process.execArgv.some((value) => value === "-r" || /^--(require|import|loader|experimental-loader)(=|$)/.test(value)) ||
    Object.keys(process.env).some((key) => key.startsWith("OTEL_"))) throw new Error("contract_unverified");
  diag.disable();
  if (installed) {
    if (trace.getTracerProvider() !== installed || metrics.getMeterProvider() !== meter) throw new Error("contract_unverified");
    return;
  }
  if (!trace.setGlobalTracerProvider(new ProxyTracerProvider()) || !metrics.setGlobalMeterProvider(meter)) throw new Error("contract_unverified");
  installed = trace.getTracerProvider();
}

export const dropLogger = { debug() {}, info() {}, warn() {}, error() {}, trace() {}, log() {}, child() { return this; } };
