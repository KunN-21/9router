export default {
  id: "opencode",
  priority: 40,
  hasFree: true,
  alias: "oc",
  uiAlias: "oc",
  display: {
    name: "OpenCode Free",
    icon: "terminal",
    color: "#E87040",
    textIcon: "OC",
  },
  category: "free",
  noAuth: true,
  transport: {
    baseUrl: "https://opencode.ai",
    // Upstream free-tier gate rejects stream:false with 403 FreeTierError
    // (verified live). Force SSE upstream; chatCore converts back to JSON
    // for non-streaming clients via the existing forced-SSE path.
    forceStream: true,
    headers: {
      "x-opencode-client": "desktop",
    },
    noAuth: true,
    retry: { 500: { attempts: 2, delayMs: 1000 } },
    quirks: {
      forceAutoToolChoiceModels: ["muse-spark-1.3-contributor-free"],
    },
  },
  models: [
    // Only Muse Spark is served by /zen/v1/responses; Ox Alpha stays on Chat.
    { id: "muse-spark-1.2-contributor-free", name: "Muse Spark 1.2 Contributor Free", targetFormat: "openai-responses", supportedFormats: ["openai-responses"] },
    { id: "muse-spark-1.3-contributor-free", name: "Muse Spark 1.3 Contributor Free", targetFormat: "openai-responses", supportedFormats: ["openai-responses"] },
    { id: "x-preview-f-free", name: "Ox Alpha Free", targetFormat: "openai", supportedFormats: ["openai"] },
  ],
  modelsFetcher: { url: "https://opencode.ai/zen/v1/models", type: "opencode-free" },
  passthroughModels: true,
  // Responses-only endpoint for the free Muse Spark model. Auth is owned by
  // OpenCodeExecutor.buildHeaders (Bearer public + opencode UA), so no auth
  // descriptor is needed here.
  transports: [
    { format: "openai-responses", baseUrl: "https://opencode.ai/zen/v1/responses" },
  ],
};
