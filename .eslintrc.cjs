module.exports = {
  root: true,
  env: {
    node: true,
    commonjs: true,
    es2022: true,
    jest: true,
  },
  extends: ['eslint:recommended'],
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'script',
  },
  ignorePatterns: [
    'node_modules/**',
    'coverage/**',
    'public/**',
    'scripts/debug/**',
    'docs/**',
  ],
  rules: {
    // Cho phép console.log trong server code (logger đã có sẵn nhưng nhiều chỗ còn console)
    'no-console': 'off',
    'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'no-var': 'error',
    'prefer-const': 'warn',
    eqeqeq: ['error', 'smart'],
    'no-undef': 'off', // Node global không có sẵn trong eslint:recommended
  },
  overrides: [
    {
      files: ['src/**/*.js', 'routes/**/*.js', 'middleware/**/*.js', 'database/**/*.js'],
      rules: {
        'no-console': 'warn',
      },
    },
  ],
};
