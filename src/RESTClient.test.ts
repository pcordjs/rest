/// <reference types="jest" />

import * as http from 'node:http';
import * as stream from 'node:stream';
import timers from 'node:timers/promises';
import { DiscordAPIError } from '.';
import RESTClient, { BASE_USER_AGENT, TokenType } from './RESTClient';
import RESTError from './RESTError';

jest.mock('node:https', () => {
  return http;
});

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

describe('requests', () => {
  let onRequest: http.RequestListener | undefined;
  const PORT = 3000;

  const server: http.Server = http.createServer((req, res) => {
    onRequest?.(req, res);
  });

  beforeAll(() => new Promise<void>((resolve) => server.listen(PORT, resolve)));

  beforeEach(() => {
    onRequest = undefined;
  });

  afterAll(() => new Promise((resolve) => server.close(resolve)));

  function nextRequest(): Promise<[http.IncomingMessage, http.ServerResponse]> {
    return new Promise((resolve, reject) => {
      if (onRequest) reject('A request listener is already set');
      onRequest = (req, res) => {
        onRequest = undefined;
        resolve([req, res]);
      };
    });
  }

  function jsonBody<T>(req: http.IncomingMessage): Promise<T> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => resolve(JSON.parse(body) as T));
      req.on('error', reject);
    });
  }

  let client = new RESTClient({
    host: 'localhost',
    port: PORT
  });

  it('should send stream request bodies', async () => {
    const handler = nextRequest().then(async ([req, res]) => {
      try {
        // data may be sent in multiple packets (chunks) so we need to buffer it
        const body = await new Promise<string>((resolve, reject) => {
          let data = '';
          req.on('data', (chunk) => (data += chunk));
          req.on('end', () => resolve(data));
          req.on('error', reject);
        });

        // all data should be received even if multiple chunks were used
        expect(body).toBe('foo\nbar');
      } finally {
        res.end();
      }
    });

    const body = new stream.Readable();

    // start the request before data is ready
    const request = client.request('POST', '/', {
      body
    });

    // send data via multiple chunks to test if everything is sent
    body.push('foo\n');
    body.push('bar');
    body.push(null);

    return Promise.all([request, handler]);
  });

  it('should always set the User-Agent and Accept-Encoding headers', async () => {
    const handler = nextRequest().then(([req, res]) => {
      try {
        expect(req.headers['user-agent']).toBe(client.userAgent);
        expect(req.headers['accept-encoding']).toBeTruthy();
      } finally {
        res.end();
      }
    });

    await client.request('GET', '/');

    return handler;
  });

  it('should set the Authorization header if the auth option is true', async () => {
    const handler = nextRequest()
      .then(([req, res]) => {
        try {
          expect(req.headers.authorization).toBeFalsy();
        } finally {
          res.end();
        }
      })
      .then(nextRequest)
      .then(([req, res]) => {
        try {
          expect(req.headers.authorization).toBe('Bot token');
        } finally {
          res.end();
        }
      })
      .then(nextRequest)
      .then(([req, res]) => {
        try {
          expect(req.headers.authorization).toBe('Bearer token');
        } finally {
          res.end();
        }
      });

    client = new RESTClient({
      token: 'token',
      host: 'localhost',
      port: PORT
    });

    await client.request('GET', '/');
    await client.request('GET', '/', { auth: true });

    client = new RESTClient({
      token: 'token',
      tokenType: TokenType.BEARER,
      host: 'localhost',
      port: PORT
    });

    await client.request('GET', '/', { auth: true });

    return handler;
  });

  it('should automatically convert objects and arrays to JSON', async () => {
    const arrayBody = [1, 2, 3];
    const objectBody = { foo: 'bar', baz: arrayBody };

    const handler = nextRequest()
      .then(async ([req, res]) => {
        try {
          expect(req.headers['content-type']).toBe('application/json');
          await expect(jsonBody(req)).resolves.toEqual(objectBody);
        } finally {
          res.end();
        }
      })
      .then(nextRequest)
      .then(async ([req, res]) => {
        try {
          expect(req.headers['content-type']).toBe('application/json');
          await expect(jsonBody(req)).resolves.toEqual(arrayBody);
        } finally {
          res.end();
        }
      });

    await client.request('POST', '/', {
      body: objectBody
    });

    await client.request('POST', '/', {
      body: arrayBody
    });

    return handler;
  });

  it('should send requests to the v9 API by default', async () => {
    const handler = nextRequest().then(([req, res]) => {
      try {
        expect(req.url).toBe('/api/v9/users/@me');
      } finally {
        res.end();
      }
    });

    await client.request('GET', '/users/@me');

    return handler;
  });

  it('should append a query string when the queryString option is set', async () => {
    const handler = nextRequest().then(([req, res]) => {
      try {
        expect(req.url?.slice(req.url.indexOf('?'))).toBe('?foo=bar');
      } finally {
        res.end();
      }
    });

    await client.request('GET', '/', {
      queryString: new URLSearchParams({ foo: 'bar' })
    });

    return handler;
  });

  it('should use rate limit buckets when applicable', async () => {
    const handler = nextRequest().then(([req, res]) => {
      try {
        expect(req.url).toBe('/api/v9/channels/123');
      } finally {
        res.end();
      }
    });

    await client.request('GET', '/channels/123');

    return handler;
  });

  it('should use the timeout option to abort requests that hang', async () => {
    const handler = nextRequest().then(async ([, res]) => {
      try {
        await timers.setTimeout(1000);
      } finally {
        res.end();
      }
    });

    await expect(
      client.request('GET', '/', {
        timeout: 500
      })
    ).rejects.toBeInstanceOf(RESTError);

    return handler;
  });

  it('should throw on an unsuccessful response', async () => {
    const handler = nextRequest().then(([, res]) => {
      res.writeHead(400);
      res.end();
    });

    await expect(client.request('GET', '/')).rejects.toBeInstanceOf(
      DiscordAPIError
    );

    return handler;
  });

  it('should add the error code and message on an unsuccessful response', async () => {
    const [code, message] = [123, 'foo'];

    const handler = nextRequest().then(([, res]) => {
      res.writeHead(400, {
        'Content-Type': 'application/json'
      });

      res.end(
        JSON.stringify({
          code,
          message
        })
      );
    });

    const request = client.request('GET', '/');
    await expect(request).rejects.toBeInstanceOf(DiscordAPIError);
    await expect(request).rejects.toHaveProperty('code', code);
    await expect(request).rejects.toHaveProperty('message', message);

    return handler;
  });
});
