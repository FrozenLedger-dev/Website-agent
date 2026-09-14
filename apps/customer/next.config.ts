import type { NextConfig } from 'next';

/**
 * The customer-facing app: its own origin, its own authentication, and none of
 * the operator console's. It serves only customer authentication routes in this
 * slice — no editor, no project data.
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
  transpilePackages: ['@statxai/contracts', '@statxai/state', '@statxai/customer-auth'],
  poweredByHeader: false,
};

export default config;
