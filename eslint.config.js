import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/target/**',
      'apps/desktop/src-tauri/gen/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['apps/desktop/src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ['apps/desktop/scripts/**/*.ts', '*.config.{js,ts}', '**/*.config.{js,ts}'],
    languageOptions: { globals: globals.node },
  },
  {
    // 领域核心必须是纯函数：不碰 IO、不读系统时钟、不依赖界面或宿主。
    files: ['packages/core/src/**/*.ts'],
    ignores: ['packages/core/src/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*', 'fs', 'fs/*', 'path', 'os', 'child_process'], message: '领域核心不能做 IO。' },
            { group: ['@tauri-apps/*', 'sql.js', 'drizzle-orm', 'drizzle-orm/*'], message: '领域核心不能依赖宿主或数据库。' },
            { group: ['react', 'react-dom', 'react/*', '@z-todo/desktop', '@z-todo/desktop/*'], message: '领域核心不能依赖界面层。' },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: '领域核心不能发网络请求。' },
        { name: 'window', message: '领域核心不能访问浏览器环境。' },
        { name: 'document', message: '领域核心不能访问浏览器环境。' },
        { name: 'localStorage', message: '领域核心不能读写存储。' },
        { name: 'setTimeout', message: '领域核心不能依赖计时器。' },
        { name: 'setInterval', message: '领域核心不能依赖计时器。' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Date', property: 'now', message: '「现在」由调用方以参数传入。' },
        { object: 'Math', property: 'random', message: '领域核心必须是确定性的。' },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: '「现在」由调用方以参数传入。' },
      ],
    },
  },
);
