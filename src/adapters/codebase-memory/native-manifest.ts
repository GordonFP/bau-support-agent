// Exact complete tool fingerprints for fixed public a7158ac / Codebase Memory 0.12.1.
// The native 13-tool profile is verified, never registered as model tools.
export const nativeManifest = {
  "server": {
    "name": "codebase-memory-mcp",
    "version": "0.12.1"
  },
  "protocolVersion": "2025-11-25",
  "tools": [
    {
      "name": "search_graph",
      "sha256": "03eb2c6e9a5f3a99764f1e354d97d51c356ea99402d0916da25cc11752b27470"
    },
    {
      "name": "query_graph",
      "sha256": "bb1390f3776f35c0167dc9d4fe7b2852f8fa1525039ec2ddbe9ce94de5dcfdf0"
    },
    {
      "name": "trace_path",
      "sha256": "da07826b2f30566d38dd3523b35c157e23889ecbf9f0720524b536ed2bedb1e1"
    },
    {
      "name": "get_code_snippet",
      "sha256": "b51f4bb0bba60cfe99acc0a572193ccc8d851093cbf616cba9b94827600296bd"
    },
    {
      "name": "get_file_outline",
      "sha256": "2d02a35ae466aa35054f16d7f5bcfadbbaee55c8b939f51d6803a560410b94b8"
    },
    {
      "name": "get_graph_schema",
      "sha256": "beba20b32315443e23c8287ee8d51cec793947997f656088cd7a50b77e25ea84"
    },
    {
      "name": "compare_graphs",
      "sha256": "b6993fdf88c78e6151efd589d4c72f5f618c79cd3021444260c72ecad8dcf090"
    },
    {
      "name": "get_architecture",
      "sha256": "912c56c4d18ed57a646caa6013c00e407a2fa8f7818ef59cec3b0c654818a408"
    },
    {
      "name": "search_code",
      "sha256": "d992153d99ee727b849bce861ef42091ae29f1cd3a68c7e6d0cfe8d511085481"
    },
    {
      "name": "list_projects",
      "sha256": "645d7cb732d80ae64a68c79022004cf6741781dd78e13b539bc993f2b94eb03a"
    },
    {
      "name": "index_status",
      "sha256": "d4457ae43a93b9c7c3699bea2c6d819299334e140dd418f1ac4adc39a4ca73e8"
    },
    {
      "name": "check_index_coverage",
      "sha256": "7982dcb73572b8aac058ad104a9f281eb6ec1c27ba9c1a3fc620d953f79bcb41"
    },
    {
      "name": "detect_changes",
      "sha256": "a1c831cf3edde2646297bdff1b36d415c50f1102f7dbb8246e8f3fbf27af6018"
    }
  ]
} as const;
