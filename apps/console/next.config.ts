import type { NextConfig } from 'next';

const config: NextConfig = {
  // The workspace packages are consumed as TypeScript source and use NodeNext
  // import specifiers ("./defects.js" resolving to defects.ts). Node and tsx
  // handle that natively; webpack does not, so teach it the same mapping.
  webpack: (webpackConfig) => {
    webpackConfig.resolve.extensionAlias = {
      ...webpackConfig.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    };
    return webpackConfig;
  },

  turbopack: {
    resolveExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.json'],
  },

  // The driver holds native handles and must not be bundled.
  serverExternalPackages: ['mongodb'],

  transpilePackages: [
    '@statxai/contracts',
    '@statxai/state',
    '@statxai/workspace',
    '@statxai/agents',
    '@statxai/gates',
    '@statxai/job-engine',
    '@statxai/orchestrator',
  ],
};

export default config;
