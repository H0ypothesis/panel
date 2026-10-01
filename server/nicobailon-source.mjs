/** Pinned 0.73.1 integration: project artifacts follow a child's actual cwd. */
export function adaptNicobailonSource(path, source) {
  if (
    !path
      .replaceAll("\\", "/")
      .endsWith("pi-subagents/src/runs/shared/single-output.js") ||
    source.includes("panelProjectArtifactBase")
  )
    return source;
  const signature =
    "export function resolveSingleOutputPath(output, runtimeCwd, requestedCwd, relativeBaseDir) {";
  if (!source.includes(signature))
    throw new Error("Unsupported pi-subagents output-path contract");
  return source.replace(
    signature,
    `${signature}
    // panelProjectArtifactBase: only relocate the managed native namespace.
    if (requestedCwd && runtimeCwd) {
        const childCwd = path.resolve(runtimeCwd, requestedCwd);
        const projectArtifacts = path.resolve(runtimeCwd, ".pi/subagents");
        const relocate = (value) => {
            if (!value || typeof value !== "string") return value;
            const rel = path.relative(projectArtifacts, path.resolve(runtimeCwd, value));
            return rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel)
                ? path.resolve(childCwd, ".pi/subagents", rel) : value;
        };
        if (typeof output === "string" && path.isAbsolute(output)) output = relocate(output);
        relativeBaseDir = relocate(relativeBaseDir);
    }
`,
  );
}
