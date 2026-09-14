import type { NextConfig } from 'next';

/**
 * The customer-facing app: its own origin, its own authentication, and none of
 * the operator console's. It serves customer authentication, the projects a
 * customer may see, and the draft editor. It never runs a build: semantic edits
 * are submitted durably and continued by the standalone semantic-edit worker.
 */
const config: NextConfig = {
  // Workspace packages are TypeScript source with NodeNext ".js" specifiers.
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
  serverExternalPackages: ['mongodb'],
  transpilePackages: [
    '@statxai/contracts',
    '@statxai/state',
    '@statxai/customer-auth',
    '@statxai/customer-editor',
    '@statxai/workspace',
    '@statxai/agents',
    '@statxai/gates',
    '@statxai/job-engine',
    '@statxai/policy-engine',
    '@statxai/orchestrator',
  ],
  poweredByHeader: false,
};

export default config;
