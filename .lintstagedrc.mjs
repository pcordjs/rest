export default {
  '*.{ts,js,json}': () => ['tsc'],
  '*.ts': (files) => [`eslint ${files.join(' ')}`]
};
