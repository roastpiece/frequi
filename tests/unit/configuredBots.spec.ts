import { nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfiguredBots, loggedInBots, useLoginInfo } from '@/composables/loginInfo';
import type { AuthStorage } from '@/types';

const ofetchMock = vi.hoisted(() => vi.fn());

vi.mock('ofetch', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('ofetch');
  return {
    ...actual,
    ofetch: ofetchMock,
  };
});

const fetchMock = vi.fn();
const password = 's3cret-password';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function botEntry(url: string, botName = 'binance') {
  return {
    botName,
    url,
    username: 'freqtrader',
    password,
  };
}

function storedBot(botId: string): AuthStorage {
  return useLoginInfo(botId).getLoginInfo();
}

describe('configured bots', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    ofetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    for (const botId of Object.keys(loggedInBots.value)) {
      useLoginInfo(botId).logout();
    }
    localStorage.removeItem('ftAuthLoginInfo');
  });

  it('does nothing when /bots.json is missing', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));

    await loadConfiguredBots();

    expect(ofetchMock).not.toHaveBeenCalled();
    expect(loggedInBots.value).toEqual({});
  });

  it('stores tokens from a configured bot and does not store the password', async () => {
    fetchMock.mockResolvedValue(jsonResponse([botEntry('https://bots.example.com/binance')]));
    ofetchMock.mockResolvedValue({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
    });

    await loadConfiguredBots();
    await nextTick();

    expect(ofetchMock).toHaveBeenCalledWith(
      'https://bots.example.com/binance/api/v1/token/login',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: expect.stringMatching(/^Basic /) },
      }),
    );
    const stored = storedBot('ftbot.0');
    expect(stored.accessToken).toBe('access-token');
    expect(stored.refreshToken).toBe('refresh-token');
    expect(stored.apiUrl).toBe('https://bots.example.com/binance');
    expect(JSON.stringify(stored)).not.toContain(password);
    expect(localStorage.getItem('ftAuthLoginInfo')).not.toContain(password);
  });

  it('skips login when the bot already has a refresh token', async () => {
    ofetchMock.mockResolvedValue({
      access_token: 'access-1',
      refresh_token: 'refresh-1',
    });
    await useLoginInfo('ftbot.0').login({
      botName: 'Renamed',
      url: 'https://bots.example.com/binance',
      username: 'freqtrader',
      password: 'old-password',
    });
    ofetchMock.mockClear();
    fetchMock.mockResolvedValue(jsonResponse([botEntry('https://bots.example.com/binance')]));

    await loadConfiguredBots();

    expect(ofetchMock).not.toHaveBeenCalled();
    expect(storedBot('ftbot.0').botName).toBe('Renamed');
    expect(storedBot('ftbot.0').refreshToken).toBe('refresh-1');
  });

  it('logs in again when the stored refresh token is empty', async () => {
    ofetchMock.mockResolvedValue({
      access_token: 'access-1',
      refresh_token: 'refresh-1',
    });
    await useLoginInfo('ftbot.0').login({
      botName: 'Old name',
      url: 'https://bots.example.com/binance',
      username: 'freqtrader',
      password: 'old-password',
    });
    const existing = storedBot('ftbot.0');
    existing.refreshToken = '';
    existing.accessToken = '';
    ofetchMock.mockClear();
    ofetchMock.mockResolvedValue({
      access_token: 'access-2',
      refresh_token: 'refresh-2',
    });
    fetchMock.mockResolvedValue(
      jsonResponse([botEntry('https://bots.example.com/binance', 'binance')]),
    );

    await loadConfiguredBots();

    expect(ofetchMock).toHaveBeenCalledTimes(1);
    expect(storedBot('ftbot.0').refreshToken).toBe('refresh-2');
    expect(storedBot('ftbot.0').botName).toBe('binance');
    expect(JSON.stringify(storedBot('ftbot.0'))).not.toContain(password);
  });

  it('continues with the next bot when one login fails', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        botEntry('https://down.example', 'down'),
        botEntry('https://up.example', 'up'),
      ]),
    );
    ofetchMock.mockImplementation(async (url: string) => {
      if (url.includes('down.example')) {
        return {};
      }
      return { access_token: 'access-ok', refresh_token: 'refresh-ok' };
    });

    await loadConfiguredBots();

    const bots = Object.values(loggedInBots.value);
    expect(bots).toHaveLength(1);
    expect(bots[0]?.botUrl).toBe('https://up.example');
    expect(storedBot(bots[0]!.botId).refreshToken).toBe('refresh-ok');
  });
});
