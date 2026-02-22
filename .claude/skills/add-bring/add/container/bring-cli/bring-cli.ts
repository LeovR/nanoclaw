#!/usr/bin/env node

import fs from 'fs';

const BASE_URL = 'https://api.getbring.com/rest/';
const API_KEY = 'cof4Nc6D8saplXjE3h3HXqHH8m7VU2i1Gs0g85Sp';
const TOKEN_PATH = '/tmp/bring-token.json';
const CLIENT_ID = 'android';

interface TokenData {
  access_token: string;
  refresh_token: string;
  uuid: string;
  expires_at: number;
}

interface BringList {
  listUuid: string;
  name: string;
}

interface BringItem {
  name: string;
  specification: string;
}

interface ListsResponse {
  lists: BringList[];
}

interface ListItemsResponse {
  uuid: string;
  purchase: BringItem[];
  recently: BringItem[];
}

// --- Token management ---

const loadCachedToken = (): TokenData | null => {
  try {
    if (!fs.existsSync(TOKEN_PATH)) return null;
    const data = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8')) as TokenData;
    if (!data.access_token) return null;
    return data;
  } catch {
    return null;
  }
};

const saveToken = (token: TokenData): void => {
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(token));
};

const authenticate = async (email: string, password: string): Promise<TokenData> => {
  const res = await fetch(`${BASE_URL}v2/bringauth`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-BRING-API-KEY': API_KEY,
      'X-BRING-CLIENT': CLIENT_ID,
    },
    body: `email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Authentication failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  const token: TokenData = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    uuid: data.uuid,
    expires_at: Date.now() + data.expires_in * 1000,
  };

  saveToken(token);
  return token;
};

const refreshToken = async (token: TokenData): Promise<TokenData> => {
  const res = await fetch(`${BASE_URL}v2/bringauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-BRING-API-KEY': API_KEY,
      'X-BRING-CLIENT': CLIENT_ID,
    },
    body: `refresh_token=${encodeURIComponent(token.refresh_token)}`,
  });

  if (!res.ok) {
    return authenticate(
      process.env.BRING_EMAIL!,
      process.env.BRING_PASSWORD!,
    );
  }

  const data = await res.json();
  const newToken: TokenData = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || token.refresh_token,
    uuid: token.uuid,
    expires_at: Date.now() + data.expires_in * 1000,
  };

  saveToken(newToken);
  return newToken;
};

const getToken = async (): Promise<TokenData> => {
  const cached = loadCachedToken();

  if (cached) {
    if (cached.expires_at > Date.now()) {
      return cached;
    }
    return refreshToken(cached);
  }

  return authenticate(
    process.env.BRING_EMAIL!,
    process.env.BRING_PASSWORD!,
  );
};

// --- API helpers ---

const apiHeaders = (token: TokenData): Record<string, string> => ({
  Authorization: `Bearer ${token.access_token}`,
  'X-BRING-API-KEY': API_KEY,
  'X-BRING-CLIENT': CLIENT_ID,
});

const apiRequest = async (
  path: string,
  token: TokenData,
  options: RequestInit = {},
): Promise<Response> => {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      ...apiHeaders(token),
      ...(options.headers as Record<string, string> || {}),
    },
  });

  if (res.status === 401) {
    // Clear cache and re-authenticate once
    const newToken = await authenticate(
      process.env.BRING_EMAIL!,
      process.env.BRING_PASSWORD!,
    );
    // Update the token reference for callers
    Object.assign(token, newToken);

    return fetch(url, {
      ...options,
      headers: {
        ...apiHeaders(newToken),
        ...(options.headers as Record<string, string> || {}),
      },
    });
  }

  return res;
};

// --- List resolution ---

const fetchLists = async (token: TokenData): Promise<BringList[]> => {
  const res = await apiRequest(`bringusers/${token.uuid}/lists`, token);
  if (!res.ok) {
    throw new Error(`Failed to fetch lists (${res.status})`);
  }
  const data: ListsResponse = await res.json();
  return data.lists;
};

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
  token: TokenData,
  name: string,
): Promise<BringList> => {
  const lists = await fetchLists(token);
  return resolveList(lists, name);
};

// --- Commands ---

const cmdLists = async (token: TokenData): Promise<void> => {
  const lists = await fetchLists(token);

  if (lists.length === 0) {
    console.log('No shopping lists found.');
    return;
  }

  console.log('Your shopping lists:');
  for (const list of lists) {
    console.log(`  - ${list.name}`);
  }
};

const cmdItems = async (token: TokenData, listName: string): Promise<void> => {
  const list = await resolveListByName(token, listName);
  const res = await apiRequest(`v2/bringlists/${list.listUuid}`, token);

  if (!res.ok) {
    throw new Error(`Failed to fetch items (${res.status})`);
  }

  const data: ListItemsResponse = await res.json();

  if (data.purchase.length === 0 && data.recently.length === 0) {
    console.log(`List "${list.name}" is empty.`);
    return;
  }

  if (data.purchase.length > 0) {
    console.log(`Items on "${list.name}":`);
    for (const item of data.purchase) {
      const spec = item.specification ? ` (${item.specification})` : '';
      console.log(`  - ${item.name}${spec}`);
    }
  }

  if (data.recently.length > 0) {
    if (data.purchase.length > 0) console.log('');
    console.log('Recently purchased:');
    for (const item of data.recently) {
      const spec = item.specification ? ` (${item.specification})` : '';
      console.log(`  - ${item.name}${spec}`);
    }
  }
};

const cmdAdd = async (
  token: TokenData,
  listName: string,
  itemName: string,
  specification?: string,
): Promise<void> => {
  const list = await resolveListByName(token, listName);

  const body = JSON.stringify({
    uuid: list.listUuid,
    items: [
      {
        itemId: itemName,
        spec: specification || '',
        operation: 'TO_PURCHASE',
      },
    ],
  });

  const res = await apiRequest(`v2/bringlists/${list.listUuid}/items`, token, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  if (!res.ok) {
    throw new Error(`Failed to add item (${res.status})`);
  }

  const spec = specification ? ` (${specification})` : '';
  console.log(`Added "${itemName}${spec}" to "${list.name}".`);
};

const cmdRemove = async (
  token: TokenData,
  listName: string,
  itemName: string,
): Promise<void> => {
  const list = await resolveListByName(token, listName);

  const body = JSON.stringify({
    uuid: list.listUuid,
    items: [
      {
        itemId: itemName,
        spec: '',
        operation: 'REMOVE',
      },
    ],
  });

  const res = await apiRequest(`v2/bringlists/${list.listUuid}/items`, token, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  if (!res.ok) {
    throw new Error(`Failed to remove item (${res.status})`);
  }

  console.log(`Removed "${itemName}" from "${list.name}".`);
};

const cmdComplete = async (
  token: TokenData,
  listName: string,
  itemName: string,
): Promise<void> => {
  const list = await resolveListByName(token, listName);

  const body = JSON.stringify({
    uuid: list.listUuid,
    items: [
      {
        itemId: itemName,
        spec: '',
        operation: 'TO_RECENTLY',
      },
    ],
  });

  const res = await apiRequest(`v2/bringlists/${list.listUuid}/items`, token, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  if (!res.ok) {
    throw new Error(`Failed to complete item (${res.status})`);
  }

  console.log(`Marked "${itemName}" as purchased on "${list.name}".`);
};

const cmdNotify = async (
  token: TokenData,
  listName: string,
  notificationType: string,
): Promise<void> => {
  const list = await resolveListByName(token, listName);

  const body = JSON.stringify({
    listUuid: list.listUuid,
    type: notificationType,
  });

  const res = await apiRequest(
    `v2/bringnotifications/lists/${list.listUuid}`,
    token,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    },
  );

  if (!res.ok) {
    throw new Error(`Failed to send notification (${res.status})`);
  }

  console.log(`Notification "${notificationType}" sent for "${list.name}".`);
};

const cmdHelp = (): void => {
  console.log(`bring-cli - Manage Bring! shopping lists

Usage:
  bring-cli lists                         List all shopping lists
  bring-cli items <list>                  Show items on a list
  bring-cli add <list> <item> [spec]      Add item (spec = quantity/detail)
  bring-cli remove <list> <item>          Remove item from list
  bring-cli complete <list> <item>        Mark item as purchased
  bring-cli notify <list> <type>          Send notification (e.g. GOING_SHOPPING)
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

  const knownCommands = new Set(['lists', 'items', 'add', 'remove', 'complete', 'notify']);
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

  const token = await getToken();

  switch (command) {
    case 'lists':
      await cmdLists(token);
      break;

    case 'items':
      if (!args[1]) {
        console.error('Usage: bring-cli items <list-name>');
        process.exit(1);
      }
      await cmdItems(token, args[1]);
      break;

    case 'add':
      if (!args[1] || !args[2]) {
        console.error('Usage: bring-cli add <list> <item> [specification]');
        process.exit(1);
      }
      await cmdAdd(token, args[1], args[2], args.slice(3).join(' ') || undefined);
      break;

    case 'remove':
      if (!args[1] || !args[2]) {
        console.error('Usage: bring-cli remove <list> <item>');
        process.exit(1);
      }
      await cmdRemove(token, args[1], args[2]);
      break;

    case 'complete':
      if (!args[1] || !args[2]) {
        console.error('Usage: bring-cli complete <list> <item>');
        process.exit(1);
      }
      await cmdComplete(token, args[1], args[2]);
      break;

    case 'notify':
      if (!args[1] || !args[2]) {
        console.error('Usage: bring-cli notify <list> <type>');
        process.exit(1);
      }
      await cmdNotify(token, args[1], args[2]);
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
