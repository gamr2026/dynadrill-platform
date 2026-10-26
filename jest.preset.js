const nxPreset = require('@nx/jest/preset').default;

module.exports = {
  ...nxPreset,
  // Los decoradores de class-validator/class-transformer/Nest necesitan Reflect.getMetadata.
  // base-de-pruebas: con RUN_INTEGRATION=1 las pruebas solo corren contra la base *_test.
  setupFiles: [
    ...(nxPreset.setupFiles ?? []),
    'reflect-metadata',
    require.resolve('./tools/jest/base-de-pruebas.cjs'),
  ],
  // Con base real, los archivos en paralelo agotan las conexiones ("Unable to start a transaction in the given time")
  // y unos cuentan los datos de otros: en serie dentro de cada proyecto (y `nx run-many --parallel=1` entre proyectos).
  ...(process.env.RUN_INTEGRATION ? { maxWorkers: 1 } : {}),
};
