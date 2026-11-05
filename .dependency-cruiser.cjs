/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "decisions-no-mastra",
      severity: "error",
      from: { path: "^src/decisions/" },
      to: { path: ["^src/mastra/", "^@mastra/"] },
    },
    {
      name: "mastra-only-in-mastra-and-workflow",
      severity: "error",
      from: { pathNot: ["^src/mastra/", "^src/workflow/"] },
      to: { path: "^@mastra/" },
    },
    {
      name: "seam-modules-no-mastra",
      severity: "error",
      from: { path: ["^src/runner\\.ts$", "^src/session\\.ts$", "^src/gates\\.ts$"] },
      to: { path: "^@mastra/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
    },
  },
};
