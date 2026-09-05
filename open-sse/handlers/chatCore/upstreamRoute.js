import { getTargetFormat, resolveTransport } from "../../services/provider.js";
import { getModelSupportedFormats, getModelTargetFormat } from "../../config/providerModels.js";

// Resolve the wire format of the outbound body and the transport that carries it.
// Preserve local precedence: a supported source transport is the lossless passthrough;
// the model target only supplies the fallback endpoint when that transport is absent.
export function resolveUpstreamRoute({ provider, alias, model, sourceFormat, credentials }) {
  const modelTargetFormat = getModelTargetFormat(alias, model);
  const modelSupportedFormats = getModelSupportedFormats(alias, model);
  const runtimeTransport = resolveTransport(provider, sourceFormat);
  const sourceTransport = (!modelSupportedFormats || modelSupportedFormats.includes(sourceFormat)) ? runtimeTransport : null;
  const transport = sourceTransport || (modelTargetFormat ? resolveTransport(provider, modelTargetFormat) : null);
  const targetFormat = transport?.format || modelTargetFormat || getTargetFormat(provider, credentials);
  return { targetFormat, transport };
}
