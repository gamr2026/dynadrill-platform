const nxPreset = require('@nx/jest/preset').default;

module.exports = {
  ...nxPreset,
  // Los decoradores de class-validator/class-transformer/Nest necesitan Reflect.getMetadata.
  setupFiles: [...(nxPreset.setupFiles ?? []), 'reflect-metadata'],
};
