import { ofetch } from 'ofetch';

import type {
  AuthPayload,
  AuthResponse,
  BotDescriptors,
  AuthStorage,
  AuthStorageMulti,
  BotDescriptor,
} from '@/types';

const AUTH_LOGIN_INFO = 'ftAuthLoginInfo';
const APIBASE = '/api/v1';
const BOTS_CONFIG_URL = '/bots.json';

interface ConfiguredBot {
  botName: string;
  url: string;
  username: string;
  password: string;
  sortId?: number;
}

// Global state for all login infos
const allLoginInfos = useStorage<AuthStorageMulti>(AUTH_LOGIN_INFO, {});

let configuredBotsPromise: Promise<void> | null = null;

/**
 * Get available bots with their descriptors
 */
export const loggedInBots = computed<BotDescriptors>(() => {
  const allInfo = allLoginInfos.value;
  const response: BotDescriptors = {};
  Object.keys(allInfo)
    .sort((a, b) => (allInfo[a]?.sortId ?? 0) - (allInfo[b]?.sortId ?? 0))
    .forEach((k, idx) => {
      const bot = allInfo[k];
      if (!bot) return;
      response[k] = {
        botId: k,
        botName: bot.botName,
        botUrl: bot.apiUrl,
        sortId: bot.sortId ?? idx,
      };
    });

  return response;
});

/** Build a UTF-8 safe HTTP Basic Authorization header value. */
function basicAuthHeader(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  return `Basic ${btoa(String.fromCharCode(...bytes))}`;
}

export function useLoginInfo(botId: string) {
  console.log('botId', botId);

  const currentInfo = computed({
    get: () => allLoginInfos.value[botId]!,
    set: (val) => (allLoginInfos.value[botId] = val),
  });

  const autoRefresh = computed({
    get: () => currentInfo.value.autoRefresh,
    set: (val) => (currentInfo.value.autoRefresh = val),
  });
  const accessToken = computed(() => currentInfo.value.accessToken);

  const baseUrl = computed<string>(() => {
    const baseURL = currentInfo.value.apiUrl;
    if (baseURL === null) {
      return APIBASE;
    }
    if (!baseURL.endsWith(APIBASE)) {
      return `${baseURL}${APIBASE}`;
    }
    return `${baseURL}${APIBASE}`;
  });

  const baseWsUrl = computed<string>(() => {
    const baseURL = baseUrl.value;
    if (baseURL.startsWith('http://')) {
      return baseURL.replace('http://', 'ws://');
    }
    if (baseURL.startsWith('https://')) {
      return baseURL.replace('https://', 'wss://');
    }
    return '';
  });

  /**
   * Get login info for current bot
   */
  function getLoginInfo(): AuthStorage {
    const allLoginBot = allLoginInfos.value[botId];
    if (allLoginBot && 'apiUrl' in allLoginBot && 'refreshToken' in allLoginBot) {
      return allLoginBot;
    }
    return {
      botName: '',
      apiUrl: '',
      username: '',
      refreshToken: '',
      accessToken: '',
      autoRefresh: false,
    };
  }

  function updateBot(newValues: Partial<BotDescriptor>): void {
    Object.assign(currentInfo.value, newValues);
  }

  function setRefreshTokenExpired(): void {
    currentInfo.value.refreshToken = '';
    currentInfo.value.accessToken = '';
  }

  function logout(): void {
    console.log('Logging out');
    delete allLoginInfos.value[botId];
  }

  async function loginCall(auth: AuthPayload): Promise<AuthStorage> {
    const data = await ofetch<AuthResponse>(`${auth.url}${APIBASE}/token/login`, {
      method: 'POST',
      body: {},
      credentials: 'include',
      headers: { Authorization: basicAuthHeader(auth.username, auth.password) },
    });
    if (data.access_token && data.refresh_token) {
      const obj: AuthStorage = {
        botName: auth.botName,
        apiUrl: auth.url,
        username: auth.username,
        accessToken: data.access_token || '',
        refreshToken: data.refresh_token || '',
        autoRefresh: true,
      };
      return obj;
    }
    return Promise.reject('login failed');
  }

  async function login(auth: AuthPayload) {
    const loginInfo = await loginCall(auth);
    currentInfo.value = loginInfo;
  }

  // Shared across concurrent 401s so that an expired access token triggers only one refresh call.
  let refreshInFlight: Promise<string> | null = null;

  async function doRefreshToken(): Promise<string> {
    console.log('Refreshing token...');
    const token = currentInfo.value.refreshToken;
    try {
      const data = await ofetch<AuthResponse>(
        `${currentInfo.value.apiUrl}${APIBASE}/token/refresh`,
        {
          method: 'POST',
          body: {},
          credentials: 'include',
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      if (!data.access_token) {
        throw new Error('No access token received');
      }
      currentInfo.value.accessToken = data.access_token;
      return data.access_token;
    } catch (err) {
      console.error(err);
      if (isApiError(err)) {
        if (err.status === 401) {
          console.log('Refresh token did not refresh.');
          setRefreshTokenExpired();
        } else if (err.status === 500 || err.status === 404) {
          console.log('Bot seems to be offline... - retrying later');
        }
      }
      throw err;
    }
  }

  function refreshToken(): Promise<string> {
    if (!refreshInFlight) {
      refreshInFlight = doRefreshToken().finally(() => {
        refreshInFlight = null;
      });
    }
    return refreshInFlight;
  }

  return {
    updateBot,
    getLoginInfo,
    autoRefresh,
    accessToken,
    logout,
    login,
    refreshToken,
    baseUrl,
    baseWsUrl,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function configuredBot(value: unknown): ConfiguredBot | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const bot = value as Record<string, unknown>;
  if (
    !isNonEmptyString(bot.botName) ||
    !isNonEmptyString(bot.url) ||
    !isNonEmptyString(bot.username) ||
    !isNonEmptyString(bot.password)
  ) {
    return undefined;
  }
  if (bot.sortId !== undefined && typeof bot.sortId !== 'number') {
    return undefined;
  }
  return {
    botName: bot.botName,
    url: bot.url,
    username: bot.username,
    password: bot.password,
    ...(typeof bot.sortId === 'number' ? { sortId: bot.sortId } : {}),
  };
}

async function readConfiguredBots(): Promise<ConfiguredBot[]> {
  let response: Response;
  try {
    response = await fetch(BOTS_CONFIG_URL, { cache: 'no-store' });
  } catch (error) {
    console.error('Failed to fetch /bots.json', error);
    return [];
  }
  if (response.status === 404) {
    return [];
  }
  if (!response.ok) {
    console.error(`Failed to fetch /bots.json (${response.status})`);
    return [];
  }
  const contentType = response.headers.get('content-type') ?? '';
  // A missing file on the SPA fallback is index.html, not a bot list.
  if (contentType.includes('text/html')) {
    return [];
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    console.error('Ignoring /bots.json because it is not valid JSON', error);
    return [];
  }
  if (!Array.isArray(body)) {
    console.error('Ignoring /bots.json because it is not a list of bots');
    return [];
  }
  const bots: ConfiguredBot[] = [];
  body.forEach((entry, index) => {
    const bot = configuredBot(entry);
    if (!bot) {
      console.error(`Ignoring invalid /bots.json entry at index ${index}`);
      return;
    }
    bots.push(bot);
  });
  return bots;
}

function findBotIdByUrl(url: string): string | undefined {
  return Object.keys(allLoginInfos.value).find(
    (botId) => allLoginInfos.value[botId]?.apiUrl === url,
  );
}

function nextConfiguredBotId(): string {
  let nextBotCount = Object.keys(allLoginInfos.value).length;
  while (`ftbot.${nextBotCount}` in allLoginInfos.value) {
    nextBotCount += 1;
  }
  return `ftbot.${nextBotCount}`;
}

/**
 * Log in bots declared in /bots.json.
 * Passwords are sent only on the login request and are not stored.
 */
export async function loadConfiguredBots(): Promise<void> {
  const bots = await readConfiguredBots();
  const seenUrls = new Set<string>();
  let sortFallback = 0;

  for (const bot of bots) {
    const sortId = bot.sortId ?? sortFallback;
    sortFallback += 1;
    if (seenUrls.has(bot.url)) {
      continue;
    }
    seenUrls.add(bot.url);

    const existingId = findBotIdByUrl(bot.url);
    const existing = existingId ? allLoginInfos.value[existingId] : undefined;
    if (existing?.refreshToken) {
      continue;
    }

    const botId = existingId ?? nextConfiguredBotId();
    try {
      const { login } = useLoginInfo(botId);
      await login({
        botName: bot.botName,
        url: bot.url,
        username: bot.username,
        password: bot.password,
      });
      const stored = allLoginInfos.value[botId];
      if (stored) {
        allLoginInfos.value[botId] = { ...stored, sortId };
      }
    } catch (error) {
      console.error(`Failed to log in configured bot ${bot.botName} at ${bot.url}`, error);
    }
  }
}

/** Read /bots.json once per page load, then log in any configured bots. */
export function ensureConfiguredBots(): Promise<void> {
  if (!configuredBotsPromise) {
    configuredBotsPromise = loadConfiguredBots().catch((error) => {
      console.error('Failed to load configured bots', error);
    });
  }
  return configuredBotsPromise;
}
