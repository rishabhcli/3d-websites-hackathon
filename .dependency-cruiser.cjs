module.exports = {
  forbidden: [
    {
      name: 'no-circular-dependencies',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'domain-does-not-import-ui',
      severity: 'error',
      from: { path: '^src/(camera|quality|scenes|sculpture|solver)/' },
      to: {
        path: '^(src/(accessibility|gallery)/|(?:react|react-dom)(?:/|$)|@react-three/fiber(?:/|$))',
      },
    },
    {
      name: 'production-does-not-import-tests',
      severity: 'error',
      from: { path: '^src/', pathNot: '\\.(test|spec)\\.' },
      to: { path: '^(tests/|.*\\.(test|spec)\\.)' },
    },
    {
      name: 'no-unresolved-imports',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'browser', 'default'],
    },
    tsConfig: { fileName: 'tsconfig.app.json' },
  },
};
