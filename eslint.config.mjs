import nx from '@nx/eslint-plugin';

export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    ignores: ['**/dist', '**/out-tsc'],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: ['^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$'],
          // Fronteras del documento de arquitectura (cap. 6.1): un módulo solo ve
          // a los de su propio contenedor y a las librerías compartidas; entre
          // contenedores la comunicación es por HTTP interno o eventos, nunca por import.
          depConstraints: [
            { sourceTag: 'type:shared', onlyDependOnLibsWithTags: ['type:shared'] },
            { sourceTag: 'scope:gateway', onlyDependOnLibsWithTags: ['type:shared'] },
            {
              sourceTag: 'scope:plataforma',
              onlyDependOnLibsWithTags: ['type:shared', 'scope:plataforma'],
            },
            {
              sourceTag: 'scope:comercial',
              onlyDependOnLibsWithTags: ['type:shared', 'scope:comercial'],
            },
            {
              sourceTag: 'scope:operaciones',
              onlyDependOnLibsWithTags: ['type:shared', 'scope:operaciones'],
            },
            {
              sourceTag: 'scope:qhse',
              onlyDependOnLibsWithTags: ['type:shared', 'scope:qhse'],
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      '**/*.ts',
      '**/*.tsx',
      '**/*.cts',
      '**/*.mts',
      '**/*.js',
      '**/*.jsx',
      '**/*.cjs',
      '**/*.mjs',
    ],
    // Override or add rules here
    rules: {},
  },
];
