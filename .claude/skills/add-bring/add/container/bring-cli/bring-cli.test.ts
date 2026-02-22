import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const TOKEN_PATH = '/tmp/bring-token.json';
const BASE_URL = 'https://api.getbring.com/rest/';
const API_KEY = 'cof4Nc6D8saplXjE3h3HXqHH8m7VU2i1Gs0g85Sp';

// Helper to build the CLI path
const CLI_PATH = path.resolve(__dirname, 'dist', 'bring-cli.js');

// We test by importing the module's internal functions.
// First, mock fetch and fs at the module level.
const mockFetch = vi.fn() as Mock;

// Save/restore originals
let originalFetch: typeof globalThis.fetch;

// Helper to create a mock Response
const mockResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: () => Promise.resolve(body),
  text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
});

// We'll test the CLI by importing its run function
// The CLI exports a `run` function for testability
let run: (args: string[]) => Promise<void>;
let mockWriteFileSync: Mock;
let mockReadFileSync: Mock;
let mockExistsSync: Mock;

describe('bring-cli', () => {
  let stdout: string;
  let stderr: string;
  let exitCode: number | undefined;

  beforeEach(async () => {
    stdout = '';
    stderr = '';
    exitCode = undefined;

    // Mock console.log/error to capture output
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      stdout += args.join(' ') + '\n';
    });
    vi.spyOn(console, 'error').mockImplementation((...args) => {
      stderr += args.join(' ') + '\n';
    });

    // Mock process.exit
    vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null | undefined) => {
      exitCode = typeof code === 'number' ? code : code ? parseInt(String(code), 10) : 0;
      throw new Error(`process.exit(${code})`);
    });

    // Mock fetch
    originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;

    // Reset mocks
    mockFetch.mockReset();

    // Reset module to get fresh state
    vi.resetModules();

    // Mock fs for token caching
    vi.doMock('fs', () => ({
      default: {
        existsSync: (mockExistsSync = vi.fn(() => false)),
        readFileSync: (mockReadFileSync = vi.fn(() => '{}')),
        writeFileSync: (mockWriteFileSync = vi.fn()),
        mkdirSync: vi.fn(),
      },
    }));

    // Set credentials in env
    process.env.BRING_EMAIL = 'test@example.com';
    process.env.BRING_PASSWORD = 'testpass';

    const mod = await import('./bring-cli.js');
    run = mod.run;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    delete process.env.BRING_EMAIL;
    delete process.env.BRING_PASSWORD;
  });

  describe('credentials', () => {
    it('exits with error when BRING_EMAIL is missing', async () => {
      delete process.env.BRING_EMAIL;
      // Re-import to pick up missing env
      vi.resetModules();
      const mod = await import('./bring-cli.js');

      await expect(mod.run(['lists'])).rejects.toThrow('process.exit');
      expect(exitCode).toBe(1);
      expect(stderr).toContain('BRING_EMAIL');
    });

    it('exits with error when BRING_PASSWORD is missing', async () => {
      delete process.env.BRING_PASSWORD;
      vi.resetModules();
      const mod = await import('./bring-cli.js');

      await expect(mod.run(['lists'])).rejects.toThrow('process.exit');
      expect(exitCode).toBe(1);
      expect(stderr).toContain('BRING_PASSWORD');
    });
  });

  describe('authentication', () => {
    it('authenticates via POST to v2/bringauth', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        access_token: 'tok123',
        refresh_token: 'ref456',
        uuid: 'user-uuid-1',
        expires_in: 3600,
      }));

      // lists endpoint
      mockFetch.mockResolvedValueOnce(mockResponse({
        lists: [{ listUuid: 'list-1', name: 'Groceries' }],
      }));

      await run(['lists']);

      expect(mockFetch).toHaveBeenCalledWith(
        `${BASE_URL}v2/bringauth`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'X-BRING-API-KEY': API_KEY,
          }),
        }),
      );

      // Verify the auth body contains email and password
      const authCall = mockFetch.mock.calls[0];
      const body = authCall[1].body;
      expect(body).toContain('test%40example.com');
      expect(body).toContain('testpass');
    });

    it('caches token to /tmp/bring-token.json', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        access_token: 'tok123',
        refresh_token: 'ref456',
        uuid: 'user-uuid-1',
        expires_in: 3600,
      }));

      mockFetch.mockResolvedValueOnce(mockResponse({
        lists: [{ listUuid: 'list-1', name: 'Groceries' }],
      }));

      await run(['lists']);

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        TOKEN_PATH,
        expect.stringContaining('tok123'),
      );
    });

    it('reuses cached token when not expired', async () => {
      const cachedToken = JSON.stringify({
        access_token: 'cached-tok',
        refresh_token: 'cached-ref',
        uuid: 'user-uuid-1',
        expires_at: Date.now() + 3600_000,
      });

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(cachedToken);

      // Re-import to pick up mocked fs
      vi.resetModules();
      const mod = await import('./bring-cli.js');

      mockFetch.mockResolvedValueOnce(mockResponse({
        lists: [{ listUuid: 'list-1', name: 'Groceries' }],
      }));

      await mod.run(['lists']);

      // Should only call fetch once (for lists), not for auth
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0][0]).toContain('lists');
    });

    it('refreshes expired token via POST to v2/bringauth/token', async () => {
      const cachedToken = JSON.stringify({
        access_token: 'expired-tok',
        refresh_token: 'valid-ref',
        uuid: 'user-uuid-1',
        expires_at: Date.now() - 1000, // expired
      });

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(cachedToken);

      vi.resetModules();
      const mod = await import('./bring-cli.js');

      // Refresh response
      mockFetch.mockResolvedValueOnce(mockResponse({
        access_token: 'new-tok',
        refresh_token: 'new-ref',
        expires_in: 3600,
      }));

      // Lists response
      mockFetch.mockResolvedValueOnce(mockResponse({
        lists: [{ listUuid: 'list-1', name: 'Groceries' }],
      }));

      await mod.run(['lists']);

      expect(mockFetch).toHaveBeenCalledWith(
        `${BASE_URL}v2/bringauth/token`,
        expect.objectContaining({
          method: 'POST',
        }),
      );
    });
  });

  describe('lists command', () => {
    beforeEach(() => {
      // Auth response
      mockFetch.mockResolvedValueOnce(mockResponse({
        access_token: 'tok123',
        refresh_token: 'ref456',
        uuid: 'user-uuid-1',
        expires_in: 3600,
      }));
    });

    it('fetches and displays lists', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        lists: [
          { listUuid: 'list-1', name: 'Groceries' },
          { listUuid: 'list-2', name: 'Hardware Store' },
        ],
      }));

      await run(['lists']);

      expect(mockFetch).toHaveBeenCalledWith(
        `${BASE_URL}bringusers/user-uuid-1/lists`,
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer tok123',
          }),
        }),
      );

      expect(stdout).toContain('Groceries');
      expect(stdout).toContain('Hardware Store');
    });
  });

  describe('items command', () => {
    beforeEach(() => {
      // Auth
      mockFetch.mockResolvedValueOnce(mockResponse({
        access_token: 'tok123',
        refresh_token: 'ref456',
        uuid: 'user-uuid-1',
        expires_in: 3600,
      }));
      // Lists (for name resolution)
      mockFetch.mockResolvedValueOnce(mockResponse({
        lists: [
          { listUuid: 'list-1', name: 'Groceries' },
          { listUuid: 'list-2', name: 'Hardware Store' },
        ],
      }));
    });

    it('fetches and displays items for a list', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        uuid: 'list-1',
        purchase: [
          { name: 'Milk', specification: '2 liters' },
          { name: 'Bread', specification: '' },
          { name: 'Eggs', specification: '12 pack' },
        ],
        recently: [
          { name: 'Butter', specification: '' },
        ],
      }));

      await run(['items', 'Groceries']);

      expect(mockFetch).toHaveBeenCalledWith(
        `${BASE_URL}v2/bringlists/list-1`,
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer tok123',
          }),
        }),
      );

      expect(stdout).toContain('Milk');
      expect(stdout).toContain('2 liters');
      expect(stdout).toContain('Bread');
      expect(stdout).toContain('Eggs');
      expect(stdout).toContain('Butter');
    });
  });

  describe('add command', () => {
    beforeEach(() => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        access_token: 'tok123',
        refresh_token: 'ref456',
        uuid: 'user-uuid-1',
        expires_in: 3600,
      }));
      mockFetch.mockResolvedValueOnce(mockResponse({
        lists: [{ listUuid: 'list-1', name: 'Groceries' }],
      }));
    });

    it('adds item via PUT with TO_PURCHASE', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse('', 200));

      await run(['add', 'Groceries', 'Milk', '2 liters']);

      const putCall = mockFetch.mock.calls[2];
      expect(putCall[0]).toBe(`${BASE_URL}v2/bringlists/list-1/items`);
      expect(putCall[1].method).toBe('PUT');

      const body = putCall[1].body;
      expect(body).toContain('Milk');
      expect(body).toContain('2 liters');
      expect(body).toContain('TO_PURCHASE');
    });
  });

  describe('remove command', () => {
    beforeEach(() => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        access_token: 'tok123',
        refresh_token: 'ref456',
        uuid: 'user-uuid-1',
        expires_in: 3600,
      }));
      mockFetch.mockResolvedValueOnce(mockResponse({
        lists: [{ listUuid: 'list-1', name: 'Groceries' }],
      }));
    });

    it('removes item via PUT with REMOVE', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse('', 200));

      await run(['remove', 'Groceries', 'Milk']);

      const putCall = mockFetch.mock.calls[2];
      expect(putCall[0]).toBe(`${BASE_URL}v2/bringlists/list-1/items`);
      expect(putCall[1].method).toBe('PUT');
      expect(putCall[1].body).toContain('REMOVE');
      expect(putCall[1].body).toContain('Milk');
    });
  });

  describe('complete command', () => {
    beforeEach(() => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        access_token: 'tok123',
        refresh_token: 'ref456',
        uuid: 'user-uuid-1',
        expires_in: 3600,
      }));
      mockFetch.mockResolvedValueOnce(mockResponse({
        lists: [{ listUuid: 'list-1', name: 'Groceries' }],
      }));
    });

    it('completes item via PUT with TO_RECENTLY', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse('', 200));

      await run(['complete', 'Groceries', 'Milk']);

      const putCall = mockFetch.mock.calls[2];
      expect(putCall[0]).toBe(`${BASE_URL}v2/bringlists/list-1/items`);
      expect(putCall[1].method).toBe('PUT');
      expect(putCall[1].body).toContain('TO_RECENTLY');
      expect(putCall[1].body).toContain('Milk');
    });
  });

  describe('notify command', () => {
    beforeEach(() => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        access_token: 'tok123',
        refresh_token: 'ref456',
        uuid: 'user-uuid-1',
        expires_in: 3600,
      }));
      mockFetch.mockResolvedValueOnce(mockResponse({
        lists: [{ listUuid: 'list-1', name: 'Groceries' }],
      }));
    });

    it('sends notification via POST', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse('', 200));

      await run(['notify', 'Groceries', 'GOING_SHOPPING']);

      const notifyCall = mockFetch.mock.calls[2];
      expect(notifyCall[0]).toBe(`${BASE_URL}v2/bringnotifications/lists/list-1`);
      expect(notifyCall[1].method).toBe('POST');
      expect(notifyCall[1].body).toContain('GOING_SHOPPING');
    });
  });

  describe('list name resolution', () => {
    beforeEach(() => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        access_token: 'tok123',
        refresh_token: 'ref456',
        uuid: 'user-uuid-1',
        expires_in: 3600,
      }));
    });

    it('matches list names case-insensitively', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        lists: [{ listUuid: 'list-1', name: 'Groceries' }],
      }));
      mockFetch.mockResolvedValueOnce(mockResponse({
        uuid: 'list-1',
        purchase: [],
        recently: [],
      }));

      await run(['items', 'groceries']);

      expect(mockFetch).toHaveBeenCalledWith(
        `${BASE_URL}v2/bringlists/list-1`,
        expect.anything(),
      );
    });

    it('matches partial list names', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        lists: [{ listUuid: 'list-1', name: 'Groceries' }],
      }));
      mockFetch.mockResolvedValueOnce(mockResponse({
        uuid: 'list-1',
        purchase: [],
        recently: [],
      }));

      await run(['items', 'groc']);

      expect(mockFetch).toHaveBeenCalledWith(
        `${BASE_URL}v2/bringlists/list-1`,
        expect.anything(),
      );
    });

    it('errors on ambiguous list name match', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        lists: [
          { listUuid: 'list-1', name: 'Groceries' },
          { listUuid: 'list-2', name: 'Grocery Extras' },
        ],
      }));

      await expect(run(['items', 'Grocer'])).rejects.toThrow('process.exit');
      expect(exitCode).toBe(1);
      expect(stderr).toContain('Ambiguous');
    });

    it('errors when no list matches', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        lists: [{ listUuid: 'list-1', name: 'Groceries' }],
      }));

      await expect(run(['items', 'Hardware'])).rejects.toThrow('process.exit');
      expect(exitCode).toBe(1);
      expect(stderr).toContain('No list');
    });
  });

  describe('401 retry', () => {
    it('clears token cache and re-authenticates on 401', async () => {
      // Initial auth
      mockFetch.mockResolvedValueOnce(mockResponse({
        access_token: 'tok123',
        refresh_token: 'ref456',
        uuid: 'user-uuid-1',
        expires_in: 3600,
      }));

      // First request returns 401
      mockFetch.mockResolvedValueOnce(mockResponse({ message: 'Unauthorized' }, 401));

      // Re-auth
      mockFetch.mockResolvedValueOnce(mockResponse({
        access_token: 'tok-new',
        refresh_token: 'ref-new',
        uuid: 'user-uuid-1',
        expires_in: 3600,
      }));

      // Retry request succeeds
      mockFetch.mockResolvedValueOnce(mockResponse({
        lists: [{ listUuid: 'list-1', name: 'Groceries' }],
      }));

      await run(['lists']);

      // Should have 4 fetch calls: auth, 401 response, re-auth, retry
      expect(mockFetch).toHaveBeenCalledTimes(4);
      expect(stdout).toContain('Groceries');
    });
  });

  describe('help command', () => {
    it('shows usage information', async () => {
      await run(['help']);

      expect(stdout).toContain('bring-cli');
      expect(stdout).toContain('lists');
      expect(stdout).toContain('items');
      expect(stdout).toContain('add');
      expect(stdout).toContain('remove');
      expect(stdout).toContain('complete');
      expect(stdout).toContain('notify');
    });
  });

  describe('unknown command', () => {
    it('shows error for unknown command', async () => {
      await expect(run(['unknown'])).rejects.toThrow('process.exit');
      expect(exitCode).toBe(1);
      expect(stderr).toContain('Unknown command');
    });
  });
});
