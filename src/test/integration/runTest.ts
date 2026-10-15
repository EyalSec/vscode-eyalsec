// Starts a real VS Code with this extension and the fixture workspace, and runs
// ./suite inside it. Needs a display: on Linux CI, run it under xvfb-run.
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const root = path.resolve(__dirname, '../../../');
  try {
    await runTests({
      version: process.env.VSCODE_TEST_VERSION || 'stable',
      extensionDevelopmentPath: root,
      extensionTestsPath: path.resolve(__dirname, './suite'),
      launchArgs: [path.join(root, 'test-fixtures', 'workspace'), '--disable-extensions', '--disable-workspace-trust'],
    });
  } catch (err) {
    console.error('Integration tests failed:', err);
    process.exit(1);
  }
}

void main();
