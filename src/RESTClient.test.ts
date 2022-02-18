/// <reference types="jest" />

import timers from 'node:timers/promises';
import RESTClient, { BASE_USER_AGENT, TokenType } from './RESTClient';
import RESTError from './RESTError';

/*
 *import EventEmitter from 'node:events';
 *const requestEnd = jest.fn();
 *jest.mock('node:https', () => {
 *  const https = jest.requireActual<typeof import('node:https')>('node:https');
 *  return {
 *    ...https,
 *    request: jest.fn(() => {
 *      return new (class extends EventEmitter {
 *        public end = requestEnd;
 *      })();
 *    })
 *  };
 *});
 */

describe(RESTClient, () => {
  it('should warn when using an invalid api version', () => {
    const warn = jest.spyOn(process, 'emitWarning');

    new RESTClient({
      // must be integer
      apiVersion: 1.5
    });

    // reset internal state
    (
      RESTClient as unknown as { hasEmittedInvalidAPIVersionWarning: boolean }
    ).hasEmittedInvalidAPIVersionWarning = false;

    new RESTClient({
      // must be > 0
      apiVersion: -1
    });

    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('should calculate the user agent based off options', () => {
    let client = new RESTClient({
      userAgentSuffix: 'MyUserAgent'
    });
    expect(client.userAgent).toBe(`${BASE_USER_AGENT}, MyUserAgent`);

    client = new RESTClient({});
    expect(client.userAgent).toBe(BASE_USER_AGENT);
  });

  it('should throw an error if token is missing', () => {
    let client = new RESTClient({});
    expect(() => client.auth).toThrow(RESTError);

    client = new RESTClient({
      token: '123.456.789'
    });
    expect(() => client.auth).not.toThrow(RESTError);
  });

  it('should prefix the token with its type', () => {
    let client = new RESTClient({
      token: '123.456.789'
    });

    expect(client.auth).toBe('Bot 123.456.789');

    client = new RESTClient({
      token: '123.456.789',
      tokenType: TokenType.BOT
    });

    expect(client.auth).toBe('Bot 123.456.789');

    client = new RESTClient({
      token: '123.456.789',
      tokenType: TokenType.BEARER
    });

    expect(client.auth).toBe('Bearer 123.456.789');
  });

  it('should handle rate limits when flushing buckets', async () => {
    const client = new RESTClient({}) as unknown as {
      flushBucket: (rateLimitBucket: typeof bucket) => Promise<void>;
    };

    const sleep = jest.spyOn(timers, 'setTimeout');

    const bucket = {
      remaining: 10,
      reset: new Date(Date.now() + 100),
      queue: new Array<() => Promise<void>>(101),
      flushing: false
    };

    const finalizeRequest = jest.fn(() => {
      // simulate rate limiting
      if (bucket.remaining === 0) bucket.remaining = 10;
      bucket.remaining--;

      if (Date.now() < bucket.reset.getTime())
        bucket.reset = new Date(Date.now() + 100);

      return Promise.resolve();
    });

    bucket.queue.fill(finalizeRequest);

    await client.flushBucket(bucket);

    expect(sleep).toHaveBeenCalledTimes(10);
  });

  it('should not cause concurrent bucket flushes', async () => {
    const client = new RESTClient({}) as unknown as {
      flushBucket: (rateLimitBucket: typeof bucket) => Promise<void>;
      flushGlobalBucket: () => Promise<void>;
      flushing: boolean;
      queue: Array<() => Promise<void>>;
    };

    const bucket = {
      remaining: 1,
      reset: new Date(),
      queue: [],
      flushing: true
    };

    // with a specific bucket
    await client.flushBucket(bucket);

    expect(bucket.flushing).toBe(true);

    // with the global bucket
    client.flushing = true;
    await client.flushGlobalBucket();

    expect(client.flushing).toBe(true);
  });

  it('should call request finalizers when flushing buckets', async () => {
    const client = new RESTClient({}) as unknown as {
      flushBucket: (rateLimitBucket: typeof bucket) => Promise<void>;
      flushGlobalBucket: () => Promise<void>;
      queue: Array<() => Promise<void>>;
    };

    const finalizeRequest = jest.fn(() => Promise.resolve());

    const bucket = {
      remaining: 1,
      reset: new Date(),
      queue: new Array<() => Promise<void>>(100),
      flushing: false
    };

    // with a specific bucket
    bucket.queue.fill(finalizeRequest);

    await client.flushBucket(bucket);

    expect(finalizeRequest).toHaveBeenCalledTimes(100);

    finalizeRequest.mockClear();

    // with the global bucket
    client.queue.length = 100;
    client.queue.fill(finalizeRequest);

    await client.flushGlobalBucket();

    expect(finalizeRequest).toHaveBeenCalledTimes(100);
  });

  it('should create a rate limit bucket based on the request path', () => {
    const getRateLimitBucket = (
      RESTClient as unknown as {
        getRateLimitBucket: (path: string) => string | null;
      }
    ).getRateLimitBucket;
    expect(getRateLimitBucket('/channels/123')).toBe('channels/123');
    expect(getRateLimitBucket('/channels/123/messages/123')).toBe(
      'channels/123'
    );

    expect(getRateLimitBucket('/guilds/123')).toBe('guilds/123');

    expect(getRateLimitBucket('/webhooks/123/456')).toBe('webhooks/123/456');

    expect(getRateLimitBucket('/sticker-packs')).toBe(null);
  });
});
