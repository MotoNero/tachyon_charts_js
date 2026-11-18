// Import rules between the packages. The direction is: element -> core -> rendering interface <- renderers.
// Paths are matched with "(?:^|/)" in front, so that the rules also hold for the fixtures of the architecture test.
const pkg = '(?:^|/)packages/';

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment: 'Packages and modules must not depend on each other in a circle.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'core-stands-alone',
      comment: 'Core knows no DOM, no WebGPU, no framework and no other package of its own.',
      severity: 'error',
      from: { path: `${pkg}core/` },
      to: { path: `${pkg}(?!core/)` },
    },
    {
      name: 'renderers-only-use-core',
      comment: 'A renderer implements the rendering interface of core and knows nothing else of its own.',
      severity: 'error',
      from: { path: `${pkg}(render-[^/]+)/` },
      to: { path: pkg, pathNot: [`${pkg}core/`, `${pkg}$1/`] },
    },
    {
      name: 'nothing-uses-configurator',
      comment: 'The configurator is an application at the top; no package may depend on it.',
      severity: 'error',
      from: { path: `${pkg}(?!configurator/)` },
      to: { path: `${pkg}configurator/` },
    },
    {
      name: 'packages-not-into-tests-or-examples',
      comment: 'Packages must not import tests or examples.',
      severity: 'error',
      from: { path: pkg },
      to: { path: '(?:^|/)(tests|examples)/', pathNot: '(?:^|/)tests/architecture/fixtures/' },
    },
    {
      name: 'no-unresolvable',
      comment: 'Every import must resolve.',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|node_modules)/' },
    tsPreCompilationDeps: true,
    // Package names resolve to the sources, so that imports between packages are checked before anything is built.
    tsConfig: { fileName: 'tsconfig.depcruise.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'types', 'default'],
      extensions: ['.ts', '.js'],
    },
  },
};
