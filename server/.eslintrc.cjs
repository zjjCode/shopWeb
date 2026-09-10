module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    // src 走主 tsconfig（rootDir=src，供 build 使用）；prisma 下的 seed 脚本不在 build 产物内，
    // 单独用 tsconfig.seed.json（rootDir="."）覆盖，使 typed-linting 能解析 seed 文件。
    project: ['./tsconfig.json', './tsconfig.seed.json'],
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  rules: {
    // 禁止 any：必要时用 unknown + 类型守卫（项目硬性要求）
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-unsafe-assignment': 'off',
    '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports', fixStyle: 'inline-type-imports' }],
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    eqeqeq: ['error', 'always', { null: 'ignore' }],
    'prefer-const': 'error',
  },
  ignorePatterns: ['dist/', 'node_modules/', '*.js', '*.cjs'],
};
