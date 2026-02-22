#!/usr/bin/env node

import Bring from 'bring-shopping';

// --- List resolution ---

interface BringList {
  listUuid: string;
  name: string;
}

const resolveList = (lists: BringList[], query: string): BringList => {
  // Exact match (case-insensitive)
  const exact = lists.filter(
    (l) => l.name.toLowerCase() === query.toLowerCase(),
  );
  if (exact.length === 1) return exact[0];

  // Partial match (case-insensitive)
  const partial = lists.filter((l) =>
    l.name.toLowerCase().includes(query.toLowerCase()),
  );

  if (partial.length === 0) {
    console.error(
      `No list matching "${query}". Available lists: ${lists.map((l) => l.name).join(', ')}`,
    );
    process.exit(1);
  }

  if (partial.length > 1) {
    console.error(
      `Ambiguous list name "${query}". Matches: ${partial.map((l) => l.name).join(', ')}`,
    );
    process.exit(1);
  }

  return partial[0];
};

const resolveListByName = async (
  bring: Bring,
  name: string,
): Promise<BringList> => {
  const { lists } = await bring.loadLists();
  return resolveList(lists, name);
};

// --- Commands ---

const cmdLists = async (bring: Bring): Promise<void> => {
  const { lists } = await bring.loadLists();

  if (lists.length === 0) {
    console.log('No shopping lists found.');
    return;
  }

  console.log('Your shopping lists:');
  for (const list of lists) {
    console.log(`  - ${list.name}`);
  }
};

const cmdItems = async (bring: Bring, listName: string): Promise<void> => {
  const list = await resolveListByName(bring, listName);
  const data = await bring.getItems(list.listUuid);
  const purchase = data.purchase ?? [];
  const recently = data.recently ?? [];

  if (purchase.length === 0 && recently.length === 0) {
    console.log(`List "${list.name}" is empty.`);
    return;
  }

  if (purchase.length > 0) {
    console.log(`Items on "${list.name}":`);
    for (const item of purchase) {
      const spec = item.specification ? ` (${item.specification})` : '';
      console.log(`  - ${item.name}${spec}`);
    }
  }

  if (recently.length > 0) {
    if (purchase.length > 0) console.log('');
    console.log('Recently purchased:');
    for (const item of recently) {
      const spec = item.specification ? ` (${item.specification})` : '';
      console.log(`  - ${item.name}${spec}`);
    }
  }
};

const cmdAdd = async (
  bring: Bring,
  listName: string,
  itemName: string,
  specification?: string,
): Promise<void> => {
  const list = await resolveListByName(bring, listName);
  await bring.saveItem(list.listUuid, itemName, specification || '');

  const spec = specification ? ` (${specification})` : '';
  console.log(`Added "${itemName}${spec}" to "${list.name}".`);
};

const cmdRemove = async (
  bring: Bring,
  listName: string,
  itemName: string,
): Promise<void> => {
  const list = await resolveListByName(bring, listName);
  await bring.removeItem(list.listUuid, itemName);
  console.log(`Removed "${itemName}" from "${list.name}".`);
};

const cmdComplete = async (
  bring: Bring,
  listName: string,
  itemName: string,
): Promise<void> => {
  const list = await resolveListByName(bring, listName);
  await bring.moveToRecentList(list.listUuid, itemName);
  console.log(`Marked "${itemName}" as purchased on "${list.name}".`);
};

const cmdHelp = (): void => {
  console.log(`bring-cli - Manage Bring! shopping lists

Usage:
  bring-cli lists                         List all shopping lists
  bring-cli items <list>                  Show items on a list
  bring-cli add <list> <item> [spec]      Add item (spec = quantity/detail)
  bring-cli remove <list> <item>          Remove item from list
  bring-cli complete <list> <item>        Mark item as purchased
  bring-cli help                          Show this help

Environment variables:
  BRING_EMAIL       Bring! account email (required)
  BRING_PASSWORD    Bring! account password (required)

List names support case-insensitive partial matching.`);
};

// --- Main entry point ---

export const run = async (args: string[]): Promise<void> => {
  const command = args[0];

  if (command === 'help' || !command) {
    cmdHelp();
    return;
  }

  const knownCommands = new Set(['lists', 'items', 'add', 'remove', 'complete']);
  if (!knownCommands.has(command)) {
    console.error(`Unknown command: ${command}. Run "bring-cli help" for usage.`);
    process.exit(1);
  }

  // Validate credentials for commands that need auth
  if (!process.env.BRING_EMAIL || !process.env.BRING_PASSWORD) {
    console.error(
      'Error: BRING_EMAIL and BRING_PASSWORD environment variables are required.',
    );
    process.exit(1);
  }

  const bring = new Bring({
    mail: process.env.BRING_EMAIL,
    password: process.env.BRING_PASSWORD,
  });
  await bring.login();

  switch (command) {
    case 'lists':
      await cmdLists(bring);
      break;

    case 'items':
      if (!args[1]) {
        console.error('Usage: bring-cli items <list-name>');
        process.exit(1);
      }
      await cmdItems(bring, args[1]);
      break;

    case 'add':
      if (!args[1] || !args[2]) {
        console.error('Usage: bring-cli add <list> <item> [specification]');
        process.exit(1);
      }
      await cmdAdd(bring, args[1], args[2], args.slice(3).join(' ') || undefined);
      break;

    case 'remove':
      if (!args[1] || !args[2]) {
        console.error('Usage: bring-cli remove <list> <item>');
        process.exit(1);
      }
      await cmdRemove(bring, args[1], args[2]);
      break;

    case 'complete':
      if (!args[1] || !args[2]) {
        console.error('Usage: bring-cli complete <list> <item>');
        process.exit(1);
      }
      await cmdComplete(bring, args[1], args[2]);
      break;
  }
};

// CLI entry point
const cliArgs = process.argv.slice(2);
if (cliArgs.length > 0 || !process.stdin.isTTY) {
  run(cliArgs).catch((err) => {
    if (err.message?.startsWith('process.exit')) return;
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}
