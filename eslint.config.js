import apifyEslintConfig from '@apify/eslint-config';

export default [
    ...apifyEslintConfig,
    {
        files: ['eslint.config.js'],
        rules: {
            'import-x/no-default-export': 'off',
        },
    },
    {
        ignores: [
            'dist/**',
            'node_modules/**',
            'storage/**',
        ],
    },
];
