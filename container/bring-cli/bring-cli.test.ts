import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockLogin = vi.fn();
const mockLoadLists = vi.fn();
const mockGetItems = vi.fn();
const mockSaveItem = vi.fn();
const mockRemoveItem = vi.fn();
const mockMoveToRecentList = vi.fn();

vi.mock('bring-shopping', () => {
  return {
    default: vi.fn(function () {
      return {
        login: mockLogin,
        loadLists: mockLoadLists,
        getItems: mockGetItems,
        saveItem: mockSaveItem,
        removeItem: mockRemoveItem,
        moveToRecentList: mockMoveToRecentList,
      };
    }),
  };
});

let run: (args: string[]) => Promise<void>;

describe('bring-cli', () => {
  let stdout: string;
  let stderr: string;
  let exitCode: number | undefined;

  beforeEach(async () => {
    stdout = '';
    stderr = '';
    exitCode = undefined;

    vi.spyOn(console, 'log').mockImplementation((...args) => {
      stdout += args.join(' ') + '\n';
    });
    vi.spyOn(console, 'error').mockImplementation((...args) => {
      stderr += args.join(' ') + '\n';
    });

    vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null | undefined) => {
      exitCode = typeof code === 'number' ? code : code ? parseInt(String(code), 10) : 0;
      throw new Error(`process.exit(${code})`);
    });

    mockLogin.mockReset().mockResolvedValue(undefined);
    mockLoadLists.mockReset();
    mockGetItems.mockReset();
    mockSaveItem.mockReset().mockResolvedValue('');
    mockRemoveItem.mockReset().mockResolvedValue('');
    mockMoveToRecentList.mockReset().mockResolvedValue('');

    process.env.BRING_EMAIL = 'test@example.com';
    process.env.BRING_PASSWORD = 'testpass';

    vi.resetModules();
    const mod = await import('./bring-cli.js');
    run = mod.run;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.BRING_EMAIL;
    delete process.env.BRING_PASSWORD;
  });

  describe('credentials', () => {
    it('exits with error when BRING_EMAIL is missing', async () => {
      delete process.env.BRING_EMAIL;
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

  describe('login', () => {
    it('calls bring.login() before executing commands', async () => {
      mockLoadLists.mockResolvedValueOnce({
        lists: [{ listUuid: 'list-1', name: 'Groceries', theme: '' }],
      });

      await run(['lists']);

      expect(mockLogin).toHaveBeenCalledTimes(1);
    });
  });

  describe('lists command', () => {
    it('fetches and displays lists', async () => {
      mockLoadLists.mockResolvedValueOnce({
        lists: [
          { listUuid: 'list-1', name: 'Groceries', theme: '' },
          { listUuid: 'list-2', name: 'Hardware Store', theme: '' },
        ],
      });

      await run(['lists']);

      expect(mockLoadLists).toHaveBeenCalledTimes(1);
      expect(stdout).toContain('Groceries');
      expect(stdout).toContain('Hardware Store');
    });

    it('shows message when no lists exist', async () => {
      mockLoadLists.mockResolvedValueOnce({ lists: [] });

      await run(['lists']);

      expect(stdout).toContain('No shopping lists found.');
    });
  });

  describe('items command', () => {
    beforeEach(() => {
      mockLoadLists.mockResolvedValue({
        lists: [
          { listUuid: 'list-1', name: 'Groceries', theme: '' },
          { listUuid: 'list-2', name: 'Hardware Store', theme: '' },
        ],
      });
    });

    it('fetches and displays items for a list', async () => {
      mockGetItems.mockResolvedValueOnce({
        uuid: 'list-1',
        status: 'REGISTERED',
        purchase: [
          { name: 'Milk', specification: '2 liters' },
          { name: 'Bread', specification: '' },
          { name: 'Eggs', specification: '12 pack' },
        ],
        recently: [
          { name: 'Butter', specification: '' },
        ],
      });

      await run(['items', 'Groceries']);

      expect(mockGetItems).toHaveBeenCalledWith('list-1');
      expect(stdout).toContain('Milk');
      expect(stdout).toContain('2 liters');
      expect(stdout).toContain('Bread');
      expect(stdout).toContain('Eggs');
      expect(stdout).toContain('Butter');
    });

    it('shows message when list is empty', async () => {
      mockGetItems.mockResolvedValueOnce({
        uuid: 'list-1',
        status: 'REGISTERED',
        purchase: [],
        recently: [],
      });

      await run(['items', 'Groceries']);

      expect(stdout).toContain('empty');
    });

    it('exits with error when list name is missing', async () => {
      await expect(run(['items'])).rejects.toThrow('process.exit');
      expect(exitCode).toBe(1);
      expect(stderr).toContain('Usage');
    });
  });

  describe('add command', () => {
    beforeEach(() => {
      mockLoadLists.mockResolvedValue({
        lists: [{ listUuid: 'list-1', name: 'Groceries', theme: '' }],
      });
    });

    it('delegates to bring.saveItem', async () => {
      await run(['add', 'Groceries', 'Milk', '2 liters']);

      expect(mockSaveItem).toHaveBeenCalledWith('list-1', 'Milk', '2 liters');
      expect(stdout).toContain('Added');
      expect(stdout).toContain('Milk');
      expect(stdout).toContain('2 liters');
    });

    it('passes empty specification when none provided', async () => {
      await run(['add', 'Groceries', 'Milk']);

      expect(mockSaveItem).toHaveBeenCalledWith('list-1', 'Milk', '');
    });

    it('exits with error when arguments are missing', async () => {
      await expect(run(['add', 'Groceries'])).rejects.toThrow('process.exit');
      expect(exitCode).toBe(1);
      expect(stderr).toContain('Usage');
    });
  });

  describe('remove command', () => {
    beforeEach(() => {
      mockLoadLists.mockResolvedValue({
        lists: [{ listUuid: 'list-1', name: 'Groceries', theme: '' }],
      });
    });

    it('delegates to bring.removeItem', async () => {
      await run(['remove', 'Groceries', 'Milk']);

      expect(mockRemoveItem).toHaveBeenCalledWith('list-1', 'Milk');
      expect(stdout).toContain('Removed');
      expect(stdout).toContain('Milk');
    });

    it('exits with error when arguments are missing', async () => {
      await expect(run(['remove', 'Groceries'])).rejects.toThrow('process.exit');
      expect(exitCode).toBe(1);
    });
  });

  describe('complete command', () => {
    beforeEach(() => {
      mockLoadLists.mockResolvedValue({
        lists: [{ listUuid: 'list-1', name: 'Groceries', theme: '' }],
      });
    });

    it('delegates to bring.moveToRecentList', async () => {
      await run(['complete', 'Groceries', 'Milk']);

      expect(mockMoveToRecentList).toHaveBeenCalledWith('list-1', 'Milk');
      expect(stdout).toContain('Marked');
      expect(stdout).toContain('Milk');
      expect(stdout).toContain('purchased');
    });

    it('exits with error when arguments are missing', async () => {
      await expect(run(['complete', 'Groceries'])).rejects.toThrow('process.exit');
      expect(exitCode).toBe(1);
    });
  });

  describe('list name resolution', () => {
    it('matches list names case-insensitively', async () => {
      mockLoadLists.mockResolvedValue({
        lists: [{ listUuid: 'list-1', name: 'Groceries', theme: '' }],
      });
      mockGetItems.mockResolvedValueOnce({
        uuid: 'list-1',
        status: 'REGISTERED',
        purchase: [],
        recently: [],
      });

      await run(['items', 'groceries']);

      expect(mockGetItems).toHaveBeenCalledWith('list-1');
    });

    it('matches partial list names', async () => {
      mockLoadLists.mockResolvedValue({
        lists: [{ listUuid: 'list-1', name: 'Groceries', theme: '' }],
      });
      mockGetItems.mockResolvedValueOnce({
        uuid: 'list-1',
        status: 'REGISTERED',
        purchase: [],
        recently: [],
      });

      await run(['items', 'groc']);

      expect(mockGetItems).toHaveBeenCalledWith('list-1');
    });

    it('errors on ambiguous list name match', async () => {
      mockLoadLists.mockResolvedValue({
        lists: [
          { listUuid: 'list-1', name: 'Groceries', theme: '' },
          { listUuid: 'list-2', name: 'Grocery Extras', theme: '' },
        ],
      });

      await expect(run(['items', 'Grocer'])).rejects.toThrow('process.exit');
      expect(exitCode).toBe(1);
      expect(stderr).toContain('Ambiguous');
    });

    it('errors when no list matches', async () => {
      mockLoadLists.mockResolvedValue({
        lists: [{ listUuid: 'list-1', name: 'Groceries', theme: '' }],
      });

      await expect(run(['items', 'Hardware'])).rejects.toThrow('process.exit');
      expect(exitCode).toBe(1);
      expect(stderr).toContain('No list');
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
    });

    it('shows help when no command given', async () => {
      await run([]);

      expect(stdout).toContain('bring-cli');
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
