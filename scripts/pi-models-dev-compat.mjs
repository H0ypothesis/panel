// Pi 46c9de402 reads the old models.dev key "kimi-for-coding". The catalog
// now separates kimi-code-plan-cn (api.kimi.com) and kimi-code-plan-global
// (api.kimi.ai). Pi's existing provider uses api.kimi.com, so alias only CN.
// Keep this preload scoped to setup:pi; remove it when the pinned generator
// handles the renamed catalog. Pi's source and strict validation stay intact.
const fetchCatalog = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const response = await fetchCatalog(input, init);
  const url = input instanceof Request ? input.url : String(input);
  if (url !== "https://models.dev/api.json" || !response.ok) return response;

  const catalog = await response.clone().json();
  if (
    Object.hasOwn(catalog, "kimi-for-coding") ||
    !Object.hasOwn(catalog, "kimi-code-plan-cn")
  ) {
    return response;
  }

  catalog["kimi-for-coding"] = catalog["kimi-code-plan-cn"];
  console.log(
    "[setup:pi] Mapping models.dev kimi-code-plan-cn to Pi's kimi-for-coding catalog.",
  );

  const headers = new Headers(response.headers);
  // The parsed body has been decoded and changed; these headers describe the
  // original wire representation, not the JSON returned below.
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("etag");
  return Response.json(catalog, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
