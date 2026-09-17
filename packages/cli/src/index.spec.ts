import { describe, expect, it, vi } from 'vitest';

vi.mock('@immich/sdk');
vi.mock('src/commands/asset');

/**
 * `src/index.ts` parses `process.argv` as a side effect of being imported, so each case stubs
 * argv and re-imports the module. Commander refuses conflicting options during parsing, so no
 * command action ever runs for those cases.
 */
const parseArgs = async (args: string[]) => {
  const stderr: string[] = [];
  const originalArgv = process.argv;

  process.argv = ['node', 'immich', ...args];
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(chunk.toString());
    return true;
  });

  vi.resetModules();
  try {
    await import('src/index');
    return { stderr: stderr.join(''), exited: false };
  } catch {
    return { stderr: stderr.join(''), exited: true };
  } finally {
    process.argv = originalArgv;
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  }
};

describe('upload command arguments', () => {
  it('refuses --no-upload together with --delete', async () => {
    const { stderr, exited } = await parseArgs(['upload', '--no-upload', '--delete', '/tmp']);

    expect(exited).toBe(true);
    expect(stderr).toContain("option '--no-upload' cannot be used with option '--delete'");
  });

  it('refuses --no-upload together with --skip-hash', async () => {
    const { stderr, exited } = await parseArgs(['upload', '--no-upload', '--skip-hash', '/tmp']);

    expect(exited).toBe(true);
    expect(stderr).toContain("option '--no-upload' cannot be used with option '--skip-hash'");
  });

  it('accepts --no-upload together with --delete-duplicates', async () => {
    const { stderr } = await parseArgs(['upload', '--no-upload', '--delete-duplicates', '/tmp']);

    expect(stderr).not.toContain('cannot be used with');
  });

  it('accepts --no-upload together with --dry-run', async () => {
    const { stderr } = await parseArgs(['upload', '--no-upload', '--dry-run', '/tmp']);

    expect(stderr).not.toContain('cannot be used with');
  });
});
