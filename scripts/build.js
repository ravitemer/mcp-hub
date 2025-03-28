import { build } from 'esbuild';
import { readFileSync } from 'fs';

async function buildApp() {
    try {
        // Read version from package.json
        const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
        const version = pkg.version;

        const result = await build({
            entryPoints: ['src/utils/cli.js'],
            bundle: true,
            platform: 'node',
            target: 'node18',
            format: 'esm',
            outfile: 'dist/cli.js',
            banner: {
                js: `
                import { createRequire } from 'module';
                const require = createRequire(import.meta.url);
                globalThis.require = require;
                `
            },
            external: [
                // Keep dependencies external since they're specified in package.json
                '@modelcontextprotocol/sdk',
                'express',
                'yargs',
            ],
            define: {
                'process.env.NODE_ENV': '"production"',
                'VERSION': `"${version}"` // Inject version from package.json
            },
            minify: true,
            sourcemap: false,
        });

        console.log('Build complete!', result);
    } catch (err) {
        console.error('Build failed:', err);
        process.exit(1);
    }
}

buildApp();
