const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests/e2e', timeout: 45000, expect: { timeout: 10000 },
  workers: 1, fullyParallel: false, reporter: 'list',
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' }
});
