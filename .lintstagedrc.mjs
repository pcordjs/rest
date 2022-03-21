export default {
  '*.{ts,js,json}': () => ['tsc', 'jest'],
  '*.ts': (files) => [`eslint ${files.join(' ')}`]
};
